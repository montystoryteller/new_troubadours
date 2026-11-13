/**
 * tour_planner.js — "Plan a tour around a club" tool.
 *
 * Pick an anchor club + one of its upcoming dates, a window of N days before
 * and M days after, and a start point (town or postcode). For every day in the
 * window the tool lists what's on (recurring clubs via RecurrenceEngine,
 * optionally folk nights / sessions / one-off events), sorted by estimated
 * road distance from the nearest already-chosen stop on the anchor's side.
 * Choose a stop per day (or leave rest days) and get an itinerary + map.
 *
 * Depends on: recurrence-engine.js, shared_utils.js (loadEventsData,
 * haversineKm, formatDate, parseDateString, getTodayMidnight,
 * resolveClubVenueId, clubIsActiveOn, initMap). Leaflet loads on demand.
 * Geocoding: postcodes.io (browser-callable, CORS-enabled, free).
 */

const { ROAD_FACTOR, KM_TO_MI } = TourSupport; // shared helpers live in tour_support.js
const { addDays, roadMiles, fmtMiles, fmtDrive, loadLeaflet, loadStart } = TourSupport;
const dkey = TourSupport.dateKey;

const PLANNER = {
  showCands: true, // grey markers for other possible venues on the map
  hideClose: false, // hide (rather than grey out) venues too close to a chosen stop
  eventsData: null,
  venues: {},
  start: null, // { lat, lon, label }
  anchor: null, // candidate object
  before: 3,
  after: 3,
  maxHop: 60, // road miles between consecutive stops
  maxHome: 0, // road miles from home; 0 = no limit
  includeOther: false,
  days: [], // Date[] across the window, chronological
  byDay: new Map(), // dateKey -> candidate[]
  chosen: new Map(), // dateKey -> candidate
};

let plannerMap = null;
let plannerMapLayer = null;

// ── tiny helpers ────────────────────────────────────────────────────────
function venueOf(c) {
  return PLANNER.venues[c.venue_id] || null;
}
function latlonOf(c) {
  const v = venueOf(c);
  return v && Array.isArray(v.latlon) && v.latlon.length === 2 ? v.latlon : null;
}
function setStatus(msg, isError) {
  const s = document.getElementById("plannerStatus");
  s.textContent = msg || "";
  s.className = "ts-status" + (isError ? " error" : "");
}

// ── candidate gathering ─────────────────────────────────────────────────
/**
 * Everything happening between from..to (inclusive) that has a venue with
 * coordinates. Returns Map(dateKey -> candidate[]).
 * candidate: {id, kind, name, date, time, venue_id, link}
 */
function gatherCandidates(from, to, includeOther) {
  const ed = PLANNER.eventsData;
  const out = new Map();
  const add = (c) => {
    if (!c.venue_id || !PLANNER.venues[c.venue_id]) return;
    if (!latlonOf(c)) return;
    if (/online|zoom/i.test(`${c.venue_id} ${PLANNER.venues[c.venue_id].name || ""}`)) return;
    const k = dkey(c.date);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(c);
  };

  const recurring = [{ list: ed.clubs || [], kind: "club" }];
  if (includeOther) {
    recurring.push({ list: ed.folkNights || [], kind: "folk night" });
    recurring.push({ list: ed.irishSessions || [], kind: "session" });
  }
  recurring.forEach(({ list, kind }) => {
    list.forEach((rec) => {
      if (!rec.schedule) return;
      RecurrenceEngine.scheduledOccurrencesInRange(
        rec.schedule, from, to, rec.exceptions || [],
      ).forEach((occ) => {
        if (occ.status === "cancelled" || occ.status === "moved_from") return;
        if (typeof clubIsActiveOn === "function" && !clubIsActiveOn(rec, occ.date)) return;
        add({
          id: `${kind}:${rec.club || rec.name}:${dkey(occ.date)}`,
          kind,
          name: rec.name,
          date: occ.date,
          time: rec.time || "",
          venue_id: resolveClubVenueId(rec, occ.date),
          link: rec.link || rec.facebook || "",
          clubId: rec.club || null,
        });
      });
    });
  });

  // One-off events: a specific event on a day replaces the generic
  // recurring entry at the same venue that day (it's the same gig).
  // Clubs' own one-off "special" nights are always included; other event
  // lists only when "include other events" is ticked.
  const oneOffs = [{ list: ed.specificEvents || [], kind: "event" }];
  if (includeOther) {
    oneOffs.push({ list: ed.musicEvents || [], kind: "music" });
    oneOffs.push({ list: ed.poetryEvents || [], kind: "poetry" });
  }
  oneOffs.forEach(({ list, kind }) => {
    list.forEach((ev) => {
      const d = parseDateString(ev.date);
      if (!d || d < from || d > to) return;
      if (kind === "event" && !ev.club && !includeOther) return;
      if (ev.cancelled || ev.isCancelled) return;
      const k = dkey(d);
      const vid = ev.venue_id;
      if (vid && out.has(k)) {
        out.set(
          k,
          out.get(k).filter(
            (c) => !(c.venue_id === vid && c.kind !== "event" && c.kind !== "music" && c.kind !== "poetry" &&
              (!ev.club || c.clubId === ev.club)),
          ),
        );
      }
      add({
        id: `${kind}:${ev.eventId || ev.name}:${k}`,
        kind,
        name: ev.showname || ev.name,
        date: d,
        time: ev.time || "",
        venue_id: vid,
        link: ev.link || ev.tickets || "",
        clubId: ev.club || null,
      });
    });
  });
  return out;
}

// ── geocoding ───────────────────────────────────────────────────────────
function setStart(s) {
  PLANNER.start = s;
  TourSupport.saveStart(PLANNER.start);
  document.getElementById("startCurrent").textContent = s ? `Start: ${s.label}` : "";
  renderAll();
}

function findPlace(inputId, choicesId, onPick) {
  return TourSupport.findPlace({
    input: document.getElementById(inputId),
    choices: document.getElementById(choicesId),
    onPick, setStatus,
    failHint: "You can pick a venue as the start point instead.",
  });
}
function onFindStart() { return findPlace("startInput", "startChoices", setStart); }
function setArea(a) {
  PLANNER.area = a;
  document.getElementById("areaCurrent").textContent = a ? `Area centre: ${a.label}` : "";
}

function onUseLocation() {
  TourSupport.locate({ onPick: setStart, setStatus });
}

function fillVenueFallback() {
  const sel = document.getElementById("startVenue");
  Object.values(PLANNER.venues)
    .filter((v) => Array.isArray(v.latlon))
    .sort((a, b) => (a.city || a.name).localeCompare(b.city || b.name))
    .forEach((v) => {
      const o = el("option", null, `${v.city ? v.city + " — " : ""}${v.name}`);
      o.value = v.id;
      sel.appendChild(o);
    });
  sel.addEventListener("change", () => {
    const v = PLANNER.venues[sel.value];
    if (v) setStart({ lat: v.latlon[0], lon: v.latlon[1], label: v.city || v.name });
  });
}

// ── anchor picking ──────────────────────────────────────────────────────
function fillAnchorClubs() {
  const sel = document.getElementById("anchorClub");
  const today = getTodayMidnight();
  const to = addDays(today, 183);
  const rows = [];
  (PLANNER.eventsData.clubs || []).forEach((rec) => {
    if (!rec.schedule || !rec.venue_id || !PLANNER.venues[rec.venue_id]) return;
    if (!isRealPlace({ venue_id: rec.venue_id })) return; // no online-only anchors
    const dates = RecurrenceEngine.scheduledOccurrencesInRange(rec.schedule, today, to, rec.exceptions || [])
      .filter((o) => (o.status === "scheduled" || o.status === "moved_to") && clubIsActiveOn(rec, o.date));
    if (dates.length) rows.push({ rec, dates: dates.map((o) => o.date) });
  });
  rows.sort((a, b) => a.rec.name.localeCompare(b.rec.name));
  PLANNER._anchorRows = rows;
  rows.forEach((r, i) => {
    const v = PLANNER.venues[r.rec.venue_id];
    const o = el("option", null, `${r.rec.name} (${v.city || v.name})`);
    o.value = String(i);
    sel.appendChild(o);
  });
  sel.addEventListener("change", fillAnchorDates);
  fillAnchorDates();
}

function currentMode() {
  return document.getElementById("plannerMode").value;
}
function setMode() {
  const m = currentMode();
  document.querySelectorAll("[data-modes]").forEach((n) => {
    n.hidden = !n.dataset.modes.split(" ").includes(m);
  });
  if (m === "venue" && !PLANNER._venueRows) buildVenueRows();
  fillAnchorDates();
}

/** Venues with at least one gig in the next ~6 months (clubs + other events). */
function buildVenueRows() {
  const today = getTodayMidnight();
  const to = addDays(today, 183);
  const byDay = gatherCandidates(today, to, true);
  const byVenue = new Map();
  byDay.forEach((list) => list.forEach((c) => {
    if (!isRealPlace(c)) return;
    if (!byVenue.has(c.venue_id)) byVenue.set(c.venue_id, []);
    byVenue.get(c.venue_id).push(c);
  }));
  const rows = [...byVenue.entries()].map(([vid, cands]) => {
    cands.sort((x, y) => x.date - y.date);
    const v = PLANNER.venues[vid];
    return { vid, cands, label: `${v.city ? v.city + " — " : ""}${v.name}` };
  }).sort((x, y) => x.label.localeCompare(y.label));
  PLANNER._venueRows = rows;
  const sel = document.getElementById("anchorVenue");
  sel.replaceChildren();
  rows.forEach((r, i) => { const o = el("option", null, r.label); o.value = String(i); sel.appendChild(o); });
  sel.addEventListener("change", fillAnchorDates);
}

function fillAnchorDates() {
  const m = currentMode();
  const dsel = document.getElementById("anchorDate");
  dsel.replaceChildren();
  if (m === "club") {
    const row = PLANNER._anchorRows[Number(document.getElementById("anchorClub").value)];
    if (!row) return;
    row.dates.forEach((d) => { const o = el("option", null, formatDate(d)); o.value = dkey(d); dsel.appendChild(o); });
  } else if (m === "venue") {
    const row = (PLANNER._venueRows || [])[Number(document.getElementById("anchorVenue").value)];
    if (!row) return;
    row.cands.forEach((c, i) => {
      const o = el("option", null, `${formatDate(c.date)} — ${c.name}`);
      o.value = String(i);
      dsel.appendChild(o);
    });
  }
}

// ── venue pool (artists / tours -> venues + weekdays) ────────────────────
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function asIdList(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : typeof v === "string" && v ? [v] : [];
}

/** Which kind of act is this performer? A performer flagged `musician`
 *  and/or `poet` is that; anyone else (that isn't a promoter/club record) is
 *  a storyteller. */
function performerClasses(pid) {
  const p = (PLANNER.eventsData.performers || {})[pid];
  if (!p || p.isPromoter || p.isClub) return new Set();
  const c = new Set();
  if (p.musician) c.add("musician");
  if (p.poet) c.add("poet");
  if (!c.size) c.add("storyteller");
  return c;
}

/** Every gig (past or future) usable as pool evidence. A gig counts if it
 *  involves an explicitly chosen artist or tour, OR if its act class
 *  (storyteller / musician / poet) is among `cats`. Gig-level music/poetry
 *  flags (musicEvents, tour isMusic / isPoetry) override a missing flag on
 *  the performer record. Returns {vid, date, pid, club, cls[]}. */
function poolEvidence(perfIds, tourIds, cats) {
  const ed = PLANNER.eventsData;
  const out = [];
  const idsOf = (e) => [e.performer_id, ...asIdList(e.performer_ids), ...asIdList(e.other_performer_ids), ...asIdList(e.support_performer_ids)].filter(Boolean);
  const classesFor = (ids, flagMusic, flagPoet) => {
    const c = new Set();
    ids.forEach((id) => performerClasses(id).forEach((x) => c.add(x)));
    if (flagMusic) { c.delete("storyteller"); c.add("musician"); }
    if (flagPoet) { c.delete("storyteller"); c.add("poet"); }
    if (!c.size && !ids.length) c.add("storyteller"); // unlisted performer: assume story show
    return c;
  };
  const wanted = (cls) => [...cls].some((x) => cats.has(x));
  const lists = [["specificEvents", false, false], ["musicEvents", true, false], ["poetryEvents", false, true]];
  lists.forEach(([list, fm, fp]) => (ed[list] || []).forEach((e) => {
    const d = parseDateString(e.date);
    if (!d || !e.venue_id || e.online || e.cancelled || e.isCancelled) return;
    const ids = idsOf(e);
    const explicit = ids.find((id) => perfIds.has(id));
    const cls = classesFor(ids, fm || e.isMusic, fp || e.isPoetry);
    if (!explicit && !wanted(cls)) return;
    out.push({ vid: e.venue_id, date: d, pid: explicit || ids[0] || null, club: e.club || null });
  }));
  Object.entries(ed.tours || {}).forEach(([tid, t]) => {
    const ids = idsOf(t);
    const explicit = ids.find((id) => perfIds.has(id));
    const cls = classesFor(ids, t.isMusic, t.isPoetry);
    if (!explicit && !tourIds.has(tid) && !wanted(cls)) return;
    (t.tour_dates || []).forEach((td) => {
      const d = parseDateString(td.date);
      if (d && td.venue_id && !td.cancelled && !td.isCancelled) out.push({ vid: td.venue_id, date: d, pid: explicit || t.performer_id || tid, club: null });
    });
  });
  return out;
}

/** Aggregate evidence into pool rows. A gig at a story club (the event has a
 *  `club` that exists, has a schedule and a real venue) becomes a CLUB row —
 *  usable only on that club's real scheduled dates. Everything else is a
 *  VENUE row — usable on the weekdays the artists have played it. */
function buildPool() {
  const perfIds = new Set(PLANNER.pickPerf);
  const tourIds = new Set(PLANNER.pickTour);
  const clubs = new Map((PLANNER.eventsData.clubs || []).filter((c) => c.club && c.schedule).map((c) => [c.club, c]));
  const rows = new Map();
  const rowFor = (g) => {
    const rec = g.club ? clubs.get(g.club) : null;
    // A club's one-off special (different venue or off-schedule date) is just
    // a gig at a venue; only a gig on the club's own scheduled night counts
    // as a club night.
    const isClubNight = rec && resolveClubVenueId(rec, g.date) === g.vid &&
      RecurrenceEngine.scheduledOccurrencesInRange(rec.schedule, g.date, g.date, rec.exceptions || [])
        .some((o) => o.status === "scheduled" || o.status === "moved_to");
    if (isClubNight && isRealPlace({ venue_id: resolveClubVenueId(rec, null) })) {
      const key = "c:" + g.club;
      if (!rows.has(key)) rows.set(key, { key, kind: "club", club: g.club, rec, vid: resolveClubVenueId(rec, null), count: 0, wd: new Array(7).fill(0), artists: new Set(), on: true });
      return rows.get(key);
    }
    if (!isRealPlace({ venue_id: g.vid })) return null;
    const key = "v:" + g.vid;
    if (!rows.has(key)) rows.set(key, { key, kind: "venue", vid: g.vid, count: 0, wd: new Array(7).fill(0), artists: new Set(), on: true });
    return rows.get(key);
  };
  const cats = new Set(["storyteller", "musician", "poet"].filter((c) => document.getElementById("poolAll_" + c).checked));
  poolEvidence(perfIds, tourIds, cats).forEach((g) => {
    const r = rowFor(g);
    if (!r) return;
    r.count++; r.wd[g.date.getDay()]++;
    const pn = (PLANNER.eventsData.performers || {})[g.pid];
    r.artists.add(pn ? pn.name : g.pid || "(unlisted performer)");
  });
  if (document.getElementById("poolAllClubs").checked) {
    clubs.forEach((rec, id) => {
      if (rows.has("c:" + id) || !isRealPlace({ venue_id: resolveClubVenueId(rec, null) })) return;
      rows.set("c:" + id, { key: "c:" + id, kind: "club", club: id, rec, vid: resolveClubVenueId(rec, null), count: 0, wd: new Array(7).fill(0), artists: new Set(), on: true });
    });
  }
  const prev = new Map((PLANNER.pool || []).map((r) => [r.key, r.on]));
  PLANNER.pool = [...rows.values()].map((r) => ({ ...r, on: prev.has(r.key) ? prev.get(r.key) : true }))
    .sort((a, b) => b.count - a.count || (a.kind === "club" ? -1 : 1));
  return PLANNER.pool;
}
function wdLabel(r) {
  return r.wd.map((n, i) => (n ? `${WD[i]}×${n}` : "")).filter(Boolean).join(" ");
}
function renderPoolList() {
  const box = document.getElementById("poolList");
  box.replaceChildren();
  const pool = PLANNER.pool || [];
  if (!pool.length) {
    box.appendChild(el("p", "ts-hint", "No venues found — choose at least one artist or tour (their gigs need a venue)."));
    return;
  }
  const on = pool.filter((r) => r.on).length;
  box.appendChild(el("p", "ts-hint", `${pool.length} venues in the pool (${on} included). Untick any you don't want.`));
  const ul = el("div", "pool-list");
  pool.forEach((r) => {
    const v = PLANNER.venues[r.vid];
    const lab = el("label", "pool-item");
    const cb = el("input"); cb.type = "checkbox"; cb.checked = r.on;
    cb.addEventListener("change", () => { r.on = cb.checked; });
    const who = r.artists.size ? ` (${[...r.artists].slice(0, 3).join(", ")}${r.artists.size > 3 ? "…" : ""})` : "";
    const what = r.kind === "club"
      ? `🎙 ${r.rec.name} — ${typeof r.rec.schedule === "string" ? r.rec.schedule : "club night"}${v.city ? ", " + v.city : ""}`
      : `${v.name}${v.city ? ", " + v.city : ""} — ${wdLabel(r)}`;
    lab.append(cb, " " + what + who);
    ul.appendChild(lab);
  });
  box.appendChild(ul);
}
/** Search-and-add picker: type to filter, click a result to add it as a chip
 *  (click the chip's × to remove). `picked` is a Set kept in PLANNER. */
function makePicker(prefix, items, picked) {
  const input = document.getElementById(`${prefix}Filter`);
  const results = document.getElementById(`${prefix}Results`);
  const chips = document.getElementById(`${prefix}Chips`);
  const label = new Map(items.map((i) => [i.id, i.label]));
  const drawChips = () => {
    chips.replaceChildren();
    [...picked].forEach((id) => {
      const c = el("span", "picker-chip", label.get(id) || id);
      const x = el("button", "picker-chip-x", "×");
      x.type = "button";
      x.setAttribute("aria-label", `Remove ${label.get(id) || id}`);
      x.addEventListener("click", () => { picked.delete(id); drawChips(); drawResults(); });
      c.appendChild(x);
      chips.appendChild(c);
    });
  };
  const drawResults = () => {
    const q = input.value.trim().toLowerCase();
    results.replaceChildren();
    if (!q) { results.hidden = true; return; }
    const hits = items.filter((i) => i.label.toLowerCase().includes(q)).slice(0, 30);
    results.hidden = false;
    if (!hits.length) { results.appendChild(el("div", "picker-none", "No matches")); return; }
    hits.forEach((i) => {
      const b = el("button", "picker-result" + (picked.has(i.id) ? " picked" : ""), (picked.has(i.id) ? "✓ " : "+ ") + i.label);
      b.type = "button";
      b.addEventListener("click", () => {
        if (picked.has(i.id)) picked.delete(i.id); else picked.add(i.id);
        drawChips(); drawResults(); input.focus();
      });
      results.appendChild(b);
    });
  };
  input.addEventListener("input", drawResults);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { input.value = ""; drawResults(); }
    if (e.key === "Enter") { e.preventDefault(); const first = results.querySelector("button:not(.picked)"); if (first) first.click(); }
  });
  drawChips();
}

function fillPoolSelectors() {
  const ed = PLANNER.eventsData;
  PLANNER.pickPerf = new Set();
  PLANNER.pickTour = new Set();
  const perfs = new Map();
  const note = (pid) => { if (pid && (ed.performers || {})[pid]) perfs.set(pid, ed.performers[pid].name || pid); };
  const noteAll = (e) => { note(e.performer_id); asIdList(e.performer_ids).forEach(note); };
  ["specificEvents", "musicEvents", "poetryEvents"].forEach((l) => (ed[l] || []).forEach((e) => { if (e.venue_id) noteAll(e); }));
  Object.values(ed.tours || {}).forEach((t) => { if ((t.tour_dates || []).length) noteAll(t); });
  makePicker("poolPerf",
    [...perfs.entries()].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label)),
    PLANNER.pickPerf);
  makePicker("poolTour",
    Object.entries(ed.tours || {})
      .filter(([, t]) => (t.tour_dates || []).length)
      .map(([id, t]) => ({ id, label: `${t.isMusic ? "♪ " : ""}${t.tour_name || t.name || id}` }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    PLANNER.pickTour);
  document.getElementById("poolPreview").addEventListener("click", () => { buildPool(); renderPoolList(); });
}

/** Cheapest set of exactly G gigs (one per day, any gaps up to MAXGAP days)
 *  through the day columns, from home and back. Falls back to relaxed hop
 *  limits, then fewer gigs, and reports what it achieved. */
/** Straight-line miles between two gigs' venues. */
function crowMiles(a, b) {
  return TourSupport.crowMiles(latlonOf(a), latlonOf(b));
}
/** First stop (on a different day) within `miles` of gig c, or null. */
function nearStop(c, stops, miles) {
  if (!(miles > 0)) return null;
  return stops.find((s) => dkey(s.date) !== dkey(c.date) && crowMiles(s, c) < miles) || null;
}

function bestKRoute(G, relax, relaxSpread) {
  return PLANNER.distinct || PLANNER.minSpread > 0 ? beamKRoute(G, relax, relaxSpread) : exactKRoute(G, relax);
}

/** Same objective as exactKRoute but never revisits a venue. The "visited"
 *  set breaks the simple DP, so this is a beam search (keeps the cheapest
 *  few hundred partial tours per step) — near-optimal, not guaranteed. */
function beamKRoute(G, relax, relaxSpread) {
  const h = homeLL();
  const days = PLANNER.days.map((d) => ({ d, nodes: PLANNER.byDay.get(dkey(d)) || [] }));
  const MAXGAP = 4, BEAM = 400, PER_NODE = 8;
  const venueKey = (n) => n.venue_id;
  let layer = [];
  days.forEach((s, i) => s.nodes.forEach((n, j) => {
    layer.push({ i, j, cost: h ? roadMiles(h, latlonOf(n)) : 0, stops: [n], seen: new Set([venueKey(n)]) });
  }));
  const prune = (states) => {
    const per = new Map();
    states.sort((a, b) => a.cost - b.cost);
    const out = [];
    for (const st of states) {
      const k = st.i + ":" + st.j;
      const c = per.get(k) || 0;
      if (c >= PER_NODE) continue;
      per.set(k, c + 1);
      out.push(st);
      if (out.length >= BEAM) break;
    }
    return out;
  };
  const finish = (st) => st.cost + (h ? roadMiles(latlonOf(st.stops[st.stops.length - 1]), h) : 0);
  const layers = [prune(layer)];
  for (let g = 2; g <= G; g++) {
    const next = [];
    layers[g - 2].forEach((st) => {
      for (let i2 = st.i + 1; i2 <= Math.min(days.length - 1, st.i + MAXGAP); i2++) {
        const gap = i2 - st.i;
        const from = st.stops[st.stops.length - 1];
        days[i2].nodes.forEach((n, j) => {
          if (PLANNER.distinct && st.seen.has(venueKey(n))) return;
          if (!relaxSpread && nearStop(n, st.stops, PLANNER.minSpread)) return;
          const leg = roadMiles(latlonOf(from), latlonOf(n));
          if (!relax && leg > PLANNER.maxHop * gap) return;
          next.push({ i: i2, j, cost: st.cost + leg, stops: [...st.stops, n], seen: new Set([...st.seen, venueKey(n)]) });
        });
      }
    });
    if (!next.length) break;
    layers.push(prune(next));
  }
  for (let g = layers.length; g >= 1; g--) {
    const best = layers[g - 1].reduce((b, st) => (!b || finish(st) < finish(b) ? st : b), null);
    if (best) return { stops: best.stops, miles: finish(best), relaxed: !!relax, spreadRelaxed: !!relaxSpread, achieved: g, wanted: G };
  }
  if (!relax) return beamKRoute(G, true, relaxSpread);
  return !relaxSpread && PLANNER.minSpread > 0 ? beamKRoute(G, true, true) : null;
}

function exactKRoute(G, relax) {
  const h = homeLL();
  const days = PLANNER.days.map((d) => ({ d, nodes: PLANNER.byDay.get(dkey(d)) || [] }));
  const MAXGAP = 4;
  const INF = Infinity;
  // dp[i][j][g]: min miles ending at node j of day i having played g gigs
  const dp = days.map((s) => s.nodes.map(() => new Array(G + 1).fill(INF)));
  const from = days.map((s) => s.nodes.map(() => new Array(G + 1).fill(null)));
  days.forEach((s, i) => s.nodes.forEach((n, j) => {
    dp[i][j][1] = h ? roadMiles(h, latlonOf(n)) : 0;
    for (let i2 = Math.max(0, i - MAXGAP); i2 < i; i2++) {
      const gap = i - i2;
      days[i2].nodes.forEach((m, k) => {
        const leg = roadMiles(latlonOf(m), latlonOf(n));
        if (!relax && leg > PLANNER.maxHop * gap) return;
        for (let g = 2; g <= G; g++) {
          const c = dp[i2][k][g - 1] + leg;
          if (c < dp[i][j][g]) { dp[i][j][g] = c; from[i][j][g] = [i2, k]; }
        }
      });
    }
  }));
  for (let g = G; g >= 1; g--) {
    let best = INF, bi = -1, bj = -1;
    days.forEach((s, i) => s.nodes.forEach((n, j) => {
      const c = dp[i][j][g] + (h ? roadMiles(latlonOf(n), h) : 0);
      if (c < best) { best = c; bi = i; bj = j; }
    }));
    if (bi < 0) continue;
    const stops = [];
    for (let i = bi, j = bj, gg = g; gg >= 1; gg--) {
      stops.unshift(days[i].nodes[j]);
      if (gg > 1) [i, j] = from[i][j][gg];
    }
    return { stops, miles: best, relaxed: !!relax, achieved: g, wanted: G };
  }
  return relax ? null : exactKRoute(G, true);
}

// ── build + render ──────────────────────────────────────────────────────
function isRealPlace(c) {
  return TourSupport.venueUsable(PLANNER.venues, c.venue_id);
}
function homeLL() {
  return PLANNER.start ? [PLANNER.start.lat, PLANNER.start.lon] : null;
}

function onBuild() {
  const mode = currentMode();
  const clamp = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  PLANNER.maxHop = clamp(document.getElementById("maxHop").value, 5, 500, 60);
  PLANNER.maxHome = clamp(document.getElementById("maxHome").value, 0, 1000, 0);
  PLANNER.minSpread = clamp(document.getElementById("minSpread").value, 0, 200, 0);
  PLANNER.includeOther = document.getElementById("includeOther").checked;
  PLANNER.mode = mode;
  PLANNER.anchor = null;
  PLANNER.days = [];
  const today = getTodayMidnight();

  if (mode === "period" || mode === "pool") {
    const parseIn = (id) => { const v = document.getElementById(id).value; if (!v) return null; const [y, m, d] = v.split("-").map(Number); return new Date(y, m - 1, d); };
    let from = parseIn("periodStart");
    let to = parseIn("periodEnd");
    if (!from || !to) return setStatus("Choose a start and end date for the period.", true);
    if (from < today) from = today;
    if (to < from) return setStatus("The end date is before the start date.", true);
    const span = Math.round((to - from) / 86400000);
    if (span > 20) { to = addDays(from, 20); setStatus("Period limited to 21 days."); }
    for (let d = from; d <= to; d = addDays(d, 1)) PLANNER.days.push(d);
    PLANNER.radius = clamp(document.getElementById("areaRadius").value, 5, 500, 60);
  } else {
    let anchorDate, anchor;
    if (mode === "club") {
      const row = PLANNER._anchorRows[Number(document.getElementById("anchorClub").value)];
      const dsel = document.getElementById("anchorDate").value;
      if (!row || !dsel) return setStatus("Pick a club and date first.", true);
      anchorDate = parseDateString(dsel.split("-").reverse().join("/"));
      anchor = {
        id: `anchor:${row.rec.club}:${dsel}`, kind: "club", name: row.rec.name, date: anchorDate,
        time: row.rec.time || "", venue_id: resolveClubVenueId(row.rec, anchorDate),
        link: row.rec.link || row.rec.facebook || "", clubId: row.rec.club || null, isAnchor: true,
      };
    } else {
      const row = (PLANNER._venueRows || [])[Number(document.getElementById("anchorVenue").value)];
      const c = row && row.cands[Number(document.getElementById("anchorDate").value)];
      if (!c) return setStatus("Pick a venue and gig first.", true);
      anchorDate = c.date;
      anchor = { ...c, id: "anchor:" + c.id, isAnchor: true };
    }
    PLANNER.anchor = anchor;
    PLANNER.before = clamp(document.getElementById("daysBefore").value, 0, 14, 3);
    PLANNER.after = clamp(document.getElementById("daysAfter").value, 0, 14, 3);
    for (let i = -PLANNER.before; i <= PLANNER.after; i++) PLANNER.days.push(addDays(anchorDate, i));
  }

  const raw = gatherCandidates(
    PLANNER.days[0] < today ? today : PLANNER.days[0],
    PLANNER.days[PLANNER.days.length - 1],
    mode === "pool" ? true : PLANNER.includeOther,
  );
  const h = homeLL();
  if (mode === "pool") {
    buildPool();
    renderPoolList();
    PLANNER.gigsWanted = clamp(document.getElementById("gigsWanted").value, 1, 14, 5);
    PLANNER.distinct = document.getElementById("poolDistinct").checked;
    const weekdayOnly = document.getElementById("poolWeekday").checked;
    const centre0 = PLANNER.area ? [PLANNER.area.lat, PLANNER.area.lon] : h;
    const pool = (PLANNER.pool || []).filter((r) => r.on);
    if (!pool.length) return setStatus("The venue pool is empty — choose artists or tours first.", true);
    PLANNER.byDay = new Map();
    PLANNER.days.forEach((d) => {
      const k = dkey(d);
      const clashes = new Map();
      (raw.get(k) || []).forEach((c) => { if (!clashes.has(c.venue_id)) clashes.set(c.venue_id, c.name); });
      const clubNodes = pool.filter((r) => r.kind === "club").flatMap((r) =>
        (raw.get(k) || []).filter((c) => c.kind === "club" && c.clubId === r.club && isRealPlace(c)).map((c) => ({
          ...c, id: `pool:club:${r.club}:${k}`,
          note: "club night" + (r.count ? ` · hosted ${[...r.artists].slice(0, 2).join(", ")}` : ""),
        })));
      let nodes = pool
        .filter((r) => r.kind === "venue")
        .filter((r) => !weekdayOnly || r.wd[d.getDay()] > 0)
        .map((r) => {
          const v = PLANNER.venues[r.vid];
          const clash = clashes.get(r.vid);
          return {
            id: `pool:${r.vid}:${k}`, kind: "venue", name: v.name, date: d, time: "", venue_id: r.vid,
            link: v.url || "", clubId: null,
            note: `${v.venue_type && !/unknown/i.test(v.venue_type) ? v.venue_type + " · " : ""}${WD[d.getDay()]}×${r.wd[d.getDay()]} of ${r.count}${clash ? " · ⚠ also on: " + clash : ""}`,
          };
        })
        .concat(clubNodes)
        .filter((c) => !PLANNER.maxHome || !h || roadMiles(h, latlonOf(c)) <= PLANNER.maxHome);
      if (centre0) nodes = nodes.filter((c) => roadMiles(centre0, latlonOf(c)) <= PLANNER.radius);
      nodes.sort((x, y) => (centre0 ? roadMiles(centre0, latlonOf(x)) - roadMiles(centre0, latlonOf(y)) : 0));
      PLANNER.byDay.set(k, nodes);
    });
    PLANNER.chosen = new Map();
    PLANNER.hover = null;
    setStatus("");
    renderAll();
    return;
  }
  const centre = PLANNER.area ? [PLANNER.area.lat, PLANNER.area.lon] : h;
  const aLL = PLANNER.anchor ? latlonOf(PLANNER.anchor) : null;
  PLANNER.byDay = new Map();
  PLANNER.days.forEach((d) => {
    const k = dkey(d);
    if (PLANNER.anchor && k === dkey(PLANNER.anchor.date)) { PLANNER.byDay.set(k, [PLANNER.anchor]); return; }
    let nodes = (raw.get(k) || [])
      .filter(isRealPlace)
      .filter((c) => !PLANNER.maxHome || !h || roadMiles(h, latlonOf(c)) <= PLANNER.maxHome);
    if (PLANNER.anchor) {
      // reachable from the anchor at all: maxHop x days away
      const steps = Math.abs(Math.round((d - PLANNER.anchor.date) / 86400000));
      nodes = nodes.filter((c) => roadMiles(aLL, latlonOf(c)) <= PLANNER.maxHop * steps)
        .sort((x, y) => roadMiles(aLL, latlonOf(x)) - roadMiles(aLL, latlonOf(y)));
    } else if (centre) {
      nodes = nodes.filter((c) => roadMiles(centre, latlonOf(c)) <= PLANNER.radius)
        .sort((x, y) => roadMiles(centre, latlonOf(x)) - roadMiles(centre, latlonOf(y)));
    }
    PLANNER.byDay.set(k, nodes);
  });
  PLANNER.chosen = PLANNER.anchor ? new Map([[dkey(PLANNER.anchor.date), PLANNER.anchor]]) : new Map();
  PLANNER.hover = null;
  if (!PLANNER.anchor && !centre) setStatus("Tip: set a start point or an area centre to keep a period search local.");
  else if (mode !== "period" || span20ok()) setStatus("");
  renderAll();
}
function span20ok() { return !/limited to 21/.test(document.getElementById("plannerStatus").textContent); }

// ── shortest route (dynamic programming over the day columns) ───────────
/** Cheapest chain through every non-empty day, via the anchor, optionally
 *  starting/ending at home. Consecutive stops must be <= maxHop x gap-days
 *  apart. Returns {stops, miles, relaxed} or null. */
function shortestRoute(relax, relaxSpread) {
  if (PLANNER.minSpread > 0 && !relaxSpread) return beamEveryDay(!!relax);
  const h = homeLL();
  const stages = PLANNER.days
    .map((d) => ({ d, nodes: PLANNER.byDay.get(dkey(d)) || [] }))
    .filter((s) => s.nodes.length);
  if (!stages.length) return null;
  const INF = Infinity;
  const cost = stages.map((s) => s.nodes.map(() => INF));
  const prev = stages.map((s) => s.nodes.map(() => -1));
  stages[0].nodes.forEach((n, j) => { cost[0][j] = h ? roadMiles(h, latlonOf(n)) : 0; });
  for (let i = 1; i < stages.length; i++) {
    const gap = Math.round((stages[i].d - stages[i - 1].d) / 86400000);
    stages[i].nodes.forEach((n, j) => {
      stages[i - 1].nodes.forEach((m, k) => {
        if (cost[i - 1][k] === INF) return;
        const leg = roadMiles(latlonOf(m), latlonOf(n));
        if (!relax && leg > PLANNER.maxHop * gap) return;
        const c = cost[i - 1][k] + leg;
        if (c < cost[i][j]) { cost[i][j] = c; prev[i][j] = k; }
      });
    });
  }
  const last = stages.length - 1;
  let bestJ = -1, best = INF;
  stages[last].nodes.forEach((n, j) => {
    if (cost[last][j] === INF) return;
    const c = cost[last][j] + (h ? roadMiles(latlonOf(n), h) : 0);
    if (c < best) { best = c; bestJ = j; }
  });
  if (bestJ < 0) return relax ? null : shortestRoute(true, relaxSpread);
  const stops = [];
  for (let i = last, j = bestJ; i >= 0; i--) { stops.unshift(stages[i].nodes[j]); j = prev[i][j]; }
  return { stops, miles: best, relaxed: !!relax };
}

/** Fill-every-day route honouring the minimum spread (beam search; the
 *  exact DP can't track which places are already on the tour). */
function beamEveryDay(relax) {
  const h = homeLL();
  const stages = PLANNER.days
    .map((d) => ({ d, nodes: PLANNER.byDay.get(dkey(d)) || [] }))
    .filter((x) => x.nodes.length);
  if (!stages.length) return null;
  const BEAM = 400, PER_NODE = 8;
  const finish = (st) => st.cost + (h ? roadMiles(latlonOf(st.stops[st.stops.length - 1]), h) : 0);
  const prune = (states) => {
    const per = new Map(); const out = [];
    states.sort((a, b) => a.cost - b.cost);
    for (const st of states) {
      const k = st.j; const c = per.get(k) || 0;
      if (c >= PER_NODE) continue;
      per.set(k, c + 1); out.push(st);
      if (out.length >= BEAM) break;
    }
    return out;
  };
  let layer = prune(stages[0].nodes.map((n, j) => ({ j, cost: h ? roadMiles(h, latlonOf(n)) : 0, stops: [n] })));
  for (let i = 1; i < stages.length && layer.length; i++) {
    const gap = Math.round((stages[i].d - stages[i - 1].d) / 86400000);
    const next = [];
    layer.forEach((st) => {
      const from = st.stops[st.stops.length - 1];
      stages[i].nodes.forEach((n, j) => {
        if (nearStop(n, st.stops, PLANNER.minSpread)) return;
        const leg = roadMiles(latlonOf(from), latlonOf(n));
        if (!relax && leg > PLANNER.maxHop * gap) return;
        next.push({ j, cost: st.cost + leg, stops: [...st.stops, n] });
      });
    });
    layer = prune(next);
  }
  const best = layer.reduce((b, st) => (st.stops.length === stages.length && (!b || finish(st) < finish(b)) ? st : b), null);
  if (best) return { stops: best.stops, miles: finish(best), relaxed: !!relax };
  if (!relax) return beamEveryDay(true);
  const fallback = shortestRoute(false, true); // spread can't be met: drop it
  return fallback ? { ...fallback, spreadRelaxed: true } : null;
}

function routeMiles(stops) {
  const h = homeLL();
  let total = 0, p = h;
  stops.forEach((c) => { const ll = latlonOf(c); const leg = roadMiles(p, ll); if (leg != null) total += leg; p = ll; });
  if (h) total += roadMiles(p, h) || 0;
  return total;
}

// ── graph rendering ─────────────────────────────────────────────────────
let nodeEls = new Map(); // node id -> element

function renderAll() {
  const wrap = document.getElementById("plannerResults");
  wrap.replaceChildren();
  nodeEls = new Map();
  if (!PLANNER.days.length) return;
  PLANNER.best = PLANNER.mode === "pool" ? bestKRoute(PLANNER.gigsWanted, false, false) : shortestRoute(false, false);

  const bar = el("div", "ts-panel planner-bar");
  const bestBtn = el("button", "btn-primary", "⚡ Use shortest route");
  bestBtn.type = "button";
  bestBtn.disabled = !PLANNER.best;
  bestBtn.addEventListener("click", () => {
    PLANNER.chosen = new Map();
    PLANNER.best.stops.forEach((c) => PLANNER.chosen.set(dkey(c.date), c));
    renderAll();
  });
  const clearBtn = el("button", "btn-secondary", PLANNER.anchor ? "Reset to anchor only" : "Clear choices");
  clearBtn.type = "button";
  clearBtn.addEventListener("click", () => { PLANNER.chosen = PLANNER.anchor ? new Map([[dkey(PLANNER.anchor.date), PLANNER.anchor]]) : new Map(); renderAll(); });
  const allLbl = el("label", "planner-inline");
  const allCb = el("input"); allCb.type = "checkbox"; allCb.checked = !!PLANNER.showAll;
  allCb.addEventListener("change", () => { PLANNER.showAll = allCb.checked; drawEdges(); });
  allLbl.append(allCb, " show all links");
  const candLbl = el("label", "planner-inline");
  const candCb = el("input"); candCb.type = "checkbox"; candCb.checked = PLANNER.showCands !== false;
  candCb.addEventListener("change", () => { PLANNER.showCands = candCb.checked; renderMap(); });
  candLbl.append(candCb, " show other venues on map");
  bar.append(bestBtn, clearBtn, allLbl, candLbl);
  if (PLANNER.minSpread > 0) {
    const hideLbl = el("label", "planner-inline");
    const hideCb = el("input"); hideCb.type = "checkbox"; hideCb.checked = !!PLANNER.hideClose;
    hideCb.addEventListener("change", () => { PLANNER.hideClose = hideCb.checked; renderAll(); });
    hideLbl.append(hideCb, ` hide venues within ${PLANNER.minSpread} mi of a stop`);
    bar.appendChild(hideLbl);
  }
  if (PLANNER.best) {
    const isPool = PLANNER.mode === "pool";
    bar.appendChild(el("span", "ts-hint",
      (isPool ? `Shortest ${PLANNER.best.achieved}-gig route` : "Shortest route visiting a gig every possible day") +
      `: ${fmtMiles(PLANNER.best.miles)}${PLANNER.start ? " round trip" : ""}` +
      (isPool && PLANNER.best.achieved < PLANNER.best.wanted ? ` (only ${PLANNER.best.achieved} of ${PLANNER.best.wanted} gigs possible in this window)` : "") +
      (PLANNER.best.relaxed ? " (distance limits relaxed — no route fit them)" : "") +
      (PLANNER.best.spreadRelaxed ? ` (couldn't keep stops ${PLANNER.minSpread} mi apart in this window)` : "")));
  } else if (PLANNER.mode === "pool") {
    bar.appendChild(el("span", "ts-hint", "No venues in the pool fit those dates, weekdays and area — widen the window, radius or untick the weekday rule."));
  }
  if (!PLANNER.start) bar.appendChild(el("span", "ts-hint", "Set a start point to include the journey home."));
  wrap.appendChild(bar);

  const scroll = el("div", "graph-scroll");
  const inner = el("div", "graph-inner");
  inner.id = "graphInner";
  const colHome = (label, id) => {
    const col = el("div", "graph-col graph-home-col");
    col.appendChild(el("h4", null, label));
    const n = el("div", "graph-node home", PLANNER.start ? `⌂ ${PLANNER.start.label}` : "⌂ (no start set)");
    n.dataset.nid = id;
    nodeEls.set(id, n);
    col.appendChild(n);
    return col;
  };
  if (PLANNER.start) inner.appendChild(colHome("Start", "home-start"));

  PLANNER.days.forEach((date) => {
    const k = dkey(date);
    const nodes = PLANNER.byDay.get(k) || [];
    const col = el("div", "graph-col" + (nodes.length ? "" : " graph-col-rest"));
    col.appendChild(el("h4", null, nodes.length ? formatDate(date) : formatDate(date).replace(/ \d{4}$/, "")));
    if (!nodes.length) col.appendChild(el("div", "graph-none", "rest day"));
    let hiddenClose = 0;
    nodes.forEach((c) => {
      if (PLANNER.hideClose && !c.isAnchor) {
        const chosenNow = PLANNER.chosen.get(k);
        if (!(chosenNow && chosenNow.id === c.id) && nearStop(c, orderedStops(), PLANNER.minSpread)) { hiddenClose++; return; }
      }
      const v = venueOf(c) || {};
      const n = el("div", "graph-node" + (c.isAnchor ? " anchor" : ""));
      n.dataset.nid = c.id;
      n.appendChild(el("div", "graph-node-name", c.name));
      n.appendChild(el("div", "graph-node-meta", [c.time, v.city || v.name].filter(Boolean).join(" · ")));
      if (c.note) n.appendChild(el("div", "graph-node-note", c.note));
      const h = homeLL();
      if (h) n.appendChild(el("div", "graph-node-home", `${fmtMiles(roadMiles(h, latlonOf(c)))} from start`));
      if (c.link && /^https?:\/\//i.test(c.link)) {
        const a = el("a", "graph-node-link", "details ↗");
        a.href = c.link; a.target = "_blank"; a.rel = "noopener noreferrer";
        a.addEventListener("click", (e) => e.stopPropagation());
        n.appendChild(a);
      }
      const ch = PLANNER.chosen.get(k);
      if (ch && ch.id === c.id) n.classList.add("chosen");
      const near = !c.isAnchor && !(ch && ch.id === c.id) ? nearStop(c, orderedStops(), PLANNER.minSpread) : null;
      if (near) {
        n.classList.add("too-close");
        n.appendChild(el("div", "graph-node-note", `⛔ within ${PLANNER.minSpread} mi of ${near.name}`));
      }
      if (PLANNER.best && PLANNER.best.stops.some((s) => s.id === c.id)) n.classList.add("on-best");
      if (!c.isAnchor && !near) {
        n.tabIndex = 0;
        n.setAttribute("role", "button");
        const toggle = () => toggleNode(c);
        n.addEventListener("click", toggle);
        n.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
      }
      n.addEventListener("mouseenter", () => { PLANNER.hover = c.id; drawEdges(); });
      n.addEventListener("mouseleave", () => { PLANNER.hover = null; drawEdges(); });
      nodeEls.set(c.id, n);
      col.appendChild(n);
    });
    if (hiddenClose) col.appendChild(el("div", "graph-none", `${hiddenClose} hidden — within ${PLANNER.minSpread} mi of a stop`));
    inner.appendChild(col);
  });
  if (PLANNER.start) inner.appendChild(colHome("Return", "home-end"));

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "graph-edges");
  svg.id = "graphEdges";
  inner.appendChild(svg);
  scroll.appendChild(inner);
  wrap.appendChild(scroll);
  wrap.appendChild(el("p", "ts-hint",
    "Click a gig to add it to your tour (click again to remove). Lines show estimated road miles to the neighbouring days' options; hover a gig to see its links."));
  renderItinerary();
  renderMap();
  requestAnimationFrame(drawEdges);
}

function drawEdges() {
  const svg = document.getElementById("graphEdges");
  const inner = document.getElementById("graphInner");
  if (!svg || !inner) return;
  svg.replaceChildren();
  const ir = inner.getBoundingClientRect();
  svg.setAttribute("width", inner.scrollWidth);
  svg.setAttribute("height", inner.scrollHeight);
  const NS = "http://www.w3.org/2000/svg";
  const pt = (id, side) => {
    const e = nodeEls.get(id);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: (side === "r" ? r.right : r.left) - ir.left, y: r.top + r.height / 2 - ir.top };
  };
  const chosenIds = new Set([...PLANNER.chosen.values()].map((c) => c.id));
  const bestIds = new Set(PLANNER.best ? PLANNER.best.stops.map((c) => c.id) : []);
  const bestPairs = new Set();
  if (PLANNER.best) for (let i = 1; i < PLANNER.best.stops.length; i++) bestPairs.add(PLANNER.best.stops[i - 1].id + ">" + PLANNER.best.stops[i].id);

  const edge = (aId, bId, miles, cls, label, key) => {
    const p1 = pt(aId, "r"), p2 = pt(bId, "l");
    if (!p1 || !p2) return;
    const dx = Math.max(20, (p2.x - p1.x) / 2);
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", `M${p1.x},${p1.y} C${p1.x + dx},${p1.y} ${p2.x - dx},${p2.y} ${p2.x},${p2.y}`);
    path.setAttribute("class", "graph-edge " + cls);
    path.dataset.k = key || aId + ">" + bId;
    svg.appendChild(path);
    if (label) {
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", (p1.x + p2.x) / 2);
      t.setAttribute("y", (p1.y + p2.y) / 2 - 3);
      t.setAttribute("class", "graph-edge-label " + cls);
      t.setAttribute("text-anchor", "middle");
      t.textContent = fmtMiles(miles);
      svg.appendChild(t);
    }
  };

  const stages = PLANNER.days
    .map((d) => ({ d, nodes: PLANNER.byDay.get(dkey(d)) || [] }))
    .filter((s) => s.nodes.length);
  for (let i = 1; i < stages.length; i++) {
    const gap = Math.round((stages[i].d - stages[i - 1].d) / 86400000);
    stages[i - 1].nodes.forEach((m) => stages[i].nodes.forEach((n) => {
      const miles = roadMiles(latlonOf(m), latlonOf(n));
      if (miles > PLANNER.maxHop * gap) return;
      const bothChosen = chosenIds.has(m.id) && chosenIds.has(n.id);
      const touchesChosen = chosenIds.has(m.id) || chosenIds.has(n.id);
      const touchesHover = PLANNER.hover && (m.id === PLANNER.hover || n.id === PLANNER.hover);
      const isBest = bestPairs.has(m.id + ">" + n.id);
      if (!(PLANNER.showAll || touchesChosen || touchesHover || isBest)) return;
      const cls = bothChosen ? "path" : touchesHover ? "hover" : isBest ? "best" : touchesChosen ? "near" : "faint";
      edge(m.id, n.id, miles, cls, bothChosen || touchesHover || touchesChosen || isBest);
    }));
  }
  // path / best-route legs that skip a day (not between adjacent columns)
  const drawnKeys = new Set(
    [...svg.querySelectorAll("path")].map((p) => p.dataset.k).filter(Boolean),
  );
  const extra = (list, cls) => {
    for (let i = 1; i < list.length; i++) {
      const key = list[i - 1].id + ">" + list[i].id;
      if (drawnKeys.has(key)) continue;
      drawnKeys.add(key);
      edge(list[i - 1].id, list[i].id, roadMiles(latlonOf(list[i - 1]), latlonOf(list[i])), cls, true, key);
    }
  };
  extra(orderedStops(), "path");
  if (PLANNER.best) extra(PLANNER.best.stops, "best");
  // home legs
  const h = homeLL();
  const stops = orderedStops();
  if (h && stops.length && nodeEls.get("home-start")) {
    edge("home-start", stops[0].id, roadMiles(h, latlonOf(stops[0])), "home", true);
    const l = stops[stops.length - 1];
    edge(l.id, "home-end", roadMiles(latlonOf(l), h), "home", true);
  }
}
window.addEventListener("resize", () => { try { drawEdges(); } catch (e) { /* ignore */ } });

/** "Name, venue, city" without repeating a city (or venue) already named. */
function placeParts(c, v) {
  const parts = [c.name];
  [c.kind === "venue" ? null : v.name, v.city].forEach((x) => {
    if (x && !parts.some((p) => p.toLowerCase().includes(String(x).toLowerCase()))) parts.push(x);
  });
  return parts;
}

function orderedStops() {
  return PLANNER.days.map((d) => PLANNER.chosen.get(dkey(d))).filter(Boolean);
}

function renderItinerary() {
  const box = document.getElementById("plannerItinerary");
  box.replaceChildren();
  if (!PLANNER.days.length) return;
  const stops = orderedStops();
  if (stops.length < 1) {
    box.appendChild(el("h3", null, "Your tour"));
    box.appendChild(el("p", "ts-hint", "No stops yet — click gigs in the columns below, or press “Use shortest route”."));
    return;
  }
  const home = homeLL();
  const lines = [];
  let prev = home;
  stops.forEach((c) => {
    const ll = latlonOf(c);
    const leg = roadMiles(prev, ll);
    const v = venueOf(c) || {};
    lines.push(`${formatDate(c.date)}${c.time ? ", " + c.time : ""} — ${placeParts(c, v).join(", ")}` +
      (leg != null ? `  [${fmtMiles(leg)}, ${fmtDrive(leg)}]` : ""));
    prev = ll;
  });
  box.appendChild(el("h3", null, "Your tour"));
  const ol = el("ol", "ts-list");
  lines.forEach((t) => ol.appendChild(el("li", null, t)));
  box.appendChild(ol);
  const total = routeMiles(stops);
  let msg = `Total${home ? ` incl. journey from and back to ${PLANNER.start.label}` : ""}: ${fmtMiles(total)} (${fmtDrive(total)} driving).`;
  if (PLANNER.best && stops.length > 1) {
    const diff = total - PLANNER.best.miles;
    msg += diff > 1 ? ` The shortest all-days route is ${fmtMiles(PLANNER.best.miles)} (${fmtMiles(diff)} less).` : " That matches the shortest route.";
  }
  box.appendChild(el("p", "ts-total", msg + " Estimates are straight-line x " + ROAD_FACTOR + " — check a route planner."));
  const copy = el("button", "btn-secondary", "📋 Copy itinerary");
  copy.type = "button";
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(lines.join("\n")); copy.textContent = "Copied ✓"; }
    catch (e) { copy.textContent = "Copy failed"; }
  });
  box.appendChild(copy);
}

// ── map ─────────────────────────────────────────────────────────────────
/** Label for a day relative to the anchor ("+1", "−2") or, with no anchor,
 *  to the first day of the period ("d3"). */
function dayLabel(date) {
  if (PLANNER.anchor) {
    const n = Math.round((date - PLANNER.anchor.date) / 86400000);
    return n === 0 ? "0" : n > 0 ? `+${n}` : `−${Math.abs(n)}`;
  }
  return `d${Math.round((date - PLANNER.days[0]) / 86400000) + 1}`;
}

/** Add/remove a gig from the tour (same rule as clicking it in the graph). */
function toggleNode(c) {
  const k = dkey(c.date);
  const cur = PLANNER.chosen.get(k);
  if (cur && cur.id === c.id) PLANNER.chosen.delete(k); else PLANNER.chosen.set(k, c);
  renderAll();
}

/** Popup for a venue marker: every gig on offer there, with add/remove buttons. */
function venuePopup(vid, nodes) {
  const v = PLANNER.venues[vid] || {};
  const box = el("div", "map-popup");
  box.appendChild(el("strong", null, TourSupport.placeLabel(v) || vid));
  [...nodes].sort((a, b) => a.date - b.date).forEach((c) => {
    const row = el("div", "map-popup-row");
    row.appendChild(el("span", "map-popup-day", dayLabel(c.date)));
    row.appendChild(el("span", null, ` ${formatDate(c.date)}${c.time ? ", " + c.time : ""} — ${c.name}`));
    if (!c.isAnchor) {
      const ch = PLANNER.chosen.get(dkey(c.date));
      const on = ch && ch.id === c.id;
      const near = !on ? nearStop(c, orderedStops(), PLANNER.minSpread) : null;
      const b = el("button", "map-popup-btn", on ? "Remove" : near ? `⛔ within ${PLANNER.minSpread} mi of ${near.name}` : "Add to tour");
      b.type = "button";
      b.disabled = !!near;
      b.addEventListener("click", () => toggleNode(c));
      row.appendChild(b);
    }
    box.appendChild(row);
  });
  return box;
}

async function renderMap() {
  const cont = document.getElementById("plannerMapWrap");
  if (!PLANNER.days.length) { cont.style.display = "none"; return; }
  cont.style.display = "";
  try {
    await loadLeaflet();
  } catch (e) { cont.style.display = "none"; return; }
  if (!plannerMap) plannerMap = initMap("plannerMap");
  plannerMap.invalidateSize();
  if (plannerMapLayer) plannerMapLayer.remove();
  plannerMapLayer = L.layerGroup().addTo(plannerMap);
  const stops = orderedStops();
  const chosenIds = new Set(stops.map((c) => c.id));
  const pts = [];

  // Other possible venues: one grey marker per venue, labelled with the day
  // offset(s) it has a gig on. Click for the list of gigs and add/remove.
  const venuesWithStop = new Set(stops.map((c) => c.venue_id));
  const candPts = [];
  if (PLANNER.showCands) {
    const byVenue = new Map();
    PLANNER.days.forEach((d) => (PLANNER.byDay.get(dkey(d)) || []).forEach((c) => {
      if (!byVenue.has(c.venue_id)) byVenue.set(c.venue_id, []);
      byVenue.get(c.venue_id).push(c);
    }));
    byVenue.forEach((nodes0, vid) => {
      if (venuesWithStop.has(vid)) return; // shown as a numbered stop below
      const nodes = PLANNER.hideClose ? nodes0.filter((c) => !nearStop(c, stops, PLANNER.minSpread)) : nodes0;
      if (!nodes.length) return;
      const ll = latlonOf(nodes[0]);
      candPts.push(ll);
      const labs = [...new Set([...nodes].sort((a, b) => a.date - b.date).map((c) => dayLabel(c.date)))];
      const text = labs.length > 3 ? labs.slice(0, 3).join(" ") + "…" : labs.join(" ");
      L.marker(ll, { icon: L.divIcon({ className: "ts-pin cand", html: text, iconSize: [40, 20], iconAnchor: [20, 10] }) })
        .bindTooltip(`${(PLANNER.venues[vid] || {}).name || vid} (${text})`)
        .bindPopup(venuePopup(vid, nodes))
        .addTo(plannerMapLayer);
    });
  }

  if (PLANNER.start) {
    const h = [PLANNER.start.lat, PLANNER.start.lon];
    pts.push(h);
    L.marker(h, { icon: L.divIcon({ className: "ts-pin home", html: "⌂", iconSize: [26, 26] }) })
      .bindTooltip(PLANNER.start.label).addTo(plannerMapLayer);
  }
  stops.forEach((c, i) => {
    const ll = latlonOf(c);
    pts.push(ll);
    const allHere = [];
    PLANNER.days.forEach((d) => (PLANNER.byDay.get(dkey(d)) || []).forEach((n) => { if (n.venue_id === c.venue_id) allHere.push(n); }));
    L.marker(ll, { icon: L.divIcon({ className: "ts-pin", html: String(i + 1), iconSize: [26, 26] }), zIndexOffset: 500 })
      .bindTooltip(`${i + 1}. ${c.name} — ${formatDate(c.date)}`)
      .bindPopup(venuePopup(c.venue_id, allHere.length ? allHere : [c]))
      .addTo(plannerMapLayer);
  });
  if (stops.length + (PLANNER.start ? 1 : 0) > 1) L.polyline(pts, { color: "#2e7d32", weight: 3, dashArray: "6 6" }).addTo(plannerMapLayer);
  const all = pts.concat(candPts);
  if (all.length) plannerMap.fitBounds(L.latLngBounds(all).pad(0.2), { maxZoom: 11 });
}

// ── init ────────────────────────────────────────────────────────────────
async function initPlanner() {
  const result = await loadEventsData();
  if (!result) { setStatus("Couldn't load events data.", true); return; }
  PLANNER.eventsData = result.eventsData;
  PLANNER.venues = result.venuesLookup || {};
  fillAnchorClubs();
  fillVenueFallback();
  fillPoolSelectors();
  const saved = loadStart();
  if (saved) {
    PLANNER.start = saved;
    document.getElementById("startCurrent").textContent = `Start: ${saved.label}`;
  }
  document.getElementById("startFind").addEventListener("click", onFindStart);
  document.getElementById("startInput").addEventListener("keydown", (e) => { if (e.key === "Enter") onFindStart(); });
  document.getElementById("startLocate").addEventListener("click", onUseLocation);
  document.getElementById("buildTour").addEventListener("click", onBuild);
  document.getElementById("plannerMode").addEventListener("change", setMode);
  document.getElementById("areaFind").addEventListener("click", () => findPlace("areaInput", "areaChoices", setArea));
  document.getElementById("areaInput").addEventListener("keydown", (e) => { if (e.key === "Enter") findPlace("areaInput", "areaChoices", setArea); });
  document.getElementById("areaClear").addEventListener("click", () => { setArea(null); document.getElementById("areaInput").value = ""; });
  const t0 = addDays(getTodayMidnight(), 1);
  document.getElementById("periodStart").value = dkey(t0);
  document.getElementById("periodEnd").value = dkey(addDays(t0, 6));
  setMode();
  document.getElementById("plannerLoading").style.display = "none";
  document.getElementById("plannerForm").style.display = "";
}
document.addEventListener("DOMContentLoaded", initPlanner);
