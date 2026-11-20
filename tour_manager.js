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

const MGR = {
  venues: {}, plan: null, groups: [], hotels: null,
  pickups: [], dropHome: false, stays: {}, notes: {}, anyGap: false, mph: AVG_MPH,
  after: 60, trigger: 90, brands: { PI: true, TL: true },
  routed: new Map(), useRouted: false, // "lat,lon>lat,lon" -> { miles, mins }
};
const $ = (id) => document.getElementById(id);
const pkey = (a, b) => `${a[0].toFixed(4)},${a[1].toFixed(4)}>${b[0].toFixed(4)},${b[1].toFixed(4)}`;
const parseKey = (s) => { const [y, m, d] = String(s || "").split("-").map(Number); return y ? new Date(y, m - 1, d) : null; };
const fmtMins = (m) => (m == null ? "" : m >= 60 ? `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, "0")}m` : `${Math.round(m)}m`);

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

function loadPlan(plan, from) {
  if (!plan || plan.format !== "new-troubadours-tour-plan") throw new Error("This doesn't look like a Tour Planner plan file.");
  MGR.plan = plan;
  MGR.groups = groupsOf(plan);
  const m = plan.manager || {};
  MGR.pickups = Array.isArray(m.pickups) ? m.pickups.filter((p) => placeLL(p)).map((p) => ({ label: String(p.label || ""), lat: Number(p.lat), lon: Number(p.lon), place: String(p.place || ""), time: String(p.time || "") })) : [];
  MGR.dropHome = !!m.dropHome;
  MGR.notes = m.notes && typeof m.notes === "object" ? m.notes : {};
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
        dayOf(prevPick.date).items.push({ type: "sleep", stay, date: prevPick.date, l1: leg(a, h), l2: leg(h, ll), to: pk });
        prev = h; prevLabel = stay.n;
      } else if (needed) {
        dayOf(prevPick.date).items.push({ type: "suggest", date: prevPick.date, a, b: ll, leg: l, to: pk, opts: stayOptions(a, ll) });
      }
    }
    const l = prev && ll ? leg(prev, ll) : null;
    dayOf(pk.date).items.push({ type: "gig", pk, v, leg: l, from: prevLabel });
    prev = ll; prevLabel = v.name; prevPick = pk;
  });
  const last = g.picks[g.picks.length - 1], day = dayOf(last.date);
  if (MGR.dropHome && MGR.pickups.length) {
    [...MGR.pickups].reverse().forEach((p) => { const ll = [p.lat, p.lon]; day.items.push({ type: "drop", text: `Drop off ${p.label || "passenger"} — ${p.place}`, leg: leg(prev, ll), from: prevLabel }); prev = ll; prevLabel = p.place; });
  }
  const e = endLL();
  if (e && prev) day.items.push({ type: "end", text: `${MGR.plan.endSame === false ? "Finish at" : "Back at"} ${endLabel()}`, leg: leg(prev, e), from: prevLabel });
  return days.sort((x, y) => (x.date < y.date ? -1 : 1));
}
function addrOf(v) { return [v.full_address || v.name, v.city, v.postcode].filter(Boolean).join(", "); }
const dayName = (k) => { const d = parseKey(k); return d ? d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }) : k; };

const noteKey = (pk) => `${pk.date}|${pk.venue_id}`;
const runText = () => MGR.groups.map((g) => groupText(g, buildGroup(g))).join("\n");
function groupText(g, days) {
  const lines = [`${g.name}`, ""];
  days.forEach((d) => {
    lines.push(dayName(d.date));
    d.items.forEach((it) => {
      const lg = (l) => (l ? ` [${legText(l)}]` : "");
      if (it.type === "gig") {
        lines.push(`  ${it.pk.time ? it.pk.time + " " : ""}GIG: ${it.pk.name || it.v.name} — ${addrOf(it.v)}${lg(it.leg)}${it.pk.booked ? " ✓ booked" : ""}`);
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
          lineEl.appendChild(el("strong", null, `${it.pk.time ? it.pk.time + " · " : ""}${it.pk.name || it.v.name}`));
          lineEl.appendChild(document.createTextNode(` — ${addrOf(it.v)}`));
          if (it.leg) day.appendChild(el("div", "run-leg", `↳ from ${it.from || "start"}: ${legText(it.leg)}`));
          day.appendChild(lineEl);
          const nk = noteKey(it.pk), note = el("input", "run-note"); note.type = "text"; note.value = MGR.notes[nk] || "";
          note.placeholder = "Notes: load-in, soundcheck, contact…"; note.setAttribute("aria-label", `Notes for ${it.pk.name || it.v.name}`);
          const printed = el("div", "run-note-print", MGR.notes[nk] ? "Notes: " + MGR.notes[nk] : "");
          note.addEventListener("input", () => { if (note.value.trim()) MGR.notes[nk] = note.value; else delete MGR.notes[nk]; printed.textContent = note.value.trim() ? "Notes: " + note.value : ""; });
          day.appendChild(note); day.appendChild(printed);
        } else if (it.type === "suggest") renderSuggest(day, it);
        else if (it.type === "sleep") renderSleep(day, it);
        else {
          if (it.leg) day.appendChild(el("div", "run-leg", `↳ from ${it.from || "start"}: ${legText(it.leg)}`));
          day.appendChild(el("div", "run-line", it.text));
        }
      });
      wrap.appendChild(day);
    });
    box.appendChild(wrap);
  });
  box.appendChild(el("div", "run-totals", `${totalGigs} gig${totalGigs === 1 ? "" : "s"} · ${fmtMiles(totalMiles)} of driving${MGR.useRouted ? " (routed where fetched)" : " (estimates)"}`));
  const act = $("runActions");
  const mk = (t, fn) => { const b = el("button", "mgr-btn", t); b.type = "button"; b.addEventListener("click", fn); act.appendChild(b); return b; };
  const copy = mk("📋 Copy run sheet", async () => { try { await navigator.clipboard.writeText(runText()); copy.textContent = "Copied ✓"; } catch (e) { copy.textContent = "Copy failed"; } });
  mk("⬇ Download run sheet (.txt)", () => TourSupport.saveText(runText(), "run-sheet.txt", "text/plain"));
  mk("🖨 Print", () => window.print());
  mk("💾 Save plan with logistics", saveManagerPlan);
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

// ── save / handover ───────────────────────────────────────────────────────
function saveManagerPlan() {
  const out = { ...MGR.plan, manager: {
    pickups: MGR.pickups, dropHome: MGR.dropHome, stays: MGR.stays, notes: MGR.notes,
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
function allLegPairs() {
  const pairs = new Map();
  // every consecutive pair in each group's route, including pickups, stays and the end
  MGR.groups.forEach((g) => {
    const pts = [];
    const s = startLL(); if (s) pts.push(s);
    MGR.pickups.forEach((p) => pts.push([p.lat, p.lon]));
    g.picks.forEach((pk, i) => {
      const st = i > 0 ? MGR.stays[g.picks[i - 1].date] : null;
      if (st) pts.push([st.lat, st.lon]);
      pts.push(llOf(pk.venue_id));
    });
    if (MGR.dropHome) [...MGR.pickups].reverse().forEach((p) => pts.push([p.lat, p.lon]));
    const e = endLL(); if (e) pts.push(e);
    for (let i = 1; i < pts.length; i++) if (pts[i - 1] && pts[i] && pts[i - 1][0] !== pts[i][0]) pairs.set(pkey(pts[i - 1], pts[i]), [pts[i - 1], pts[i]]);
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
      if (s) { MGR.routed.set(k, { miles: s.distance / 1609.344, mins: s.duration / 60 }); done++; }
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
  $("mgrMain").hidden = false;
  let handover = null;
  try { handover = JSON.parse(localStorage.getItem(HANDOVER_KEY) || "null"); } catch (e) { /* ignore */ }
  if (handover && handover.format === "new-troubadours-tour-plan") {
    $("mgrFromPlanner").hidden = false;
    const useHandover = () => { try { loadPlan(handover, "Plan loaded from the Tour Planner."); localStorage.removeItem(HANDOVER_KEY); } catch (e) { setStatus(e.message, true); } };
    $("mgrFromPlanner").addEventListener("click", useHandover);
    if (/[?&]from=planner/.test(location.search)) useHandover(); // the copy kept in browser storage is removed once used
  }
  $("mgrFile").addEventListener("change", (e) => readFile(e.target.files[0], (p) => loadPlan(p, "Plan file loaded.")));
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
