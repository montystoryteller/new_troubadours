#!/usr/bin/env node
/* Fetch Premier Inn and Travelodge locations in Great Britain from OpenStreetMap (Overpass API)
 * and write them to data/budget_hotels.json for the Tour Manager.
 *
 *   node tools/fetch_budget_hotels.js            (Node 18+, needs internet)
 *
 * Output: [{ "b": "PI" | "TL", "n": "Premier Inn Leeds City Centre", "lat": 53.79, "lon": -1.55, "t": "Leeds" }, ...]
 * Names and coordinates only (no prices or availability). Data (c) OpenStreetMap contributors, ODbL:
 * keep the credit line the Tour Manager shows. Re-run now and then to refresh. The counts are printed so
 * you can compare them with each chain's published number of UK hotels.
 */
const fs = require("fs"), path = require("path");
const ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const BRANDS = [["PI", "Premier Inn"], ["TL", "Travelodge"]];

const query = `[out:json][timeout:180];
area["ISO3166-1"="GB"][admin_level=2]->.uk;
(
${BRANDS.map(([, n]) => `  nwr["tourism"="hotel"]["brand"="${n}"](area.uk);\n  nwr["tourism"="hotel"]["name"~"^${n}",i](area.uk);`).join("\n")}
);
out center tags;`;

async function post(url) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(query) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

(async () => {
  let json = null, last = null;
  for (const u of ENDPOINTS) { try { json = await post(u); break; } catch (e) { last = e; console.error("  " + e.message); } }
  if (!json) { console.error("Could not reach Overpass: " + (last && last.message)); process.exit(1); }
  const seen = new Set(), out = [];
  for (const e of json.elements || []) {
    const tags = e.tags || {};
    const lat = e.lat != null ? e.lat : e.center && e.center.lat, lon = e.lon != null ? e.lon : e.center && e.center.lon;
    if (lat == null || lon == null) continue;
    const hay = `${tags.brand || ""} ${tags.name || ""}`.toLowerCase();
    const brand = BRANDS.find(([, n]) => hay.includes(n.toLowerCase()));
    if (!brand) continue;
    const key = `${brand[0]}|${lat.toFixed(4)}|${lon.toFixed(4)}`;
    if (seen.has(key)) continue; seen.add(key);
    out.push({ b: brand[0], n: tags.name || brand[1], lat: +lat.toFixed(5), lon: +lon.toFixed(5), t: tags["addr:city"] || tags["addr:town"] || tags["addr:suburb"] || "" });
  }
  out.sort((a, b) => a.b.localeCompare(b.b) || a.n.localeCompare(b.n));
  const file = path.join(__dirname, "..", "data", "budget_hotels.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out));
  BRANDS.forEach(([k, n]) => console.log(`${n}: ${out.filter((x) => x.b === k).length}`));
  console.log(`Wrote ${out.length} hotels to ${file}`);
})();
