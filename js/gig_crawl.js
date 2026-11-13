/**
 * gig_crawl.js — fan-facing "gig crawl" planner.
 *
 * Pick a period, pick a gig you want to go to, and see other events on the
 * nights either side within reach of it; add the ones you fancy to build a
 * short trip with an itinerary, map and calendar download.
 *
 * Reads events_normalized.json via shared_utils.js's loadEventsData().
 * Sources: story clubs / folk nights / sessions (recurring, via
 * RecurrenceEngine), specificEvents, musicEvents, poetryEvents and every
 * tour date. Geocoding: postcodes.io (browser-callable).
 *
 * NB: the distance/geocode/Leaflet helpers deliberately mirror
 * tour_planner.js; they could move into a shared file later.
 */

const GC_GEO_API = "https://api.postcodes.io";
const GC_START_KEY = "tourPlannerStart"; // shared with the tour planner
const GC_LEAFLET_JS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js";
const GC_LEAFLET_CSS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css";
const GC_ROAD = 1.3, GC_MPH = 45, GC_KM_MI = 0.621371;
const GC_UK = { latMin: 49, latMax: 61, lonMin: -11, lonMax: 2.5 };
const GC_CAT = { story: "📖 Story", music: "🎸 Music", poetry: "✒️ Poetry", folk: "🎻 Folk" };

const GC = {
  data: null, venues: {}, events: [], shown: [],
  start: null, anchor: null,
  before: 2, after: 2, radius: 40,
  chosen: new Map(), // dateKey -> event
  limit: 120,
};
let gcMap = null, gcLayer = null, gcLeafletP = null;

// ── helpers ─────────────────────────────────────────────────────────────
function gEl(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
const gKey = (d) => formatDateForInput(d);
function gAdd(d, n) { const r = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); r.setHours(0, 0, 0, 0); return r; }
function gParseInput(v) { if (!v) return null; const [y, m, d] = v.split("-").map(Number); return new Date(y, m - 1, d); }
function gLL(e) { const v = GC.venues[e.venue_id]; return v && Array.isArray(v.latlon) ? v.latlon : null; }
function gHome() { return GC.start ? [GC.start.lat, GC.start.lon] : null; }
function gMiles(a, b) { return a && b ? haversineKm(a[0], a[1], b[0], b[1]) * GC_KM_MI * GC_ROAD : null; }
function gFmtMi(m) { return m == null ? "?" : `${Math.round(m)} mi`; }
function gFmtDrive(m) {
  if (m == null) return "";
  const mins = Math.round((m / GC_MPH) * 60), h = Math.floor(mins / 60);
  return h ? `~${h}h ${String(mins % 60).padStart(2, "0")}m` : `~${mins}m`;
}
function gStatus(msg, err) { const s = document.getElementById("gcStatus"); s.textContent = msg || ""; s.className = "gc-status" + (err ? " error" : ""); }
function gVenueOk(vid) {
  const v = GC.venues[vid];
  if (!v || !Array.isArray(v.latlon) || v.isClosedDown) return false;
  if (/online|zoom/i.test(`${vid} ${v.name || ""} ${v.city || ""}`)) return false;
  const [la, lo] = v.latlon;
  return la >= GC_UK.latMin && la <= GC_UK.latMax && lo >= GC_UK.lonMin && lo <= GC_UK.lonMax;
}
function gIds(e) {
  const a = (x) => (Array.isArray(x) ? x : typeof x === "string" && x ? [x] : []);
  return [e.performer_id, ...a(e.performer_ids), ...a(e.other_performer_ids)].filter(Boolean);
}
function gPerformers(e) {
  const P = GC.data.performers || {};
  const names = gIds(e).map((id) => (P[id] ? P[id].name : null)).filter(Boolean);
  return names.length ? names.join(", ") : (typeof e.performer === "string" ? e.performer : "");
}
function gPlace(v) {
  return [v.name, v.city && !String(v.name || "").toLowerCase().includes(String(v.city).toLowerCase()) ? v.city : ""].filter(Boolean).join(", ");
}
function gEventUrl(rec, date) {
  try {
    const id = rec.eventId || resolveEventId(rec, date);
    return id ? `event.html?event=${encodeURIComponent(id)}` : "";
  } catch (e) { return ""; }
}

// ── collecting every event in a window ──────────────────────────────────
function gCollect(from, to) {
  const ed = GC.data;
  const out = [];
  const push = (ev) => { if (gVenueOk(ev.venue_id)) out.push(ev); };

  const recurring = [["clubs", "story"], ["folkNights", "folk"], ["irishSessions", "folk"]];
  recurring.forEach(([list, cat]) => (ed[list] || []).forEach((rec) => {
    if (!rec.schedule) return;
    RecurrenceEngine.scheduledOccurrencesInRange(rec.schedule, from, to, rec.exceptions || []).forEach((o) => {
      if (o.status === "cancelled" || o.status === "moved_from") return;
      if (typeof clubIsActiveOn === "function" && list === "clubs" && !clubIsActiveOn(rec, o.date)) return;
      push({
        id: `rec:${list}:${rec.club || rec.folk_id || rec.name}:${gKey(o.date)}`, cat, kind: "recurring",
        title: rec.name, performer: "", date: o.date, time: rec.time || "",
        venue_id: list === "clubs" ? resolveClubVenueId(rec, o.date) : rec.venue_id,
        url: rec.club ? `storyclub.html?club=${encodeURIComponent(rec.club)}` : "",
        ext: rec.link || rec.facebook || "", price: rec.price || "", soldOut: false,
      });
    });
  }));

  const dated = [["specificEvents", "story"], ["musicEvents", "music"], ["poetryEvents", "poetry"]];
  dated.forEach(([list, cat]) => (ed[list] || []).forEach((e) => {
    const d = parseDateString(e.date);
    if (!d || d < from || d > to || e.online || e.cancelled || e.isCancelled) return;
    push({
      id: `ev:${e.eventId || e.name + gKey(d)}`, cat: e.isMusic ? "music" : e.isPoetry ? "poetry" : cat, kind: "event",
      title: e.showname || e.name, performer: gPerformers(e), date: d, time: e.time || "",
      venue_id: e.venue_id, url: gEventUrl(e, d), ext: e.ticket_url || e.event_url || e.fb_event || e.link || "",
      price: e.price || "", soldOut: !!e.isSoldOut,
    });
  }));

  Object.values(ed.tours || {}).forEach((t) => (t.tour_dates || []).forEach((td) => {
    const d = parseDateString(td.date);
    if (!d || d < from || d > to || td.cancelled || td.isCancelled) return;
    push({
      id: `ev:${td.eventId || (t.tour_name || t.name) + gKey(d) + td.venue_id}`,
      cat: t.isMusic ? "music" : t.isPoetry ? "poetry" : "story", kind: "event",
      title: t.tour_name || t.name, performer: gPerformers({ ...t, ...td }), date: d, time: td.time || t.time || "",
      venue_id: td.venue_id, url: gEventUrl(td, d), ext: td.ticket_url || td.fb_event || "",
      price: td.price || t.price || "", soldOut: !!td.isSoldOut,
    });
  }));

  // De-duplicate: the same gig can appear as a tour date AND a specific event,
  // or as a one-off on top of a club's regular night. Keep the richer record.
  const seen = new Map();
  out.sort((a, b) => (a.kind === "event" ? 0 : 1) - (b.kind === "event" ? 0 : 1));
  const keep = [];
  out.forEach((ev) => {
    const k1 = ev.id;
    const k2 = `${ev.venue_id}|${gKey(ev.date)}`;
    if (seen.has(k1)) return;
    const prior = seen.get(k2);
    if (prior && (ev.kind === "recurring" || prior.title.toLowerCase() === ev.title.toLowerCase())) return;
    seen.set(k1, ev); seen.set(k2, ev);
    keep.push(ev);
  });
  return keep.sort((a, b) => a.date - b.date || a.title.localeCompare(b.title));
}

// ── filters ─────────────────────────────────────────────────────────────
function gCats() {
  return new Set([...document.querySelectorAll("#gcCats input:checked")].map((i) => i.value));
}
function gPasses(ev, cats, maxHome) {
  if (!cats.has(ev.cat)) return false;
  const h = gHome();
  if (maxHome && h) { const m = gMiles(h, gLL(ev)); if (m != null && m > maxHome) return false; }
  return true;
}

// ── geocoding ───────────────────────────────────────────────────────────
const GC_PC = /^[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}$/;
const GC_OC = /^[A-Za-z]{1,2}\d[A-Za-z\d]?$/;
async function gGeoJson(path) {
  const r = await fetch(`${GC_GEO_API}${path}`);
  if (!r.ok && r.status !== 404) throw new Error(`Lookup failed (HTTP ${r.status})`);
  return r.status === 404 ? null : r.json();
}
async function gGeocode(text) {
  const q = text.trim();
  if (!q) return [];
  if (GC_PC.test(q)) {
    const j = await gGeoJson(`/postcodes/${encodeURIComponent(q.replace(/\s+/g, ""))}`);
    return j && j.result && j.result.latitude != null ? [{ lat: j.result.latitude, lon: j.result.longitude, label: j.result.postcode }] : [];
  }
  if (GC_OC.test(q)) {
    const j = await gGeoJson(`/outcodes/${encodeURIComponent(q)}`);
    if (j && j.result && j.result.latitude != null) return [{ lat: j.result.latitude, lon: j.result.longitude, label: j.result.outcode }];
  }
  const j = await gGeoJson(`/places?q=${encodeURIComponent(q)}&limit=8`);
  return ((j && j.result) || []).filter((p) => p.latitude != null)
    .map((p) => ({ lat: p.latitude, lon: p.longitude, label: [...new Set([p.name_1, p.county_unitary || p.region].filter(Boolean))].join(", ") }));
}
function gSetStart(s) {
  GC.start = s;
  try { localStorage.setItem(GC_START_KEY, JSON.stringify(s)); } catch (e) { /* optional */ }
  document.getElementById("gcStartCurrent").textContent = s ? `Start: ${s.label}` : "";
  gRenderAll();
}
async function gFindStart() {
  const list = document.getElementById("gcStartChoices");
  list.replaceChildren();
  gStatus("Looking up location…");
  try {
    const res = await gGeocode(document.getElementById("gcStartInput").value);
    if (!res.length) return gStatus("No match found — try a postcode or a nearby larger town.", true);
    gStatus("");
    if (res.length === 1) return gSetStart(res[0]);
    list.appendChild(gEl("div", "gc-hint", "Did you mean…"));
    res.forEach((r) => {
      const b = gEl("button", "gc-choice", r.label);
      b.type = "button";
      b.addEventListener("click", () => { list.replaceChildren(); gSetStart(r); });
      list.appendChild(b);
    });
  } catch (e) { gStatus(`${e.message}. You can still browse without a start point.`, true); }
}
function gLocate() {
  if (!navigator.geolocation) return gStatus("Location isn't available in this browser.", true);
  gStatus("Asking for your location…");
  navigator.geolocation.getCurrentPosition(
    (p) => { gStatus(""); gSetStart({ lat: p.coords.latitude, lon: p.coords.longitude, label: "My location" }); },
    () => gStatus("Couldn't get your location.", true), { timeout: 10000 });
}

// ── period / reload ─────────────────────────────────────────────────────
function gReload() {
  const today = getTodayMidnight();
  let from = gParseInput(document.getElementById("gcFrom").value) || today;
  let to = gParseInput(document.getElementById("gcTo").value) || gAdd(from, 13);
  if (from < today) from = today;
  if (to < from) { gStatus("The end date is before the start date.", true); return; }
  if ((to - from) / 86400000 > 59) { to = gAdd(from, 59); gStatus("Period limited to 60 days."); } else gStatus("");
  // pad by the nights-around window so neighbours of edge gigs are available
  GC.periodFrom = from; GC.periodTo = to;
  const padFrom = gAdd(from, -(GC.before + 1));
  GC.events = gCollect(padFrom < today ? today : padFrom, gAdd(to, GC.after + 1));
  gRenderAll();
}

// ── cards ───────────────────────────────────────────────────────────────
function gCard(ev, opts) {
  const v = GC.venues[ev.venue_id] || {};
  const card = gEl("div", `gc-card ${ev.cat}` + (opts.anchor ? " anchor" : "") + (opts.chosen ? " chosen" : "") + (ev.soldOut ? " soldout" : ""));
  const t = gEl("div", "gc-card-title", ev.title);
  t.appendChild(gEl("span", "gc-badge", GC_CAT[ev.cat] || ev.cat));
  if (ev.soldOut) t.appendChild(gEl("span", "gc-badge", "sold out"));
  card.appendChild(t);
  if (ev.performer) card.appendChild(gEl("div", "gc-card-perf", ev.performer));
  card.appendChild(gEl("div", "gc-card-meta", [opts.showDate ? formatDate(ev.date) : "", ev.time, gPlace(v)].filter(Boolean).join(" · ")));
  const dist = [];
  if (opts.hop != null) dist.push(`${gFmtMi(opts.hop)} (${gFmtDrive(opts.hop)}) from ${opts.refName || "previous stop"}`);
  const h = gHome();
  if (h) dist.push(`${gFmtMi(gMiles(h, gLL(ev)))} from home`);
  if (dist.length) card.appendChild(gEl("div", "gc-card-dist", dist.join(" · ")));
  const act = gEl("div", "gc-card-actions");
  const href = ev.url || (/^https?:\/\//i.test(ev.ext) ? ev.ext : "");
  if (href) {
    const a = gEl("a", null, "details ↗"); a.href = href;
    if (/^https?:/i.test(href)) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
    act.appendChild(a);
  }
  if (opts.button) {
    const b = gEl("button", "gc-btn", opts.button.label); b.type = "button";
    b.addEventListener("click", opts.button.fn); act.appendChild(b);
  }
  card.appendChild(act);
  return card;
}

// ── rendering ───────────────────────────────────────────────────────────
function gRenderAll() {
  gRenderBrowse();
  gRenderNearby();
  gRenderPlan();
}

function gRenderBrowse() {
  const box = document.getElementById("gcBrowse");
  box.replaceChildren();
  if (!GC.periodFrom) return;
  const cats = gCats();
  const maxHome = parseInt(document.getElementById("gcMaxHome").value, 10) || 0;
  const q = document.getElementById("gcSearch").value.trim().toLowerCase();
  let list = GC.events.filter((e) => e.date >= GC.periodFrom && e.date <= GC.periodTo && gPasses(e, cats, maxHome));
  if (q) list = list.filter((e) => `${e.title} ${e.performer} ${(GC.venues[e.venue_id] || {}).name} ${(GC.venues[e.venue_id] || {}).city}`.toLowerCase().includes(q));
  if (!list.length) { box.appendChild(gEl("p", "gc-hint", "No events match — try widening the dates, categories or distance.")); return; }
  const total = list.length;
  list = list.slice(0, GC.limit);
  let lastKey = "", grid = null;
  list.forEach((ev) => {
    const k = gKey(ev.date);
    if (k !== lastKey) {
      box.appendChild(gEl("h4", "gc-date-head", formatDate(ev.date)));
      grid = gEl("div", "gc-browse-grid"); box.appendChild(grid); lastKey = k;
    }
    const isAnchor = GC.anchor && GC.anchor.id === ev.id;
    grid.appendChild(gCard(ev, {
      anchor: isAnchor,
      button: { label: isAnchor ? "★ Your gig" : "Plan around this gig", fn: () => gSetAnchor(ev) },
    }));
  });
  if (total > list.length) {
    const more = gEl("button", "gc-btn", `Show more (${total - list.length} not shown)`); more.type = "button";
    more.addEventListener("click", () => { GC.limit += 120; gRenderBrowse(); });
    box.appendChild(more);
  }
}

function gSetAnchor(ev) {
  GC.anchor = ev;
  GC.chosen = new Map([[gKey(ev.date), ev]]);
  // make sure neighbours are loaded for this anchor even if near the period edge
  const from = gAdd(ev.date, -GC.before - 1), to = gAdd(ev.date, GC.after + 1);
  const today = getTodayMidnight();
  GC.events = gCollect(from < today ? today : from, to).concat(GC.events.filter((e) => e.date >= GC.periodFrom && e.date <= GC.periodTo))
    .reduce((acc, e) => (acc.some((x) => x.id === e.id) ? acc : (acc.push(e), acc)), [])
    .sort((a, b) => a.date - b.date || a.title.localeCompare(b.title));
  gRenderAll();
  document.getElementById("gcSummaryRow").scrollIntoView({ behavior: "smooth", block: "start" });
}

function gRefFor(date) {
  const a = GC.anchor.date, step = date < a ? 1 : -1;
  for (let d = gAdd(date, step); step > 0 ? d <= a : d >= a; d = gAdd(d, step)) {
    const c = GC.chosen.get(gKey(d));
    if (c) return c;
  }
  return GC.anchor;
}

function gRenderNearby() {
  const sec = document.getElementById("gcNearby");
  sec.replaceChildren();
  if (!GC.anchor) { sec.hidden = true; return; }
  sec.hidden = false;
  sec.appendChild(gEl("h3", null, "Add more nights around your gig"));
  const ctl = gEl("div", "gc-grid");
  const mk = (label, id, val, min, max) => {
    const l = gEl("label", "gc-field", label);
    const i = gEl("input"); i.type = "number"; i.id = id; i.min = min; i.max = max; i.value = val;
    i.addEventListener("change", () => {
      GC.before = Math.min(7, Math.max(0, parseInt(document.getElementById("gcBefore").value, 10) || 0));
      GC.after = Math.min(7, Math.max(0, parseInt(document.getElementById("gcAfter").value, 10) || 0));
      GC.radius = Math.min(300, Math.max(5, parseInt(document.getElementById("gcRadius").value, 10) || 40));
      gSetAnchor(GC.anchor);
    });
    l.appendChild(i); return l;
  };
  ctl.append(mk("Nights before", "gcBefore", GC.before, 0, 7), mk("Nights after", "gcAfter", GC.after, 0, 7), mk("Within … miles of the previous stop", "gcRadius", GC.radius, 5, 300));
  sec.appendChild(ctl);
  sec.appendChild(gEl("p", "gc-hint", "Add one event per night. Distances are measured from your nearest chosen stop towards the gig you picked."));

  const cats = gCats();
  const maxHome = parseInt(document.getElementById("gcMaxHome").value, 10) || 0;
  const row = gEl("div", "gc-nights");
  for (let i = -GC.before; i <= GC.after; i++) {
    const date = gAdd(GC.anchor.date, i), k = gKey(date);
    if (date < getTodayMidnight()) continue; // can't go to a night that's gone
    const col = gEl("div", "gc-night" + (i === 0 ? " anchor" : ""));
    col.appendChild(gEl("h4", null, formatDate(date) + (i === 0 ? "  ★" : "")));
    if (i === 0) {
      col.appendChild(gCard(GC.anchor, { anchor: true }));
    } else {
      const ref = gRefFor(date), refLL = gLL(ref);
      col.appendChild(gEl("div", "gc-ref", `from ${ref.title}`));
      const cands = GC.events.filter((e) => gKey(e.date) === k && gPasses(e, cats, maxHome))
        .map((e) => ({ e, hop: gMiles(refLL, gLL(e)) }))
        .filter((x) => x.hop != null && x.hop <= GC.radius)
        .sort((a, b) => a.hop - b.hop);
      if (!cands.length) col.appendChild(gEl("div", "gc-none", `Nothing within ${GC.radius} mi`));
      cands.forEach(({ e, hop }) => {
        const on = GC.chosen.get(k) && GC.chosen.get(k).id === e.id;
        col.appendChild(gCard(e, {
          chosen: on, hop, refName: ref.title,
          button: { label: on ? "✓ In plan (remove)" : "Add to plan", fn: () => { if (on) GC.chosen.delete(k); else GC.chosen.set(k, e); gRenderAll(); } },
        }));
      });
    }
    row.appendChild(col);
  }
  sec.appendChild(row);
}

function gStops() {
  if (!GC.anchor) return [];
  const out = [];
  for (let i = -GC.before; i <= GC.after; i++) { const c = GC.chosen.get(gKey(gAdd(GC.anchor.date, i))); if (c) out.push(c); }
  return out;
}

function gStopLine(c, leg) {
  const v = GC.venues[c.venue_id] || {};
  return `${formatDate(c.date)}${c.time ? ", " + c.time : ""} — ${c.title}${c.performer ? " (" + c.performer + ")" : ""}, ${gPlace(v)}` +
    (leg != null ? `  [${gFmtMi(leg)}, ${gFmtDrive(leg)}]` : "");
}

function gRenderPlan() {
  const row = document.getElementById("gcSummaryRow");
  const box = document.getElementById("gcPlan");
  box.replaceChildren();
  if (!GC.anchor) { row.hidden = true; return; }
  row.hidden = false;
  const stops = gStops(), home = gHome();
  box.appendChild(gEl("h3", null, "Your trip"));
  const ol = gEl("ol", "gc-list");
  const lines = [];
  let prev = home, total = 0;
  stops.forEach((c) => {
    const ll = gLL(c), leg = gMiles(prev, ll);
    if (leg != null) total += leg;
    const line = gStopLine(c, leg); lines.push(line);
    ol.appendChild(gEl("li", null, line));
    prev = ll;
  });
  box.appendChild(ol);
  if (home) total += gMiles(prev, home) || 0;
  const info = stops.length > 1 || home
    ? `Travel${home ? ` from and back to ${GC.start.label}` : " between stops"}: about ${gFmtMi(total)} (${gFmtDrive(total)} driving). `
    : "";
  box.appendChild(gEl("p", "gc-total", info + "Estimates only — check a route planner, and the event's own page for times and booking."));
  const act = gEl("div", "gc-actions");
  const copy = gEl("button", "gc-btn", "📋 Copy plan"); copy.type = "button";
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(lines.join("\n")); copy.textContent = "Copied ✓"; } catch (e) { copy.textContent = "Copy failed"; }
  });
  const ics = gEl("button", "gc-btn", "📅 Download calendar (.ics)"); ics.type = "button";
  ics.addEventListener("click", () => gDownloadIcs(stops));
  const reset = gEl("button", "gc-btn", "Start again"); reset.type = "button";
  reset.addEventListener("click", () => { GC.anchor = null; GC.chosen = new Map(); gRenderAll(); window.scrollTo({ top: 0, behavior: "smooth" }); });
  act.append(copy, ics, reset);
  box.appendChild(act);
  gRenderMap(stops);
}

function gIcsEsc(s) { return String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n"); }
function gDownloadIcs(stops) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//New Troubadours//Gig Crawl//EN", "CALSCALE:GREGORIAN"];
  stops.forEach((c, i) => {
    const v = GC.venues[c.venue_id] || {};
    const href = c.url ? new URL(c.url, location.href).href : c.ext;
    L.push("BEGIN:VEVENT", `UID:gigcrawl-${i}-${ymd(c.date)}-${encodeURIComponent(c.id).slice(0, 40)}@newtroubadours`,
      `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${ymd(c.date)}`, `DTEND;VALUE=DATE:${ymd(gAdd(c.date, 1))}`,
      `SUMMARY:${gIcsEsc(c.title)}`, `LOCATION:${gIcsEsc([v.name, v.full_address || v.city].filter(Boolean).join(", "))}`,
      `DESCRIPTION:${gIcsEsc([c.time ? "Time: " + c.time : "", c.performer, href].filter(Boolean).join("\n"))}`, "END:VEVENT");
  });
  L.push("END:VCALENDAR");
  const blob = new Blob([L.join("\r\n")], { type: "text/calendar" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "gig-crawl.ics";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ── map ─────────────────────────────────────────────────────────────────
function gLoadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (gcLeafletP) return gcLeafletP;
  gcLeafletP = new Promise((resolve, reject) => {
    const css = document.createElement("link"); css.rel = "stylesheet"; css.href = GC_LEAFLET_CSS; document.head.appendChild(css);
    const s = document.createElement("script"); s.src = GC_LEAFLET_JS; s.async = true;
    s.onload = () => resolve(window.L); s.onerror = () => reject(new Error("Leaflet could not be loaded"));
    document.head.appendChild(s);
  });
  return gcLeafletP;
}
async function gRenderMap(stops) {
  const wrap = document.getElementById("gcMapWrap");
  if (!stops.length) { wrap.style.display = "none"; return; }
  wrap.style.display = "";
  try { await gLoadLeaflet(); } catch (e) { wrap.style.display = "none"; return; }
  if (!gcMap) gcMap = initMap("gcMap");
  gcMap.invalidateSize();
  if (gcLayer) gcLayer.remove();
  gcLayer = L.layerGroup().addTo(gcMap);
  const pts = [], h = gHome();
  if (h) { pts.push(h); L.marker(h, { icon: L.divIcon({ className: "gc-pin home", html: "⌂", iconSize: [26, 26] }) }).bindTooltip(GC.start.label).addTo(gcLayer); }
  stops.forEach((c, i) => {
    const ll = gLL(c); pts.push(ll);
    L.marker(ll, { icon: L.divIcon({ className: "gc-pin" + (GC.anchor && c.id === GC.anchor.id ? " anchor" : ""), html: String(i + 1), iconSize: [26, 26] }) })
      .bindTooltip(`${i + 1}. ${c.title} — ${formatDate(c.date)}`).addTo(gcLayer);
  });
  if (pts.length > 1) L.polyline(pts, { color: "#2e7d32", weight: 3, dashArray: "6 6" }).addTo(gcLayer);
  gcMap.fitBounds(L.latLngBounds(pts).pad(0.25), { maxZoom: 11 });
}

// ── init ────────────────────────────────────────────────────────────────
async function gInit() {
  const res = await loadEventsData();
  if (!res) { document.getElementById("gcLoading").textContent = "Couldn't load events data."; return; }
  GC.data = res.eventsData; GC.venues = res.venuesLookup || {};
  try {
    const s = JSON.parse(localStorage.getItem(GC_START_KEY) || "null");
    if (s && typeof s.lat === "number") { GC.start = s; document.getElementById("gcStartCurrent").textContent = `Start: ${s.label}`; }
  } catch (e) { /* ignore */ }
  const t0 = getTodayMidnight();
  document.getElementById("gcFrom").value = gKey(t0);
  document.getElementById("gcTo").value = gKey(gAdd(t0, 13));
  ["gcFrom", "gcTo"].forEach((id) => document.getElementById(id).addEventListener("change", gReload));
  document.getElementById("gcMaxHome").addEventListener("change", gRenderAll);
  document.querySelectorAll("#gcCats input").forEach((i) => i.addEventListener("change", gRenderAll));
  document.getElementById("gcSearch").addEventListener("input", () => { GC.limit = 120; gRenderBrowse(); });
  document.getElementById("gcStartFind").addEventListener("click", gFindStart);
  document.getElementById("gcStartInput").addEventListener("keydown", (e) => { if (e.key === "Enter") gFindStart(); });
  document.getElementById("gcStartLocate").addEventListener("click", gLocate);
  document.getElementById("gcLoading").style.display = "none";
  document.getElementById("gcApp").style.display = "";
  gReload();
}
document.addEventListener("DOMContentLoaded", gInit);
