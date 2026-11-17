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
  showBest: true, // draw the suggested (orange) route
  showBestOnMap: false, // ...also as a line on the map
  reachMode: "grey", // venues out of range of the picks: show | grey | hide
  hideUsed: false, // hide venues already on the tour (when each venue is visited once)
  mapFollowsFilters: true, // map markers follow the column filters
  autoCollapse: false,
  mapDay: null, // day key being previewed on the tour map (null = whole tour)
  mapSides: true, // while previewing a day, also show the picks either side
  collapsed: new Set(), // day keys showing only their pick
  hideClose: false, // hide (rather than grey out) venues too close to a chosen stop
  eventsData: null,
  venues: {},
  start: null, // { lat, lon, label }
  anchor: null, // candidate object
  before: 3,
  after: 3,
  maxHop: 60, // road miles between consecutive stops
  maxHome: 0, // road miles from home; 0 = no limit
  minHop: 0, // min road miles between consecutive gigs (pool mode)
  maxFirst: Infinity, // max road miles start -> first gig (pool mode)
  maxLast: Infinity, // max road miles last gig -> end (pool mode)
  endSame: true, // finish where the tour started
  end: null, // { lat, lon, label } when the end differs from the start
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
const ALL_KINDS = { club: 1, storyEvent: 1, music: 1, poetry: 1, folk: 1, session: 1 };
/** Which kinds of event are ticked (non-pool modes). */
function selectedCats() {
  const on = (id) => { const c = document.getElementById(id); return !c || c.checked; };
  const o = {};
  if (on("catClub")) o.club = 1;
  if (on("catStoryEvent")) o.storyEvent = 1;
  if (on("catMusic")) o.music = 1;
  if (on("catPoetry")) o.poetry = 1;
  if (on("catFolk")) o.folk = 1;
  if (on("catSession")) o.session = 1;
  return o;
}
/** cats: true = every kind; false/undefined = story clubs only; or an object of kinds. */
function gatherCandidates(from, to, cats) {
  const C = cats === true ? ALL_KINDS : cats && typeof cats === "object" ? cats : { club: 1 };
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

  const recurring = [];
  if (C.club) recurring.push({ list: ed.clubs || [], kind: "club" });
  if (C.folk) recurring.push({ list: ed.folkNights || [], kind: "folk night" });
  if (C.session) recurring.push({ list: ed.irishSessions || [], kind: "session" });
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
  if (C.music) oneOffs.push({ list: ed.musicEvents || [], kind: "music" });
  if (C.poetry) oneOffs.push({ list: ed.poetryEvents || [], kind: "poetry" });
  oneOffs.forEach(({ list, kind }) => {
    list.forEach((ev) => {
      const d = parseDateString(ev.date);
      if (!d || d < from || d > to) return;
      if (kind === "event" && (ev.club ? !C.club : !C.storyEvent)) return;
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
  const currentDiv = document.getElementById("startCurrent");
  const clearBtn = document.getElementById("startClear");
  currentDiv.textContent = s ? `Start: ${s.label}` : "";
  if (clearBtn) clearBtn.style.display = s ? "" : "none";
  if (!s) PLANNER._endTouched = false;
  syncEndSame();
  renderAll();
  liveRebuild();
  if (poolMap || currentMode() === "pool") renderPoolMap(false);
}

function setEnd(e) {
  PLANNER.end = e;
  document.getElementById("endCurrent").textContent = e ? `End: ${e.label}` : "";
  document.getElementById("endClear").style.display = e ? "" : "none";
  updateStartSummary();
  liveRebuild();
  renderAll();
  renderMap();
  if (currentMode() === "pool") renderPoolMap(false);
}
/** "Finish back at the start" only makes sense once a start is set: otherwise greyed out and unticked. */
function syncEndSame() {
  const cb = document.getElementById("endSame");
  const hint = document.getElementById("endSameHint");
  if (!PLANNER.start) { cb.checked = false; cb.disabled = true; if (hint) hint.hidden = false; }
  else { cb.disabled = false; if (hint) hint.hidden = true; if (!PLANNER._endTouched) cb.checked = true; }
  PLANNER.endSame = cb.checked;
  document.getElementById("endBlock").hidden = cb.checked;
  updateStartSummary();
}
function updateStartSummary() {
  const box = document.getElementById("startSummary");
  if (!box) return;
  const s = PLANNER.start ? `Start: ${PLANNER.start.label}` : "No start set";
  const e = PLANNER.endSame ? (PLANNER.start ? "finish back at the start" : "") : PLANNER.end ? `finish: ${PLANNER.end.label}` : (PLANNER.start ? "no set finish" : "");
  box.textContent = e ? `${s} · ${e}` : s;
}
function onEndSameChange() {
  PLANNER._endTouched = true;
  const same = document.getElementById("endSame").checked;
  PLANNER.endSame = same;
  document.getElementById("endBlock").hidden = same;
  updateStartSummary();
  renderAll();
  renderMap();
  if (currentMode() === "pool") renderPoolMap(false);
}

/** Forget any built tour and empty the results area (itinerary, map, columns). */
function clearResults() {
  PLANNER.days = [];
  PLANNER.byDay = new Map();
  PLANNER.chosen = new Map();
  PLANNER.collapsed = new Set();
  PLANNER.mapDay = null;
  PLANNER.best = null;
  PLANNER.anchor = null;
  PLANNER.musts = [];
  PLANNER.mode = null;
  renderAll();
  renderItinerary();
  renderMap();
  const st = document.getElementById("plannerStatus");
  if (st) st.textContent = "";
}

/** The distance-limits panel sits between the map and the columns once a tour has been built. */
function updateLivePanel() {
  const live = document.getElementById("plannerLive");
  if (live) live.hidden = !PLANNER.days.length || PLANNER.mode !== currentMode();
}
let liveTimer = null;
/** Re-read the limits and rebuild the options, keeping the user's picks that still exist. */
function liveRebuild() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => {
    if (!PLANNER.days.length || PLANNER.mode !== currentMode()) return;
    const keep = [...PLANNER.chosen.values()];
    PLANNER._rebuilding = true;
    try { onBuild(); } finally { PLANNER._rebuilding = false; }
    let changed = false;
    keep.forEach((c) => {
      if (PLANNER.chosen.has(dkey(c.date)) && PLANNER.chosen.get(dkey(c.date)).id === c.id) return;
      const again = (PLANNER.byDay.get(dkey(c.date)) || []).find((n) => n.id === c.id);
      if (again) { PLANNER.chosen.set(dkey(c.date), again); changed = true; }
    });
    if (changed) renderAll();
  }, 200);
}

/** Range slider over a stepped scale, kept in sync with a number input.
 *  atEnd: what the far-right position means ("" = blank/no limit for a max,
 *  or the first scale value for a minimum). */
/** One slider for both limits between stops: right handle = furthest (far right = no limit), left handle =
 *  closest (far left = no minimum). The handles can never cross; the number fields stay in step. */
const DR_SCALE = [0, 5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 150, 200, 300, 500];
function drMinInput() { return document.getElementById(currentMode() === "pool" ? "minHop" : "minSpread"); }
function drSync() {
  const a = document.getElementById("drMin"), b = document.getElementById("drMax");
  if (!a || !b) return;
  const n = DR_SCALE.length;
  const near = (v) => { let best = 0; DR_SCALE.forEach((x, i) => { if (Math.abs(x - v) < Math.abs(DR_SCALE[best] - v)) best = i; }); return best; };
  const mi = drMinInput(), ma = document.getElementById("maxHop");
  const minV = Number(mi.value) || 0;
  const maxRaw = ma.value.trim();
  let lo = near(minV), hi = maxRaw === "" ? n : Math.max(1, near(Number(maxRaw)));
  if (lo >= hi) lo = hi - 1;
  a.value = String(lo); b.value = String(hi);
  const lt = minV <= 0 ? "no minimum" : `${minV} mi`, ht = maxRaw === "" ? "no limit" : `${Number(maxRaw)} mi`;
  document.getElementById("drMinTxt").textContent = lt; document.getElementById("drMaxTxt").textContent = ht;
  a.setAttribute("aria-valuetext", lt); b.setAttribute("aria-valuetext", ht);
  const f = document.getElementById("drFill");
  f.style.left = (lo / n) * 100 + "%"; f.style.width = ((hi - lo) / n) * 100 + "%";
}
function attachDualRange() {
  const a = document.getElementById("drMin"), b = document.getElementById("drMax");
  if (!a || !b) return;
  const n = DR_SCALE.length;
  [a, b].forEach((s) => { s.min = 0; s.max = n; s.step = 1; });
  const fire = (id) => document.getElementById(id).dispatchEvent(new Event("input", { bubbles: true }));
  a.addEventListener("input", () => {
    let lo = Number(a.value); const hi = Number(b.value);
    if (lo >= hi) lo = hi - 1;
    a.value = String(Math.max(0, lo));
    drMinInput().value = String(DR_SCALE[Number(a.value)]);
    fire(drMinInput().id); drSync();
  });
  b.addEventListener("input", () => {
    let hi = Number(b.value); const lo = Number(a.value);
    if (hi <= lo) hi = lo + 1;
    hi = Math.max(1, hi); b.value = String(hi);
    document.getElementById("maxHop").value = hi >= n ? "" : String(DR_SCALE[hi]);
    fire("maxHop"); drSync();
  });
  // typed values: keep min below max (the value just edited is the one pulled back)
  const settle = (edited) => {
    const mi = drMinInput(), ma = document.getElementById("maxHop");
    const lo = Number(mi.value) || 0, hi = ma.value.trim() === "" ? Infinity : Number(ma.value);
    if (lo > hi) { if (edited === "min") mi.value = String(hi); else ma.value = String(Math.max(lo, 5)); }
    drSync();
  };
  ["minHop", "minSpread"].forEach((id) => { const x = document.getElementById(id); x.addEventListener("input", drSync); x.addEventListener("change", () => settle("min")); });
  const mx = document.getElementById("maxHop"); mx.addEventListener("input", drSync); mx.addEventListener("change", () => settle("max"));
  drSync();
}
function attachScaleSlider(inputId, sliderId, scale, isMax) {
  const input = document.getElementById(inputId), sl = document.getElementById(sliderId);
  if (!input || !sl) return;
  const n = scale.length;
  sl.min = 0; sl.max = isMax ? n : n - 1; sl.step = 1;
  const fromInput = () => {
    const raw = input.value.trim();
    if (isMax && raw === "") return n;
    const v = Number(raw);
    let best = 0;
    scale.forEach((x, i) => { if (Math.abs(x - v) < Math.abs(scale[best] - v)) best = i; });
    return best;
  };
  const sync = () => { sl.value = String(fromInput()); sl.setAttribute("aria-valuetext", input.value.trim() === "" ? "no limit" : input.value + " miles"); };
  sl.addEventListener("input", () => {
    const i = Number(sl.value);
    input.value = isMax && i >= n ? "" : String(scale[i]);
    sl.setAttribute("aria-valuetext", input.value === "" ? "no limit" : input.value + " miles");
    input.dispatchEvent(new Event("input", { bubbles: true })); // so the live filters react
  });
  input.addEventListener("input", sync);
  if (isMax) input.placeholder = "no limit";
  sync();
}

function clearStart() {
  setStart(null);
  document.getElementById("startInput").value = "";
  TourSupport.clearStart();
  setStatus("Start location cleared.");
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
  if (currentMode() === "pool") renderPoolMap(false);
  liveRebuild();
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
/** Number the visible step headings by their on-screen order, so reordering steps never needs text edits. */
function numberSteps() {
  const cards = [...document.querySelectorAll("#plannerFlow > .flow-card")].filter((c) => !c.hidden);
  cards.sort((a, b) => (parseInt(getComputedStyle(a).order, 10) || 0) - (parseInt(getComputedStyle(b).order, 10) || 0));
  document.querySelectorAll("#plannerRefine h3.flow-step").forEach((h) => { delete h.dataset.num; });
  let n = 0;
  const numbered = true;
  cards.forEach((c) => {
    const h = c.querySelector(":scope > h3.flow-step");
    if (!h) return;
    if (h.hidden || !numbered) { delete h.dataset.num; return; }
    h.dataset.num = String(++n);
  });
}

/** Changing what the tour is built around starts afresh: forget the artists, pool and must-visits. */
function resetPoolState() {
  PLANNER.pickPerf.clear(); PLANNER.pickTour.clear();
  PLANNER.extraVenues = new Map(); PLANNER.primary = null; PLANNER.pool = [];
  PLANNER.exp.focus = new Set(); PLANNER.exp.scope = "all"; PLANNER.exp.discover = false; PLANNER.exp.group = "all"; PLANNER.exp.setop = "any"; PLANNER.exp.hover = null;
  ["poolAll_storyteller", "poolAll_musician", "poolAll_poet", "poolAllClubs"].forEach((id) => { const c = document.getElementById(id); if (c) c.checked = false; });
  ["poolPerfChips", "poolTourChips", "poolPerfResults", "poolTourResults"].forEach((id) => { const n = document.getElementById(id); if (n) n.replaceChildren(); });
  ["poolPerfFilter", "poolTourFilter"].forEach((id) => { const n = document.getElementById(id); if (n) n.value = ""; });
  const sim = document.getElementById("poolSimilar"); if (sim) { sim.hidden = true; sim.replaceChildren(); }
  PLANNER.mustRows = []; drawMustRows();
  renderPoolList(); renderPoolMap(false);
}

/** Venue-pool mode: before the first build the refining options (area, must-visits, dates, start/end) sit in the
 *  step list; once a tour is built they move into panels beside the map, where changes apply live. */
const REFINE_IDS = ["blkArea", "blkMust", "blkDates", "blkStart"];
function placeRefine() {
  const box = document.getElementById("plannerRefine"), flow = document.getElementById("plannerFlow");
  if (!box || !flow) return;
  const built = currentMode() === "pool" && PLANNER.days.length > 0 && PLANNER.mode === "pool";
  box.hidden = !built;
  REFINE_IDS.forEach((id) => {
    const c = document.getElementById(id);
    if (!c) return;
    if (built) { if (c.parentElement !== box) box.appendChild(c); }
    else if (c.parentElement !== flow) flow.insertBefore(c, document.getElementById("blkBuild"));
  });
}

function setMode() {
  const m = currentMode();
  document.querySelectorAll('input[name="buildMode"]').forEach((r) => { r.checked = r.value === m; r.closest(".mode-card").classList.toggle("selected", r.value === m); });
  const flow = document.getElementById("plannerFlow");
  if (flow) { flow.classList.remove("mode-club", "mode-venue", "mode-period", "mode-pool"); flow.classList.add("mode-" + m); }
  document.querySelectorAll("[data-modes]").forEach((n) => {
    n.hidden = !n.dataset.modes.split(" ").includes(m);
  });
  // changing what we build around invalidates everything downstream: clear it until rebuilt
  if (PLANNER.days.length && PLANNER.mode && PLANNER.mode !== m) clearResults();
  updateLivePanel();
  if (PLANNER._lastMode && PLANNER._lastMode !== m) resetPoolState();
  PLANNER._lastMode = m;
  placeRefine();
  drSync();
  numberSteps();
  if (PLANNER._refreshSummaries) PLANNER._refreshSummaries();
  if (PLANNER._help) PLANNER._help.refresh();
  if (m === "venue" && !PLANNER._venueRows) buildVenueRows();
  fillAnchorDates();
}

/** Venues with at least one gig in the next ~6 months (clubs + other events). */
function buildVenueRows() {
  const today = getTodayMidnight();
  const to = addDays(today, 183);
  const byDay = gatherCandidates(today, to, selectedCats());
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
}

function fillAnchorDates() {
  const m = currentMode();
  const dsel = document.getElementById("anchorDate");
  const msel = document.getElementById("anchorMonth");
  dsel.replaceChildren();
  let items = []; // {date, label, value}
  if (m === "club") {
    const row = PLANNER._anchorRows[Number(document.getElementById("anchorClub").value)];
    if (row) items = row.dates.map((d) => ({ date: d, label: formatDate(d), value: dkey(d) }));
  } else if (m === "venue") {
    const row = (PLANNER._venueRows || [])[Number(document.getElementById("anchorVenue").value)];
    if (row) items = row.cands.map((c, i) => ({ date: c.date, label: `${formatDate(c.date)} — ${c.name}`, value: String(i) }));
  }
  // month filter: keep the choice if that month still exists for this club / venue
  const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const months = [...new Map(items.map((i) => [monthKey(i.date), i.date])).entries()];
  const prev = msel.value;
  msel.replaceChildren();
  const anyOpt = el("option", null, "Any month"); anyOpt.value = ""; msel.appendChild(anyOpt);
  months.forEach(([k, d]) => {
    const o = el("option", null, d.toLocaleString("en-GB", { month: "long", year: "numeric" }));
    o.value = k; msel.appendChild(o);
  });
  if (months.some(([k]) => k === prev)) msel.value = prev;
  items.filter((i) => !msel.value || monthKey(i.date) === msel.value).forEach((i) => {
    const o = el("option", null, i.label); o.value = i.value; dsel.appendChild(o);
  });
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

const evIds = (e) => [e.performer_id, ...asIdList(e.performer_ids), ...asIdList(e.other_performer_ids), ...asIdList(e.support_performer_ids)].filter(Boolean);

/** Every gig (past or future) usable as pool evidence. A gig counts if it
 *  involves an explicitly chosen artist or tour, OR if its act class
 *  (storyteller / musician / poet) is among `cats`. Gig-level music/poetry
 *  flags (musicEvents, tour isMusic / isPoetry) override a missing flag on
 *  the performer record. Returns {vid, date, pid, club, cls[]}. */
function poolEvidence(perfIds, tourIds, cats) {
  const ed = PLANNER.eventsData;
  const out = [];
  const idsOf = evIds;
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
  // venues brought in from a suggested artist: use that artist's gigs there
  (PLANNER.extraVenues || new Map()).forEach((src, vid) => {
    poolEvidence(src, new Set(), new Set()).filter((g) => g.vid === vid).forEach((g) => {
      const r = rowFor(g);
      if (!r) return;
      r.count++; r.wd[g.date.getDay()]++; r.extra = true;
      const pn = (PLANNER.eventsData.performers || {})[g.pid];
      r.artists.add(pn ? pn.name : g.pid || "(unlisted performer)");
    });
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
function refreshPool() {
  buildPool();
  renderPoolList();
  renderPoolMap(true);
  renderSimilar();
}

// ── venue explorer: who has played the pool's venues, and what is new to you ──
PLANNER.exp = { view: "cards", colour: "state", group: "all", setop: "any", sort: "count", open: true, discover: false, focus: new Set(), scope: "all", hover: null };
PLANNER.extraVenues = new Map(); // venue id -> Set(artist ids) added from a suggested artist
PLANNER.primary = null;
const ART_COLOURS = ["#0072B2", "#D55E00", "#009E73", "#CC79A7", "#E69F00", "#56B4E9"]; // colour-blind friendly
const ART_OTHER = "#757575";

/** The artist everything is compared against: the one chosen with ★, else the first added. */
function primaryId() {
  if (PLANNER.primary && PLANNER.pickPerf.has(PLANNER.primary)) return PLANNER.primary;
  return [...PLANNER.pickPerf][0] || null;
}
function artistName(id) { const p = (PLANNER.eventsData.performers || {})[id]; return p ? p.name || id : id; }
/** Selected artists in order (explicit picks first, then the performers of picked tours). */
function selectedArtistIds() {
  const out = [...PLANNER.pickPerf];
  PLANNER.pickTour.forEach((tid) => {
    const t = (PLANNER.eventsData.tours || {})[tid];
    if (t) evIds(t).forEach((id) => { if (!out.includes(id)) out.push(id); });
  });
  const prim = primaryId();
  return prim ? [prim, ...out.filter((i) => i !== prim)] : out;
}
/** Artists who have played the same venues as the selection, best overlap first. */
function similarArtists() {
  const idx = performerVenueIndex(), ed = PLANNER.eventsData;
  const selected = new Set(selectedArtistIds());
  const mine = new Set();
  selected.forEach((id) => (idx.get(id) || new Map()).forEach((n, vid) => mine.add(vid)));
  if (!selected.size || !mine.size) return [];
  const out = [];
  idx.forEach((venues, id) => {
    if (selected.has(id)) return;
    const p = (ed.performers || {})[id];
    if (!p || p.isPromoter || p.isClub) return;
    let shared = 0;
    venues.forEach((n, vid) => { if (mine.has(vid)) shared++; });
    if (shared) out.push({ id, name: p.name || id, shared });
  });
  return out.sort((a, b) => b.shared - a.shared || a.name.localeCompare(b.name));
}

/** Everything the explorer shows: pool rows plus venues only suggested artists have played. */
function expModel() {
  const idx = performerVenueIndex();
  const sel = selectedArtistIds(), prim = primaryId();
  // suggestions are opt-in: the pool is just the chosen artists' venues until you ask to discover more
  const sim = PLANNER.exp.discover ? similarArtists().slice(0, 8) : [];
  // an artist you are focused on stays in the model even if they stop being suggested
  const ext = [...PLANNER.exp.focus].filter((id) => !sel.includes(id) && !sim.some((o) => o.id === id));
  const colour = new Map();
  [...sel, ...sim.map((o) => o.id), ...ext].forEach((id, i) => colour.set(id, i < ART_COLOURS.length ? ART_COLOURS[i] : ART_OTHER));
  const has = (id, vid) => (idx.get(id) || new Map()).has(vid);
  const pool = PLANNER.pool || [];
  const rows = pool.map((r) => {
    const by = sel.filter((id) => has(id, r.vid));
    const group = !prim ? "all" : by.includes(prim) ? (by.length > 1 ? "shared" : "mine") : "new";
    const who = [...sel, ...sim.map((o) => o.id), ...ext].filter((id) => has(id, r.vid));
    return { key: r.key, vid: r.vid, r, by, who, group, suggested: false, sources: [] };
  });
  const poolVids = new Set(pool.map((r) => r.vid));
  const sugg = new Map();
  [...sim.map((o) => o.id), ...ext].forEach((aid) => (idx.get(aid) || new Map()).forEach((n, vid) => {
    if (poolVids.has(vid)) return;
    if (!sugg.has(vid)) sugg.set(vid, new Set());
    sugg.get(vid).add(aid);
  }));
  const suggested = [...sugg.entries()].map(([vid, src]) => ({ key: "s:" + vid, vid, r: null, by: [], who: [...src], group: "new", suggested: true, sources: [...src] }));
  return { sel, prim, sim, ext, colour, rows, suggested };
}
function expLabel(x) {
  const v = PLANNER.venues[x.vid] || {};
  if (x.r && x.r.kind === "club") return `🎙 ${x.r.rec.name}${v.city ? " — " + v.city : ""}`;
  return `${v.name || x.vid}${v.city && !String(v.name || "").includes(v.city) ? ", " + v.city : ""}`;
}
/** Apply the lens (set operation, soloed artist, sort); counts per group are taken before the group filter. */
function expVisible(m) {
  const e = PLANNER.exp, n = m.sel.length;
  const F = [...e.focus];
  let all = [...m.rows, ...m.suggested].filter((x) => {
    if (F.length) {
      const k = x.who.filter((id) => F.includes(id)).length;
      if (!k) return false;
      if (F.length > 1) {
        if (e.setop === "all" && k !== F.length) return false;
        if (e.setop === "two" && k < 2) return false;
        if (e.setop === "one" && k !== 1) return false;
      }
      return true;
    }
    if (n < 2) return true; // the "played by" control only exists with 2+ artists
    if (e.setop === "all" && !(!x.suggested && n > 0 && x.by.length === n)) return false;
    if (e.setop === "two" && !(!x.suggested && x.by.length >= 2)) return false;
    if (e.setop === "one" && !(!x.suggested && x.by.length === 1)) return false;
    return true;
  });
  if (e.scope === "in") all = all.filter((x) => !x.suggested && x.r.on);
  else if (e.scope === "out") all = all.filter((x) => x.suggested || !x.r.on);
  const counts = { all: all.length, mine: 0, shared: 0, new: 0 };
  all.forEach((x) => { if (counts[x.group] !== undefined) counts[x.group]++; });
  let shown = e.group === "all" || !m.prim ? all : all.filter((x) => x.group === e.group);
  const start = PLANNER.start ? [PLANNER.start.lat, PLANNER.start.lon] : null;
  const dist = (x) => { const v = PLANNER.venues[x.vid]; return start && v && Array.isArray(v.latlon) ? roadMiles(start, v.latlon) : Infinity; };
  const cnt = (x) => (x.r ? x.r.count : 0) + x.by.length * 0.01 + x.sources.length * 0.001;
  shown = [...shown].sort(e.sort === "az" ? (a, b) => expLabel(a).localeCompare(expLabel(b))
    : e.sort === "near" && start ? (a, b) => dist(a) - dist(b) : (a, b) => cnt(b) - cnt(a));
  return { shown, counts };
}
let expCardEls = new Map();
/** The artists to show for a venue: just the focused ones when some are focused, else the selected ones (or the suggesting artists). */
function artsOf(x) {
  const F = PLANNER.exp.focus;
  return F.size ? x.who.filter((id) => F.has(id)) : x.suggested ? x.sources : x.by;
}

function renderPoolList() {
  const box = document.getElementById("poolList");
  box.replaceChildren();
  expCardEls = new Map();
  const sum = document.getElementById("poolSummary");
  const pool = PLANNER.pool || [];
  const e = PLANNER.exp;
  if (!pool.length) {
    sum.textContent = "Choose artists, tours or types of act above and the venues they have played appear here.";
    return;
  }
  const m = expModel();
  const vis = expVisible(m);
  const newCount = m.prim ? vis.counts.new : 0;
  sum.textContent = `${pool.length} venues in the pool (${pool.filter((r) => r.on).length} included)` +
    (m.prim ? ` · ${newCount} new to ${artistName(m.prim)}` : "") + ". Untick any you don't want — or click a dot on the map.";

  const head = el("button", "exp-toggle", `${e.open ? "▾" : "▸"} Venue explorer — ${vis.shown.length} shown`);
  head.type = "button";
  head.setAttribute("aria-expanded", String(e.open));
  head.addEventListener("click", () => { e.open = !e.open; renderPoolList(); });
  box.appendChild(head);
  if (!e.open) return;

  const disc = el("div", "exp-discover");
  const db = el("button", "exp-chip" + (e.discover ? " on" : ""), e.discover ? "Discovering: showing venues of similar artists ✓" : "Discover more: also show venues played by similar artists");
  db.type = "button"; db.setAttribute("aria-pressed", String(e.discover));
  db.addEventListener("click", () => {
    e.discover = !e.discover;
    if (!e.discover) { e.focus = new Set([...e.focus].filter((id) => selectedArtistIds().includes(id))); if (e.scope === "out") e.scope = "all"; }
    renderPoolList(); renderPoolMap(false);
  });
  disc.appendChild(db);
  disc.appendChild(el("span", "ts-hint", e.discover ? " Suggested artists and their venues are shown as extra options; add the ones you like to the pool." : " Off: this list is only the venues of the artists you chose above."));
  box.appendChild(disc);

  // artists: colour key, ★ primary, hover to highlight, click to solo
  const arts = el("div", "exp-artists");
  [...m.sel, ...m.sim.slice(0, 5).map((o) => o.id), ...m.ext.filter((id) => !m.sim.slice(0, 5).some((o) => o.id === id))].forEach((id) => {
    const isSel = m.sel.includes(id);
    const b = el("button", "exp-art" + (e.focus.has(id) ? " solo" : "") + (isSel ? "" : " suggested"), "");
    b.type = "button";
    const dot = el("span", "exp-dot", (artistName(id) || "?").charAt(0).toUpperCase());
    dot.style.background = m.colour.get(id) || ART_OTHER;
    b.append(dot, " " + artistName(id) + (id === m.prim ? " ★" : isSel ? "" : " (suggested)"));
    b.title = (isSel ? "Click to focus on this artist's venues (click several to compare)" : "Suggested: has played venues you have. Click to focus") + " · hover to highlight";
    b.setAttribute("aria-pressed", String(e.focus.has(id)));
    b.addEventListener("click", () => {
      if (e.focus.has(id)) e.focus.delete(id); else { e.focus.add(id); if (e.focus.size === 1) e.colour = "artist"; }
      renderPoolList(); renderPoolMap(false);
    });
    b.addEventListener("mouseenter", () => { e.hover = id; markExpHover(); renderPoolMap(false); });
    b.addEventListener("mouseleave", () => { e.hover = null; markExpHover(); renderPoolMap(false); });
    arts.appendChild(b);
  });
  if (e.focus.size) {
    const clr = el("button", "exp-chip", `Focused on ${e.focus.size} artist${e.focus.size === 1 ? "" : "s"} — show all`);
    clr.type = "button";
    clr.addEventListener("click", () => { e.focus = new Set(); renderPoolList(); renderPoolMap(false); });
    arts.appendChild(clr);
  } else if (m.sel.length + m.sim.length > 1) arts.appendChild(el("span", "ts-hint", " Click artists to compare their venues on the list and map."));
  box.appendChild(arts);

  // scope: everything / what is in the pool / what is not
  const inN = m.rows.filter((x) => x.r.on).length, outN = m.rows.length - inN + m.suggested.length;
  const scopeBar = el("div", "exp-bar");
  scopeBar.appendChild(el("span", "exp-sel", "Show: "));
  [["all", `Everything (${m.rows.length + m.suggested.length})`], ["in", `In my pool (${inN})`], ["out", `Not in my pool (${outN})`]].forEach(([k, t]) => {
    const b = el("button", "exp-chip" + (e.scope === k ? " on" : ""), t); b.type = "button";
    b.setAttribute("aria-pressed", String(e.scope === k));
    b.addEventListener("click", () => { e.scope = k; renderPoolList(); renderPoolMap(false); });
    scopeBar.appendChild(b);
  });
  box.appendChild(scopeBar);
  // lens controls
  const bar = el("div", "exp-bar");
  if (m.prim) {
    [["all", "All"], ["mine", `${artistName(m.prim)} only`], ["shared", "Shared"], ["new", "New to " + artistName(m.prim)]].forEach(([k, t]) => {
      const b = el("button", "exp-chip" + (e.group === k ? " on" : ""), `${t} (${vis.counts[k]})`);
      b.type = "button";
      b.addEventListener("click", () => { e.group = k; renderPoolList(); renderPoolMap(false); });
      bar.appendChild(b);
    });
  }
  const sel = (label, key, opts, after) => {
    const lab = el("label", "exp-sel", label + " ");
    const s = el("select");
    opts.forEach(([v, t]) => { const o = el("option", null, t); o.value = v; if (v === e[key]) o.selected = true; s.appendChild(o); });
    s.addEventListener("change", () => { e[key] = s.value; if (after) after(); renderPoolList(); renderPoolMap(false); });
    lab.appendChild(s);
    return lab;
  };
  if (m.sel.length > 1 || e.focus.size > 1) bar.appendChild(sel("Played by", "setop", [["any", e.focus.size ? "any of the focused artists (union)" : "any selected artist"], ["all", e.focus.size ? "all of the focused artists (overlap)" : "all selected artists"], ["two", "2 or more of them"], ["one", "only one of them"]]));
  bar.appendChild(sel("Map colours", "colour", [["state", "included / excluded"], ["artist", "by artist"]]));
  bar.appendChild(sel("Sort", "sort", [["count", "most played"], ["near", "nearest to start"], ["az", "A–Z"]]));
  bar.appendChild(sel("View", "view", [["cards", "cards"], ["list", "compact list"]]));
  box.appendChild(bar);

  const acts = el("div", "ts-row");
  [[`Include all shown (${vis.shown.length})`, true], ["Exclude all shown", false]].forEach(([t, val]) => {
    const b = el("button", "btn-secondary btn-small", t); b.type = "button";
    b.addEventListener("click", () => {
      vis.shown.forEach((x) => { if (x.r) x.r.on = val; else if (val && x.suggested) PLANNER.extraVenues.set(x.vid, new Set(x.sources)); });
      if (val && vis.shown.some((x) => x.suggested)) refreshPool(); else { renderPoolList(); renderPoolMap(false); }
    });
    acts.appendChild(b);
  });
  box.appendChild(acts);

  const list = el("div", "exp-cards" + (e.view === "list" ? " compact" : ""));
  if (!vis.shown.length) list.appendChild(el("div", "graph-none", "No venues match this lens."));
  vis.shown.forEach((x) => {
    const card = el("div", "exp-card" + (x.suggested ? " suggested" : "") + (x.r && !x.r.on ? " off" : ""));
    card.dataset.key = x.key;
    expCardEls.set(x.key, card);
    const names = artsOf(x).map((id) => artistName(id));
    const top = el("div", "exp-card-top");
    if (!x.suggested) {
      const cb = el("input"); cb.type = "checkbox"; cb.checked = x.r.on;
      cb.setAttribute("aria-label", "Include " + expLabel(x));
      cb.addEventListener("change", () => { x.r.on = cb.checked; card.classList.toggle("off", !x.r.on); updatePoolSummary(); renderPoolMap(false); });
      top.appendChild(cb);
    }
    const dots = el("span", "exp-dots");
    artsOf(x).forEach((id) => {
      const d = el("span", "exp-dot sm", (artistName(id) || "?").charAt(0).toUpperCase());
      d.style.background = m.colour.get(id) || ART_OTHER; d.title = artistName(id);
      dots.appendChild(d);
    });
    top.append(dots, el("span", "exp-name", " " + expLabel(x)));
    if (x.suggested || (m.prim && x.group === "new")) top.appendChild(el("span", "exp-new", "new to you"));
    card.appendChild(top);
    if (e.view !== "list") {
      const meta = [];
      if (x.r && x.r.kind === "venue") meta.push(wdLabel(x.r));
      else if (x.r && x.r.kind === "club") meta.push(typeof x.r.rec.schedule === "string" ? x.r.rec.schedule : "club night");
      if (names.length) meta.push((x.suggested ? "Via " : "Played by ") + names.slice(0, 4).join(", ") + (names.length > 4 ? "…" : ""));
      else if (x.r && x.r.artists.size) meta.push("Played by " + [...x.r.artists].slice(0, 3).join(", "));
      if (meta.length) card.appendChild(el("div", "exp-meta", meta.join(" · ")));
      const row = el("div", "exp-actions");
      const link = el("a", "exp-link", "Venue page ↗");
      link.href = `venues.html?venue=${encodeURIComponent(x.vid)}`; link.target = "_blank"; link.rel = "noopener";
      row.appendChild(link);
      if (x.suggested) {
        const add = el("button", "btn-secondary btn-small", "+ Add to pool"); add.type = "button";
        add.addEventListener("click", () => addExtraVenue(x));
        row.appendChild(add);
      } else if (x.r.extra) {
        const rm = el("button", "btn-secondary btn-small", "Remove from pool"); rm.type = "button";
        rm.addEventListener("click", () => { PLANNER.extraVenues.delete(x.vid); refreshPool(); });
        row.appendChild(rm);
      } else {
        const tg = el("button", "btn-secondary btn-small", x.r.on ? "✓ In pool · remove" : "+ Add to pool"); tg.type = "button";
        tg.addEventListener("click", () => { x.r.on = !x.r.on; renderPoolList(); renderPoolMap(false); });
        row.appendChild(tg);
      }
      card.appendChild(row);
    }
    card.addEventListener("mouseenter", () => { e.hover = null; });
    list.appendChild(card);
  });
  box.appendChild(list);
}
function markExpHover() {
  const h = PLANNER.exp.hover;
  const m = expModel();
  expCardEls.forEach((card, key) => {
    const x = [...m.rows, ...m.suggested].find((r) => r.key === key);
    card.classList.toggle("dim", !!(h && x && !x.who.includes(h)));
  });
}
/** Bring a suggested venue into the pool (using that artist's gigs there for its weekdays). */
function addExtraVenue(x) {
  PLANNER.extraVenues.set(x.vid, new Set(x.sources));
  refreshPool();
}
function updatePoolSummary() {
  const pool = PLANNER.pool || [];
  const prim = primaryId();
  let tail = "";
  if (prim) { const m = expModel(); tail = ` · ${expVisible(m).counts.new} new to ${artistName(prim)}`; }
  document.getElementById("poolSummary").textContent =
    `${pool.length} venues in the pool (${pool.filter((r) => r.on).length} included)${tail}. Untick any you don't want — or click a dot on the map.`;
}

let poolMap = null, poolLayer = null;
/** Map of the venue pool. Colours show included/excluded, or who played where (by artist);
 *  hollow rings are venues only a suggested artist has played (click to add). */
async function renderPoolMap(fit) {
  const wrap = document.getElementById("poolMapWrap");
  const pool = PLANNER.pool || [];
  if (currentMode() !== "pool" || !pool.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  try { await loadLeaflet(); } catch (e) { wrap.hidden = true; return; }
  if (!poolMap) poolMap = initMap("poolMap");
  poolMap.invalidateSize();
  if (poolLayer) poolLayer.remove();
  poolLayer = L.layerGroup().addTo(poolMap);
  const e = PLANNER.exp, m = expModel(), vis = expVisible(m);
  const pts = [];
  const hov = e.hover;
  vis.shown.forEach((x) => {
    const v = PLANNER.venues[x.vid];
    if (!v || !Array.isArray(v.latlon)) return;
    pts.push(v.latlon);
    const fade = hov && !x.who.includes(hov);
    const firstCol = (id) => m.colour.get(id) || ART_OTHER;
    let opts;
    if (x.suggested) {
      opts = { radius: 8, color: firstCol(x.sources[0]), weight: 3, dashArray: "3 3", fillColor: "#fff", fillOpacity: 0.2, opacity: fade ? 0.25 : 1 };
    } else if (e.colour === "artist") {
      const cols = artsOf(x).map(firstCol);
      opts = { radius: x.r.kind === "club" ? 9 : 7, fillColor: cols[0] || ART_OTHER, fillOpacity: x.r.on ? 0.95 : 0.3,
        color: cols.length > 1 ? cols[1] : "#fff", weight: cols.length > 1 ? 4 : 1.5, opacity: fade ? 0.25 : 1 };
      if (fade) opts.fillOpacity = 0.15;
    } else {
      opts = { radius: x.r.kind === "club" ? 8 : 6, color: "#fff", weight: 1.5,
        fillColor: x.r.on ? (x.r.kind === "club" ? "#1b5e20" : "#43a047") : "#bdbdbd", fillOpacity: fade ? 0.2 : 0.95 };
    }
    const mk = L.circleMarker(v.latlon, opts);
    const who = artsOf(x).map(artistName).join(", ");
    mk.bindTooltip(`${expLabel(x)}${who ? " — " + who : ""}${x.suggested ? " · new to you (click to add)" : x.r.on ? "" : " (excluded)"}`);
    mk.on("click", () => {
      if (x.suggested) addExtraVenue(x);
      else { x.r.on = !x.r.on; renderPoolList(); renderPoolMap(false); }
    });
    mk.on("mouseover", () => { const c = expCardEls.get(x.key); if (c) c.classList.add("hl"); });
    mk.on("mouseout", () => { const c = expCardEls.get(x.key); if (c) c.classList.remove("hl"); });
    mk.addTo(poolLayer);
  });
  const pin = (ll, html, label) => L.marker(ll, { icon: L.divIcon({ className: "ts-pin home", html, iconSize: [26, 26] }) }).bindTooltip(label).addTo(poolLayer);
  if (PLANNER.start) pin([PLANNER.start.lat, PLANNER.start.lon], "⌂", "Start: " + PLANNER.start.label);
  const end = endPoint();
  if (end && end !== PLANNER.start) pin([end.lat, end.lon], "⚑", "End: " + end.label);
  const centre = PLANNER.area ? [PLANNER.area.lat, PLANNER.area.lon] : PLANNER.start ? [PLANNER.start.lat, PLANNER.start.lon] : null;
  const rad = Number(document.getElementById("areaRadius").value);
  if (centre && rad > 0 && (PLANNER.area || document.getElementById("areaRadius").dataset.touched)) {
    L.circle(centre, { radius: (rad / ROAD_FACTOR) * 1609.344, color: "#1565c0", weight: 1.5, dashArray: "5 5", fill: false }).addTo(poolLayer);
  }
  if (fit && pts.length) poolMap.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 10 });
}

/** performer id -> Map(venue id -> gig count), from every gig and tour date. */
function performerVenueIndex() {
  if (PLANNER._pvIdx) return PLANNER._pvIdx;
  const ed = PLANNER.eventsData, idx = new Map();
  const note = (ids, vid) => {
    if (!vid || !isRealPlace({ venue_id: vid })) return;
    ids.forEach((id) => {
      let m = idx.get(id);
      if (!m) { m = new Map(); idx.set(id, m); }
      m.set(vid, (m.get(vid) || 0) + 1);
    });
  };
  ["specificEvents", "musicEvents", "poetryEvents"].forEach((l) => (ed[l] || []).forEach((e) => {
    if (e.online || e.cancelled || e.isCancelled) return;
    note(evIds(e), e.venue_id);
  }));
  Object.values(ed.tours || {}).forEach((t) => (t.tour_dates || []).forEach((td) => {
    if (!td.cancelled && !td.isCancelled) note(evIds(t), td.venue_id);
  }));
  PLANNER._pvIdx = idx;
  return idx;
}
/** Suggest artists whose venues overlap those of the artists/tours picked. */
function renderSimilar() {
  const box = document.getElementById("poolSimilar");
  box.replaceChildren();
  const out = similarArtists();
  if (!out.length) { box.hidden = true; return; }
  box.hidden = false;
  box.appendChild(el("div", null, "Artists who have played the same venues — click to add:"));
  const chips = el("div", "pool-similar-chips");
  out.slice(0, 10).forEach((o) => {
    const b = el("button", "pool-sim-btn", `+ ${o.name} · ${o.shared} shared`);
    b.type = "button";
    b.addEventListener("click", () => {
      PLANNER.pickPerf.add(o.id);
      if (PLANNER._perfPicker) PLANNER._perfPicker.redraw();
      refreshPool();
    });
    chips.appendChild(b);
  });
  box.appendChild(chips);
}

/** Search-and-add picker: type to filter, click a result to add it as a chip
 *  (click the chip's × to remove). `picked` is a Set kept in PLANNER. */
function makePicker(prefix, items, picked, onChange, primary) {
  const changed = () => { if (onChange) onChange(); };
  const input = document.getElementById(`${prefix}Filter`);
  const results = document.getElementById(`${prefix}Results`);
  const chips = document.getElementById(`${prefix}Chips`);
  const label = new Map(items.map((i) => [i.id, i.label]));
  const drawChips = () => {
    chips.replaceChildren();
    [...picked].forEach((id) => {
      const isPrim = primary && primary.get() === id;
      const c = el("span", "picker-chip" + (isPrim ? " primary" : ""), label.get(id) || id);
      if (primary) {
        const star = el("button", "picker-chip-star", isPrim ? "★" : "☆");
        star.type = "button";
        star.title = isPrim ? "Primary artist: everything is compared with their venues" : "Make this the primary artist";
        star.setAttribute("aria-label", (isPrim ? "Primary artist " : "Make primary: ") + (label.get(id) || id));
        star.addEventListener("click", () => { primary.set(id); drawChips(); changed(); });
        c.appendChild(star);
      }
      const x = el("button", "picker-chip-x", "×");
      x.type = "button";
      x.setAttribute("aria-label", `Remove ${label.get(id) || id}`);
      x.addEventListener("click", () => { picked.delete(id); drawChips(); drawResults(); changed(); });
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
        drawChips(); drawResults(); input.focus(); changed();
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
  return { redraw: drawChips };
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
  PLANNER._perfPicker = makePicker("poolPerf",
    [...perfs.entries()].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label)),
    PLANNER.pickPerf, refreshPool, { get: primaryId, set: (id) => { PLANNER.primary = id; } });
  makePicker("poolTour",
    Object.entries(ed.tours || {})
      .filter(([, t]) => (t.tour_dates || []).length)
      .map(([id, t]) => ({ id, label: `${t.isMusic ? "♪ " : ""}${t.tour_name || t.name || id}` }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    PLANNER.pickTour, refreshPool);
  document.getElementById("poolPreview").addEventListener("click", () => refreshPool(true));
  ["poolAll_storyteller", "poolAll_musician", "poolAll_poet", "poolAllClubs"].forEach((id) =>
    document.getElementById(id).addEventListener("change", () => refreshPool()));
  initMustPicker();
}

// ── must-visit places (pool mode) ───────────────────────────────────────
PLANNER.mustRows = [];
const MUST_FLEX = [[0, "exactly"], [1, "± 1 day"], [2, "± 2 days"], [3, "± 3 days"], [7, "± 7 days"]];
function mustItems() {
  const items = [], towns = new Map();
  Object.entries(PLANNER.venues).forEach(([id, v]) => {
    if (!TourSupport.venueUsable(PLANNER.venues, id)) return;
    items.push({ type: "v", key: id, label: `${v.name}${v.city ? " — " + v.city : ""}` });
    if (v.city) towns.set(v.city.trim().toLowerCase(), v.city.trim());
  });
  towns.forEach((name, k) => items.push({ type: "t", key: k, label: `📍 ${name} (any venue)` }));
  return items.sort((a, b) => a.label.localeCompare(b.label));
}
function mustMatchIds(m) {
  return Object.entries(PLANNER.venues)
    .filter(([id, v]) => TourSupport.venueUsable(PLANNER.venues, id) &&
      (m.type === "v" ? id === m.key : String(v.city || "").trim().toLowerCase() === m.key))
    .map(([id]) => id);
}
function initMustPicker() {
  const input = document.getElementById("mustFilter");
  const results = document.getElementById("mustResults");
  if (!input) return;
  let items = null;
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    results.replaceChildren();
    if (!q) { results.hidden = true; return; }
    if (!items) items = mustItems();
    const hits = items.filter((i) => i.label.toLowerCase().includes(q)).slice(0, 30);
    results.hidden = false;
    if (!hits.length) { results.appendChild(el("div", "picker-none", "No matches")); return; }
    hits.forEach((i) => {
      const b = el("button", "picker-result", "+ " + i.label);
      b.type = "button";
      b.addEventListener("click", () => {
        const ps = document.getElementById("periodStart").value;
        PLANNER.mustRows.push({ ...i, date: ps || "", flex: 0 });
        input.value = ""; draw(); drawMustRows(); liveRebuild();
      });
      results.appendChild(b);
    });
  };
  input.addEventListener("input", draw);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { input.value = ""; draw(); }
    if (e.key === "Enter") { e.preventDefault(); const f = results.querySelector("button"); if (f) f.click(); }
  });
}
function drawMustRows() {
  const box = document.getElementById("mustRows");
  box.replaceChildren();
  PLANNER.mustRows.forEach((m, idx) => {
    const row = el("div", "must-row");
    row.appendChild(el("span", "must-label", "★ " + m.label));
    const d = el("input"); d.type = "date"; d.value = m.date;
    d.setAttribute("aria-label", "Target date for " + m.label);
    d.addEventListener("change", () => { m.date = d.value; liveRebuild(); });
    const f = el("select");
    f.setAttribute("aria-label", "Flexibility for " + m.label);
    MUST_FLEX.forEach(([n, t]) => { const o = el("option", null, t); o.value = n; if (n === m.flex) o.selected = true; f.appendChild(o); });
    f.addEventListener("change", () => { m.flex = Number(f.value); liveRebuild(); });
    const x = el("button", "must-x", "×"); x.type = "button"; x.setAttribute("aria-label", "Remove " + m.label);
    x.addEventListener("click", () => { PLANNER.mustRows.splice(idx, 1); drawMustRows(); liveRebuild(); });
    row.append(d, f, x);
    box.appendChild(row);
  });
}
/** Resolve the rows into {label, ids:Set, dayKeys:Set, lastIdx}; string = error. */
function resolveMusts() {
  const out = [];
  for (const m of PLANNER.mustRows) {
    if (!m.date) return `Choose a target date for “${m.label}”.`;
    const [y, mo, dd] = m.date.split("-").map(Number);
    const t = new Date(y, mo - 1, dd);
    const idxs = [];
    PLANNER.days.forEach((day, i) => { if (Math.abs(Math.round((day - t) / 86400000)) <= m.flex) idxs.push(i); });
    if (!idxs.length) return `“${m.label}” (${formatDate(t)}${m.flex ? " ± " + m.flex : ""}) falls outside the tour period.`;
    const ids = new Set(mustMatchIds(m));
    if (!ids.size) return `No usable venue found for “${m.label}”.`;
    out.push({ label: m.label, ids, dayKeys: new Set(idxs.map((i) => dkey(PLANNER.days[i]))), lastIdx: idxs[idxs.length - 1] });
  }
  return out;
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
  return PLANNER.distinct || PLANNER.minSpread > 0 || PLANNER.minHop > 0 || (PLANNER.musts || []).length ? beamKRoute(G, relax, relaxSpread) : exactKRoute(G, relax);
}

/** Same objective as exactKRoute but never revisits a venue. The "visited"
 *  set breaks the simple DP, so this is a beam search (keeps the cheapest
 *  few hundred partial tours per step) — near-optimal, not guaranteed. */
function beamKRoute(G, relax, relaxSpread) {
  const h = homeLL(), he = endLL();
  const musts = PLANNER.musts || [];
  const FULL = (1 << musts.length) - 1;
  if (musts.length) G = Math.max(G, musts.length);
  const bits = (n) => (n.must || []).reduce((m, i) => m | (1 << i), 0);
  const pop = (m) => { let c = 0; while (m) { c += m & 1; m >>= 1; } return c; };
  const days = PLANNER.days.map((d) => ({ d, nodes: PLANNER.byDay.get(dkey(d)) || [] }));
  const MAXGAP = 4, BEAM = 400, PER_NODE = 8, MUST_BONUS = 1000;
  const venueKey = (n) => n.venue_id;
  // a state is dead if a still-unmet must-visit can no longer be reached
  const alive = (st) => musts.every((m, i) => (st.mask >> i) & 1 || m.lastIdx > st.i);
  let layer = [];
  days.forEach((s, i) => s.nodes.forEach((n, j) => {
    if (h && roadMiles(h, latlonOf(n)) > PLANNER.maxFirst) return;
    layer.push({ i, j, mask: bits(n), cost: h ? roadMiles(h, latlonOf(n)) : 0, stops: [n], seen: new Set([venueKey(n)]) });
  }));
  const prune = (states) => {
    const per = new Map();
    const score = (st) => st.cost - MUST_BONUS * pop(st.mask);
    states = states.filter(alive);
    states.sort((a, b) => score(a) - score(b));
    const out = [];
    for (const st of states) {
      const k = st.i + ":" + st.j + ":" + st.mask;
      const c = per.get(k) || 0;
      if (c >= PER_NODE) continue;
      per.set(k, c + 1);
      out.push(st);
      if (out.length >= BEAM) break;
    }
    return out;
  };
  const finish = (st) => st.cost + (he ? roadMiles(latlonOf(st.stops[st.stops.length - 1]), he) : 0);
  const lastOk = (st) => !he || roadMiles(latlonOf(st.stops[st.stops.length - 1]), he) <= PLANNER.maxLast;
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
          if (!relaxSpread && leg < PLANNER.minHop) return;
          next.push({ i: i2, j, mask: st.mask | bits(n), cost: st.cost + leg, stops: [...st.stops, n], seen: new Set([...st.seen, venueKey(n)]) });
        });
      }
    });
    if (!next.length) break;
    layers.push(prune(next));
  }
  for (let g = layers.length; g >= 1; g--) {
    const best = layers[g - 1].filter((st) => st.mask === FULL && lastOk(st)).reduce((b, st) => (!b || finish(st) < finish(b) ? st : b), null);
    if (best) return { stops: best.stops, miles: finish(best), relaxed: !!relax, spreadRelaxed: !!relaxSpread, achieved: g, wanted: G };
  }
  if (!relax) return beamKRoute(G, true, relaxSpread);
  return !relaxSpread && PLANNER.minSpread > 0 ? beamKRoute(G, true, true) : null;
}

function exactKRoute(G, relax) {
  const h = homeLL(), he = endLL();
  const days = PLANNER.days.map((d) => ({ d, nodes: PLANNER.byDay.get(dkey(d)) || [] }));
  const MAXGAP = 4;
  const INF = Infinity;
  // dp[i][j][g]: min miles ending at node j of day i having played g gigs
  const dp = days.map((s) => s.nodes.map(() => new Array(G + 1).fill(INF)));
  const from = days.map((s) => s.nodes.map(() => new Array(G + 1).fill(null)));
  days.forEach((s, i) => s.nodes.forEach((n, j) => {
    dp[i][j][1] = h ? (roadMiles(h, latlonOf(n)) > PLANNER.maxFirst ? Infinity : roadMiles(h, latlonOf(n))) : 0;
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
      if (he && roadMiles(latlonOf(n), he) > PLANNER.maxLast) return;
      const c = dp[i][j][g] + (he ? roadMiles(latlonOf(n), he) : 0);
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
/** Where the tour finishes: the start unless a separate end is set (pool mode). */
function endPoint() { return PLANNER.endSame !== false ? PLANNER.start : PLANNER.end; }
function endLL() { const e = endPoint(); return e ? [e.lat, e.lon] : null; }
function homeLL() {
  return PLANNER.start ? [PLANNER.start.lat, PLANNER.start.lon] : null;
}

function onBuild() {
  const mode = currentMode();
  const clamp = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const mhRaw = document.getElementById("maxHop").value.trim();
  PLANNER.maxHop = mhRaw === "" ? Infinity : clamp(mhRaw, 5, 500, 60);
  const isPoolMode = mode === "pool";
  const optMiles = (id) => { const v = document.getElementById(id).value.trim(); const n = clamp(v, 0, 1000, 0); return v === "" || !isPoolMode || !n ? Infinity : n; };
  PLANNER.minHop = isPoolMode ? clamp(document.getElementById("minHop").value, 0, 300, 0) : 0;
  const minAny = isPoolMode && document.getElementById("minScope").value === "any";
  PLANNER.maxFirst = optMiles("maxFirst");
  PLANNER.maxLast = optMiles("maxLast");
  PLANNER.endSame = document.getElementById("endSame").checked;
  PLANNER.maxHome = clamp(document.getElementById("maxHome").value, 0, 1000, 0);
  PLANNER.minSpread = clamp(document.getElementById("minSpread").value, 0, 200, 0);
  if (PLANNER.maxHop < Infinity) { PLANNER.minHop = Math.min(PLANNER.minHop, PLANNER.maxHop); PLANNER.minSpread = Math.min(PLANNER.minSpread, PLANNER.maxHop); }
  if (isPoolMode) { // one setting: apart from consecutive gigs only, or from any stop
    PLANNER.minSpread = minAny ? PLANNER.minHop : 0;
    if (minAny) PLANNER.minHop = 0;
  }
  PLANNER.includeOther = Object.keys(selectedCats()).some((k) => k !== "club");
  if (mode !== "pool" && !Object.keys(selectedCats()).length) return setStatus("Tick at least one kind of event.", true);
  PLANNER.mode = mode;
  PLANNER.musts = [];
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
    mode === "pool" ? true : selectedCats(),
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
    const musts = resolveMusts();
    if (typeof musts === "string") return setStatus(musts, true);
    PLANNER.musts = musts;
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
      // must-visit venues: always on offer within their date window, whatever the filters said
      musts.forEach((m, mi) => {
        if (!m.dayKeys.has(k)) return;
        m.ids.forEach((vid) => {
          const v = PLANNER.venues[vid];
          let n = nodes.find((x) => x.kind === "venue" && x.venue_id === vid);
          if (!n) {
            if (!Array.isArray(v.latlon)) return;
            const clash = clashes.get(vid);
            n = { id: `pool:${vid}:${k}`, kind: "venue", name: v.name, date: d, time: "", venue_id: vid, link: v.url || "", clubId: null,
              note: "★ must-visit" + (clash ? " · ⚠ also on: " + clash : "") };
            nodes.push(n);
          } else if (!/must-visit/.test(n.note || "")) n.note = "★ must-visit · " + (n.note || "");
          n.must = [...(n.must || []), mi];
        });
      });
      nodes.sort((x, y) => (centre0 ? roadMiles(centre0, latlonOf(x)) - roadMiles(centre0, latlonOf(y)) : 0));
      PLANNER.byDay.set(k, nodes);
    });
    PLANNER.chosen = new Map();
    PLANNER.hover = null;
    setStatus("");
    renderAll();
    announceBuilt("");
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
      // venues beyond maxHop x days from the anchor are no longer dropped here: the column filter
      // ("out of range of my picks": show / grey out / hide) decides, so greyed-out venues can be seen
      nodes = nodes
        .sort((x, y) => roadMiles(aLL, latlonOf(x)) - roadMiles(aLL, latlonOf(y)));
    } else if (centre) {
      nodes = nodes.filter((c) => roadMiles(centre, latlonOf(c)) <= PLANNER.radius)
        .sort((x, y) => roadMiles(centre, latlonOf(x)) - roadMiles(centre, latlonOf(y)));
    }
    PLANNER.byDay.set(k, nodes);
  });
  PLANNER.chosen = PLANNER.anchor ? new Map([[dkey(PLANNER.anchor.date), PLANNER.anchor]]) : new Map();
  PLANNER.hover = null;
  let tip = "";
  if (!PLANNER.anchor && !centre) tip = "Tip: set a start point or an area centre to keep a period search local.";
  else if (mode !== "period" || span20ok()) tip = "";
  setStatus(tip);
  renderAll();
  announceBuilt(tip);
}

/** Make it obvious that Build did something: say what was built and bring the results into view. */
function announceBuilt(tip) {
  if (PLANNER._rebuilding) return;
  const n = [...PLANNER.byDay.values()].reduce((t, a) => t + a.length, 0);
  setStatus(`✓ ${n} option${n === 1 ? "" : "s"} over ${PLANNER.days.length} days — your tour, the map and the filters are below, with the day columns underneath.${tip ? " " + tip : ""}`);
  const row = document.getElementById("plannerSummaryRow");
  if (row && row.scrollIntoView) row.scrollIntoView({ behavior: "smooth", block: "start" });
}
function span20ok() { return !/limited to 21/.test(document.getElementById("plannerStatus").textContent); }

// ── shortest route (dynamic programming over the day columns) ───────────
/** Cheapest chain through every non-empty day, via the anchor, optionally
 *  starting/ending at home. Consecutive stops must be <= maxHop x gap-days
 *  apart. Returns {stops, miles, relaxed} or null. */
function shortestRoute(relax, relaxSpread) {
  if (PLANNER.minSpread > 0 && !relaxSpread) return beamEveryDay(!!relax);
  const h = homeLL(), he = endLL();
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
    const c = cost[last][j] + (he ? roadMiles(latlonOf(n), he) : 0);
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
  const h = homeLL(), he = endLL();
  const stages = PLANNER.days
    .map((d) => ({ d, nodes: PLANNER.byDay.get(dkey(d)) || [] }))
    .filter((x) => x.nodes.length);
  if (!stages.length) return null;
  const BEAM = 400, PER_NODE = 8;
  const finish = (st) => st.cost + (he ? roadMiles(latlonOf(st.stops[st.stops.length - 1]), he) : 0);
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
  const h = homeLL(), he = endLL();
  let total = 0, p = h;
  stops.forEach((c) => { const ll = latlonOf(c); const leg = roadMiles(p, ll); if (leg != null) total += leg; p = ll; });
  if (he && p) total += roadMiles(p, he) || 0;
  return total;
}

// ── graph rendering ─────────────────────────────────────────────────────
let nodeEls = new Map(); // node id -> element
let mapMarkers = new Map(); // venue id -> leaflet marker (for hover linking)

/** Is gig c out of range of the picks either side of it (max/min between gigs)? */
function outOfReach(c, stops) {
  if (c.isAnchor || !stops.length) return false;
  const cl = latlonOf(c), k = dkey(c.date);
  let prev = null, next = null;
  for (const s of stops) {
    if (dkey(s.date) === k) continue;
    if (s.date < c.date) prev = s; else if (!next) next = s;
  }
  const bad = (st) => {
    const gap = Math.max(1, Math.round(Math.abs(st.date - c.date) / 86400000));
    const m = roadMiles(latlonOf(st), cl);
    return m == null ? false : m > PLANNER.maxHop * gap || m < PLANNER.minHop;
  };
  return (prev && bad(prev)) || (next && bad(next)) || false;
}
/** Another stop (on a different day) already at this venue, when each venue is visited once. */
function usedElsewhere(c, stops) {
  if (!PLANNER.distinct || PLANNER.mode !== "pool") return null;
  return stops.find((s) => dkey(s.date) !== dkey(c.date) && s.venue_id === c.venue_id) || null;
}
/** One verdict per gig for the column list and the map. */
function nodeState(c, stops) {
  const chosen = PLANNER.chosen.get(dkey(c.date));
  if (chosen && chosen.id === c.id) return { hide: false };
  const near = !c.isAnchor ? nearStop(c, stops, PLANNER.minSpread) : null;
  const used = !c.isAnchor ? usedElsewhere(c, stops) : null;
  const unreach = PLANNER.reachMode !== "show" && outOfReach(c, stops);
  const hide = (near && PLANNER.hideClose) || (used && PLANNER.hideUsed) || (unreach && PLANNER.reachMode === "hide");
  return { near, used, unreach, hide: !!hide };
}

/** Buttons above the day columns: preview one day's options on the map (with the picks either side). */
function buildDayBar() {
  const row = el("div", "day-bar");
  row.appendChild(el("span", "planner-filter-title", "Show on map:"));
  const mk = (label, key) => {
    const b = el("button", "day-btn" + (PLANNER.mapDay === key ? " on" : ""), label);
    b.type = "button"; b.dataset.day = key || "";
    b.setAttribute("aria-pressed", String(PLANNER.mapDay === key));
    b.addEventListener("click", () => setMapDay(PLANNER.mapDay === key ? null : key));
    return b;
  };
  row.appendChild(mk("whole tour", null));
  PLANNER.days.forEach((d) => {
    const k = dkey(d), n = (PLANNER.byDay.get(k) || []).length;
    if (!n) return;
    row.appendChild(mk(`${formatDate(d).replace(/ \d{4}$/, "")} (${n})`, k));
  });
  const lbl = el("label", "planner-inline"), cb = el("input"); cb.type = "checkbox"; cb.checked = PLANNER.mapSides;
  cb.addEventListener("change", () => { PLANNER.mapSides = cb.checked; renderMap(); });
  lbl.append(cb, " with the picks either side");
  row.appendChild(lbl);
  return row;
}
function setMapDay(k) {
  PLANNER.mapDay = k;
  document.querySelectorAll(".day-bar .day-btn").forEach((b) => {
    const on = (b.dataset.day || null) === k;
    b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on));
  });
  renderMap();
}

/** Distance from a gig to the nearest earlier and later picked stop (other days). */
function neighbourLegs(c, stops) {
  if (!stops.length) return {};
  const cl = latlonOf(c), k = dkey(c.date);
  let prev = null, next = null;
  for (const s of stops) {
    if (dkey(s.date) === k) continue;
    if (s.date < c.date) prev = s; else if (!next) next = s;
  }
  const leg = (s, dir) => {
    const m = roadMiles(latlonOf(s), cl);
    if (m == null) return null;
    const v = venueOf(s) || {};
    const days = Math.round(Math.abs(s.date - c.date) / 86400000);
    return { miles: m, label: `${v.city || s.name}${days > 1 ? ` (${days} days ${dir})` : ""}` };
  };
  return { prev: prev ? leg(prev, "earlier") : null, next: next ? leg(next, "later") : null };
}

function renderAll() {
  updateLivePanel();
  placeRefine();
  numberSteps();
  const wrap = document.getElementById("plannerResults");
  wrap.replaceChildren();
  nodeEls = new Map();
  if (!PLANNER.days.length) return;
  PLANNER.best = PLANNER.mode === "pool" ? bestKRoute(PLANNER.gigsWanted, false, false) : shortestRoute(false, false);

  const bar = el("div", "ts-panel planner-bar");
  const chosenIdsNow = new Set([...PLANNER.chosen.values()].map((c) => c.id));
  const bestPressed = !!PLANNER.best && PLANNER.best.stops.length === chosenIdsNow.size && PLANNER.best.stops.every((c) => chosenIdsNow.has(c.id));
  const bestBtn = el("button", "btn-primary" + (bestPressed ? " pressed" : ""), bestPressed ? "✓ Shortest route selected (click to clear)" : "⚡ Use shortest route");
  bestBtn.type = "button";
  bestBtn.setAttribute("aria-pressed", String(bestPressed));
  bestBtn.disabled = !PLANNER.best;
  bestBtn.addEventListener("click", () => {
    PLANNER.chosen = new Map();
    if (bestPressed) { if (PLANNER.anchor) PLANNER.chosen.set(dkey(PLANNER.anchor.date), PLANNER.anchor); }
    else PLANNER.best.stops.forEach((c) => PLANNER.chosen.set(dkey(c.date), c));
    renderAll();
  });
  const clearBtn = el("button", "btn-secondary", PLANNER.anchor ? "Reset to anchor only" : "Clear choices");
  clearBtn.type = "button";
  clearBtn.addEventListener("click", () => { PLANNER.chosen = PLANNER.anchor ? new Map([[dkey(PLANNER.anchor.date), PLANNER.anchor]]) : new Map(); renderAll(); });
  const chk = (label, val, onChange) => {
    const lbl = el("label", "planner-inline");
    const cb = el("input"); cb.type = "checkbox"; cb.checked = !!val;
    cb.addEventListener("change", () => onChange(cb.checked));
    lbl.append(cb, " " + label);
    return lbl;
  };
  bar.append(bestBtn, clearBtn,
    chk("show suggested route", PLANNER.showBest, (v) => { PLANNER.showBest = v; renderAll(); }),
    chk("show all links", PLANNER.showAll, (v) => { PLANNER.showAll = v; drawEdges(); }));
  const filters = el("div", "planner-filters");
  filters.appendChild(el("span", "planner-filter-title", "Columns:"));
  const reachLbl = el("label", "planner-inline", "venues out of range of my picks: ");
  const reachSel = el("select");
  [["show", "show"], ["grey", "grey out"], ["hide", "hide"]].forEach(([v, t]) => { const o = el("option", null, t); o.value = v; if (v === PLANNER.reachMode) o.selected = true; reachSel.appendChild(o); });
  reachSel.addEventListener("change", () => { PLANNER.reachMode = reachSel.value; renderAll(); });
  reachLbl.appendChild(reachSel);
  filters.appendChild(reachLbl);
  if (PLANNER.minSpread > 0) filters.appendChild(chk(`hide venues within ${PLANNER.minSpread} mi of a stop`, PLANNER.hideClose, (v) => { PLANNER.hideClose = v; renderAll(); }));
  filters.appendChild(chk("collapse a day to my pick once I choose", PLANNER.autoCollapse, (v) => { PLANNER.autoCollapse = v; }));
  if (PLANNER.distinct && PLANNER.mode === "pool") filters.appendChild(chk("hide venues already on the tour", PLANNER.hideUsed, (v) => { PLANNER.hideUsed = v; renderAll(); }));
  const pickedDays = PLANNER.days.map(dkey).filter((k) => PLANNER.chosen.has(k));
  if (pickedDays.length) {
    const allCollapsed = pickedDays.every((k) => PLANNER.collapsed.has(k));
    const colBtn = el("button", "btn-secondary btn-small", allCollapsed ? "Show all options" : "Only show my picks");
    colBtn.type = "button";
    colBtn.addEventListener("click", () => {
      if (allCollapsed) PLANNER.collapsed.clear(); else pickedDays.forEach((k) => PLANNER.collapsed.add(k));
      renderAll();
    });
    filters.appendChild(colBtn);
  }
  bar.appendChild(filters);
  const mapOpts = el("div", "planner-filters");
  mapOpts.appendChild(el("span", "planner-filter-title", "Map:"));
  mapOpts.append(
    chk("other venues", PLANNER.showCands !== false, (v) => { PLANNER.showCands = v; renderMap(); }),
    chk("follow the column filters", PLANNER.mapFollowsFilters, (v) => { PLANNER.mapFollowsFilters = v; renderMap(); }),
    chk("suggested route line", PLANNER.showBestOnMap, (v) => { PLANNER.showBestOnMap = v; renderMap(); }));
  const mapHost = document.getElementById("plannerMapOpts");
  if (mapHost) mapHost.replaceChildren(mapOpts); else bar.appendChild(mapOpts);
  if (PLANNER.best) {
    const isPool = PLANNER.mode === "pool";
    bar.appendChild(el("span", "ts-hint",
      (isPool ? `Shortest ${PLANNER.best.achieved}-gig route` : "Shortest route visiting a gig every possible day") +
      `: ${fmtMiles(PLANNER.best.miles)}${PLANNER.start && PLANNER.endSame !== false ? " round trip" : PLANNER.start || endPoint() ? " incl. start/end legs" : ""}` +
      (isPool && PLANNER.best.achieved < PLANNER.best.wanted ? ` (only ${PLANNER.best.achieved} of ${PLANNER.best.wanted} gigs possible in this window)` : "") +
      (PLANNER.best.relaxed ? " (distance limits relaxed — no route fit them)" : "") +
      (isPool && (PLANNER.musts || []).length ? ` · includes all ${PLANNER.musts.length} must-visit${PLANNER.musts.length > 1 ? "s" : ""}` : "") +
      (PLANNER.best.spreadRelaxed ? ` (couldn't keep stops ${PLANNER.minSpread || PLANNER.minHop} mi apart in this window)` : "")));
  } else if (PLANNER.mode === "pool" && (PLANNER.musts || []).length) {
    bar.appendChild(el("span", "ts-hint", "No route could include every must-visit place on those dates — widen their flexibility, the period, or untick “visit each venue only once”."));
  } else if (PLANNER.mode === "pool") {
    const lim = PLANNER.minHop > 0 || PLANNER.maxFirst < Infinity || PLANNER.maxLast < Infinity;
    bar.appendChild(el("span", "ts-hint", "No route fits" + (lim ? " your distance limits (min/max between gigs, start and end)" : " those dates, weekdays and area") + " — widen the window, radius or limits, or untick the weekday rule."));
  }
  if (!PLANNER.start) bar.appendChild(el("span", "ts-hint", "Set a start point to include the journey home."));
  wrap.appendChild(bar);
  wrap.appendChild(buildDayBar());

  const scroll = el("div", "graph-scroll");
  const inner = el("div", "graph-inner");
  inner.id = "graphInner";
  const colHome = (label, id, pt) => {
    const col = el("div", "graph-col graph-home-col");
    col.appendChild(el("h4", null, label));
    const n = el("div", "graph-node home", pt ? `${id === "home-end" && PLANNER.endSame === false ? "⚑" : "⌂"} ${pt.label}` : "⌂ (no start set)");
    n.dataset.nid = id;
    nodeEls.set(id, n);
    col.appendChild(n);
    return col;
  };
  if (PLANNER.start) inner.appendChild(colHome("Start", "home-start", PLANNER.start));

  const stopsNow = orderedStops();
  PLANNER.days.forEach((date) => {
    const k = dkey(date);
    const nodes = PLANNER.byDay.get(k) || [];
    const col = el("div", "graph-col" + (nodes.length ? "" : " graph-col-rest"));
    col.appendChild(el("h4", null, nodes.length ? formatDate(date) : formatDate(date).replace(/ \d{4}$/, "")));
    if (!nodes.length) col.appendChild(el("div", "graph-none", "rest day"));
    let hiddenClose = 0, hiddenOther = 0;
    const pickHere = PLANNER.chosen.get(k);
    if (pickHere) {
      const tog = el("button", "col-collapse", PLANNER.collapsed.has(k) ? "show all" : "only my pick");
      tog.type = "button";
      tog.setAttribute("aria-pressed", String(PLANNER.collapsed.has(k)));
      tog.addEventListener("click", () => { if (PLANNER.collapsed.has(k)) PLANNER.collapsed.delete(k); else PLANNER.collapsed.add(k); renderAll(); });
      col.appendChild(tog);
    }
    nodes.forEach((c) => {
      const st = nodeState(c, stopsNow);
      if (PLANNER.collapsed.has(k) && pickHere && pickHere.id !== c.id) { hiddenOther++; return; }
      if (st.hide) { hiddenClose++; return; }
      const v = venueOf(c) || {};
      const n = el("div", "graph-node" + (c.isAnchor ? " anchor" : "") + (c.must && c.must.length ? " must" : ""));
      n.dataset.nid = c.id;
      n.appendChild(el("div", "graph-node-name", c.name));
      n.appendChild(el("div", "graph-node-meta", [c.time, v.city || v.name].filter(Boolean).join(" · ")));
      if (c.note) n.appendChild(el("div", "graph-node-note", c.note));
      const h = homeLL();
      if (h) n.appendChild(el("div", "graph-node-home", `${fmtMiles(roadMiles(h, latlonOf(c)))} from start`));
      const legs = neighbourLegs(c, stopsNow);
      if (legs.prev) n.appendChild(el("div", "graph-node-leg", `← ${fmtMiles(legs.prev.miles)} from ${legs.prev.label}`));
      if (legs.next) n.appendChild(el("div", "graph-node-leg", `→ ${fmtMiles(legs.next.miles)} to ${legs.next.label}`));
      if (c.link && /^https?:\/\//i.test(c.link)) {
        const a = el("a", "graph-node-link", "details ↗");
        a.href = c.link; a.target = "_blank"; a.rel = "noopener noreferrer";
        a.addEventListener("click", (e) => e.stopPropagation());
        n.appendChild(a);
      }
      const ch = PLANNER.chosen.get(k);
      if (ch && ch.id === c.id) n.classList.add("chosen");
      const near = !c.isAnchor && !(ch && ch.id === c.id) ? st.near : null;
      if (near) {
        n.classList.add("too-close");
        n.appendChild(el("div", "graph-node-note", `⛔ within ${PLANNER.minSpread} mi of ${near.name}`));
      }
      const used = !near && st.used;
      if (used) {
        n.classList.add("too-close");
        n.appendChild(el("div", "graph-node-note", `⛔ already on the tour (${formatDate(used.date).replace(/ \d{4}$/, "")})`));
      }
      if (!near && !used && st.unreach && PLANNER.reachMode === "grey") {
        n.classList.add("out-of-range");
        n.appendChild(el("div", "graph-node-note", "out of range of your picks"));
      }
      if (PLANNER.showBest && PLANNER.best && PLANNER.best.stops.some((s) => s.id === c.id)) n.classList.add("on-best");
      if (!c.isAnchor && !near && !used) {
        n.tabIndex = 0;
        n.setAttribute("role", "button");
        const toggle = () => toggleNode(c);
        n.addEventListener("click", toggle);
        n.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
      }
      n.addEventListener("mouseenter", () => { PLANNER.hover = c.id; drawEdges(); markerHighlight(c.venue_id, true); });
      n.addEventListener("mouseleave", () => { PLANNER.hover = null; drawEdges(); markerHighlight(c.venue_id, false); });
      nodeEls.set(c.id, n);
      col.appendChild(n);
    });
    if (hiddenClose) col.appendChild(el("div", "graph-none", `${hiddenClose} hidden by the column filters`));
    if (hiddenOther) col.appendChild(el("div", "graph-none", `${hiddenOther} other option${hiddenOther > 1 ? "s" : ""} hidden`));
    col.addEventListener("scroll", () => { if (!PLANNER._edgeRaf) PLANNER._edgeRaf = requestAnimationFrame(() => { PLANNER._edgeRaf = 0; drawEdges(); }); }, { passive: true });
    inner.appendChild(col);
  });
  if (endPoint()) inner.appendChild(colHome(PLANNER.endSame === false ? "End" : "Return", "home-end", endPoint()));

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
    // a node scrolled out of its column keeps its line, pinned to the column's visible edge
    const cr = e.parentElement ? e.parentElement.getBoundingClientRect() : null;
    let y = r.top + r.height / 2;
    if (cr && cr.height > 0 && e.parentElement.classList.contains("graph-col")) y = Math.min(Math.max(y, cr.top + 28), cr.bottom - 6);
    return { x: (side === "r" ? r.right : r.left) - ir.left, y: y - ir.top };
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
      if (miles > PLANNER.maxHop * gap || miles < PLANNER.minHop) return;
      const bothChosen = chosenIds.has(m.id) && chosenIds.has(n.id);
      const touchesChosen = chosenIds.has(m.id) || chosenIds.has(n.id);
      const touchesHover = PLANNER.hover && (m.id === PLANNER.hover || n.id === PLANNER.hover);
      const isBest = PLANNER.showBest && bestPairs.has(m.id + ">" + n.id);
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
  if (PLANNER.best && PLANNER.showBest) extra(PLANNER.best.stops, "best");
  // home legs
  const h = homeLL();
  const stops = orderedStops();
  const he = endLL();
  if (stops.length) {
    if (h && nodeEls.get("home-start")) edge("home-start", stops[0].id, roadMiles(h, latlonOf(stops[0])), "home", true);
    const l = stops[stops.length - 1];
    if (he && nodeEls.get("home-end")) edge(l.id, "home-end", roadMiles(latlonOf(l), he), "home", true);
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
  const xbox = document.getElementById("plannerExport"); // export buttons live at the end of the page
  xbox.replaceChildren();
  xbox.hidden = true;
  if (!PLANNER.days.length) return;
  const stops = orderedStops();
  if (stops.length < 1) {
    box.appendChild(el("h3", null, "Your tour"));
    box.appendChild(el("p", "ts-hint", "No stops yet — click gigs in the columns below, or press “Use shortest route”."));
    return;
  }
  const home = homeLL(), endP = endPoint();
  const lines = [];
  let prev = home, prevStop = null;
  const warn = (leg, first, c) => {
    if (leg == null) return "";
    const w = [];
    if (first && leg > PLANNER.maxFirst) w.push(`over your ${PLANNER.maxFirst} mi limit from the start`);
    if (!first && prevStop) {
      const gap = Math.max(1, Math.round((c.date - prevStop.date) / 86400000));
      if (leg > PLANNER.maxHop * gap) w.push("longer than your max between gigs");
      if (leg < PLANNER.minHop) w.push(`closer than your ${PLANNER.minHop} mi minimum`);
    }
    return w.length ? "  ⚠ " + w.join("; ") : "";
  };
  stops.forEach((c, i) => {
    const ll = latlonOf(c);
    const leg = roadMiles(prev, ll);
    const v = venueOf(c) || {};
    lines.push(`${formatDate(c.date)}${c.time ? ", " + c.time : ""} — ${placeParts(c, v).join(", ")}` +
      (leg != null ? `  [${fmtMiles(leg)}, ${fmtDrive(leg)}]` : "") + warn(leg, i === 0, c));
    prev = ll; prevStop = c;
  });
  if (endP && prev) {
    const lastLeg = roadMiles(prev, [endP.lat, endP.lon]);
    if (lastLeg != null) lines.push(`${PLANNER.endSame !== false ? "Back at" : "Finish at"} ${endP.label}  [${fmtMiles(lastLeg)}, ${fmtDrive(lastLeg)}]` +
      (lastLeg > PLANNER.maxLast ? `  ⚠ over your ${PLANNER.maxLast} mi limit to the end` : ""));
  }
  box.appendChild(el("h3", null, "Your tour"));
  const ol = el("ol", "ts-list");
  lines.forEach((t) => ol.appendChild(el("li", null, t)));
  box.appendChild(ol);
  const total = routeMiles(stops);
  let msg = `Total${home || endP ? ` incl. journey${home ? " from " + PLANNER.start.label : ""}${endP ? (PLANNER.endSame !== false ? " and back" : " to " + endP.label) : ""}` : ""}: ${fmtMiles(total)} (${fmtDrive(total)} driving).`;
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
  xbox.hidden = false;
  xbox.appendChild(el("h3", null, "Take your tour away"));
  xbox.appendChild(el("p", "ts-hint", "Copy it, add it to a calendar, or download the data to build your own plan."));
  xbox.appendChild(copy);
  const ics = el("button", "btn-secondary", "📅 Download calendar (.ics)");
  ics.type = "button";
  ics.addEventListener("click", () => {
    let prevLL = home;
    TourSupport.downloadIcs(stops.map((c) => {
      const v = venueOf(c) || {};
      const ll = latlonOf(c);
      const leg = roadMiles(prevLL, ll);
      prevLL = ll;
      const proposed = c.kind === "venue";
      const href = c.link ? new URL(c.link, location.href).href : "";
      return {
        date: c.date, uid: c.id,
        title: (proposed ? "Gig (to arrange): " : "") + placeParts(c, v).join(", "),
        location: TourSupport.icsLocation(v),
        description: [c.time ? "Time: " + c.time : "", proposed ? "Proposed — not yet booked" : "",
          c.note || "", leg != null ? `Leg: ${fmtMiles(leg)}, ${fmtDrive(leg)}` : "", href].filter(Boolean).join("\n"),
      };
    }), "tour.ics", "Tour Planner");
  });
  const records = () => TourSupport.buildRecords(stops, (c) => {
    const v = venueOf(c) || {};
    const ll = latlonOf(c);
    const proposed = c.kind === "venue";
    return {
      title: c.name, kind: proposed ? "proposed venue" : c.kind, status: proposed ? "proposed" : "listed",
      venue: v.name, address: v.full_address || "", town: v.city || "", postcode: v.postcode || "",
      latitude: ll ? ll[0] : null, longitude: ll ? ll[1] : null,
      link: c.link ? new URL(c.link, location.href).href : "", notes: c.note || "",
    };
  }, home);
  const exp = el("span");
  TourSupport.addExportButtons(exp, {
    className: "btn-secondary", basename: "tour", getRecords: records,
    getMeta: () => ({ page: "tour_planner", start: PLANNER.start ? { label: PLANNER.start.label, latitude: PLANNER.start.lat, longitude: PLANNER.start.lon } : null }),
  });
  exp.querySelectorAll("button").forEach((b, i) => { b.style.marginRight = "8px"; });
  xbox.appendChild(ics);
  xbox.appendChild(exp);
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
  if (cur && cur.id === c.id) { PLANNER.chosen.delete(k); PLANNER.collapsed.delete(k); }
  else { PLANNER.chosen.set(k, c); if (PLANNER.autoCollapse) PLANNER.collapsed.add(k); }
  renderAll();
}

/** Highlight a venue's map marker while its gig card is hovered. */
function markerHighlight(vid, on) {
  const m = mapMarkers.get(vid);
  const e = m && m.getElement ? m.getElement() : null;
  if (e) e.classList.toggle("hl", on);
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
  mapMarkers = new Map();
  const allStops = orderedStops();
  const dayKey = PLANNER.mapDay && PLANNER.byDay.has(PLANNER.mapDay) ? PLANNER.mapDay : null;
  const dayDate = dayKey ? PLANNER.days.find((d) => dkey(d) === dayKey) : null;
  // previewing a day: only its own pick and (optionally) the nearest pick either side stay on the map
  let prevPick = null, nextPick = null;
  if (dayDate) allStops.forEach((s) => { if (dkey(s.date) === dayKey) return; if (s.date < dayDate) prevPick = s; else if (!nextPick) nextPick = s; });
  const stops = dayDate ? allStops.filter((s) => dkey(s.date) === dayKey || (PLANNER.mapSides && (s === prevPick || s === nextPick))) : allStops;
  const chosenIds = new Set(stops.map((c) => c.id));
  const pts = [];

  // Other possible venues: one grey marker per venue, labelled with the day
  // offset(s) it has a gig on. Click for the list of gigs and add/remove.
  const venuesWithStop = new Set(stops.map((c) => c.venue_id));
  const dayLines = [];
  const candPts = [];
  if (PLANNER.showCands) {
    const byVenue = new Map();
    PLANNER.days.forEach((d) => (dayKey && dkey(d) !== dayKey ? [] : PLANNER.byDay.get(dkey(d)) || []).forEach((c) => {
      if (!byVenue.has(c.venue_id)) byVenue.set(c.venue_id, []);
      byVenue.get(c.venue_id).push(c);
    }));
    byVenue.forEach((nodes0, vid) => {
      if (venuesWithStop.has(vid)) return; // shown as a numbered stop below
      const nodes = PLANNER.mapFollowsFilters ? nodes0.filter((c) => !nodeState(c, allStops).hide) : nodes0;
      if (!nodes.length) return;
      const ll = latlonOf(nodes[0]);
      candPts.push(ll);
      const labs = [...new Set([...nodes].sort((a, b) => a.date - b.date).map((c) => dayLabel(c.date)))];
      // small pin: the day offset when there is just one, else a count; full list on hover
      const short = labs.length === 1 ? labs[0] : `${labs.length}×`;
      const isMust = nodes.some((c) => c.must && c.must.length);
      const faded = nodes.every((c) => { const st = nodeState(c, allStops); return st.near || st.used || st.unreach; });
      const m = L.marker(ll, { icon: L.divIcon({ className: "ts-pin cand sm" + (isMust ? " must" : "") + (faded ? " faded" : ""), html: short, iconSize: [24, 24], iconAnchor: [12, 12] }) })
        .bindTooltip(`${(PLANNER.venues[vid] || {}).name || vid} — ${labs.join(" ")}`)
        .bindPopup(venuePopup(vid, nodes))
        .addTo(plannerMapLayer);
      mapMarkers.set(vid, m);
      m.on("mouseover", () => nodes.forEach((c) => { const e = nodeEls.get(c.id); if (e) e.classList.add("hl"); }));
      m.on("mouseout", () => nodes.forEach((c) => { const e = nodeEls.get(c.id); if (e) e.classList.remove("hl"); }));
    });
  }

  if (PLANNER.start) {
    const h = [PLANNER.start.lat, PLANNER.start.lon];
    if (!dayKey) pts.push(h);
    L.marker(h, { icon: L.divIcon({ className: "ts-pin home", html: "⌂", iconSize: [26, 26] }) })
      .bindTooltip(PLANNER.start.label).addTo(plannerMapLayer);
  }
  const ePt = endPoint();
  stops.forEach((c) => {
    const i = allStops.indexOf(c);
    const ll = latlonOf(c);
    pts.push(ll);
    const allHere = [];
    PLANNER.days.forEach((d) => (PLANNER.byDay.get(dkey(d)) || []).forEach((n) => { if (n.venue_id === c.venue_id) allHere.push(n); }));
    const sm = L.marker(ll, { icon: L.divIcon({ className: "ts-pin", html: String(i + 1), iconSize: [26, 26] }), zIndexOffset: 500 })
      .bindTooltip(`${i + 1}. ${c.name} — ${formatDate(c.date)}`)
      .bindPopup(venuePopup(c.venue_id, allHere.length ? allHere : [c]))
      .addTo(plannerMapLayer);
    mapMarkers.set(c.venue_id, sm);
  });
  if (ePt && stops.length) {
    const eLL = [ePt.lat, ePt.lon];
    if (!dayKey) pts.push(eLL);
    if (PLANNER.endSame === false) {
      L.marker(eLL, { icon: L.divIcon({ className: "ts-pin home", html: "⚑", iconSize: [26, 26] }) }).bindTooltip("End: " + ePt.label).addTo(plannerMapLayer);
    }
  }
  if (!dayKey && stops.length + (PLANNER.start ? 1 : 0) > 1) L.polyline(pts, { color: "#2e7d32", weight: 3, dashArray: "6 6" }).addTo(plannerMapLayer);
  if (dayKey && PLANNER.mapSides) {
    // thin lines from each option to the picks either side, with the miles on hover
    (PLANNER.byDay.get(dayKey) || []).forEach((c) => {
      if (PLANNER.mapFollowsFilters && nodeState(c, allStops).hide) return;
      [prevPick, nextPick].forEach((s) => {
        if (!s) return;
        const mi = roadMiles(latlonOf(s), latlonOf(c));
        L.polyline([latlonOf(s), latlonOf(c)], { color: "#757575", weight: 1.5, opacity: 0.55, dashArray: "3 5" })
          .bindTooltip(`${c.name}: ${fmtMiles(mi)} ${s === prevPick ? "from" : "to"} ${s.name}`).addTo(plannerMapLayer);
      });
    });
  }
  if (!dayKey && PLANNER.showBestOnMap && PLANNER.best && PLANNER.best.stops.length > 1) {
    L.polyline(PLANNER.best.stops.map(latlonOf), { color: "#f9a825", weight: 3, dashArray: "2 7" }).addTo(plannerMapLayer);
  }
  const all = pts.concat(candPts);
  if (all.length) plannerMap.fitBounds(L.latLngBounds(all).pad(0.2), { maxZoom: 11 });
}

/** Collapse buttons: start/end body, and the venue-discovery cards (with a one-line summary while collapsed). */
function setupCollapsibles() {
  const st = document.getElementById("startToggle"), body = document.getElementById("startBody");
  if (st && body) st.addEventListener("click", () => {
    const open = body.hidden; body.hidden = !open;
    st.setAttribute("aria-expanded", String(open)); st.textContent = open ? "Hide" : "Show";
  });
  const summaryOf = {
    blkPool: () => { const n = document.querySelectorAll("#poolPerfChips .picker-chip, #poolTourChips .picker-chip").length; const types = document.querySelectorAll("#blkPool .ts-checks input[type=checkbox]:checked:not(#poolWeekday)").length; return n || types ? `${n} artist/tour selection${n === 1 ? "" : "s"}${types ? ` + ${types} type-of-act option${types === 1 ? "" : "s"}` : ""}.` : "Nothing chosen yet."; },
    blkDates: () => {
      const v = (id) => document.getElementById(id).value;
      const f = (s) => { const d = s ? new Date(s + "T00:00:00") : null; return d && !isNaN(d) ? formatDate(d) : "?"; };
      return `${f(v("periodStart"))} to ${f(v("periodEnd"))} · ${v("gigsWanted") || "?"} gigs` + (document.getElementById("poolWeekday").checked ? " · usual weekdays only" : " · any weekday");
    },
    blkPoolPreview: () => (document.getElementById("poolSummary") || {}).textContent || "",
  };
  const sums = [];
  PLANNER._refreshSummaries = () => sums.forEach(([card, sum, fn]) => { if (card.classList.contains("collapsed")) sum.textContent = fn(); });
  ["periodStart", "periodEnd", "gigsWanted", "poolWeekday"].forEach((i) => {
    const n = document.getElementById(i);
    if (n) { n.addEventListener("input", () => PLANNER._refreshSummaries()); n.addEventListener("change", () => PLANNER._refreshSummaries()); }
  });
  Object.keys(summaryOf).forEach((id) => {
    const card = document.getElementById(id), btn = card && card.querySelector(".flow-collapse");
    if (!btn) return;
    const sum = el("div", "flow-summary ts-hint"); sum.hidden = true;
    card.querySelector(":scope > h3").after(sum);
    sums.push([card, sum, summaryOf[id]]);
    btn.addEventListener("click", () => {
      const collapse = !card.classList.contains("collapsed");
      card.classList.toggle("collapsed", collapse);
      sum.hidden = !collapse; if (collapse) sum.textContent = summaryOf[id]();
      btn.setAttribute("aria-expanded", String(!collapse)); btn.textContent = collapse ? "Expand" : "Collapse";
      if (!collapse && poolMap) setTimeout(() => poolMap.invalidateSize(), 50);
    });
  });
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
    const clearBtn = document.getElementById("startClear");
    if (clearBtn) clearBtn.style.display = "";
  }
  syncEndSame();
  setupCollapsibles();
  document.getElementById("anchorVenue").addEventListener("change", fillAnchorDates);
  document.querySelectorAll("#eventKinds input").forEach((cb) => cb.addEventListener("change", () => {
    PLANNER._venueRows = null;
    if (currentMode() === "venue") { buildVenueRows(); fillAnchorDates(); }
    if (PLANNER.days.length) clearResults();
  }));
  document.getElementById("startFind").addEventListener("click", onFindStart);
  document.getElementById("startInput").addEventListener("keydown", (e) => { if (e.key === "Enter") onFindStart(); });
  document.getElementById("startLocate").addEventListener("click", onUseLocation);
  document.getElementById("startClear").addEventListener("click", clearStart);
  document.getElementById("buildTour").addEventListener("click", onBuild);
  document.getElementById("endSame").addEventListener("change", onEndSameChange);
  document.getElementById("endFind").addEventListener("click", () => findPlace("endInput", "endChoices", setEnd));
  document.getElementById("endInput").addEventListener("keydown", (e) => { if (e.key === "Enter") findPlace("endInput", "endChoices", setEnd); });
  document.getElementById("endClear").addEventListener("click", () => { setEnd(null); document.getElementById("endInput").value = ""; });
  const rad = document.getElementById("areaRadius");
  rad.addEventListener("input", () => { rad.dataset.touched = "1"; if (currentMode() === "pool") renderPoolMap(false); });
  ["anchorClub", "anchorVenue", "anchorDate", "anchorMonth"].forEach((id) => {
    document.getElementById(id).addEventListener("change", () => { if (PLANNER.days.length) clearResults(); });
  });
  document.getElementById("anchorMonth").addEventListener("change", fillAnchorDates);
  ["maxHop", "minHop", "minScope", "maxHome", "minSpread", "poolDistinct", "daysBefore", "daysAfter",
    "periodStart", "periodEnd", "gigsWanted", "areaRadius", "poolWeekday", "maxFirst", "maxLast", "endSame"].forEach((id) => {
    const e = document.getElementById(id);
    e.addEventListener(e.type === "checkbox" || e.tagName === "SELECT" ? "change" : "input", liveRebuild);
  });
  attachDualRange();
  { // the weekday rule is also offered beside the map once a tour is built; the two boxes stay in step
    const a = document.getElementById("poolWeekday"), b = document.getElementById("poolWeekdayLive");
    a.addEventListener("change", () => { b.checked = a.checked; });
    b.addEventListener("change", () => { a.checked = b.checked; a.dispatchEvent(new Event("change", { bubbles: true })); });
  }
  document.getElementById("plannerMode").addEventListener("change", setMode);
  document.querySelectorAll('input[name="buildMode"]').forEach((r) => r.addEventListener("change", () => {
    if (!r.checked) return;
    const sel = document.getElementById("plannerMode");
    sel.value = r.value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }));
  document.getElementById("areaFind").addEventListener("click", () => findPlace("areaInput", "areaChoices", setArea));
  document.getElementById("areaInput").addEventListener("keydown", (e) => { if (e.key === "Enter") findPlace("areaInput", "areaChoices", setArea); });
  document.getElementById("areaClear").addEventListener("click", () => { setArea(null); document.getElementById("areaInput").value = ""; });
  const t0 = addDays(getTodayMidnight(), 1);
  document.getElementById("periodStart").value = dkey(t0);
  document.getElementById("periodEnd").value = dkey(addDays(t0, 6));
  setMode();
  // optional "Explain this step" text, kept in tour_planner_help.json (one record per step)
  TourSupport.setupHelp("tour_planner_help.json", currentMode).then((h) => { PLANNER._help = h; });
  document.getElementById("plannerLoading").style.display = "none";
  document.getElementById("plannerForm").style.display = "";
}
document.addEventListener("DOMContentLoaded", initPlanner);
