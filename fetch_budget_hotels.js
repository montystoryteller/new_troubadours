
#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];

const BRANDS = [
  ["PI", "Premier Inn"],
  ["TL", "Travelodge"]
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function buildQuery(name) {
  return `[out:json][timeout:180];
area["ISO3166-1"="GB"][admin_level=2]->.uk;
(
  nwr["tourism"="hotel"]["brand"="${name}"](area.uk);
  nwr["tourism"="hotel"]["name"~"^${name}",i](area.uk);
);
out center tags;`;
}

async function post(url, query) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 210000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        "User-Agent": "TourManager/1.0 (hotel location data)"
      },
      body: new URLSearchParams({ data: query }).toString(),
      signal: controller.signal
    });

    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      throw new Error(
        `HTTP ${response.status}` +
        (retryAfter ? ` (Retry-After: ${retryAfter})` : "")
      );
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWithRetry(query) {
  let lastError;

  for (const endpoint of ENDPOINTS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        console.log(`Trying ${endpoint} (attempt ${attempt + 1})`);
        return await post(endpoint, query);
      } catch (error) {
        lastError = error;
        console.error(`  ${error.message}`);

        if (attempt < 2) {
          const delay = Math.min(5000 * (2 ** attempt), 30000);
          console.log(`  Waiting ${delay / 1000}s...`);
          await sleep(delay);
        }
      }
    }
  }

  throw lastError;
}

(async () => {
  try {
    const seen = new Set();
    const out = [];

    for (const [code, name] of BRANDS) {
      console.log(`Fetching ${name}...`);

      const json = await fetchWithRetry(buildQuery(name));

      for (const e of json.elements || []) {
        const tags = e.tags || {};

        const lat = e.lat != null
          ? e.lat
          : e.center?.lat;

        const lon = e.lon != null
          ? e.lon
          : e.center?.lon;

        if (lat == null || lon == null) continue;

        const hay = `${tags.brand || ""} ${tags.name || ""}`.toLowerCase();

        if (!hay.includes(name.toLowerCase())) continue;

        const key = `${code}|${lat.toFixed(4)}|${lon.toFixed(4)}`;

        if (seen.has(key)) continue;
        seen.add(key);

        out.push({
          b: code,
          n: tags.name || name,
          lat: +lat.toFixed(5),
          lon: +lon.toFixed(5),
          t: tags["addr:city"] ||
             tags["addr:town"] ||
             tags["addr:suburb"] || ""
        });
      }

      console.log(`${name}: ${out.filter(x => x.b === code).length}`);

      // Give the public API a little breathing room.
      await sleep(3000);
    }

    out.sort((a, b) =>
      a.b.localeCompare(b.b) || a.n.localeCompare(b.n)
    );

    const file = path.join(
      __dirname, "..", "data", "budget_hotels.json"
    );

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out, null, 2));

    console.log(`Successfully wrote ${out.length} hotels.`);
    console.log(file);

  } catch (error) {
    console.error("Hotel fetch failed:", error.message);
    process.exit(1);
  }
})();
