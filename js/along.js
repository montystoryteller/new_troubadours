// Tour Manager: search along the route (Overpass, stubbed), stretch search, add/remove stop, save/restore, fallback, cache.
const { run } = require("../lib");
run("along the route", async (t) => {
  const p = t.page;
  await t.open("tour_planner.html");
  await p.locator(".mode-card[data-mode=pool]").click();
  const id = await p.evaluate(() => [...performerVenueIndex().entries()].sort((a, b) => b[1].size - a[1].size)[0][0]);
  await p.evaluate((id) => { PLANNER.pickPerf.add(id); refreshPool(); }, id); await p.waitForTimeout(500);
  await p.click("#buildTour"); await p.waitForTimeout(2500);
  await p.evaluate(() => { const b = [...document.querySelectorAll("#plannerResults button")].find((x) => /shortest route/i.test(x.textContent)); b && b.click(); }); await p.waitForTimeout(400);
  const [m] = await Promise.all([p.context().waitForEvent("page"), p.click("#openManager")]);
  await m.waitForSelector("#mgrMain:not([hidden])", { timeout: 20000 }); await m.waitForTimeout(800);
  const errs = []; m.on("pageerror", (e) => errs.push(e.message));
  const bodies = []; let fail1 = false, failAll = false;
  const handler = (name) => async (r) => {
    const body = decodeURIComponent((r.request().postData() || "").replace(/^data=/, "").replace(/\+/g, " "));
    bodies.push({ name, body });
    if (failAll || (fail1 && name === "main")) return r.fulfill({ status: 500, body: "busy" });
    // build fake places on the straight line between the two points of the first leg
    const co = (body.match(/around:\d+,([^)]*)\)/) || [])[1].split(",").map(Number); const pts = []; for (let i = 0; i < co.length; i += 2) pts.push([co[i], co[i + 1]]);
    const a = pts[0], b = pts[pts.length - 1], at = (f, off) => ({ lat: a[0] + (b[0] - a[0]) * f + off, lon: a[1] + (b[1] - a[1]) * f });
    const els = [
      { type: "node", id: 1, ...at(0.8, 0), tags: { amenity: "pub", name: "Late Pub" } },
      { type: "node", id: 2, ...at(0.2, 0), tags: { amenity: "cafe", name: "Early Cafe", opening_hours: "Mo-Su 08:00-17:00" } },
      { type: "node", id: 3, ...at(0.5, 0.5), tags: { amenity: "pub", name: "Far Off Pub" } },
    ];
    r.fulfill({ contentType: "application/json", body: JSON.stringify({ elements: els }) });
  };
  await m.route("https://overpass-api.de/**", handler("main")); await m.route("https://overpass.kumi.systems/**", handler("alt"));
  t.ok((await m.locator("#alongLeg option").count()) >= 2, "leg picker lists the legs");
  t.ok(/2 mi from the road \(about 4 min detour\)/.test(await m.textContent("#alongMilesOut")), "slider label: " + (await m.textContent("#alongMilesOut")));
  await m.evaluate(() => { const l = document.getElementById("alongLeg"); l.selectedIndex = 1; l.dispatchEvent(new Event("input")); });
  // whole-leg search
  await m.click("#alongGo"); await m.waitForSelector(".along-item", { timeout: 10000 });
  const q = bodies[0].body;
  t.ok(/around:3219,/.test(q), "2 miles becomes a 3219 m radius");
  t.ok(/amenity"="pub"/.test(q) && /amenity"="cafe"/.test(q), "query asks for pubs and cafés");
  t.ok(!/fuel/.test(q), "and nothing else");
  const names = await m.locator(".along-item strong").allTextContents();
  t.ok(names.length === 2 && /Early Cafe/.test(names[0]) && /Late Pub/.test(names[1]), "results sorted along the road, far-off pub excluded: " + names.join(" | "));
  t.ok(/mi off the road/.test(await m.textContent(".along-item")), "distance off the road is shown");
  // cache
  const n0 = bodies.length; await m.click("#alongGo"); await m.waitForSelector(".along-item"); await m.waitForTimeout(300);
  t.eq(bodies.length, n0, "identical search is served from the session cache");
  t.ok(/cache/.test(await m.textContent("#alongStatus")), "status says cached");
  // stretch: only the middle part of the leg is searched
  const full = await m.evaluate(() => { const f = stretchFractions(); return { miles: f.g.miles, line: f.g.line }; });
  await m.selectOption("#alongWhere", "stretch");
  t.ok(await m.isVisible("#alongStretch"), "stretch controls appear");
  const half = Math.round(full.miles / 2);
  await m.fill("#alongFrom", String(Math.round(full.miles * 0.4))); await m.fill("#alongTo", String(Math.round(full.miles * 0.6)));
  await m.waitForTimeout(200);
  t.ok(/≈ \d+–\d+ mi/.test(await m.textContent("#alongConv")), "conversion text: " + (await m.textContent("#alongConv")));
  const n1 = bodies.length; await m.click("#alongGo"); await m.waitForTimeout(800);
  const sq = bodies[n1] && bodies[n1].body;
  t.ok(!!sq, "stretch search sent a query");
  const co = sq.match(/around:\d+,([^)]*)\)/)[1].split(",").map(Number); const lats = co.filter((_, i) => i % 2 === 0);
  const L = full.line, la0 = L[0][0], la1 = L[L.length - 1][0], lo = Math.min(la0, la1), hi = Math.max(la0, la1), span = hi - lo;
  t.ok(Math.min(...lats) >= lo + span * 0.3 && Math.max(...lats) <= hi - span * 0.3 || span < 0.05, "stretch query only covers the chosen middle of the leg");
  // minutes unit
  await m.selectOption("#alongUnit", "min"); await m.fill("#alongFrom", "5"); await m.fill("#alongTo", "20"); await m.waitForTimeout(200);
  t.ok(/\d+m/.test(await m.textContent("#alongConv")), "minutes mode converts: " + (await m.textContent("#alongConv")));
  await m.selectOption("#alongWhere", "all");
  // add a stop
  const before = await m.evaluate(() => legSpans().reduce((s, sp) => s + spanGeometry(sp).miles, 0));
  await m.click("#alongGo"); await m.waitForSelector(".along-item");
  await m.locator(".along-item", { hasText: "Early Cafe" }).locator("button:has-text('Add as a stop')").click(); await m.waitForTimeout(500);
  t.ok(/Stop: Early Cafe/.test(await m.textContent("#runSheet")), "stop appears in the run sheet");
  const order = await m.evaluate(() => [...document.querySelectorAll("#runSheet .run-line strong, #runSheet .run-stop span")].map((e) => e.textContent));
  const si = order.findIndex((x) => /Early Cafe/.test(x)); t.ok(si > 0 && si < order.length - 1, "stop sits between two gigs");
  const after = await m.evaluate(() => legSpans().reduce((s, sp) => s + spanGeometry(sp).miles, 0));
  t.ok(after >= before - 0.01, `route not shorter with a stop (${before.toFixed(1)} → ${after.toFixed(1)})`);
  t.ok(await m.evaluate(() => window.__markers.some((x) => /☕/.test(String(x.icon && x.icon.html)))), "stop pin is on the map");
  await m.click("#tabCards"); await m.waitForTimeout(200); await m.click("#tabSheet");
  // save + reload restores
  const saved = await m.evaluate(() => JSON.stringify(MGR.extras));
  t.ok(/Early Cafe/.test(saved), "stop is in the extras that get saved");
  const dl = m.waitForEvent("download"); await m.evaluate(() => saveManagerPlan()); const d = await dl;
  const fp = require("path").join(require("os").tmpdir(), "nt_along_plan.json"); await d.saveAs(fp);
  t.ok(/"extras"/.test(require("fs").readFileSync(fp, "utf8")), "saved plan file carries manager.extras");
  await m.evaluate(() => { MGR.extras = []; renderAll(); });
  t.ok(!/Early Cafe/.test(await m.textContent("#runSheet")), "(stop cleared before reload)");
  await m.setInputFiles("#mgrFile", fp); await m.waitForTimeout(1200);
  t.ok(/Stop: Early Cafe/.test(await m.textContent("#runSheet")), "stop restored when the plan is reloaded");
  // remove
  await m.locator(".run-stop button:has-text('Remove')").click(); await m.waitForTimeout(300);
  t.ok(!/Early Cafe/.test(await m.textContent("#runSheet")), "Remove takes the stop out");
  // fallback and failure (new query so cache is bypassed)
  await m.route("https://overpass-api.de/**", handler("main")); await m.route("https://overpass.kumi.systems/**", handler("alt"));
  await m.check("#alongKinds input[value=fuel]"); fail1 = true;
  const n2 = bodies.length; await m.click("#alongGo"); await m.waitForSelector(".along-item", { timeout: 10000 });
  t.ok(bodies.slice(n2).some((b) => b.name === "alt"), "first server 500 → second server used");
  await m.check("#alongKinds input[value=ev]"); failAll = true; await m.click("#alongGo"); await m.waitForTimeout(1500);
  t.ok(/didn't answer/.test(await m.textContent("#alongStatus")), "both servers down → friendly message");
  t.ok(await m.evaluate(() => !document.getElementById("alongGo").disabled), "button re-enabled");
  t.ok(await m.locator("#runSheet .run-line").count() > 0, "rest of the page still works");
  t.eq(errs.length, 0, "no page errors" + (errs.length ? ": " + errs.join("; ") : ""));
});
