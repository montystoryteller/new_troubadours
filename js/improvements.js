// Review fixes: save-plan side effect, phone action bar, handover cleanup, next-day-only overnights,
// mph setting, gig notes, routes refetched around a newly chosen hotel.
const { run } = require("../lib");
run("review improvements", async (t) => {
  const p = t.page;
  // ---- planner: Save plan must not turn the working stage into a saved one; phone action bar
  await p.setViewportSize({ width: 390, height: 800 });
  await t.open("tour_planner.html");
  await p.locator(".mode-card[data-mode=pool]").click();
  const id = await p.evaluate(() => [...performerVenueIndex().entries()].sort((a, b) => b[1].size - a[1].size)[0][0]);
  await p.evaluate((id) => { PLANNER.pickPerf.add(id); refreshPool(); }, id); await p.waitForTimeout(500);
  const barShown = () => p.evaluate(() => getComputedStyle(document.getElementById("actionBar")).display !== "none");
  t.ok(await barShown(), "action bar is showing on a phone-width screen");
  t.eq((await p.textContent("#barBuild")).trim(), "Develop tour", "action bar button says Develop tour");
  await p.click("#barBuild"); await p.waitForTimeout(2500);
  t.ok(await p.evaluate(() => PLANNER.days.length > 0), "the bar's Develop button builds the tour");
  await p.evaluate(() => { const b = [...document.querySelectorAll("#plannerResults button")].find((x) => /shortest route/i.test(x.textContent)); b && b.click(); }); await p.waitForTimeout(400);
  await p.evaluate(() => { PLANNER.stageIdx = PLANNER.stages.length; renderStages(); });
  t.eq((await p.textContent("#barBuild")).trim(), "Develop stage 1", "while staging the bar says Develop stage 1");
  const before = await p.evaluate(() => ({ n: PLANNER.stages.length, idx: PLANNER.stageIdx }));
  const saved = await p.evaluate(async () => { let got = null; const O = Blob; window.Blob = class extends O { constructor(a, o) { super(a, o); got = a; } };
    document.getElementById("barSave").click(); await new Promise((r) => setTimeout(r, 400)); window.Blob = O; return got ? got.join("") : ""; });
  t.eq(await p.evaluate(() => ({ n: PLANNER.stages.length, idx: PLANNER.stageIdx })), before, "Save plan leaves the stages on screen unchanged");
  t.ok(JSON.parse(saved).picks.length > 0, "and the saved file holds the working stage's picks");
  await p.setViewportSize({ width: 1400, height: 900 });
  t.ok(!(await barShown()), "the action bar is hidden on a wide screen");

  // ---- manager
  await p.evaluate(() => { const plan = (function () { const c = gatherPlan(); c.stages = { idx: PLANNER.stages.length, list: [] }; return c; })(); localStorage.setItem("nt_tour_plan", JSON.stringify(plan)); });
  const m = await p.context().newPage(); const errs = []; m.on("pageerror", (e) => errs.push(e.message));
  await m.goto(`${t.base}/tour_manager.html?from=planner`); await m.waitForSelector("#mgrMain:not([hidden])"); await m.waitForTimeout(1200);
  t.ok(await m.evaluate(() => !document.getElementById("mgrWork").hidden), "manager loaded the handed-over plan");
  t.eq(await m.evaluate(() => localStorage.getItem("nt_tour_plan")), null, "the handover copy is removed from browser storage once used");
  t.ok(await m.evaluate(() => /How this works/.test(document.querySelector(".mgr-help summary").textContent)), "the manager has a How this works note");

  // a 3-gig plan: gig 2 is the next day, gig 3 is three days later, both legs are long
  const setup = await m.evaluate(() => {
    const vs = Object.keys(MGR.venues).filter((v) => llOf(v));
    // two venues far apart
    let A = vs[0], B = vs[1], best = 0;
    for (const x of vs.slice(0, 60)) for (const y of vs.slice(0, 60)) { const d = roadMiles(llOf(x), llOf(y)); if (d > best && d < 160) { best = d; A = x; B = y; } }
    const pk = (d, v) => ({ date: d, venue_id: v, name: "Gig " + d });
    loadPlan({ format: "new-troubadours-tour-plan", version: 1, mode: "pool", picks: [pk("2026-12-01", A), pk("2026-12-02", B), pk("2026-12-05", A)], settings: { values: {}, checks: {} } }, "x");
    const a = llOf(A), b = llOf(B), mid = (f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    setHotels([{ b: "PI", n: "Premier Inn Mid", lat: mid(0.4)[0], lon: mid(0.4)[1], t: "Mid" }, { b: "PI", n: "Premier Inn Mid2", lat: mid(0.6)[0], lon: mid(0.6)[1], t: "Mid2" }], "test");
    MGR.trigger = 10; $("triggerMins").value = 10; MGR.after = 240; $("afterMins").value = 240; renderAll();
    return { miles: Math.round(best) };
  });
  t.ok(setup.miles > 20, `test venues ${setup.miles} mi apart`);
  const stays = () => m.locator(".run-stay").count();
  t.eq(await stays(), 1, "by default only the leg to the next-day gig gets an overnight suggestion (the 3-day gap is skipped)");
  await m.check("#anyGap"); await m.waitForTimeout(200);
  t.eq(await stays(), 2, "ticking 'also when the next gig is more than a day away' adds the 3-day leg");
  await m.uncheck("#anyGap");
  // mph setting changes the estimated minutes
  const mins1 = await m.evaluate(() => legText(leg(llOf(MGR.groups[0].picks[0].venue_id), llOf(MGR.groups[0].picks[1].venue_id))));
  await m.fill("#mphIn", "30"); await m.waitForTimeout(200);
  const mins2 = await m.evaluate(() => legText(leg(llOf(MGR.groups[0].picks[0].venue_id), llOf(MGR.groups[0].picks[1].venue_id))));
  t.ok(mins1 !== mins2, `changing mph changes the estimate (${mins1} → ${mins2})`);
  // notes appear in the text export and the saved plan
  await m.locator(".run-note").first().fill("Load-in 5pm, ring Jo 07700 900000");
  t.ok(/Notes: Load-in 5pm/.test(await m.evaluate(() => runText())), "gig notes appear in the run sheet text");
  const saved2 = await m.evaluate(async () => { let got = null; const O = Blob; window.Blob = class extends O { constructor(a, o) { super(a, o); got = a; } };
    [...document.querySelectorAll("#runActions button")].find((b) => /Save plan/.test(b.textContent)).click(); await new Promise((r) => setTimeout(r, 300)); window.Blob = O; return got ? got.join("") : ""; });
  const sp = JSON.parse(saved2);
  t.ok(Object.values(sp.manager.notes).length === 1 && sp.manager.settings.mph === 30, "notes and the mph setting are saved in the plan file");
  t.ok(!/test-key/.test(saved2), "no API key in the saved plan");
  // routes are fetched for new legs when a hotel is chosen after real times were fetched
  let calls = 0;
  await m.route("https://api.openrouteservice.org/**", (r) => { calls++; r.fulfill({ contentType: "application/json", body: JSON.stringify({ routes: [{ summary: { distance: 80467, duration: 3000 } }] }) }); });
  await m.fill("#orsKey", "test-key"); await m.click("#orsGo"); await m.waitForTimeout(2500);
  const afterFirst = calls;
  await m.locator(".run-stay button").first().click(); await m.waitForTimeout(2500);
  t.ok(calls > afterFirst, `choosing a hotel fetches the new legs automatically (${calls - afterFirst} new calls)`);
  t.ok(!/\(routed\)/.test("") && (await m.locator(".run-leg:has-text('routed')").count()) > 0, "legs are still shown as routed");
  t.ok(errs.length === 0, "no page errors in the manager" + (errs[0] ? ": " + errs[0] : ""));
});
