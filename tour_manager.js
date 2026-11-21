/* tour_manager.js — logistics for a tour plan: pickups, legs, overnight hotels, run sheet.
 *
 * Reads a plan made by the Tour Planner (a saved plan file, or the handover from the planner's
 * "Open in tour manager" button) and adds what a tour manager needs. It never changes the plan file's
 * own fields; its additions live under plan.manager (the planner ignores unknown fields).
 *
 * Needs: shared_utils.js (el, loadEventsData, formatDate), tour_support.js (TourSupport).
 */
const HANDOVER_KEY = "nt_tour_plan";
const ORS_KEY = "nt_ors_key";
const HOTEL_URL = "data/budget_hotels.json";
const BRAND_NAME = { PI: "Premier Inn", TL: "Travelodge" };
const { roadMiles, fmtMiles, AVG_MPH } = TourSupport;

const PLAN_FORMAT = "new-troubadours-tour-plan";
const MGR = {
  venues: {}, plan: null, groups: [], hotels: null,
  pickups: [], dropHome: false, stays: {}, notes: {}, extras: [], anyGap: false, mph: AVG_MPH,
  after: 60, trigger: 90, brands: { PI: true, TL: true },
  eventsData: null, recs: new Map(), view: "sheet", tourName: "",
  routed: new Map(), useRouted: false, // "lat,lon>lat,lon" -> { miles, mins }
};
const $ = (id) => document.getElementById(id);
const pkey = (a, b) => `${a[0].toFixed(4)},${a[1].toFixed(4)}>${b[0].toFixed(4)},${b[1].toFixed(4)}`;
const parseKey = (s) => { const [y, m, d] = String(s || "").split("-").map(Number); return y ? new Date(y, m - 1, d) : null; };
const fmtMins = (m) => (m == null ? "" : m >= 60 ? `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, "0")}m` : `${Math.round(m)}m`);

/** Decode an encoded polyline (precision 5, as OpenRouteService returns) to [[lat, lon], …]. */
function decodePoly(str) {
  let i = 0, lat = 0, lon = 0; const out = [];
  while (i < str.length) {
    let b, shift = 0, res = 0;
    do { b = str.charCodeAt(i++) - 63; res |= (b & 31) << shift; shift += 5; } while (b >= 32);
    lat += res & 1 ? ~(res >> 1) : res >> 1;
    shift = 0; res = 0;
    do { b = str.charCodeAt(i++) - 63; res |= (b & 31) << shift; shift += 5; } while (b >= 32);
    lon += res & 1 ? ~(res >> 1) : res >> 1;
    out.push([lat / 1e5, lon / 1e5]);
  }
  return out;
}
function setStatus(msg, err) { const s = $("mgrStatus"); s.textContent = msg || ""; s.classList.toggle("err", !!err); }

// ── legs: estimated, or routed when the user has fetched real times ─────────
function leg(a, b) {
  if (!a || !b) return null;
  const r = MGR.useRouted ? MGR.routed.get(pkey(a, b)) : null;
  if (r) return { miles: r.miles, mins: r.mins, routed: true };
  const miles = roadMiles(a, b);
  return miles == null ? null : { miles, mins: (miles / MGR.mph) * 60, routed: false };
}
const legText = (l) => (l ? `${fmtMiles(l.miles)}, ${fmtMins(l.mins)}${l.routed ? " (routed)" : ""}` : "");

// ── plan → groups of gigs ─────────────────────────────────────────────────
function groupsOf(plan) {
  const st = plan.stages && Array.isArray(plan.stages.list) ? plan.stages : null;
  const groups = [];
  if (st) {
    st.list.forEach((s, i) => groups.push({ name: `Stage ${i + 1}`, picks: (s.plan && s.plan.picks) || [] }));
    if (st.idx >= st.list.length && (plan.picks || []).length) groups.push({ name: `Stage ${st.list.length + 1}`, picks: plan.picks });
  } else groups.push({ name: "Tour", picks: plan.picks || [] });
  return groups
    .map((g) => ({ name: g.name, picks: g.picks.filter((p) => p && p.date && MGR.venues[p.venue_id]).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)) }))
    .filter((g) => g.picks.length);
}
const llOf = (vid) => { const v = MGR.venues[vid]; return v && Array.isArray(v.latlon) && v.latlon.length === 2 ? v.latlon : null; };
const placeLL = (p) => (p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon)) ? [Number(p.lat), Number(p.lon)] : null);

/** What the events data knows about a picked gig (time, price, bill, link); the plan file only holds id, venue and name. */
function resolveRecs() {
  MGR.recs = new Map();
  const dates = MGR.groups.flatMap((g) => g.picks.map((p) => parseKey(p.date))).filter(Boolean);
  if (!dates.length || !MGR.eventsData || typeof EventCollect === "undefined") return;
  const dk = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  try {
    // a pick is "this venue on this night"; if the events data has a gig there that night, that is the gig
    EventCollect.collect(MGR.eventsData, new Date(Math.min(...dates)), new Date(Math.max(...dates)))
      .forEach((r) => { const k = `${r.venue_id}|${dk(r.date)}`; if (!MGR.recs.has(k) || (r.kind === "event" && MGR.recs.get(k).kind !== "event")) MGR.recs.set(k, r); });
  } catch (e) { /* details are a bonus */ }
}
function gigInfo(pk) {
  const r = MGR.recs.get(`${pk.venue_id}|${pk.date}`), v = MGR.venues[pk.venue_id] || {};
  let evId = "";
  if (r && r.kind === "event" && r.source && r.source.rec) {
    try { evId = r.source.rec.eventId || (r.source.list !== "tours" && typeof resolveEventId === "function" ? resolveEventId(r.source.rec, r.date) : ""); } catch (e) { evId = ""; }
  }
  return {
    known: !!r, title: (r && r.title) || pk.name || v.name || "", time: (r && r.time) || pk.time || "", price: (r && r.price) || "", soldOut: !!(r && r.soldOut),
    head: r && r.bill ? [...r.bill.head, ...r.bill.also] : [], support: r && r.bill ? r.bill.support : [],
    url: evId ? `event.html?event=${encodeURIComponent(evId)}` : "",
  };
}
const dkey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const slug = (t) => String(t || "tour").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "tour";
/** A tour in the events-data format ({ tour_name, tour_dates: [{ date: "dd/mm/yyyy", venue_id, … }] }) as a plan with fixed gigs. */
function tourToPlan(tour, id) {
  const picks = [];
  (tour.tour_dates || []).forEach((td) => {
    if (!td || td.isCancelled || td.cancelled || td.online || !td.venue_id) return;
    EventHelpers.eventDates(td, parseDateString).forEach((d) => picks.push({
      date: dkey(d), id: `tour:${td.eventId || id}:${dkey(d)}`, venue_id: td.venue_id,
      name: td.showname || td.name || td.title || tour.tour_name || "", time: td.time || tour.time || "", booked: true,
    }));
  });
  return { format: PLAN_FORMAT, version: 1, mode: "tour", picks, settings: { values: {}, checks: {} }, start: null, end: null, endSame: true,
    tourName: tour.tour_name || "", sourceTour: id || "", pool: { artists: [tour.performer_id].filter(Boolean), tours: [], primary: tour.performer_id || null } };
}
/** Whatever the user opens: a plan file, one tour, or a collection of tours keyed by id (the events-data shape). */
function acceptJson(j, label) {
  if (j && j.format === PLAN_FORMAT) return loadPlan(j, label);
  if (j && Array.isArray(j.tour_dates)) return loadPlan(tourToPlan(j, slug(j.tour_name)), `${label} (a tour in the events format).`);
  const tours = j && typeof j === "object" ? Object.entries(j).filter(([, t]) => t && Array.isArray(t.tour_dates)) : [];
  if (tours.length === 1) return loadPlan(tourToPlan(tours[0][1], tours[0][0]), `${label} (a tour in the events format).`);
  if (tours.length > 1) { fillTourSelect(Object.fromEntries(tours), `${tours.length} tours in that file`); return setStatus(`That file has ${tours.length} tours: choose one in the list below.`); }
  throw new Error("This doesn't look like a Tour Planner plan file or a tour in the events format.");
}
function tourOption(id, t, today) {
  const ds = (t.tour_dates || []).flatMap((td) => EventHelpers.eventDates(td, parseDateString)).sort((a, b) => a - b);
  if (!ds.length) return null;
  const f = (d) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" });
  const upcoming = ds.find((d) => d >= today);
  return { id, upcoming: !!upcoming, sort: (upcoming || ds[ds.length - 1]).getTime(), label: `${t.tour_name || id} — ${f(ds[0])}${ds.length > 1 ? " to " + f(ds[ds.length - 1]) : ""} (${ds.length})` };
}
function fillTourSelect(tours, title) {
  MGR.tourPool = tours;
  const sel = $("mgrTourSel"), today = getTodayMidnight();
  sel.textContent = "";
  sel.appendChild(el("option", null, title || "Choose a tour…")).value = "";
  const opts = Object.entries(tours).map(([id, t]) => tourOption(id, t, today)).filter(Boolean);
  const group = (name, list) => { if (!list.length) return; const g = document.createElement("optgroup"); g.label = name; list.forEach((o) => { const op = el("option", null, o.label); op.value = o.id; g.appendChild(op); }); sel.appendChild(g); };
  group("Upcoming and current", opts.filter((o) => o.upcoming).sort((a, b) => a.sort - b.sort));
  group("Past tours", opts.filter((o) => !o.upcoming).sort((a, b) => b.sort - a.sort));
}
function openChosenTour() {
  const id = $("mgrTourSel").value, t = MGR.tourPool && MGR.tourPool[id];
  if (!t) return setStatus("Choose a tour from the list first.", true);
  try { loadPlan(tourToPlan(t, id), `Opened "${t.tour_name || id}" from the listings. Set where you start from below.`); } catch (e) { setStatus(e.message, true); }
}
function loadPlan(plan, from) {
  if (!plan || plan.format !== PLAN_FORMAT) throw new Error("This doesn't look like a Tour Planner plan file.");
  MGR.plan = plan;
  MGR.groups = groupsOf(plan);
  resolveRecs();
  MGR.tourName = String(plan.tourName || (plan.manager && plan.manager.tourName) || "");
  $("tourName").value = MGR.tourName; showStart();
  const m = plan.manager || {};
  MGR.pickups = Array.isArray(m.pickups) ? m.pickups.filter((p) => placeLL(p)).map((p) => ({ label: String(p.label || ""), lat: Number(p.lat), lon: Number(p.lon), place: String(p.place || ""), time: String(p.time || "") })) : [];
  MGR.dropHome = !!m.dropHome;
  MGR.notes = m.notes && typeof m.notes === "object" ? m.notes : {};
  MGR.extras = Array.isArray(m.extras) ? m.extras.filter((e) => e && Number.isFinite(e.lat) && Number.isFinite(e.lon) && e.after).map((e) => ({ id: String(e.id || e.name), after: String(e.after), frac: Number(e.frac) || 0, name: String(e.name || "Stop"), kind: String(e.kind || ""), icon: String(e.icon || "📍"), lat: e.lat, lon: e.lon, mins: Math.min(240, Math.max(0, parseInt(e.mins, 10) || 30)) })) : [];
  MGR.stays = m.stays && typeof m.stays === "object" ? m.stays : {};
  const s = m.settings || {};
  MGR.after = Math.min(240, Math.max(15, parseInt(s.after, 10) || 60));
  MGR.trigger = Math.min(600, Math.max(30, parseInt(s.trigger, 10) || 90));
  MGR.anyGap = !!s.anyGap;
  MGR.mph = Math.min(80, Math.max(20, parseInt(s.mph, 10) || AVG_MPH));
  $("anyGap").checked = MGR.anyGap; $("mphIn").value = MGR.mph;
  MGR.brands = { PI: s.brands ? s.brands.PI !== false : true, TL: s.brands ? s.brands.TL !== false : true };
  $("afterMins").value = MGR.after; $("triggerMins").value = MGR.trigger;
  $("brandPI").checked = MGR.brands.PI; $("brandTL").checked = MGR.brands.TL; $("dropHome").checked = MGR.dropHome;
  MGR.routed = new Map(); MGR.useRouted = false; $("orsOff").hidden = true;
  drawPickups();
  const n = MGR.groups.reduce((t, g) => t + g.picks.length, 0);
  $("mgrWork").hidden = !n;
  $("mgrSummary").textContent = n
    ? `${n} gig${n === 1 ? "" : "s"}${MGR.groups.length > 1 ? ` in ${MGR.groups.length} stages` : ""}${plan.start ? ` · start: ${plan.start.label}` : " · no start point set in the plan"}.`
    : "That plan has no picked gigs yet. Pick gigs in the Tour Planner, then save the plan again.";
  setStatus(n ? (from || "Plan loaded.") : "", false);
  renderAll();
}

// ── hotels ────────────────────────────────────────────────────────────────
function setHotels(list, source) {
  MGR.hotels = (Array.isArray(list) ? list : []).filter((h) => h && BRAND_NAME[h.b] && Number.isFinite(h.lat) && Number.isFinite(h.lon));
  $("hotelStatus").textContent = MGR.hotels.length
    ? `${MGR.hotels.length} Premier Inn / Travelodge locations loaded${source ? " from " + source : ""}.`
    : "No hotel data loaded.";
  $("hotelFileWrap").hidden = true;
  renderAll();
}
async function initHotels() {
  try {
    const r = await fetch(HOTEL_URL);
    if (!r.ok) throw new Error("HTTP " + r.status);
    setHotels(await r.json(), "the site's data file");
  } catch (e) {
    MGR.hotels = null;
    $("hotelStatus").textContent = "Hotel data isn't installed yet, so no hotels can be suggested. Run tools/fetch_budget_hotels.js to create data/budget_hotels.json, or load a hotels file below.";
    $("hotelFileWrap").hidden = false;
  }
}
/** Hotels that fit "drive up to `after` min after the gig, towards the next one", best (closest to the next gig) first. */
function stayOptions(a, b) {
  if (!MGR.hotels || !a || !b) return { list: [], reason: "" };
  const ab = roadMiles(a, b);
  const brandOn = (h) => MGR.brands[h.b];
  const scored = MGR.hotels.filter(brandOn).map((h) => {
    const ll = [h.lat, h.lon], ah = roadMiles(a, ll), hb = roadMiles(ll, b);
    return { h, ah, hb, ahMins: (ah / MGR.mph) * 60, hbMins: (hb / MGR.mph) * 60 };
  });
  const towards = scored.filter((x) => x.hb < ab && x.ah + x.hb <= ab * 1.3 + 3);
  const list = towards.filter((x) => x.ahMins <= MGR.after).sort((x, y) => x.hb - y.hb).slice(0, 3);
  if (list.length) return { list, reason: "" };
  const nearest = towards.sort((x, y) => x.ah - y.ah)[0];
  return { list: [], reason: nearest ? `No hotel within ${MGR.after} min towards the next gig; the nearest is ${fmtMins(nearest.ahMins)} away (${BRAND_NAME[nearest.h.b]}, ${nearest.h.t || nearest.h.n}).` : "No Premier Inn or Travelodge found on the way." };
}

// ── run sheet ─────────────────────────────────────────────────────────────
const startLL = () => placeLL(MGR.plan && MGR.plan.start);
const endLL = () => (MGR.plan && MGR.plan.endSame === false ? placeLL(MGR.plan.end) : startLL() || placeLL(MGR.plan && MGR.plan.end));
const endLabel = () => (MGR.plan && (MGR.plan.endSame === false ? MGR.plan.end : MGR.plan.start) || {}).label || "home";

/** The journey for one group as an ordered list of events (also used for the plain-text run sheet). */
const exAfter = (key) => MGR.extras.filter((e) => e.after === key).sort((a, b) => a.frac - b.frac);
const exPts = (key) => exAfter(key).map((e) => ({ ll: [e.lat, e.lon], kind: "stop", label: `${e.name} (${e.mins} min)`, icon: e.icon, ex: e }));
function buildGroup(g) {
  const days = [], first = g.picks[0].date;
  const dayOf = (k) => { let d = days.find((x) => x.date === k); if (!d) { d = { date: k, items: [] }; days.push(d); } return d; };
  const start = startLL();
  let prev = start, prevLabel = MGR.plan.start ? MGR.plan.start.label : "";
  MGR.pickups.forEach((p, i) => {
    const ll = [p.lat, p.lon], l = prev ? leg(prev, ll) : null;
    dayOf(first).items.push({ type: "pickup", text: `${p.time ? p.time + " " : ""}Pick up ${p.label || "passenger " + (i + 1)} — ${p.place}`, leg: l, from: prevLabel });
    prev = ll; prevLabel = p.place;
  });
  const addStops = (key, k) => exAfter(key).forEach((ex) => {
    const ll = [ex.lat, ex.lon];
    dayOf(k).items.push({ type: "stop", ex, text: `${ex.icon} Stop: ${ex.name} (${ex.mins} min)`, leg: prev ? leg(prev, ll) : null, from: prevLabel });
    prev = ll; prevLabel = ex.name;
  });
  addStops("start:" + g.name, first);
  let prevPick = null;
  g.picks.forEach((pk, i) => {
    const v = MGR.venues[pk.venue_id], ll = llOf(pk.venue_id);
    // an overnight between the previous gig and this one
    if (prevPick) {
      const a = llOf(prevPick.venue_id), l = leg(a, ll), stay = MGR.stays[prevPick.date];
      const d1 = parseKey(prevPick.date), d2 = parseKey(pk.date);
      const nights = d1 && d2 ? Math.round((d2 - d1) / 86400000) : 0;
      const needed = nights >= 1 && (nights === 1 || MGR.anyGap) && l && l.mins > MGR.trigger && a && ll && a[0] !== ll[0];
      if (stay && nights >= 1) {
        const h = [stay.lat, stay.lon];
        dayOf(prevPick.date).items.push({ type: "sleep", stay, date: prevPick.date, l1: leg(prev, h), l2: leg(h, ll), to: pk });
        prev = h; prevLabel = stay.n;
      } else if (needed) {
        dayOf(prevPick.date).items.push({ type: "suggest", date: prevPick.date, a, b: ll, leg: l, to: pk, opts: stayOptions(a, ll) });
      }
    }
    const l = prev && ll ? leg(prev, ll) : null;
    dayOf(pk.date).items.push({ type: "gig", pk, v, leg: l, from: prevLabel });
    prev = ll; prevLabel = v.name; prevPick = pk;
    addStops(noteKey(pk), pk.date);
  });
  const last = g.picks[g.picks.length - 1], day = dayOf(last.date);
  if (MGR.dropHome && MGR.pickups.length) {
    [...MGR.pickups].reverse().forEach((p) => { const ll = [p.lat, p.lon]; day.items.push({ type: "drop", text: `Drop off ${p.label || "passenger"} — ${p.place}`, leg: leg(prev, ll), from: prevLabel }); prev = ll; prevLabel = p.place; });
  }
  const e = endLL();
  if (e && prev) day.items.push({ type: "end", text: `${MGR.plan.endSame === false ? "Finish at" : "Back at"} ${endLabel()}`, leg: leg(prev, e), from: prevLabel });
  return days.sort((x, y) => (x.date < y.date ? -1 : 1));
}
function addrOf(v) { return v.full_address || [v.name, v.city, v.postcode].filter(Boolean).join(", "); }
const dayName = (k) => { const d = parseKey(k); return d ? d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }) : k; };

const billLine = (i) => [i.head.length ? "With " + i.head.join(", ") : "", i.support.length ? "support: " + i.support.join(", ") : ""].filter(Boolean).join(" · ");
const noteKey = (pk) => `${pk.date}|${pk.venue_id}`;
const runText = () => MGR.groups.map((g) => groupText(g, buildGroup(g))).join("\n");
function groupText(g, days) {
  const lines = [`${g.name}`, ""];
  days.forEach((d) => {
    lines.push(dayName(d.date));
    d.items.forEach((it) => {
      const lg = (l) => (l ? ` [${legText(l)}]` : "");
      if (it.type === "gig") {
        const info = gigInfo(it.pk);
        lines.push(`  ${info.time ? info.time + " " : ""}GIG: ${info.title} — ${addrOf(it.v)}${lg(it.leg)}${it.pk.booked ? " ✓ booked" : ""}`);
        const bl = billLine(info); if (bl) lines.push(`      ${bl}`);
        const note = MGR.notes[noteKey(it.pk)]; if (note) lines.push(`      Notes: ${note}`);
      }
      else if (it.type === "sleep") lines.push(`  SLEEP: ${it.stay.n}${it.stay.t ? ", " + it.stay.t : ""} (${legText(it.l1)} after the gig; then ${legText(it.l2)} to the next gig)`);
      else if (it.type === "suggest") lines.push(`  (long leg to the next gig: ${legText(it.leg)} — overnight not chosen yet)`);
      else lines.push(`  ${it.text}${lg(it.leg)}`);
    });
    lines.push("");
  });
  return lines.join("\n");
}

function renderAll() {
  const box = $("runSheet");
  box.textContent = "";
  $("runActions").textContent = "";
  if (!MGR.plan || !MGR.groups.length) return;
  let totalMiles = 0, totalGigs = 0;
  MGR.groups.forEach((g) => {
    const days = buildGroup(g);
    const wrap = el("div", "run-group");
    if (MGR.groups.length > 1) wrap.appendChild(el("h4", null, g.name));
    days.forEach((d) => {
      const day = el("div", "run-day");
      day.appendChild(el("div", "run-date", dayName(d.date)));
      d.items.forEach((it) => {
        if (it.leg) { totalMiles += it.leg.miles; }
        if (it.type === "gig") {
          totalGigs++;
          const lineEl = el("div", "run-line");
          const info = gigInfo(it.pk);
          lineEl.appendChild(el("strong", null, `${info.time ? info.time + " · " : ""}${info.title}`));
          lineEl.appendChild(document.createTextNode(` — ${addrOf(it.v)} `));
          const onMap = el("button", "mgr-btn small", "📍 map"); onMap.type = "button"; onMap.addEventListener("click", () => focusGig(it.pk)); lineEl.appendChild(onMap);
          if (it.leg) day.appendChild(el("div", "run-leg", `↳ from ${it.from || "start"}: ${legText(it.leg)}`));
          day.appendChild(lineEl);
          const billTxt = billLine(info); if (billTxt) day.appendChild(el("div", "run-leg", billTxt));
          const nk = noteKey(it.pk), note = el("input", "run-note"); note.type = "text"; note.value = MGR.notes[nk] || "";
          note.placeholder = "Notes: load-in, soundcheck, contact…"; note.setAttribute("aria-label", `Notes for ${it.pk.name || it.v.name}`);
          const printed = el("div", "run-note-print", MGR.notes[nk] ? "Notes: " + MGR.notes[nk] : "");
          note.addEventListener("input", () => { if (note.value.trim()) MGR.notes[nk] = note.value; else delete MGR.notes[nk]; printed.textContent = note.value.trim() ? "Notes: " + note.value : ""; });
          day.appendChild(note); day.appendChild(printed);
        } else if (it.type === "suggest") renderSuggest(day, it);
        else if (it.type === "sleep") renderSleep(day, it);
        else if (it.type === "stop") renderStop(day, it);
        else {
          if (it.leg) day.appendChild(el("div", "run-leg", `↳ from ${it.from || "start"}: ${legText(it.leg)}`));
          day.appendChild(el("div", "run-line", it.text));
        }
      });
      wrap.appendChild(day);
    });
    box.appendChild(wrap);
  });
  renderCards();
  drawMap();
  fillAlongLegs();
  box.appendChild(el("div", "run-totals", `${totalGigs} gig${totalGigs === 1 ? "" : "s"} · ${fmtMiles(totalMiles)} of driving${MGR.useRouted ? " (routed where fetched)" : " (estimates)"}`));
  const act = $("runActions");
  const mk = (t, fn) => { const b = el("button", "mgr-btn", t); b.type = "button"; b.addEventListener("click", fn); act.appendChild(b); return b; };
  const copy = mk("📋 Copy run sheet", async () => { try { await navigator.clipboard.writeText(runText()); copy.textContent = "Copied ✓"; } catch (e) { copy.textContent = "Copy failed"; } });
  mk("⬇ Download run sheet (.txt)", () => TourSupport.saveText(runText(), "run-sheet.txt", "text/plain"));
  mk("🖨 Print", () => window.print());
  mk("💾 Save plan with logistics", saveManagerPlan);
  mk("⬇ Download as tour (events format)", exportTour);
}
function renderSuggest(day, it) {
  const box = el("div", "run-stay");
  box.appendChild(el("div", null, `🛏 Long leg to the next gig (${legText(it.leg)}). Stop for the night up to ${MGR.after} min after the gig?`));
  if (!MGR.hotels) box.appendChild(el("div", "mgr-hint", "Hotel data isn't loaded (see Overnights above)."));
  else if (!it.opts.list.length) box.appendChild(el("div", "mgr-hint", it.opts.reason));
  it.opts.list.forEach((x) => {
    const b = el("button", "mgr-btn small", `Stay: ${x.h.n}${x.h.t ? ", " + x.h.t : ""} — ${fmtMins(x.ahMins)} then ${fmtMins(x.hbMins)}`);
    b.type = "button";
    b.addEventListener("click", () => { MGR.stays[it.date] = { b: x.h.b, n: x.h.n, t: x.h.t || "", lat: x.h.lat, lon: x.h.lon }; renderAll(); routeMissing(); });
    box.appendChild(b);
  });
  day.appendChild(box);
}
function renderStop(day, it) {
  if (it.leg) day.appendChild(el("div", "run-leg", `↳ from ${it.from || "start"}: ${legText(it.leg)}`));
  const box = el("div", "run-stop");
  box.appendChild(el("span", null, `${it.ex.icon} Stop: ${it.ex.name} — `));
  const m = el("input", "stop-mins"); m.type = "number"; m.min = "0"; m.max = "240"; m.value = it.ex.mins; m.setAttribute("aria-label", `Minutes at ${it.ex.name}`);
  m.addEventListener("input", () => { const n = parseInt(m.value, 10); if (Number.isFinite(n)) it.ex.mins = Math.min(240, Math.max(0, n)); });
  box.appendChild(m); box.appendChild(document.createTextNode(" min "));
  const rm = el("button", "mgr-btn small", "Remove"); rm.type = "button";
  rm.addEventListener("click", () => { MGR.extras = MGR.extras.filter((e) => e !== it.ex); renderAll(); routeMissing(); });
  box.appendChild(rm); day.appendChild(box);
}
function renderSleep(day, it) {
  const box = el("div", "run-stay chosen");
  box.appendChild(el("div", null, `🛏 Sleep: ${it.stay.n}${it.stay.t ? ", " + it.stay.t : ""} — ${legText(it.l1)} after the gig, then ${legText(it.l2)} to the next gig`));
  const q = encodeURIComponent(`${it.stay.n} ${it.stay.t || ""}`.trim());
  const a = el("a", null, "Find on the hotel's site / map ↗"); a.href = `https://www.google.com/maps/search/?api=1&query=${q}`; a.target = "_blank"; a.rel = "noopener";
  box.appendChild(a); box.appendChild(document.createTextNode(" "));
  const rm = el("button", "mgr-btn small", "Remove"); rm.type = "button";
  rm.addEventListener("click", () => { delete MGR.stays[it.date]; renderAll(); routeMissing(); });
  box.appendChild(rm);
  day.appendChild(box);
}

// ── cards ─────────────────────────────────────────────────────────────────
function renderCards() {
  const box = $("runCards"); box.textContent = "";
  MGR.groups.forEach((g) => {
    if (MGR.groups.length > 1) box.appendChild(el("h4", "cards-heading", g.name));
    const grid = el("div", "cards-grid"); let last = null, n = 0;
    buildGroup(g).forEach((d) => d.items.forEach((it) => {
      if (it.type === "gig") {
        n++; const info = gigInfo(it.pk), card = el("div", "gig-card");
        card.appendChild(el("div", "gc-date", `${n}. ${dayName(it.pk.date)}${info.time ? " · " + info.time : ""}`));
        const t = el("div", "gc-title", info.title); if (info.soldOut) t.appendChild(el("span", "gc-badge", " SOLD OUT")); card.appendChild(t);
        card.appendChild(el("div", "gc-venue", (info.title === it.v.name ? [it.v.full_address || it.v.city, it.v.postcode] : [it.v.name, it.v.city]).filter(Boolean).join(", ")));
        const bl = billLine(info); if (bl) card.appendChild(el("div", "gc-bill", bl));
        const meta = [info.price, it.pk.booked ? "✓ booked" : "", !info.known && /^pool:/.test(it.pk.id || "") ? "venue night — not in the events data yet" : ""].filter(Boolean).join(" · "); if (meta) card.appendChild(el("div", "gc-meta", meta));
        if (it.leg) card.appendChild(el("div", "gc-leg", `↳ from ${it.from || "start"}: ${legText(it.leg)}`));
        const acts = el("div", "gc-actions");
        const m = el("button", "mgr-btn small", "📍 Show on map"); m.type = "button"; m.addEventListener("click", () => focusGig(it.pk)); acts.appendChild(m);
        if (info.url) { const a = el("a", null, " Event details ↗"); a.href = info.url; a.target = "_blank"; a.rel = "noopener"; acts.appendChild(a); }
        card.appendChild(acts);
        grid.appendChild(card); last = card;
      } else if (it.type === "sleep" && last) last.appendChild(el("div", "gc-stay", `🛏 Sleep: ${it.stay.n}${it.stay.t ? ", " + it.stay.t : ""} — then ${legText(it.l2)} to the next gig`));
      else if (it.type === "suggest" && last) last.appendChild(el("div", "gc-stay hint", "🛏 Long leg to the next gig: see Run sheet for overnight options"));
      else if (it.type !== "sleep" && it.type !== "suggest") grid.appendChild(el("div", "gig-card mini", `${it.text}${it.leg ? " — " + legText(it.leg) : ""}`));
    }));
    box.appendChild(grid);
  });
}
function setView(v) {
  MGR.view = v;
  $("runSheet").hidden = v !== "sheet"; $("runCards").hidden = v !== "cards";
  [["tabSheet", "sheet"], ["tabCards", "cards"]].forEach(([id, k]) => { $(id).classList.toggle("on", v === k); $(id).setAttribute("aria-selected", String(v === k)); });
}

// ── map ───────────────────────────────────────────────────────────────────
let MAP = null, MAP_LAYER = null, SEARCH_LAYER = null; const MARKERS = new Map();
const popupFor = (title, lines) => { const d = document.createElement("div"); const b = document.createElement("strong"); b.textContent = title; d.appendChild(b); lines.filter(Boolean).forEach((t) => { const p = document.createElement("div"); p.textContent = t; d.appendChild(p); }); return d; };
async function drawMap() {
  const box = $("mgrMap");
  if (!MGR.groups.length) { box.hidden = true; return; }
  let L;
  try { L = await TourSupport.loadLeaflet(); } catch (e) { box.hidden = true; $("mapNote").textContent = "The map couldn't load (no connection to the map library). Everything else still works."; return; }
  box.hidden = false;
  if (!MAP) { MAP = initMap("mgrMap"); MAP_LAYER = L.layerGroup().addTo(MAP); SEARCH_LAYER = L.layerGroup().addTo(MAP); }
  MAP_LAYER.clearLayers(); MARKERS.clear();
  const all = [], seen = new Set(); let n = 0;
  const pin = (txt, cls) => L.divIcon({ className: "", html: `<span class="mgr-pin ${cls}">${txt}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] });
  MGR.groups.forEach((g) => {
    const pts = routePoints(g);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1].ll, b = pts[i].ll, r = MGR.useRouted ? MGR.routed.get(pkey(a, b)) : null;
      if (r && r.geometry) L.polyline(decodePoly(r.geometry), { color: "#2e7d32", weight: 4, opacity: 0.85 }).addTo(MAP_LAYER);
      else L.polyline([a, b], { color: "#2e7d32", weight: 3, opacity: 0.6, dashArray: "6 8" }).addTo(MAP_LAYER);
    }
    pts.forEach((x) => {
      all.push(x.ll);
      const k = x.kind + x.ll.join(",");
      if (x.kind !== "gig" && seen.has(k)) return; seen.add(k);
      const icon = x.kind === "gig" ? pin(++n, "gig") : x.kind === "pickup" ? pin("P" + x.n, "pickup") : x.kind === "stay" ? pin("🛏", "stay") : x.kind === "stop" ? pin(x.icon || "📍", "stop") : pin(x.kind === "start" || x.kind === "end" ? "🏠" : "↩", "home");
      const m = L.marker(x.ll, { icon }).addTo(MAP_LAYER);
      if (x.kind === "gig") { const info = gigInfo(x.pk), v = MGR.venues[x.pk.venue_id] || {}; m.bindPopup(popupFor(info.title, [dayName(x.pk.date) + (info.time ? " · " + info.time : ""), addrOf(v)])); MARKERS.set(noteKey(x.pk), m); }
      else m.bindPopup(popupFor(x.label, []));
    });
    buildGroup(g).forEach((d) => d.items.forEach((it) => { // hotels still to choose from, as small dots
      if (it.type === "suggest") it.opts.list.forEach((o) => L.circleMarker([o.h.lat, o.h.lon], { radius: 5, color: "#ef6c00", fillOpacity: 0.7 }).bindPopup(popupFor(o.h.n, [`${fmtMins(o.ahMins)} after the gig, then ${fmtMins(o.hbMins)}`])).addTo(MAP_LAYER));
    }));
  });
  if (all.length) MAP.fitBounds(L.latLngBounds(all).pad ? L.latLngBounds(all).pad(0.15) : L.latLngBounds(all));
  setTimeout(() => MAP.invalidateSize(), 50);
  $("mapNote").textContent = `● numbered = gigs in order · P = pickups · 🛏 = overnights · orange dots = hotel options · ${MGR.useRouted ? "solid line = road route" : "dashed line = straight line, not the road"}`;
}
function focusGig(pk) {
  const m = MARKERS.get(noteKey(pk)); if (!m || !MAP) return;
  $("mgrMap").scrollIntoView({ block: "center", behavior: "smooth" });
  if (MAP.flyTo) MAP.flyTo(m.getLatLng ? m.getLatLng() : m.ll, 13);
  if (m.openPopup) m.openPopup();
}

// ── start point, and export as a tour in the events format ──────────────
function showStart() { const st = MGR.plan && MGR.plan.start; $("startNow").textContent = st && st.label ? `Starting from: ${st.label}` : "No start point yet: legs begin at the first gig."; }
function setStart(place) {
  MGR.plan.start = { lat: place.lat, lon: place.lon, label: place.label };
  if (MGR.plan.endSame === undefined) MGR.plan.endSame = true;
  $("startPlace").value = ""; $("startChoices").textContent = ""; showStart(); renderAll();
}
/** The plan as tours in the events-data format: one per stage. Required fields are filled; gigs matched to real events keep their ids, price and time. */
function toursOut() {
  const base = MGR.tourName.trim() || "My tour", out = {}, pool = (MGR.plan && MGR.plan.pool) || {};
  const performer = pool.primary || (pool.artists && pool.artists[0]) || "";
  MGR.groups.forEach((g, gi) => {
    const name = MGR.groups.length > 1 ? `${base} — ${g.name}` : base;
    const dateOut = (k) => { const d = parseKey(k); return d ? `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}` : k; };
    const dates = g.picks.map((pk) => {
      const info = gigInfo(pk), r = MGR.recs.get(`${pk.venue_id}|${pk.date}`), src = r && r.source && r.source.rec;
      const td = { date: dateOut(pk.date), venue_id: pk.venue_id };
      if (info.time) td.time = info.time;
      if (info.price) td.price = info.price;
      if (r && r.kind === "event" && src) { if (src.eventId) td.eventId = src.eventId; if (src.performer_id) td.performer_id = src.performer_id; if (info.title) td.title = info.title; }
      return td;
    });
    out[slug(name)] = { tour_name: name, name, performer_id: performer, tour_dates: dates };
  });
  return { out, performer };
}
function exportTour() {
  const { out, performer } = toursOut();
  TourSupport.saveText(JSON.stringify(out, null, 2), `${slug(MGR.tourName || "tour")}-tour.json`, "application/json");
  setStatus(performer ? "Tour downloaded in the events-data format." : "Tour downloaded. The format requires a performer_id and none is known: add one before using it in the events data.", !performer);
}

// ── search along the route (OpenStreetMap via Overpass) ────────────────────
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const KINDS = {
  pub: { label: "Pubs", icon: "🍺", q: ['["amenity"="pub"]'] },
  cafe: { label: "Cafés", icon: "☕", q: ['["amenity"="cafe"]'] },
  food: { label: "Restaurants", icon: "🍽", q: ['["amenity"~"^(restaurant|fast_food)$"]'] },
  fuel: { label: "Fuel", icon: "⛽", q: ['["amenity"="fuel"]'] },
  services: { label: "Motorway services", icon: "🅿", q: ['["highway"="services"]'] },
  ev: { label: "EV charging", icon: "🔌", q: ['["amenity"="charging_station"]'] },
  hotel: { label: "Premier Inn / Travelodge", icon: "🛏", q: ['["tourism"="hotel"]["name"~"Premier Inn|Travelodge",i]'] },
};
const kindOf = (t) => (t.amenity === "pub" ? "pub" : t.amenity === "cafe" ? "cafe" : /^(restaurant|fast_food)$/.test(t.amenity || "") ? "food" : t.amenity === "fuel" ? "fuel" : t.highway === "services" ? "services" : t.amenity === "charging_station" ? "ev" : t.tourism === "hotel" ? "hotel" : "");
const flatMi = (a, b) => { const k = Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180); return Math.hypot((b[0] - a[0]) * 69.0, (b[1] - a[1]) * 69.17 * k); };
function lineLen(line) { let t = 0; for (let i = 1; i < line.length; i++) t += flatMi(line[i - 1], line[i]); return t; }
/** The part of a line between fractions f0 and f1 of its length. */
function sliceLine(line, f0, f1) {
  const cum = [0]; for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + flatMi(line[i - 1], line[i]));
  const T = cum[cum.length - 1]; if (!T) return line.slice();
  const at = (d) => { let i = 1; while (i < cum.length - 1 && cum[i] < d) i++; const seg = cum[i] - cum[i - 1] || 1, t = (d - cum[i - 1]) / seg; return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t]; };
  const s0 = f0 * T, e0 = f1 * T, out = [at(s0)];
  for (let i = 1; i < line.length - 1; i++) if (cum[i] > s0 && cum[i] < e0) out.push(line[i]);
  out.push(at(e0)); return out;
}
/** Thin a line to at most `max` points (Douglas–Peucker), keeping its shape. */
function simplifyLine(pts, max) {
  const perp = (p, a, b) => { const dx = b[1] - a[1], dy = b[0] - a[0], L = dx * dx + dy * dy; if (!L) return Math.hypot(p[0] - a[0], p[1] - a[1]); let t = ((p[1] - a[1]) * dx + (p[0] - a[0]) * dy) / L; t = Math.max(0, Math.min(1, t)); return Math.hypot(p[0] - (a[0] + dy * t), p[1] - (a[1] + dx * t)); };
  const dp = (eps) => { const keep = new Array(pts.length).fill(false); keep[0] = keep[pts.length - 1] = true; const st = [[0, pts.length - 1]];
    while (st.length) { const [a, b] = st.pop(); let md = 0, mi = -1; for (let i = a + 1; i < b; i++) { const d = perp(pts[i], pts[a], pts[b]); if (d > md) { md = d; mi = i; } } if (md > eps && mi > -1) { keep[mi] = true; st.push([a, mi], [mi, b]); } }
    return pts.filter((_, i) => keep[i]); };
  let eps = 0.0005, cur = pts; while (cur.length > max && eps < 5) { cur = dp(eps); eps *= 1.6; }
  return cur.length > max ? cur.filter((_, i) => i % Math.ceil(cur.length / max) === 0 || i === cur.length - 1) : cur;
}
/** Distance in miles from a point to a line, and how far along (0–1) the nearest point is. */
function nearOnLine(p, line) {
  const k = Math.cos(p[0] * Math.PI / 180), xy = (q) => [(q[1] - p[1]) * 69.17 * k, (q[0] - p[0]) * 69.0];
  let best = Infinity, bestAlong = 0, run = 0; const T = lineLen(line) || 1;
  for (let i = 1; i < line.length; i++) {
    const a = xy(line[i - 1]), b = xy(line[i]), dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
    let t = L ? Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / L)) : 0;
    const d = Math.hypot(a[0] + dx * t, a[1] + dy * t), seg = Math.sqrt(L);
    if (d < best) { best = d; bestAlong = run + seg * t; }
    run += seg;
  }
  return { d: best, frac: Math.min(1, bestAlong / T) };
}
/** Every leg that can be searched: start→first gig, gig→gig, last gig→end. */
function legSpans() {
  const out = [];
  MGR.groups.forEach((g, gi) => {
    const pts = routePoints(g), gigs = pts.map((x, i) => (x.kind === "gig" ? i : -1)).filter((i) => i >= 0);
    for (let k = 0; k <= gigs.length; k++) {
      const from = k === 0 ? 0 : gigs[k - 1], to = k === gigs.length ? pts.length - 1 : gigs[k];
      if (from >= to) continue;
      const first = pts[from], last = pts[to];
      const nm = (x, dflt) => (x.kind === "gig" ? x.label : x.kind === "start" || x.kind === "end" ? dflt : x.label);
      out.push({ value: `${gi}:${k}`, afterKey: k === 0 ? "start:" + g.name : noteKey(first.pk), pts: pts.slice(from, to + 1),
        label: `${MGR.groups.length > 1 ? g.name + ": " : ""}${k === 0 ? "Start" : nm(first, "Start")} → ${k === gigs.length ? "Home" : nm(last, "Home")}` });
    }
  });
  return out;
}
function spanGeometry(span) {
  let line = [], miles = 0, mins = 0;
  for (let i = 1; i < span.pts.length; i++) {
    const a = span.pts[i - 1].ll, b = span.pts[i].ll, r = MGR.useRouted ? MGR.routed.get(pkey(a, b)) : null, l = leg(a, b);
    const piece = r && r.geometry ? decodePoly(r.geometry) : [a, b];
    line = line.concat(line.length ? piece.slice(1) : piece);
    if (l) { miles += l.miles; mins += l.mins; }
  }
  return { line, miles, mins };
}
function fillAlongLegs() {
  const sel = $("alongLeg"); if (!sel) return;
  const keep = sel.value, spans = legSpans();
  sel.textContent = "";
  spans.forEach((sp) => { const o = el("option", null, sp.label); o.value = sp.value; sel.appendChild(o); });
  if (spans.some((sp) => sp.value === keep)) sel.value = keep;
  updateAlongConv();
}
function stretchFractions() {
  const sp = legSpans().find((x) => x.value === $("alongLeg").value); if (!sp) return null;
  const g = spanGeometry(sp);
  if ($("alongWhere").value === "all" || !g.miles) return { sp, g, f0: 0, f1: 1 };
  let a = Number($("alongFrom").value), b = Number($("alongTo").value);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { sp, g, f0: 0, f1: 1 };
  const total = $("alongUnit").value === "mi" ? g.miles : g.mins;
  let f0 = Math.max(0, Math.min(1, Math.min(a, b) / total)), f1 = Math.max(0, Math.min(1, Math.max(a, b) / total));
  return { sp, g, f0, f1 };
}
function updateAlongConv() {
  const miles = Number($("alongMiles").value);
  $("alongMilesOut").textContent = `${miles} mi from the road (about ${Math.round(miles * 2)} min detour)`;
  $("alongStretch").hidden = $("alongWhere").value === "all";
  const f = stretchFractions(), out = $("alongConv");
  if (!f || $("alongWhere").value === "all") { out.textContent = f ? `This leg is ${fmtMiles(f.g.miles)}, ${fmtMins(f.g.mins)}.` : ""; return; }
  const m0 = f.f0 * f.g.miles, m1 = f.f1 * f.g.miles, t0 = f.f0 * f.g.mins, t1 = f.f1 * f.g.mins;
  out.textContent = `≈ ${Math.round(m0)}–${Math.round(m1)} mi, ${fmtMins(t0)}–${fmtMins(t1)} into a ${fmtMiles(f.g.miles)} leg`;
}
async function overpass(query) {
  const key = "nt_op_" + [...query].reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 5381);
  try { const c = sessionStorage.getItem(key); if (c) return { elements: JSON.parse(c), cached: true }; } catch (e) { /* no cache */ }
  let last = "";
  for (const url of OVERPASS) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 35000);
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(query), signal: ctl.signal });
      if (!r.ok) { last = `HTTP ${r.status}`; continue; }
      const j = await r.json();
      if (j.remark && /error|timed out|too many/i.test(j.remark) && !(j.elements || []).length) { last = "the server was too busy"; continue; }
      const els = j.elements || [];
      try { sessionStorage.setItem(key, JSON.stringify(els)); } catch (e) { /* too big to cache */ }
      return { elements: els, cached: false };
    } catch (e) { last = e.name === "AbortError" ? "it took too long" : e.message; } finally { clearTimeout(timer); }
  }
  throw new Error(last || "no response");
}
async function searchAlong() {
  const st = $("alongStatus"), list = $("alongList"), f = stretchFractions();
  list.textContent = "";
  const kinds = [...document.querySelectorAll("#alongKinds input:checked")].map((i) => i.value);
  if (!f) { st.textContent = "Load a tour first."; return; }
  if (!kinds.length) { st.textContent = "Tick at least one kind of place."; return; }
  if (f.f1 - f.f0 < 0.001) { st.textContent = "That stretch is empty: check the from and to values."; return; }
  const miles = Number($("alongMiles").value), line = sliceLine(f.g.line, f.f0, f.f1);
  const coords = simplifyLine(line, 80), around = `(around:${Math.round(miles * 1609.344)},${coords.map((c) => c[0].toFixed(5) + "," + c[1].toFixed(5)).join(",")})`;
  const query = `[out:json][timeout:25];(${kinds.flatMap((k) => KINDS[k].q.map((q) => `nwr${q}${around};`)).join("")});out center tags 300;`;
  st.textContent = "Searching OpenStreetMap…"; $("alongGo").disabled = true;
  let res;
  try { res = await overpass(query); } catch (e) { st.textContent = `The map data service didn't answer (${e.message}). Nothing else is affected: try again in a minute, or with a narrower stretch.`; $("alongGo").disabled = false; return; }
  $("alongGo").disabled = false;
  const a = f.sp.pts[0].ll, b = f.sp.pts[f.sp.pts.length - 1].ll, direct = roadMiles(a, b) || 0, seen = new Set(), items = [];
  res.elements.forEach((e) => {
    const lat = e.lat != null ? e.lat : e.center && e.center.lat, lon = e.lon != null ? e.lon : e.center && e.center.lon, t = e.tags || {}, kind = kindOf(t);
    if (lat == null || lon == null || !kinds.includes(kind) || seen.has(e.type + e.id)) return; seen.add(e.type + e.id);
    const n = nearOnLine([lat, lon], line); if (n.d > miles + 0.25) return;
    const detour = Math.max(0, (roadMiles(a, [lat, lon]) + roadMiles([lat, lon], b) - direct) / MGR.mph * 60);
    items.push({ id: `${e.type}${e.id}`, name: t.name || `${KINDS[kind].label.replace(/s$/, "")} (unnamed)`, kind, lat, lon, d: n.d, detour,
      frac: f.f0 + n.frac * (f.f1 - f.f0), town: t["addr:city"] || t["addr:town"] || t["addr:suburb"] || "", street: t["addr:street"] || "", hours: t.opening_hours || "", web: t.website || t["contact:website"] || "" });
  });
  items.sort((x, y) => x.frac - y.frac);
  const shown = items.slice(0, 80);
  st.textContent = shown.length
    ? `${items.length} place${items.length === 1 ? "" : "s"} within ${miles} mi${items.length > shown.length ? ` (showing the first ${shown.length} along the road)` : ""}${res.cached ? " (from this session's cache)" : ""}. Map data © OpenStreetMap contributors: opening hours may be missing or out of date.`
    : `Nothing found within ${miles} mi of that stretch. Try a wider distance or more kinds.`;
  drawSearch(shown, line);
  shown.forEach((it) => {
    const li = el("li", "along-item");
    li.appendChild(el("strong", null, `${KINDS[it.kind].icon} ${it.name}`));
    li.appendChild(el("span", "mgr-hint", ` ${[it.street, it.town].filter(Boolean).join(", ")}`));
    li.appendChild(el("div", "mgr-hint", `${it.d.toFixed(1)} mi off the road · about ${Math.max(1, Math.round(it.detour))} min detour${it.hours ? " · " + it.hours.slice(0, 70) : ""}`));
    const add = el("button", "mgr-btn small", "＋ Add as a stop"); add.type = "button";
    add.addEventListener("click", () => { addStop(it, f.sp.afterKey); add.textContent = "✓ Added"; add.disabled = true; });
    li.appendChild(add);
    if (MAP) { const loc = el("button", "mgr-btn small", "📍"); loc.type = "button"; loc.addEventListener("click", () => { $("mgrMap").scrollIntoView({ block: "center", behavior: "smooth" }); if (MAP.flyTo) MAP.flyTo([it.lat, it.lon], 14); }); li.appendChild(loc); }
    list.appendChild(li);
  });
}
function drawSearch(items, line) {
  if (!MAP || !SEARCH_LAYER || !window.L) return;
  SEARCH_LAYER.clearLayers();
  L.polyline(line, { color: "#ef6c00", weight: 8, opacity: 0.3 }).addTo(SEARCH_LAYER);
  items.forEach((it) => L.circleMarker([it.lat, it.lon], { radius: 6, color: "#6a1b9a", fillOpacity: 0.75 }).bindPopup(popupFor(`${KINDS[it.kind].icon} ${it.name}`, [`${it.d.toFixed(1)} mi off the road`, it.hours])).addTo(SEARCH_LAYER));
}
function addStop(it, afterKey) {
  if (MGR.extras.some((e) => e.id === it.id && e.after === afterKey)) return;
  MGR.extras.push({ id: it.id, after: afterKey, frac: it.frac, name: it.name, kind: it.kind, icon: KINDS[it.kind].icon, lat: it.lat, lon: it.lon, mins: it.kind === "fuel" || it.kind === "ev" ? 15 : 30 });
  renderAll(); routeMissing();
}

// ── save / handover ───────────────────────────────────────────────────────
function saveManagerPlan() {
  const out = { ...MGR.plan, tourName: MGR.tourName, manager: {
    pickups: MGR.pickups, dropHome: MGR.dropHome, stays: MGR.stays, notes: MGR.notes, extras: MGR.extras,
    settings: { after: MGR.after, trigger: MGR.trigger, brands: MGR.brands, anyGap: MGR.anyGap, mph: MGR.mph },
  } };
  TourSupport.saveText(JSON.stringify(out, null, 2), `tour-plan-with-logistics.json`, "application/json");
}

// ── pickups ───────────────────────────────────────────────────────────────
function addPickup(place) {
  MGR.pickups.push({ label: $("pickupLabel").value.trim(), lat: place.lat, lon: place.lon, place: place.label, time: $("pickupTime").value });
  $("pickupLabel").value = ""; $("pickupPlace").value = ""; $("pickupTime").value = "";
  drawPickups(); renderAll();
}
function drawPickups() {
  const ol = $("pickupList"); ol.textContent = "";
  MGR.pickups.forEach((p, i) => {
    const li = el("li", null, `${p.time ? p.time + " · " : ""}${p.label || "Passenger " + (i + 1)} — ${p.place} `);
    const mk = (t, fn, dis) => { const b = el("button", "mgr-btn small", t); b.type = "button"; b.disabled = !!dis; b.addEventListener("click", fn); li.appendChild(b); li.appendChild(document.createTextNode(" ")); };
    mk("↑", () => { [MGR.pickups[i - 1], MGR.pickups[i]] = [MGR.pickups[i], MGR.pickups[i - 1]]; drawPickups(); renderAll(); }, i === 0);
    mk("↓", () => { [MGR.pickups[i + 1], MGR.pickups[i]] = [MGR.pickups[i], MGR.pickups[i + 1]]; drawPickups(); renderAll(); }, i === MGR.pickups.length - 1);
    mk("Remove", () => { MGR.pickups.splice(i, 1); drawPickups(); renderAll(); });
    ol.appendChild(li);
  });
}

// ── optional real drive times (OpenRouteService) ──────────────────────────
/** The journey as ordered points: start, pickups, gigs (with any overnight stay between), drop-offs, end. */
function routePoints(g) {
  const pts = [], s0 = startLL();
  if (s0) pts.push({ ll: s0, kind: "start", label: (MGR.plan.start && MGR.plan.start.label) || "Start" });
  MGR.pickups.forEach((p, i) => pts.push({ ll: [p.lat, p.lon], kind: "pickup", label: `${p.label || "Passenger " + (i + 1)} — ${p.place}`, n: i + 1 }));
  pts.push(...exPts("start:" + g.name));
  g.picks.forEach((pk, i) => {
    const prev = i > 0 ? g.picks[i - 1] : null, st = prev ? MGR.stays[prev.date] : null;
    const d1 = prev && parseKey(prev.date), d2 = parseKey(pk.date);
    if (st && d1 && d2 && d2 - d1 >= 86400000) pts.push({ ll: [st.lat, st.lon], kind: "stay", label: st.n + (st.t ? ", " + st.t : "") });
    pts.push({ ll: llOf(pk.venue_id), kind: "gig", label: pk.name, pk });
    pts.push(...exPts(noteKey(pk)));
  });
  if (MGR.dropHome) [...MGR.pickups].reverse().forEach((p) => pts.push({ ll: [p.lat, p.lon], kind: "drop", label: `Drop ${p.label || "passenger"} — ${p.place}` }));
  const e = endLL(); if (e) pts.push({ ll: e, kind: "end", label: endLabel() });
  return pts.filter((x) => x.ll);
}
function allLegPairs() {
  const pairs = new Map();
  MGR.groups.forEach((g) => {
    const pts = routePoints(g).map((x) => x.ll);
    for (let i = 1; i < pts.length; i++) if (pts[i - 1][0] !== pts[i][0] || pts[i - 1][1] !== pts[i][1]) pairs.set(pkey(pts[i - 1], pts[i]), [pts[i - 1], pts[i]]);
  });
  return [...pairs.entries()];
}
/** When real times are in use, fetch any legs that have appeared since (e.g. around a newly chosen hotel). */
function routeMissing() { if (MGR.useRouted && $("orsKey").value.trim()) getRoutes(); }
async function getRoutes() {
  const key = $("orsKey").value.trim(), st = $("orsStatus");
  if (!key) { st.textContent = "Paste your OpenRouteService key first."; return; }
  try { localStorage.setItem(ORS_KEY, key); } catch (e) { /* optional */ }
  const todo = allLegPairs().filter(([k]) => !MGR.routed.has(k));
  let done = 0, failed = "";
  $("orsGo").disabled = true;
  for (const [k, [a, b]] of todo) {
    st.textContent = `Fetching real drive times… ${done}/${todo.length}`;
    try {
      const r = await fetch("https://api.openrouteservice.org/v2/directions/driving-car", {
        method: "POST", headers: { Authorization: key, "Content-Type": "application/json" },
        body: JSON.stringify({ coordinates: [[a[1], a[0]], [b[1], b[0]]] }),
      });
      if (r.status === 401 || r.status === 403) { failed = "OpenRouteService rejected the key."; break; }
      if (r.status === 429) { failed = "OpenRouteService rate limit reached — try again in a minute."; break; }
      if (!r.ok) { failed = `OpenRouteService error (HTTP ${r.status}) for one leg; the rest are estimates.`; continue; }
      const j = await r.json(), s = j.routes && j.routes[0] && j.routes[0].summary;
      if (s) { MGR.routed.set(k, { miles: s.distance / 1609.344, mins: s.duration / 60, geometry: typeof j.routes[0].geometry === "string" ? j.routes[0].geometry : "" }); done++; }
    } catch (e) { failed = "Couldn't reach OpenRouteService: " + e.message; break; }
  }
  $("orsGo").disabled = false;
  MGR.useRouted = MGR.routed.size > 0;
  $("orsOff").hidden = !MGR.useRouted;
  st.textContent = failed ? `${failed} ${done} leg${done === 1 ? "" : "s"} routed.` : `Done: ${done} leg${done === 1 ? "" : "s"} routed. Legs marked (routed) use real times.`;
  renderAll();
}

// ── wiring ────────────────────────────────────────────────────────────────
function readFile(file, cb) {
  if (!file) return;
  const rd = new FileReader();
  rd.onerror = () => setStatus("Couldn't read that file.", true);
  rd.onload = () => { try { cb(JSON.parse(String(rd.result))); } catch (e) { setStatus(e instanceof SyntaxError ? "That file isn't valid JSON." : e.message, true); } };
  rd.readAsText(file);
}
async function initManager() {
  const result = await loadEventsData();
  $("mgrLoading").hidden = true;
  if (!result) { $("mgrLoading").hidden = false; $("mgrLoading").textContent = "Couldn't load events data."; return; }
  MGR.venues = result.venuesLookup || {};
  MGR.eventsData = result.eventsData || null;
  $("mgrMain").hidden = false;
  let handover = null;
  try { handover = JSON.parse(localStorage.getItem(HANDOVER_KEY) || "null"); } catch (e) { /* ignore */ }
  if (handover && handover.format === "new-troubadours-tour-plan") {
    $("mgrFromPlanner").hidden = false;
    const useHandover = () => { try { loadPlan(handover, "Plan loaded from the Tour Planner."); localStorage.removeItem(HANDOVER_KEY); } catch (e) { setStatus(e.message, true); } };
    $("mgrFromPlanner").addEventListener("click", useHandover);
    if (/[?&]from=planner/.test(location.search)) useHandover(); // the copy kept in browser storage is removed once used
  }
  $("alongKinds").append(...Object.entries(KINDS).map(([k, v]) => { const l = el("label", "mgr-check"); const i = document.createElement("input"); i.type = "checkbox"; i.value = k; i.checked = k === "pub" || k === "cafe"; l.appendChild(i); l.appendChild(document.createTextNode(" " + v.icon + " " + v.label)); return l; }));
  ["alongLeg", "alongMiles", "alongWhere", "alongFrom", "alongTo", "alongUnit"].forEach((id) => $(id).addEventListener("input", updateAlongConv));
  $("alongGo").addEventListener("click", searchAlong);
  $("tabSheet").addEventListener("click", () => setView("sheet")); $("tabCards").addEventListener("click", () => setView("cards"));
  $("mgrFile").addEventListener("change", (e) => readFile(e.target.files[0], (p) => acceptJson(p, "File loaded")));
  fillTourSelect(MGR.eventsData && MGR.eventsData.tours ? MGR.eventsData.tours : {});
  $("mgrTourOpen").addEventListener("click", openChosenTour);
  const tid = (location.search.match(/[?&]tour=([^&]+)/) || [])[1];
  if (tid && MGR.tourPool && MGR.tourPool[decodeURIComponent(tid)]) { $("mgrTourSel").value = decodeURIComponent(tid); openChosenTour(); }
  $("tourName").addEventListener("input", () => { MGR.tourName = $("tourName").value; });
  const findStart = () => TourSupport.findPlace({ input: $("startPlace"), choices: $("startChoices"), onPick: setStart,
    setStatus: (m, err) => { if (m) { $("startChoices").textContent = m; $("startChoices").classList.toggle("err", !!err); } }, hintClass: "mgr-hint", choiceClass: "mgr-btn" });
  $("startSet").addEventListener("click", findStart);
  $("startPlace").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); findStart(); } });
  $("hotelFile").addEventListener("change", (e) => readFile(e.target.files[0], (l) => setHotels(l, "your file")));
  const num = (id, key, lo, hi) => $(id).addEventListener("input", () => { const n = parseInt($(id).value, 10); if (Number.isFinite(n)) { MGR[key] = Math.min(hi, Math.max(lo, n)); renderAll(); } });
  num("mphIn", "mph", 20, 80);
  $("anyGap").addEventListener("change", () => { MGR.anyGap = $("anyGap").checked; renderAll(); });
  num("afterMins", "after", 15, 240); num("triggerMins", "trigger", 30, 600);
  $("brandPI").addEventListener("change", () => { MGR.brands.PI = $("brandPI").checked; renderAll(); });
  $("brandTL").addEventListener("change", () => { MGR.brands.TL = $("brandTL").checked; renderAll(); });
  $("dropHome").addEventListener("change", () => { MGR.dropHome = $("dropHome").checked; renderAll(); });
  const doFind = () => TourSupport.findPlace({
    input: $("pickupPlace"), choices: $("pickupChoices"), onPick: addPickup,
    setStatus: (m, err) => { const s = $("pickupChoices"); if (m) { s.textContent = m; s.classList.toggle("err", !!err); } },
    hintClass: "mgr-hint", choiceClass: "mgr-btn",
  });
  $("pickupAdd").addEventListener("click", doFind);
  $("pickupPlace").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doFind(); } });
  try { $("orsKey").value = localStorage.getItem(ORS_KEY) || ""; } catch (e) { /* optional */ }
  $("orsGo").addEventListener("click", getRoutes);
  $("orsOff").addEventListener("click", () => { MGR.useRouted = false; $("orsOff").hidden = true; $("orsStatus").textContent = "Showing estimates."; renderAll(); });
  await initHotels();
  drawPickups();
}
initManager();
