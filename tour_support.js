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

  return {
    ROAD_FACTOR, AVG_MPH, KM_TO_MI,
    addDays, dateKey,
    roadMiles, crowMiles, fmtMiles, fmtDrive,
    venueUsable, placeLabel,
    geocode, saveStart, loadStart, findPlace, locate,
    loadLeaflet,
  };
})();
