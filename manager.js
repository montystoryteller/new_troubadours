// Tour Manager: loads a planner plan, pickups, legs, hotel suggestions (60 min towards the next gig), routed times, handover.
const { run } = require("../lib");
const fs = require("fs"), os = require("os"), path = require("path");
run("tour manager", async (t) => {
  const p = t.page;
  // 1. make a plan in the planner (pool mode, 2 picks far enough apart for a long leg) and hand it over
  await t.open("tour_planner.html");
  await p.locator(".mode-card[data-mode=pool]").click();
  const id = await p.evaluate(() => [...performerVenueIndex().entries()].sort((a, b) => b[1].size - a[1].size)[0][0]);
  await p.evaluate((id) => { PLANNER.pickPerf.add(id); refreshPool(); }, id); await p.waitForTimeout(500);
  await p.click("#buildTour"); await p.waitForTimeout(2500);
  await p.evaluate(() => { const b = [...document.querySelectorAll("#plannerResults button")].find((x) => /shortest route/i.test(x.textContent)); b && b.click(); }); await p.waitForTimeout(400);
  const picked = await p.evaluate(() => PLANNER.chosen.size);
  t.ok(picked > 1, `planner has ${picked} picks`);
  const [popup] = await Promise.all([p.context().waitForEvent("page"), p.click("#openManager")]);
  await popup.waitForSelector("#mgrMain:not([hidden])", { timeout: 20000 });
  await popup.waitForTimeout(800);
  const errs = []; popup.on("pageerror", (e) => errs.push(e.message));
  t.ok(/tour_manager\.html/.test(popup.url()), "Open in tour manager opens the manager page");
  t.ok(await popup.evaluate(() => !document.getElementById("mgrWork").hidden), "the plan from the planner loaded automatically");
  t.ok(/gigs?/.test(await popup.textContent("#mgrSummary")), "summary line: " + (await popup.textContent("#mgrSummary")));
  const gigCount = await popup.locator(".run-line strong").count();
  t.eq(gigCount, picked, "every picked gig is in the run sheet");
  t.ok(await popup.evaluate(() => /Hotel data isn't installed/.test(document.getElementById("hotelStatus").textContent)), "without data/budget_hotels.json the hotel part says so (no crash)");
  // 2. pickups
  await popup.route("https://api.postcodes.io/**", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { postcode: "LS1 4AP", latitude: 53.7965, longitude: -1.5478 } }) }));
  await popup.fill("#pickupLabel", "Sam"); await popup.fill("#pickupPlace", "LS1 4AP"); await popup.fill("#pickupTime", "08:30");
  await popup.click("#pickupAdd"); await popup.waitForTimeout(600);
  t.eq(await popup.locator("#pickupList li").count(), 1, "pickup added");
  t.ok(/08:30 Pick up Sam/.test(await popup.textContent("#runSheet")), "pickup appears in the run sheet with its time");
  // 3. hotels: load a small fixture, force a long leg with a low trigger, expect suggestions
  const hotels = await popup.evaluate(() => {
    const gigs = []; MGR.groups.forEach((g) => g.picks.forEach((pk) => gigs.push(pk)));
    const a = llOf(gigs[0].venue_id), b = llOf(gigs[1].venue_id);
    const mid = (f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    return [
      { b: "PI", n: "Premier Inn Test Near", lat: mid(0.2)[0], lon: mid(0.2)[1], t: "Nearby" },
      { b: "TL", n: "Travelodge Test Far", lat: mid(0.9)[0], lon: mid(0.9)[1], t: "Farway" },
      { b: "PI", n: "Premier Inn Wrong Way", lat: a[0] - (b[0] - a[0]) * 0.2, lon: a[1] - (b[1] - a[1]) * 0.2, t: "Behind" },
    ];
  });
  const hf = path.join(os.tmpdir(), "nt_hotels_test.json"); fs.writeFileSync(hf, JSON.stringify(hotels));
  await popup.evaluate(() => { document.getElementById("hotelFileWrap").hidden = false; });
  await popup.setInputFiles("#hotelFile", hf); await popup.waitForTimeout(400);
  t.ok(/3 Premier Inn \/ Travelodge/.test(await popup.textContent("#hotelStatus")), "hotel file loaded");
  await popup.fill("#triggerMins", "30"); await popup.fill("#afterMins", "240"); await popup.waitForTimeout(400);
  const sug = await popup.locator(".run-stay button").allTextContents();
  t.ok(sug.length >= 1, `hotel suggestions shown (${sug.length})`);
  t.ok(!sug.some((s) => /Wrong Way/.test(s)), "a hotel behind the gig (wrong direction) is never suggested");
  if (sug.length > 1) t.ok(/Far/.test(sug[0]), "the hotel nearest the next gig (within the drive limit) is listed first");
  await popup.locator(".run-stay button").first().click(); await popup.waitForTimeout(300);
  t.ok(await popup.locator(".run-stay.chosen").count() === 1, "choosing a hotel adds a Sleep line");
  t.ok(/SLEEP: /.test(await popup.evaluate(() => groupText(MGR.groups[0], buildGroup(MGR.groups[0])))), "the sleep stop is in the plain-text run sheet");
  // a tight limit with only far hotels explains why nothing fits
  await popup.locator(".run-stay .mgr-btn.small:has-text('Remove')").click(); await popup.waitForTimeout(200);
  await popup.evaluate(() => { MGR.hotels = MGR.hotels.filter((h) => /Far/.test(h.n)); }); // only a far hotel
  await popup.fill("#afterMins", "15"); await popup.waitForTimeout(300);
  const sheet15 = await popup.textContent("#runSheet");
  t.ok(/No hotel within 15 min towards the next gig; the nearest is/.test(sheet15), "when nothing fits it says which limit ruled everything out: " + (sheet15.match(/No hotel[^.]*\./) || ["(no message: " + sheet15.slice(0, 120) + ")"])[0]);
  // brand switch
  await popup.fill("#afterMins", "240"); await popup.uncheck("#brandPI"); await popup.waitForTimeout(300);
  t.ok(!/Premier Inn/.test((await popup.locator(".run-stay button").allTextContents()).join()), "untick Premier Inn removes them from the suggestions");
  await popup.check("#brandPI");
  // 4. routed times (stub the ORS API)
  await popup.route("https://api.openrouteservice.org/**", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ routes: [{ summary: { distance: 160934, duration: 6000 } }] }) }));
  await popup.fill("#orsKey", "test-key"); await popup.click("#orsGo"); await popup.waitForTimeout(2500);
  t.ok(/routed/.test(await popup.textContent("#runSheet")), "after fetching, legs are marked (routed)");
  t.ok(/100 mi/.test(await popup.textContent("#runSheet")), "routed distance is used (100 mi from the stub)");
  await popup.click("#orsOff"); await popup.waitForTimeout(200);
  t.ok(!/routed\)/.test(await popup.textContent("#runSheet")), "Back to estimates restores the estimates");
  // 5. save with logistics, reload it in a fresh manager
  const text = await popup.evaluate(async () => { let got = null; const O = Blob; window.Blob = class extends O { constructor(a, o) { super(a, o); got = a; } };
    [...document.querySelectorAll("#runActions button")].find((b) => /Save plan/.test(b.textContent)).click(); await new Promise((r) => setTimeout(r, 300)); window.Blob = O; return got ? got.join("") : ""; });
  const saved = JSON.parse(text);
  t.eq(saved.manager.pickups.length, 1, "saved plan carries the pickup");
  t.eq(saved.format, "new-troubadours-tour-plan", "saved plan is still a valid planner plan file");
  const pf = path.join(os.tmpdir(), "nt_mgr_plan.json"); fs.writeFileSync(pf, text);
  await popup.evaluate(() => localStorage.removeItem("nt_tour_plan"));
  await popup.goto(`${t.base}/tour_manager.html`); await popup.waitForSelector("#mgrMain:not([hidden])"); await popup.waitForTimeout(600);
  await popup.setInputFiles("#mgrFile", pf); await popup.waitForTimeout(800);
  t.eq(await popup.locator("#pickupList li").count(), 1, "loading the saved file restores the pickup");
  // 6. a plan file with no gigs and a non-plan file are handled
  const pf2 = path.join(os.tmpdir(), "nt_mgr_notplan.json"); fs.writeFileSync(pf2, JSON.stringify({ hello: 1 }));
  await popup.setInputFiles("#mgrFile", pf2); await popup.waitForTimeout(400);
  t.ok(/doesn't look like/.test(await popup.textContent("#mgrStatus")), "a file that isn't a plan gives a clear message");
  // 7. a staged plan: each stage is its own group, with the start/end legs per stage
  const staged = await popup.evaluate(() => {
    const pk = (d, i) => ({ date: d, id: "x" + i, venue_id: Object.keys(MGR.venues).filter((v) => llOf(v))[i], name: "G" + i });
    const mk = (picks) => ({ format: "new-troubadours-tour-plan", version: 1, mode: "pool", picks, settings: { values: {}, checks: {} } });
    const plan = { ...mk([pk("2026-12-11", 2)]), start: { lat: 52, lon: -1, label: "Home" }, endSame: true,
      stages: { idx: 1, list: [{ plan: mk([pk("2026-12-04", 0), pk("2026-12-05", 1)]), gigs: 2, miles: 0 }, { plan: mk([pk("2026-12-11", 2)]), gigs: 1, miles: 0 }] } };
    loadPlan(plan, "x");
    return { groups: MGR.groups.map((g) => g.name + ":" + g.picks.length), backHome: (document.getElementById("runSheet").textContent.match(/Back at Home/g) || []).length, headings: document.querySelectorAll(".run-group h4").length };
  });
  t.eq(staged.groups, ["Stage 1:2", "Stage 2:1"], "a staged plan becomes one group per stage (the current stage isn't counted twice)");
  t.eq(staged.backHome, 2, "each stage ends back at the start point");
  t.eq(staged.headings, 2, "stage headings shown");
  t.ok(errs.length === 0, "no page errors in the manager" + (errs[0] ? ": " + errs[0] : ""));
});
