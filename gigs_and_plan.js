// Booked / pencilled / queried must-visits, multi-night runs, and the save / load plan file.
const { run } = require("../lib");
const fs = require("fs"), os = require("os"), path = require("path");
run("must-visit statuses, runs and plan file (pool mode)", async (t) => {
  const p = t.page; await t.open("tour_planner.html");
  await p.locator(".mode-card[data-mode=pool]").click();
  const id = await p.evaluate(() => [...performerVenueIndex().entries()].sort((a, b) => b[1].size - a[1].size)[0][0]);
  await p.evaluate((id) => { PLANNER.pickPerf.add(id); refreshPool(); }, id); await p.waitForTimeout(500);
  const { V, D } = await p.evaluate(() => {
    const inPool = new Set(PLANNER.pool.map((r) => r.vid));
    const V = Object.keys(PLANNER.venues).filter((v) => !inPool.has(v) && TourSupport.venueUsable(PLANNER.venues, v) && Array.isArray(PLANNER.venues[v].latlon)).slice(0, 5);
    const base = document.getElementById("periodStart").value;
    const D = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => { const d = new Date(base + "T00:00:00"); d.setDate(d.getDate() + n); return dkey(d); });
    return { V, D };
  });
  const setRows = (rows) => p.evaluate((rows) => {
    PLANNER.mustRows = rows.map((r) => { const it = mustItems().find((i) => i.type === "v" && i.key === r.key); return { ...it, date: r.date, alt: r.alt || [], flex: 0, status: r.status, nights: r.nights || 1 }; });
    PLANNER.released = new Set(); drawMustRows();
  }, rows);
  const build = async () => { await p.click("#buildTour"); await p.waitForTimeout(2500); };
  const chosen = () => p.evaluate(() => [...PLANNER.chosen.entries()].sort().map(([k, c]) => k + "|" + c.venue_id));

  await setRows([{ key: V[0], date: D[2], status: "booked" }]); await build();
  t.eq((await chosen()).filter((x) => x.startsWith(D[2])).map((x) => x.split("|")[1]), [V[0]], "booked venue is the only gig on its night");

  await setRows([{ key: V[1], date: D[1], alt: [D[4], ""], status: "queried" }]); await build();
  t.eq(await p.evaluate(() => [...PLANNER.chosen.values()].filter((c) => c.queried).length <= 1), true, "queried venue used at most once");

  await setRows([{ key: V[2], date: D[2], status: "booked", nights: 3 }]); await build();
  const run3 = (await chosen()).filter((x) => x.endsWith("|" + V[2])).map((x) => x.split("|")[0]);
  t.eq(run3, [D[2], D[3], D[4]], "3-night run fills three consecutive nights at one venue");

  await setRows([{ key: V[0], date: D[1], status: "booked" }, { key: V[1], date: D[3], status: "pencilled" }]); await build();
  const file = path.join(os.tmpdir(), "nt_plan_test.json");
  await p.evaluate(() => { window.__b = []; URL.createObjectURL = () => "blob:x"; });
  const savedText = await p.evaluate(async () => { const ev = []; const orig = Blob; let got = null;
    window.Blob = class extends orig { constructor(a, o) { super(a, o); got = a; } };
    document.getElementById("planSave").click(); await new Promise((r) => setTimeout(r, 400)); window.Blob = orig; return got ? got.join("") : ""; });
  t.ok(savedText.includes("mustVisits"), "Save plan produces a plan file");
  fs.writeFileSync(file, savedText);
  const before = await p.evaluate(() => JSON.stringify(PLANNER.mustRows.map((m) => [m.status, m.date, m.nights])));
  await p.locator(".mode-card[data-mode=period]").click(); await p.waitForTimeout(300);
  await p.setInputFiles("#planFile", file); await p.waitForTimeout(3500);
  t.eq(await p.evaluate(() => JSON.stringify(PLANNER.mustRows.map((m) => [m.status, m.date, m.nights]))), before, "load plan restores must-visit statuses and dates");
  t.ok(await t.vis("#blkMust"), "optional panels shown after loading a plan");
});
