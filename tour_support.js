/**
 * tour_support.js — code shared by tour_planner.js and gig_crawl.js.
 *
 * Load AFTER shared_utils.js (uses haversineKm, formatDateForInput) and
 * BEFORE the page script. Exposes one global, `TourSupport`:
 *
 *   constants   ROAD_FACTOR, AVG_MPH, KM_TO_MI
 *   dates       addDays(), dateKey()          (DOM el() comes from shared_utils.js)
 *   distance    roadMiles(a, b), fmtMiles(m), fmtDrive(m), crowMiles(a, b)
 *   venues      venueUsable(venues, id), placeLabel(venue)
 *   start point geocode(text), saveStart(s), loadStart(), findPlace({...}), locate({...})
 *   map         loadLeaflet()
 *
 * Distances are straight-line x ROAD_FACTOR estimates, not routed journeys.
 * Geocoding uses postcodes.io (free, browser-callable, CORS-enabled).
 */
const TourSupport = (function () {
  "use strict";

  const GEO_API = "https://api.postcodes.io";
  const START_KEY = "tourPlannerStart"; // shared by both pages so a start point carries over
  const LEAFLET_JS_URL = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js";
  const LEAFLET_CSS_URL = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css";
  const ROAD_FACTOR = 1.3; // straight-line -> rough road distance
  const AVG_MPH = 45; // for the drive-time estimate
  const KM_TO_MI = 0.621371;
  const UK_BOUNDS = { latMin: 49, latMax: 61, lonMin: -11, lonMax: 2.5 };

  // ── dates ─────────────────────────────────────────────────────────────
  function addDays(d, n) {
    const r = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
    r.setHours(0, 0, 0, 0);
    return r;
  }
  /** yyyy-mm-dd key for a Date (same format as an <input type=date>). */
  function dateKey(d) {
    return formatDateForInput(d);
  }

  // ── distance ──────────────────────────────────────────────────────────
  /** Estimated road miles between two [lat, lon] points, or null. */
  function roadMiles(a, b) {
    if (!a || !b) return null;
    return haversineKm(a[0], a[1], b[0], b[1]) * KM_TO_MI * ROAD_FACTOR;
  }
  /** Straight-line miles between two [lat, lon] points (Infinity if unknown). */
  function crowMiles(a, b) {
    return a && b ? haversineKm(a[0], a[1], b[0], b[1]) * KM_TO_MI : Infinity;
  }
  function fmtMiles(m) {
    return m == null ? "?" : `${Math.round(m)} mi`;
  }
  function fmtDrive(m) {
    if (m == null) return "";
    const mins = Math.round((m / AVG_MPH) * 60);
    const h = Math.floor(mins / 60);
    const mm = mins % 60;
    return h ? `~${h}h ${String(mm).padStart(2, "0")}m` : `~${mm}m`;
  }

  // ── venues ────────────────────────────────────────────────────────────
  /** A venue we can place on a map: has coordinates inside the UK/Ireland
   *  box, isn't closed down, and isn't an online "venue". */
  function venueUsable(venues, id) {
    const v = venues && venues[id];
    if (!v || !Array.isArray(v.latlon) || v.latlon.length !== 2 || v.isClosedDown) return false;
    if (/online|zoom/i.test(`${id} ${v.name || ""} ${v.city || ""}`)) return false;
    const [la, lo] = v.latlon;
    return la >= UK_BOUNDS.latMin && la <= UK_BOUNDS.latMax && lo >= UK_BOUNDS.lonMin && lo <= UK_BOUNDS.lonMax;
  }
  /** "Venue name, City" without repeating the city when the name has it. */
  function placeLabel(v) {
    if (!v) return "";
    const city = v.city && !String(v.name || "").toLowerCase().includes(String(v.city).toLowerCase()) ? v.city : "";
    return [v.name, city].filter(Boolean).join(", ");
  }

  // ── start point: geocoding, persistence, UI wiring ────────────────────
  const POSTCODE_RE = /^[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}$/;
  const OUTCODE_RE = /^[A-Za-z]{1,2}\d[A-Za-z\d]?$/;

  async function geoJson(path) {
    const r = await fetch(`${GEO_API}${path}`);
    if (!r.ok && r.status !== 404) throw new Error(`Lookup failed (HTTP ${r.status})`);
    return r.status === 404 ? null : r.json();
  }

  /** @returns {Promise<{lat:number, lon:number, label:string}[]>} */
  async function geocode(text) {
    const q = (text || "").trim();
    if (!q) return [];
    if (POSTCODE_RE.test(q)) {
      const j = await geoJson(`/postcodes/${encodeURIComponent(q.replace(/\s+/g, ""))}`);
      return j && j.result && j.result.latitude != null
        ? [{ lat: j.result.latitude, lon: j.result.longitude, label: j.result.postcode }]
        : [];
    }
    if (OUTCODE_RE.test(q)) {
      const j = await geoJson(`/outcodes/${encodeURIComponent(q)}`);
      if (j && j.result && j.result.latitude != null)
        return [{ lat: j.result.latitude, lon: j.result.longitude, label: j.result.outcode }];
    }
    const j = await geoJson(`/places?q=${encodeURIComponent(q)}&limit=8`);
    return ((j && j.result) || [])
      .filter((p) => p.latitude != null)
      .map((p) => ({
        lat: p.latitude,
        lon: p.longitude,
        label: [...new Set([p.name_1, p.county_unitary || p.region].filter(Boolean))].join(", "),
      }));
  }

  function saveStart(s) {
    try { localStorage.setItem(START_KEY, JSON.stringify(s)); } catch (e) { /* storage is optional */ }
  }
  function loadStart() {
    try {
      const s = JSON.parse(localStorage.getItem(START_KEY) || "null");
      if (s && typeof s.lat === "number" && typeof s.lon === "number") return s;
    } catch (e) { /* ignore */ }
    return null;
  }
  function clearStart() {
    try { localStorage.removeItem(START_KEY); } catch (e) { /* storage is optional */ }
  }

  /**
   * Look up the text in `input`, then call onPick with the one match — or
   * show "Did you mean…" buttons in `choices` when there are several.
   * Options: {input, choices (elements), onPick(place), setStatus(msg, isError),
   *           hintClass, choiceClass, failHint}
   */
  async function findPlace(o) {
    o.choices.replaceChildren();
    o.setStatus("Looking up location…");
    try {
      const res = await geocode(o.input.value);
      if (!res.length) return o.setStatus("No match found — try a postcode or a nearby larger town.", true);
      o.setStatus("");
      if (res.length === 1) return o.onPick(res[0]);
      o.choices.appendChild(el("div", o.hintClass || "ts-hint", "Did you mean…"));
      res.forEach((r) => {
        const b = el("button", o.choiceClass || "ts-choice", r.label);
        b.type = "button";
        b.addEventListener("click", () => { o.choices.replaceChildren(); o.onPick(r); });
        o.choices.appendChild(b);
      });
    } catch (e) {
      o.setStatus(`${e.message}.${o.failHint ? " " + o.failHint : ""}`, true);
    }
  }

  /** Use the browser's geolocation. Options: {onPick(place), setStatus}. */
  function locate(o) {
    if (!navigator.geolocation) return o.setStatus("Location isn't available in this browser.", true);
    o.setStatus("Asking for your location…");
    navigator.geolocation.getCurrentPosition(
      (p) => { o.setStatus(""); o.onPick({ lat: p.coords.latitude, lon: p.coords.longitude, label: "My location" }); },
      () => o.setStatus("Couldn't get your location.", true),
      { timeout: 10000 },
    );
  }

  // ── Leaflet, loaded on demand so a slow CDN never delays page content ─
  let leafletPromise = null;
  function loadLeaflet() {
    if (window.L) return Promise.resolve(window.L);
    if (leafletPromise) return leafletPromise;
    leafletPromise = new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet"; css.href = LEAFLET_CSS_URL;
      document.head.appendChild(css);
      const s = document.createElement("script");
      s.src = LEAFLET_JS_URL; s.async = true;
      s.onload = () => resolve(window.L);
      s.onerror = () => { leafletPromise = null; reject(new Error("Leaflet could not be loaded")); };
      document.head.appendChild(s);
    });
    return leafletPromise;
  }

  /** Escape text for an iCalendar property value. */
  function icsEscape(s) {
    return String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  }
  /** "Venue, address" without repeating the venue name when the address already has it. */
  function icsLocation(v) {
    v = v || {};
    const a = v.full_address || v.city || "";
    return a && v.name && a.toLowerCase().includes(String(v.name).split(",")[0].trim().toLowerCase()) ? a : [v.name, a].filter(Boolean).join(", ");
  }
  /** Download all-day calendar entries. items: [{date, title, location, description, uid}] */
  function downloadIcs(items, filename, prodId) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
    const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    const L = ["BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:-//New Troubadours//${prodId || "Tour"}//EN`, "CALSCALE:GREGORIAN"];
    items.forEach((it, i) => {
      L.push("BEGIN:VEVENT", `UID:nt-${i}-${ymd(it.date)}-${encodeURIComponent(it.uid || "x").slice(0, 40)}@newtroubadours`,
        `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${ymd(it.date)}`, `DTEND;VALUE=DATE:${ymd(addDays(it.date, 1))}`,
        `SUMMARY:${icsEscape(it.title)}`, `LOCATION:${icsEscape(it.location)}`, `DESCRIPTION:${icsEscape(it.description)}`, "END:VEVENT");
    });
    L.push("END:VCALENDAR");
    const blob = new Blob([L.join("\r\n")], { type: "text/calendar" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = filename || "tour.ics";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ── data export (JSON / CSV) ─────────────────────────────────────────
  function saveText(text, filename, mime) {
    const blob = new Blob([text], { type: mime });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  /** Turn a page's stops into flat export rows and add the leg from the previous stop
   *  (or from home for the first). base(c) -> {title, kind, status, performer, venue, address,
   *  town, postcode, latitude, longitude, link, notes}; c.date must be a Date. */
  function buildRecords(stops, base, home) {
    let prev = home || null;
    return stops.map((c, i) => {
      const b = base(c);
      const ll = b.latitude != null && b.longitude != null ? [b.latitude, b.longitude] : null;
      const leg = prev && ll ? roadMiles(prev, ll) : null;
      if (ll) prev = ll;
      return {
        stop: i + 1, date: iso(c.date), weekday: WEEKDAYS[c.date.getDay()], time: c.time || "",
        title: b.title || "", kind: b.kind || "", status: b.status || "listed", performer: b.performer || "",
        venue: b.venue || "", address: b.address || "", town: b.town || "", postcode: b.postcode || "",
        latitude: b.latitude ?? "", longitude: b.longitude ?? "",
        miles_from_previous: leg == null ? "" : Math.round(leg * 10) / 10,
        drive_minutes_from_previous: leg == null ? "" : Math.round((leg / AVG_MPH) * 60),
        link: b.link || "", notes: b.notes || "",
      };
    });
  }
  function csvCell(v) { return `"${String(v == null ? "" : v).replace(/"/g, '""')}"`; }
  function toCsv(records) {
    if (!records.length) return "";
    const cols = Object.keys(records[0]);
    return "\ufeff" + [cols.join(","), ...records.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\r\n") + "\r\n";
  }
  function toJson(records, meta) {
    const total = records.reduce((t, r) => t + (Number(r.miles_from_previous) || 0), 0);
    return JSON.stringify({
      source: "New Troubadours", generated: new Date().toISOString(), ...(meta || {}),
      estimated_total_miles: Math.round(total * 10) / 10,
      note: `Distances are straight-line x ${ROAD_FACTOR} estimates at ${AVG_MPH} mph, not routed journeys.`,
      stops: records,
    }, null, 2);
  }
  /** Add "JSON" and "CSV" download buttons to `parent`. getRecords() is called on click. */
  function addExportButtons(parent, { className, getRecords, getMeta, basename }) {
    [["{ } Download JSON", "json"], ["⬇ Download CSV", "csv"]].forEach(([label, kind]) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = className || ""; b.textContent = label;
      b.addEventListener("click", () => {
        const rows = getRecords();
        if (kind === "json") saveText(toJson(rows, getMeta ? getMeta() : {}), (basename || "tour") + ".json", "application/json");
        else saveText(toCsv(rows), (basename || "tour") + ".csv", "text/csv;charset=utf-8");
      });
      parent.appendChild(b);
    });
  }

  // ── small, safe markdown renderer + "Explain this step" help (built with DOM nodes, never innerHTML) ──
  /** Inline markdown: **bold**, *italic*, `code`, [text](http/relative url). */
  function mdInline(text, parent) {
    const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      const t = m[0];
      let node;
      if (t.startsWith("**")) { node = document.createElement("strong"); mdInline(t.slice(2, -2), node); }
      else if (t.startsWith("`")) { node = document.createElement("code"); node.textContent = t.slice(1, -1); }
      else if (t.startsWith("[")) {
        const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t);
        const url = mm[2];
        if (/^(https?:\/\/|[\w./?=&%#-]+$)/i.test(url) && !/^javascript:/i.test(url)) {
          node = document.createElement("a"); node.href = url; node.textContent = mm[1];
          if (/^https?:/i.test(url)) { node.target = "_blank"; node.rel = "noopener"; }
        } else node = document.createTextNode(t);
      } else { node = document.createElement("em"); mdInline(t.slice(1, -1), node); }
      parent.appendChild(node);
      last = m.index + t.length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }
  /** Block markdown: blank-line paragraphs, "- " / "* " bullet lists, "1. " numbered lists, "## " headings. */
  function renderMarkdown(src) {
    const root = document.createElement("div");
    const blocks = String(src || "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
    blocks.forEach((blk) => {
      const lines = blk.split("\n").filter((l) => l.trim() !== "");
      if (!lines.length) return;
      if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
        const ul = document.createElement("ul");
        lines.forEach((l) => { const li = document.createElement("li"); mdInline(l.replace(/^\s*[-*]\s+/, ""), li); ul.appendChild(li); });
        root.appendChild(ul);
      } else if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
        const ol = document.createElement("ol");
        lines.forEach((l) => { const li = document.createElement("li"); mdInline(l.replace(/^\s*\d+[.)]\s+/, ""), li); ol.appendChild(li); });
        root.appendChild(ol);
      } else if (/^#{1,4}\s+/.test(lines[0])) {
        const h = document.createElement("h4"); mdInline(lines[0].replace(/^#{1,4}\s+/, ""), h); root.appendChild(h);
        if (lines.length > 1) { const p = document.createElement("p"); mdInline(lines.slice(1).join(" "), p); root.appendChild(p); }
      } else {
        const p = document.createElement("p");
        lines.forEach((l, i) => { if (i) p.appendChild(document.createElement("br")); mdInline(l, p); });
        root.appendChild(p);
      }
    });
    return root;
  }
  /** Load a JSON array of {id, title, text, modes?} and give each element with data-help-id
   *  an "Explain this step" button that reveals the rendered text. getMode() picks the record
   *  whose `modes` includes it (a record without `modes` applies to all). Safe if the file is missing. */
  async function setupHelp(url, getMode) {
    let records = [];
    try {
      const r = await fetch(url, { cache: "no-cache" });
      if (!r.ok) return null;
      records = await r.json();
      if (!Array.isArray(records)) return null;
    } catch (e) { return null; }
    const pick = (id) => {
      const mode = getMode ? getMode() : null;
      const mine = records.filter((x) => x && (x.step || x.id) === id && typeof x.text === "string");
      return mine.find((x) => Array.isArray(x.modes) && x.modes.includes(mode)) || mine.find((x) => !x.modes) || null;
    };
    const targets = [...document.querySelectorAll("[data-step],[data-help-id]")].map((host) => {
      host.classList.add("has-help");
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = "help-btn"; btn.textContent = "ⓘ Explain this step";
      btn.setAttribute("aria-expanded", "false");
      const box = document.createElement("div");
      box.className = "help-text"; box.hidden = true;
      const stepName = host.dataset.step || host.dataset.helpId;
      box.id = "help-" + stepName;
      btn.setAttribute("aria-controls", box.id);
      const heading = host.querySelector(":scope > h3");
      host.insertBefore(box, heading ? heading.nextSibling : host.firstChild);
      host.insertBefore(btn, host.firstChild);
      const draw = () => {
        const rec = pick(stepName);
        btn.hidden = !rec;
        if (!rec) { box.hidden = true; btn.setAttribute("aria-expanded", "false"); return; }
        box.replaceChildren();
        if (rec.title) { const t = document.createElement("strong"); t.textContent = rec.title; box.appendChild(t); }
        box.appendChild(renderMarkdown(rec.text));
      };
      btn.addEventListener("click", () => {
        const open = box.hidden;
        if (open) draw();
        box.hidden = !open;
        btn.setAttribute("aria-expanded", String(open));
        btn.textContent = open ? "ⓘ Hide explanation" : "ⓘ Explain this step";
      });
      draw();
      return { draw, box, btn };
    });
    return { refresh: () => targets.forEach((t) => { t.draw(); if (t.btn.hidden) t.box.hidden = true; }) };
  }

  return {
    ROAD_FACTOR, AVG_MPH, KM_TO_MI,
    addDays, dateKey,
    roadMiles, crowMiles, fmtMiles, fmtDrive,
    venueUsable, placeLabel,
    geocode, saveStart, loadStart, clearStart, findPlace, locate,
    loadLeaflet, icsEscape, icsLocation, downloadIcs,
    saveText, buildRecords, toCsv, toJson, addExportButtons,
    mdInline, renderMarkdown, setupHelp,
  };
})();
