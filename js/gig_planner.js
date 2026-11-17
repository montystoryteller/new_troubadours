/**
 * gig_planner.js — fan-facing gig planner.
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
 * Shared helpers (distance, geocoding, Leaflet loader, export, help text) live in
 * tour_support.js, shared with tour_planner.js. Pure event helpers (bill roles, troupes,
 * multi-night runs) live in event_helpers.js, which only this page loads.
 *
 * This page keeps its own remembered place (key below) and never reads, writes or clears
 * the tour planner's saved start point.
 */

const GC_CAT = { story: "📖 Story", music: "🎸 Music", poetry: "✒️ Poetry", folk: "🎻 Folk" };

const GC = {
  data: null, venues: {}, events: [], shown: [],
  start: null, anchor: null,
  before: 2, after: 2, radius: 40,
  chosen: new Map(), // dateKey -> event
  filters: new Set(), // active night filters: "g:clubs", "g:folk", "p:<performer>"
  browseOpen: false, // after a gig is picked the results collapse to one line; this reopens them
  entry: null, // which starting point was chosen ("gig" | "place" | "dates"); lets a help record vary by it
  help: null, // handle from TourSupport.setupHelp ("Explain this step")
  day: null, // results narrowed to one date (a "YYYY-MM-DD" key), from the day strip
  venueByLabel: new Map(), // typed venue name -> venue, so "Near" accepts a venue as well as a town
  limit: 120,
};
let gcMap = null, gcLayer = null;

// ── helpers ─────────────────────────────────────────────────────────────
const gEl = el; // shared_utils.js
const gKey = TourSupport.dateKey;
const gAdd = TourSupport.addDays;
const gMiles = TourSupport.roadMiles;
const gFmtMi = TourSupport.fmtMiles;
const gFmtDrive = TourSupport.fmtDrive;
const gPlace = TourSupport.placeLabel;
function gParseInput(v) { if (!v) return null; const [y, m, d] = v.split("-").map(Number); return new Date(y, m - 1, d); }
function gLL(e) { const v = GC.venues[e.venue_id]; return v && Array.isArray(v.latlon) ? v.latlon : null; }
function gHome() { return GC.start ? [GC.start.lat, GC.start.lon] : null; }
function gShortDate(d) { return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }); }
/** "Tue, 17 Nov – Mon, 30 Nov", or with years once the range is long or crosses a year ("17 Nov 2026 – 16 Nov 2027"). */
function gRangeText(from, to) {
  const long = from.getFullYear() !== to.getFullYear() || (to - from) / 86400000 > 180;
  const f = (d) => (long ? d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : gShortDate(d));
  return `${f(from)} – ${f(to)}`;
}
function gStartName() { return GC.start && GC.start.label ? String(GC.start.label).split(",")[0].trim() : ""; }
function gDesc(x) { return typeof x === "string" ? x.slice(0, 1500) : ""; }
function gStatus(msg, err) { const s = document.getElementById("gcStatus"); s.textContent = msg || ""; s.className = "ts-status" + (err ? " error" : ""); }
function gVenueOk(vid) { return TourSupport.venueUsable(GC.venues, vid); }
// Bill roles, troupe handling and multi-night runs: pure helpers in event_helpers.js.
const gBill = (e) => EventHelpers.buildBill(e, (GC.data && GC.data.performers) || {});
const gBillText = EventHelpers.billText;
const gMergeBill = EventHelpers.mergeBill;
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
        title: rec.name, performer: "", performerList: [], bill: null, group: list === "clubs" ? "clubs" : "folk", date: o.date, time: rec.time || "",
        venue_id: list === "clubs" ? resolveClubVenueId(rec, o.date) : rec.venue_id,
        url: rec.club ? `storyclub.html?club=${encodeURIComponent(rec.club)}` : "",
        ext: rec.link || rec.facebook || "", price: rec.price || "", soldOut: false,
      });
    });
  }));

  const dated = [["specificEvents", "story"], ["musicEvents", "music"], ["poetryEvents", "poetry"]];
  dated.forEach(([list, cat]) => (ed[list] || []).forEach((e) => {
    if (e.online || e.cancelled || e.isCancelled) return;
    const all = EventHelpers.eventDates(e, parseDateString), multi = all.length > 1; // a multi-night run is one gig per night
    all.filter((d) => d >= from && d <= to).forEach((d) => {
      const bill = gBill(e);
      push({
        id: `ev:${e.eventId ? e.eventId + (multi ? ":" + gKey(d) : "") : e.name + gKey(d)}`, cat: e.isMusic ? "music" : e.isPoetry ? "poetry" : cat, kind: "event",
        title: e.showname || e.name, performer: [...bill.head, ...bill.also].join(", "), performerList: bill.all, bill, group: null, date: d, time: e.time || "",
        venue_id: e.venue_id, url: gEventUrl(e, d), ext: e.ticket_url || e.event_url || e.fb_event || e.link || "",
        price: e.price || "", soldOut: !!e.isSoldOut, desc: gDesc(e.description),
      });
    });
  }));

  Object.values(ed.tours || {}).forEach((t) => (t.tour_dates || []).forEach((td) => {
    if (td.cancelled || td.isCancelled) return;
    const all = EventHelpers.eventDates(td, parseDateString), multi = all.length > 1;
    all.filter((d) => d >= from && d <= to).forEach((d) => {
      const bill = gBill({ ...t, ...td });
      push({
        id: `ev:${td.eventId ? td.eventId + (multi ? ":" + gKey(d) : "") : (t.tour_name || t.name) + gKey(d) + td.venue_id}`,
        cat: t.isMusic ? "music" : t.isPoetry ? "poetry" : "story", kind: "event",
        title: t.tour_name || t.name, performer: [...bill.head, ...bill.also].join(", "), performerList: bill.all, bill, group: null, date: d, time: td.time || t.time || "",
        venue_id: td.venue_id, url: gEventUrl(td, d), ext: td.ticket_url || td.fb_event || "",
        price: td.price || t.price || "", soldOut: !!td.isSoldOut, desc: gDesc(td.description || t.tour_description),
      });
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
    if (seen.has(k1)) { gMergeBill(seen.get(k1), ev); return; }
    const prior = seen.get(k2);
    if (prior && (ev.kind === "recurring" || prior.title.toLowerCase() === ev.title.toLowerCase())) { gMergeBill(prior, ev); return; }
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

// ── start point ─────────────────────────────────────────────────────────
const G_NEAR_KEY = "gigPlannerNear"; // this page's own key; the tour planner's saved start is never touched
function gSaveNear(s) {
  try {
    if (s) localStorage.setItem(G_NEAR_KEY, JSON.stringify({ lat: s.lat, lon: s.lon, label: s.label }));
    else localStorage.removeItem(G_NEAR_KEY);
  } catch (e) { /* storage is optional */ }
}
function gLoadNear() {
  try {
    const s = JSON.parse(localStorage.getItem(G_NEAR_KEY) || "null");
    if (s && typeof s.lat === "number" && typeof s.lon === "number" && s.label) return s;
  } catch (e) { /* ignore */ }
  return null;
}
function gShowStart(s) {
  const clearBtn = document.getElementById("gcStartClear");
  document.getElementById("gcStartCurrent").textContent = s ? `Near: ${s.label}` : "";
  if (clearBtn) clearBtn.style.display = s ? "" : "none";
}
function gSetStart(s) {
  GC.start = s;
  gSaveNear(s);
  gShowStart(s);
  gRenderAll();
}
function gClearStart() {
  gSetStart(null);
  document.getElementById("gcStartInput").value = "";
  gStatus("Place cleared.");
}
function gFindStart() {
  // A venue name picked from the list is used directly.
  const typed = document.getElementById("gcStartInput").value.trim().toLowerCase();
  const venue = GC.venueByLabel.get(typed);
  if (venue) {
    document.getElementById("gcStartChoices").replaceChildren();
    gStatus("");
    gSetStart({ lat: venue.latlon[0], lon: venue.latlon[1], label: venue.name });
    return Promise.resolve();
  }
  return TourSupport.findPlace({
    input: document.getElementById("gcStartInput"),
    choices: document.getElementById("gcStartChoices"),
    onPick: gSetStart, setStatus: gStatus,
    failHint: "You can still browse without a place.",
  });
}
function gLocate() { TourSupport.locate({ onPick: gSetStart, setStatus: gStatus }); }

// ── period / reload ─────────────────────────────────────────────────────
function gReload() {
  const today = getTodayMidnight();
  let from = gParseInput(document.getElementById("gcFrom").value) || today;
  let to = gParseInput(document.getElementById("gcTo").value) || gAdd(from, 13);
  if (from < today) from = today;
  if (to < from) { gStatus("The end date is before the start date.", true); return; }
  if ((to - from) / 86400000 > 364) { to = gAdd(from, 364); gStatus("Period limited to 12 months."); } else gStatus("");
  // pad by the nights-around window so neighbours of edge gigs are available
  GC.periodFrom = from; GC.periodTo = to; GC.day = null;
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
  if (ev.bill && ev.bill.support.length) card.appendChild(gEl("div", "gc-card-support", "with " + ev.bill.support.join(", ") + " (support)"));
  card.appendChild(gEl("div", "gc-card-meta", [opts.showDate ? formatDate(ev.date) : "", ev.time, gPlace(v)].filter(Boolean).join(" · ")));
  const dist = [];
  if (opts.hop != null) dist.push(`${gFmtMi(opts.hop)} (${gFmtDrive(opts.hop)}) from ${opts.refName || "previous stop"}`);
  const h = gHome();
  if (h) dist.push(`${gFmtMi(gMiles(h, gLL(ev)))} from ${gStartName() || "your start point"}`);
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
  const box = document.getElementById("gcBrowse"), strip = document.getElementById("gcDays");
  box.replaceChildren(); strip.replaceChildren();
  GC.browseList = [];
  if (!GC.periodFrom) return;
  gRefineSummary(); gSearchHint();
  const cats = gCats();
  const maxHome = parseInt(document.getElementById("gcMaxHome").value, 10) || 0;
  const words = document.getElementById("gcSearch").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const special = document.getElementById("gcSpecialOnly").checked;
  let list = GC.events.filter((e) => e.date >= GC.periodFrom && e.date <= GC.periodTo && gPasses(e, cats, maxHome) && !(special && e.kind === "recurring"));
  if (words.length) {
    list = list.filter((e) => {
      const v = GC.venues[e.venue_id] || {};
      const hay = `${e.title} ${e.performer} ${(e.performerList || []).join(" ")} ${v.name || ""} ${v.city || ""} ${e.desc || ""}`.toLowerCase();
      return words.every((w) => hay.includes(w)); // every word must appear somewhere (title, anyone on the bill, venue, town, blurb)
    });
  }
  if (GC.anchor && !GC.browseOpen) {
    GC.browseList = list;
    document.getElementById("gcBrowseHead").textContent = "Your gig";
    const row = gEl("p", "gc-collapsed");
    row.append(`Planning around “${GC.anchor.title}”. `);
    const b = gEl("button", "gc-btn", `Change gig (${list.length} to choose from)`); b.type = "button";
    b.addEventListener("click", () => { GC.browseOpen = true; gRenderBrowse(); });
    row.appendChild(b);
    box.appendChild(row);
    return;
  }
  if (GC.anchor) {
    const hide = gEl("button", "gc-btn gc-hide-list", "▲ Hide this list"); hide.type = "button";
    hide.addEventListener("click", () => { GC.browseOpen = false; gRenderBrowse(); });
    box.appendChild(hide);
  }
  // Day strip: how many gigs on each date, ignoring the day filter itself
  const counts = new Map();
  list.forEach((e) => { const k = gKey(e.date); counts.set(k, (counts.get(k) || 0) + 1); });
  if (GC.day && ![...counts.keys()].some((k) => k.startsWith(GC.day))) GC.day = null;
  gRenderDays(strip, counts, list.length);
  if (GC.day) list = list.filter((e) => gKey(e.date).startsWith(GC.day)); // a "YYYY-MM-DD" day or a "YYYY-MM" month
  GC.browseList = list;
  document.getElementById("gcBrowseHead").textContent = `Pick a gig to plan around${list.length ? ` (${list.length})` : ""}`;
  if (!list.length) { box.appendChild(gEl("p", "ts-hint", "No events match — try widening the dates, categories or distance.")); return; }
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

/** Dates with gigs, shaded by how busy they are; click one to narrow the results (and map) to it.
 *  Over a long range the strip shows months first, then that month's days. */
function gRenderDays(strip, counts, total) {
  const entries = [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const long = entries.length > 45;
  const month = long && GC.day ? GC.day.slice(0, 7) : null;
  const heat = (n, max) => (0.08 + 0.42 * (n / max)).toFixed(2);
  const mk = (label, key, h) => {
    const on = (GC.day || "") === key;
    const b = gEl("button", "gc-day" + (on && key ? " on" : ""), label); b.type = "button";
    b.setAttribute("aria-pressed", on && key ? "true" : "false");
    b.style.setProperty("--heat", String(h));
    b.addEventListener("click", () => { GC.day = GC.day === key ? null : key; GC.limit = 120; gRenderAll(); });
    strip.appendChild(b);
  };
  const monthName = (m) => { const [y, mo] = m.split("-").map(Number); return new Date(y, mo - 1, 1).toLocaleDateString("en-GB", { month: "short", year: "numeric" }); };
  if (long && !month) {
    const byMonth = new Map();
    entries.forEach(([k, n]) => byMonth.set(k.slice(0, 7), (byMonth.get(k.slice(0, 7)) || 0) + n));
    const max = Math.max(...byMonth.values());
    mk(`All dates (${total})`, "", 0);
    [...byMonth.entries()].forEach(([m, n]) => mk(`${monthName(m)} · ${n}`, m, heat(n, max)));
    return;
  }
  const view = month ? entries.filter(([k]) => k.startsWith(month)) : entries;
  if (!month && view.length < 2) return;
  mk(month ? `‹ All months (${monthName(month)})` : `All dates (${total})`, "", 0);
  const max = Math.max(...view.map(([, n]) => n));
  view.forEach(([k, n]) => mk(`${gShortDate(gParseInput(k))} · ${n}`, k, heat(n, max)));
}

/** One line under "Refine" so the active filters are visible while it is collapsed. */
function gRefineSummary() {
  const el = document.getElementById("gcRefineSummary");
  const maxHome = parseInt(document.getElementById("gcMaxHome").value, 10) || 0;
  const cats = [...gCats()];
  const bits = [
    !GC.start ? "anywhere" : maxHome ? `within ${maxHome} mi of ${gStartName()}` : `distances from ${gStartName()}`,
    gRangeText(GC.periodFrom, GC.periodTo),
    cats.length === 4 ? "all types" : cats.map((c) => (GC_CAT[c] || c).replace(/^\S+\s/, "")).join(", ") || "no types selected",
  ];
  if (document.getElementById("gcSpecialOnly").checked) bits.push("one-offs only");
  el.textContent = bits.join(" · ");
}

/** When a search is short of the 60-day maximum, offer to look further ahead. */
function gSearchHint() {
  const h = document.getElementById("gcSearchHint");
  h.replaceChildren();
  if (!document.getElementById("gcSearch").value.trim()) return;
  if ((GC.periodTo - GC.periodFrom) / 86400000 >= 364) return;
  h.append(`Searching ${gRangeText(GC.periodFrom, GC.periodTo)} only. `);
  const b = gEl("button", "gc-link", "Search the next 12 months instead"); b.type = "button";
  b.addEventListener("click", () => gPreset("year"));
  h.appendChild(b);
}

/** Quick date ranges. */
function gPreset(kind) {
  const t = getTodayMidnight();
  let from = t, to;
  if (kind === "weekend") {
    const dow = t.getDay(); // 0 = Sunday
    to = gAdd(t, (7 - dow) % 7);
    from = dow === 0 || dow >= 5 ? t : gAdd(to, -2);
  } else to = gAdd(t, { week: 6, month: 29, quarter: 89, year: 364 }[kind] || 13);
  document.getElementById("gcFrom").value = gKey(from);
  document.getElementById("gcTo").value = gKey(to);
  gReload();
}

/** The three starting points only choose what to open and focus; every control stays available. */
function gStartMode(kind) {
  GC.entry = kind;
  if (GC.help) GC.help.refresh(); // help records may carry "modes": ["gig" | "place" | "dates"]
  document.querySelectorAll(".gc-start-btn").forEach((b) => b.classList.toggle("on", b.dataset.start === kind));
  const refine = document.getElementById("gcRefine");
  if (kind === "gig") {
    if ((GC.periodTo - GC.periodFrom) / 86400000 < 364) gPreset("year"); // a named gig can be months away
    document.getElementById("gcSearch").focus();
  } else if (kind === "place") {
    refine.open = true;
    if (!(parseInt(document.getElementById("gcMaxHome").value, 10) > 0)) { document.getElementById("gcMaxHome").value = 25; gRenderAll(); }
    document.getElementById("gcStartInput").focus();
  } else {
    refine.open = true;
    document.getElementById("gcFrom").focus();
  }
}

/** Make sure the anchor's neighbouring nights are loaded, even near the edge of the period. */
function gLoadAround() {
  const ev = GC.anchor;
  const from = gAdd(ev.date, -GC.before - 1), to = gAdd(ev.date, GC.after + 1);
  const today = getTodayMidnight();
  GC.events = gCollect(from < today ? today : from, to).concat(GC.events.filter((e) => e.date >= GC.periodFrom && e.date <= GC.periodTo))
    .reduce((acc, e) => (acc.some((x) => x.id === e.id) ? acc : (acc.push(e), acc)), [])
    .sort((a, b) => a.date - b.date || a.title.localeCompare(b.title));
}
function gSetAnchor(ev) {
  if (!GC.anchor || GC.anchor.id !== ev.id) GC.filters = new Set();
  GC.anchor = ev;
  GC.chosen = new Map([[gKey(ev.date), ev]]);
  gLoadAround();
  GC.browseOpen = false;
  gRenderAll();
  // Straight to the nights columns (the trip so far sits just above them)
  const target = document.getElementById("gcNearby");
  (target.hidden ? document.getElementById("gcPlan") : target).scrollIntoView({ behavior: "smooth", block: "start" });
}

function gRefFor(date) {
  const a = GC.anchor.date, step = date < a ? 1 : -1;
  for (let d = gAdd(date, step); step > 0 ? d <= a : d >= a; d = gAdd(d, step)) {
    const c = GC.chosen.get(gKey(d));
    if (c) return c;
  }
  return GC.anchor;
}

function gPassesFilter(e) {
  if (!GC.filters.size) return true;
  return (e.group && GC.filters.has("g:" + e.group)) || (e.performerList || []).some((n) => GC.filters.has("p:" + n));
}

function gRenderNearby() {
  // #gcNearby is a fixed shell (its heading and "Explain this step" button are set up once);
  // only #gcNearbyBody is rebuilt on each render.
  const host = document.getElementById("gcNearby"), sec = document.getElementById("gcNearbyBody");
  sec.replaceChildren();
  GC.scope = []; // gigs in reach of the plan (after filters), for the map
  host.hidden = !GC.anchor;
  if (!GC.anchor) return;
  const ctl = gEl("div", "ts-grid");
  const mk = (label, id, val, min, max) => {
    const l = gEl("label", "ts-field", label);
    const i = gEl("input"); i.type = "number"; i.id = id; i.min = min; i.max = max; i.value = val;
    i.addEventListener("change", () => {
      GC.before = Math.min(7, Math.max(0, parseInt(document.getElementById("gcBefore").value, 10) || 0));
      GC.after = Math.min(7, Math.max(0, parseInt(document.getElementById("gcAfter").value, 10) || 0));
      GC.radius = Math.min(300, Math.max(5, parseInt(document.getElementById("gcRadius").value, 10) || 40));
      gLoadAround();
      // keep the stops already added, dropping only any that now fall outside the window
      const lo = gKey(gAdd(GC.anchor.date, -GC.before)), hi = gKey(gAdd(GC.anchor.date, GC.after));
      GC.chosen.forEach((_, k) => { if (k < lo || k > hi) GC.chosen.delete(k); });
      gRenderAll();
    });
    l.appendChild(i); return l;
  };
  ctl.append(mk("Nights before", "gcBefore", GC.before, 0, 7), mk("Nights after", "gcAfter", GC.after, 0, 7), mk("Within … miles of the previous stop", "gcRadius", GC.radius, 5, 300));
  sec.appendChild(ctl);

  // Pass 1: what's in reach each night (before the performer/club filters)
  const cats = gCats();
  const maxHome = parseInt(document.getElementById("gcMaxHome").value, 10) || 0;
  const nights = [];
  for (let i = -GC.before; i <= GC.after; i++) {
    const date = gAdd(GC.anchor.date, i), k = gKey(date);
    if (date < getTodayMidnight()) continue; // can't go to a night that's gone
    if (i === 0) { nights.push({ i, date, k }); continue; }
    const ref = gRefFor(date), refLL = gLL(ref);
    const cands = GC.events.filter((e) => gKey(e.date) === k && gPasses(e, cats, maxHome))
      .map((e) => ({ e, hop: gMiles(refLL, gLL(e)) }))
      .filter((x) => x.hop != null && x.hop <= GC.radius)
      .sort((a, b) => a.hop - b.hop);
    nights.push({ i, date, k, ref, cands });
  }

  // Filter buttons: all story clubs / folk nights in one go, then each performer in reach
  const counts = { clubs: 0, folk: 0 }, perf = new Map(), nonSupport = new Set();
  nights.forEach((n) => (n.cands || []).forEach(({ e }) => {
    if (e.group) counts[e.group]++;
    (e.performerList || []).forEach((p) => perf.set(p, (perf.get(p) || 0) + 1));
    if (e.bill) [...e.bill.head, ...e.bill.also].forEach((p) => nonSupport.add(p));
  }));
  const chips = [];
  if (counts.clubs) chips.push({ key: "g:clubs", label: `📖 All story clubs (${counts.clubs})` });
  if (counts.folk) chips.push({ key: "g:folk", label: `🎻 All folk nights & sessions (${counts.folk})` });
  [...perf.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .forEach(([name, n]) => chips.push({ key: "p:" + name, label: nonSupport.has(name) ? `${name} (${n})` : `${name} — support (${n})` }));
  GC.filters = new Set([...GC.filters].filter((k) => chips.some((c) => c.key === k))); // drop filters no longer in scope
  if (chips.length) {
    const box = gEl("div", "gc-filters");
    box.appendChild(gEl("div", "ts-hint", GC.filters.size
      ? "Showing only gigs matching the highlighted buttons (click again to remove a filter)."
      : "Narrow down by who's playing — click one or more (leave all off to see everything):"));
    const wrap = gEl("div", "gc-chips");
    chips.forEach((c) => {
      const b = gEl("button", "gc-chip" + (GC.filters.has(c.key) ? " on" : ""), c.label);
      b.type = "button";
      b.setAttribute("aria-pressed", GC.filters.has(c.key) ? "true" : "false");
      b.addEventListener("click", () => { if (GC.filters.has(c.key)) GC.filters.delete(c.key); else GC.filters.add(c.key); gRenderAll(); });
      wrap.appendChild(b);
    });
    if (GC.filters.size) {
      const clr = gEl("button", "gc-chip clear", "✕ Clear filters"); clr.type = "button";
      clr.addEventListener("click", () => { GC.filters = new Set(); gRenderAll(); });
      wrap.appendChild(clr);
    }
    box.appendChild(wrap);
    sec.appendChild(box);
  }
  sec.appendChild(gEl("p", "ts-hint", "Add one event per night. Distances are measured from your nearest chosen stop towards the gig you picked."));

  // Pass 2: draw the nights (filters applied; a stop already in your plan always stays visible)
  const row = gEl("div", "gc-nights");
  nights.forEach((n) => {
    const col = gEl("div", "gc-night" + (n.i === 0 ? " anchor" : ""));
    col.appendChild(gEl("h4", null, formatDate(n.date) + (n.i === 0 ? "  ★" : "")));
    if (n.i === 0) {
      col.appendChild(gCard(GC.anchor, { anchor: true }));
    } else {
      col.appendChild(gEl("div", "ts-ref gc-ref", `from ${n.ref.title}`));
      const chosenHere = GC.chosen.get(n.k);
      const shown = n.cands.filter(({ e }) => gPassesFilter(e) || (chosenHere && chosenHere.id === e.id));
      if (!shown.length) col.appendChild(gEl("div", "gc-none", n.cands.length ? "Nothing matches the filters" : `Nothing within ${GC.radius} mi`));
      shown.forEach(({ e, hop }) => {
        GC.scope.push(e);
        const on = chosenHere && chosenHere.id === e.id;
        col.appendChild(gCard(e, {
          chosen: on, hop, refName: n.ref.title,
          button: { label: on ? "✓ In plan (remove)" : "Add to plan", fn: () => gToggle(e) },
        }));
      });
    }
    row.appendChild(col);
  });
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
  return `${formatDate(c.date)}${c.time ? ", " + c.time : ""} — ${c.title}${gBillText(c) ? " (" + gBillText(c) + ")" : ""}, ${gPlace(v)}` +
    (leg != null ? `  [${gFmtMi(leg)}, ${gFmtDrive(leg)}]` : "");
}

function gRenderPlan() {
  const host = document.getElementById("gcPlan"), box = document.getElementById("gcPlanBody");
  box.replaceChildren();
  host.hidden = !GC.anchor;
  if (!GC.anchor) { gRenderMap([]); return; }
  const stops = gStops(), home = gHome();
  const ol = gEl("ol", "ts-list");
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
  box.appendChild(gEl("p", "ts-total", info + "Estimates only — check a route planner, and the event's own page for times and booking."));
  const act = gEl("div", "gc-actions");
  const copy = gEl("button", "gc-btn", "📋 Copy plan"); copy.type = "button";
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(lines.join("\n")); copy.textContent = "Copied ✓"; } catch (e) { copy.textContent = "Copy failed"; }
  });
  const link = gEl("button", "gc-btn", "🔗 Copy link"); link.type = "button";
  link.title = "Copies a link that reopens this plan. It does not include the place you entered.";
  link.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(gPlanLink()); link.textContent = "Link copied ✓"; } catch (e) { link.textContent = "Copy failed"; }
  });
  const ics = gEl("button", "gc-btn", "📅 Download calendar (.ics)"); ics.type = "button";
  ics.addEventListener("click", () => gDownloadIcs(stops));
  const reset = gEl("button", "gc-btn", "Start again"); reset.type = "button";
  reset.addEventListener("click", () => { GC.anchor = null; GC.chosen = new Map(); gRenderAll(); window.scrollTo({ top: 0, behavior: "smooth" }); });
  act.append(copy, link, ics);
  TourSupport.addExportButtons(act, {
    className: "gc-btn", basename: "gig-planner",
    getRecords: () => TourSupport.buildRecords(stops, (c) => {
      const v = GC.venues[c.venue_id] || {};
      const ll = gLL(c);
      return {
        title: c.title, kind: c.kind || "", performer: gBillText(c),
        venue: v.name, address: v.full_address || "", town: v.city || "", postcode: v.postcode || "",
        latitude: ll ? ll[0] : null, longitude: ll ? ll[1] : null,
        link: c.url ? new URL(c.url, location.href).href : (c.ext || ""),
      };
    }, home),
    getMeta: () => ({ page: "gig_planner", start: GC.start ? { label: GC.start.label, latitude: GC.start.lat, longitude: GC.start.lon } : null }),
  });
  act.append(reset);
  box.appendChild(act);
  gRenderMap(stops);
}

/** A link that reopens this plan. It carries the gigs, not the visitor's own place. */
function gPlanLink() {
  const p = new URLSearchParams();
  p.set("plan", GC.anchor.id);
  gStops().forEach((c) => { if (c.id !== GC.anchor.id) p.append("s", c.id); });
  p.set("b", GC.before); p.set("a", GC.after); p.set("r", GC.radius);
  return `${location.href.split("#")[0]}#${p.toString()}`;
}
/** Open straight onto a shared plan (#plan=…). Returns true if restored, "missing" if its gig has gone, else false. */
function gRestoreFromHash() {
  const p = new URLSearchParams(location.hash.replace(/^#/, ""));
  const id = p.get("plan");
  if (!id) return false;
  const today = getTodayMidnight();
  const anchor = gCollect(today, gAdd(today, 372)).find((e) => e.id === id);
  if (!anchor) return "missing";
  const num = (k, d, lo, hi) => Math.min(hi, Math.max(lo, parseInt(p.get(k), 10) || d));
  GC.before = num("b", 2, 0, 7); GC.after = num("a", 2, 0, 7); GC.radius = num("r", 40, 5, 300);
  const last = gAdd(today, 364), to = gAdd(anchor.date, 14);
  document.getElementById("gcFrom").value = gKey(today);
  document.getElementById("gcTo").value = gKey(to > last ? last : to);
  gReload();
  gSetAnchor(GC.events.find((e) => e.id === id) || anchor);
  p.getAll("s").forEach((sid) => { const e = GC.events.find((x) => x.id === sid); if (e && e.id !== id) GC.chosen.set(gKey(e.date), e); });
  gRenderAll();
  try { history.replaceState(null, "", location.href.split("#")[0]); } catch (e) { /* ignore */ } // the link was a starting point, not live state
  return true;
}

function gDownloadIcs(stops) {
  TourSupport.downloadIcs(stops.map((c) => {
    const v = GC.venues[c.venue_id] || {};
    const href = c.url ? new URL(c.url, location.href).href : c.ext;
    return {
      date: c.date, uid: c.id, title: c.title,
      location: TourSupport.icsLocation(v),
      description: [c.time ? "Time: " + c.time : "", gBillText(c), href].filter(Boolean).join("\n"),
    };
  }), "gig-planner.ics", "Gig Planner");
}

// ── map ─────────────────────────────────────────────────────────────────
function gToggle(e) {
  const k = gKey(e.date), cur = GC.chosen.get(k);
  if (cur && cur.id === e.id) GC.chosen.delete(k); else GC.chosen.set(k, e);
  gRenderAll();
}
function gDayLabel(date) {
  const n = Math.round((date - GC.anchor.date) / 86400000);
  return n === 0 ? "0" : n > 0 ? `+${n}` : `−${Math.abs(n)}`;
}
/** Popup listing a venue's gigs, each with a button (plan around / add / remove). */
function gVenuePopup(vid, events) {
  const box = gEl("div", "map-popup");
  box.appendChild(gEl("strong", null, gPlace(GC.venues[vid]) || vid));
  [...events].sort((a, b) => a.date - b.date).forEach((e) => {
    const row = gEl("div", "map-popup-row");
    if (GC.anchor) row.appendChild(gEl("span", "map-popup-day", gDayLabel(e.date)));
    row.appendChild(gEl("span", null, ` ${formatDate(e.date)}${e.time ? ", " + e.time : ""} — ${e.title}${gBillText(e) ? " (" + gBillText(e) + ")" : ""}`));
    const b = gEl("button", "map-popup-btn");
    b.type = "button";
    if (!GC.anchor) {
      b.textContent = "Plan around this gig";
      b.addEventListener("click", () => gSetAnchor(e));
    } else if (GC.anchor.id === e.id) {
      b.textContent = "★ Your gig"; b.disabled = true;
    } else {
      const on = GC.chosen.get(gKey(e.date)) && GC.chosen.get(gKey(e.date)).id === e.id;
      b.textContent = on ? "Remove" : "Add to plan";
      b.addEventListener("click", () => gToggle(e));
    }
    row.appendChild(b);
    box.appendChild(row);
  });
  return box;
}

function gMapCaption() {
  const cap = document.getElementById("gcMapCaption");
  const scope = document.getElementById("gcShowScope").checked;
  if (GC.anchor) {
    cap.textContent = "Your trip: numbered pins are your stops" + (scope ? "; grey pins are other gigs within reach (−1, +1 … are days from your gig)." : ".");
    return;
  }
  const list = GC.browseList || [], v = new Set(list.map((e) => e.venue_id)).size;
  cap.textContent = list.length
    ? `${list.length} gig${list.length === 1 ? "" : "s"} at ${v} venue${v === 1 ? "" : "s"}${scope ? " — each grey pin shows how many; click one for details." : "."}`
    : "No gigs to show — widen the dates or filters.";
}

async function gRenderMap(stops) {
  const wrap = document.getElementById("gcMapWrap");
  wrap.style.display = "";
  gMapCaption();
  document.getElementById("gcApp").classList.remove("no-map");
  try { await TourSupport.loadLeaflet(); } catch (e) { wrap.style.display = "none"; document.getElementById("gcApp").classList.add("no-map"); return; }
  if (!gcMap) gcMap = initMap("gcMap");
  gcMap.invalidateSize();
  if (gcLayer) gcLayer.remove();
  gcLayer = L.layerGroup().addTo(gcMap);
  const pts = [], h = gHome(), extra = [];

  // Venues in scope: before a gig is picked, every venue with a matching
  // gig in the period (labelled with how many); afterwards, venues with a
  // gig on a nearby night (labelled +1, −2 …). Click for the gigs.
  const showScope = document.getElementById("gcShowScope").checked;
  const stopVenues = new Set(stops.map((c) => c.venue_id));
  if (showScope) {
    const pool = GC.anchor ? (GC.scope || []) : (GC.browseList || []);
    const byVenue = new Map();
    pool.forEach((e) => { if (!byVenue.has(e.venue_id)) byVenue.set(e.venue_id, []); byVenue.get(e.venue_id).push(e); });
    byVenue.forEach((evs, vid) => {
      if (stopVenues.has(vid)) return;
      const ll = gLL(evs[0]); extra.push(ll);
      const text = GC.anchor
        ? (() => { const l = [...new Set([...evs].sort((a, b) => a.date - b.date).map((e) => gDayLabel(e.date)))]; return l.length > 3 ? l.slice(0, 3).join(" ") + "…" : l.join(" "); })()
        : String(evs.length);
      L.marker(ll, { icon: L.divIcon({ className: "ts-pin cand", html: text, iconSize: [40, 20], iconAnchor: [20, 10] }) })
        .bindTooltip(`${(GC.venues[vid] || {}).name || vid} (${GC.anchor ? text : evs.length + (evs.length === 1 ? " gig" : " gigs")})`)
        .bindPopup(gVenuePopup(vid, evs)).addTo(gcLayer);
    });
  }
  if (h) { pts.push(h); L.marker(h, { icon: L.divIcon({ className: "ts-pin home", html: "⌂", iconSize: [26, 26] }) }).bindTooltip(GC.start.label).addTo(gcLayer); }
  stops.forEach((c, i) => {
    const ll = gLL(c); pts.push(ll);
    const here = [c].concat((GC.scope || []).filter((e) => e.venue_id === c.venue_id && e.id !== c.id));
    L.marker(ll, { icon: L.divIcon({ className: "ts-pin" + (GC.anchor && c.id === GC.anchor.id ? " anchor" : ""), html: String(i + 1), iconSize: [26, 26] }), zIndexOffset: 500 })
      .bindTooltip(`${i + 1}. ${c.title} — ${formatDate(c.date)}`).bindPopup(gVenuePopup(c.venue_id, here)).addTo(gcLayer);
  });
  if (stops.length + (h ? 1 : 0) > 1) L.polyline(pts, { color: "#2e7d32", weight: 3, dashArray: "6 6" }).addTo(gcLayer);
  const all = pts.concat(extra);
  if (all.length) gcMap.fitBounds(L.latLngBounds(all).pad(0.2), { maxZoom: 11 });
}

// ── init ────────────────────────────────────────────────────────────────
async function gInit() {
  const res = await loadEventsData();
  if (!res) { document.getElementById("gcLoading").textContent = "Couldn't load events data."; return; }
  GC.data = res.eventsData; GC.venues = res.venuesLookup || {};
  // No place is assumed: only one the visitor gave on this page before (kept in their own browser) is restored.
  const t0 = getTodayMidnight();
  document.getElementById("gcFrom").value = gKey(t0);
  document.getElementById("gcTo").value = gKey(gAdd(t0, 13));
  ["gcFrom", "gcTo"].forEach((id) => document.getElementById(id).addEventListener("change", gReload));
  document.getElementById("gcMaxHome").addEventListener("change", gRenderAll);
  document.getElementById("gcShowScope").addEventListener("change", () => gRenderMap(gStops()));
  document.querySelectorAll("#gcCats input").forEach((i) => i.addEventListener("change", gRenderAll));
  let searchTimer = null;
  document.getElementById("gcSearch").addEventListener("input", () => {
    GC.limit = 120; GC.day = null;
    if (GC.anchor) GC.browseOpen = true;
    clearTimeout(searchTimer);
    // Before a gig is picked the map shows the results, so it follows the search; afterwards only the list does.
    searchTimer = setTimeout(() => (GC.anchor ? gRenderBrowse() : gRenderAll()), 250);
  });
  document.getElementById("gcSpecialOnly").addEventListener("change", gRenderAll);
  document.querySelectorAll(".gc-start-btn").forEach((b) => b.addEventListener("click", () => gStartMode(b.dataset.start)));
  document.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => gPreset(b.dataset.preset)));
  // Venues can be typed into "Near" as well as towns and postcodes
  const dl = document.getElementById("gcVenueList");
  Object.entries(GC.venues).forEach(([id, v]) => {
    if (!gVenueOk(id) || !v.name) return;
    GC.venueByLabel.set(v.name.toLowerCase(), v);
    const o = document.createElement("option"); o.value = v.name; dl.appendChild(o);
  });
  const saved = gLoadNear();
  if (saved) { GC.start = saved; document.getElementById("gcStartInput").value = saved.label; gShowStart(saved); }
  document.getElementById("gcStartFind").addEventListener("click", gFindStart);
  document.getElementById("gcStartInput").addEventListener("keydown", (e) => { if (e.key === "Enter") gFindStart(); });
  document.getElementById("gcStartLocate").addEventListener("click", gLocate);
  document.getElementById("gcStartClear").addEventListener("click", gClearStart);
  document.getElementById("gcLoading").style.display = "none";
  document.getElementById("gcApp").style.display = "";
  // "Explain this step": one record per step in gig_planner_help.json, rendered by the shared
  // TourSupport markdown code. Harmless if the file is missing.
  TourSupport.setupHelp("gig_planner_help.json", () => GC.entry).then((h) => { GC.help = h; });
  const restored = gRestoreFromHash(); // a shared #plan=… link opens straight onto that plan
  if (restored !== true) gReload(); // true = a shared plan was restored (that already loaded events)
  if (restored === "missing") gStatus("That shared plan's gig is no longer listed, or has already happened.", true);
}
document.addEventListener("DOMContentLoaded", gInit);
