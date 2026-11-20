// The constraint rail: before a build each chip adds one panel; after a build chips jump to panels and show what is set.
const { run } = require("../lib");
run("constraint rail", async (t) => {
  const p = t.page; await t.open("tour_planner.html");
  await p.locator(".mode-card[data-mode=pool]").click(); await p.waitForTimeout(400);
  const chips = await p.locator("#constraintRail .rail-chip:visible").allTextContents();
  t.eq(chips.map((c) => c.split(" ")[0]), ["Area", "Must-visits", "Start", "Filters", "Stages"], "pool mode shows five chips: " + chips.join(" | "));
  t.ok(!(await t.vis("#blkArea")), "nothing extra is showing yet");
  await p.click('.rail-chip[data-rail="blkArea"]'); await p.waitForTimeout(200);
  t.ok(await t.vis("#blkArea"), "Area chip adds the area panel");
  t.ok(!(await t.vis("#blkMust")) && !(await t.vis("#plannerLive")), "and only that panel");
  t.eq(await p.getAttribute('.rail-chip[data-rail="blkArea"]', "aria-pressed"), "true", "chip shows it is on");
  await p.click('.rail-chip[data-rail="blkArea"]'); await p.waitForTimeout(200);
  t.ok(!(await t.vis("#blkArea")), "pressing it again takes the panel away");
  await p.click('.rail-chip[data-rail="plannerLive"]'); await p.waitForTimeout(200);
  t.ok(await t.vis("#plannerLive"), "Filters chip adds the filters");
  await p.click('.rail-chip[data-rail="stageBox"]'); await p.waitForTimeout(200);
  t.ok(await t.vis(".stage-chips"), "Stages chip starts staging");
  await p.click("#stageBox button:has-text('Not in stages after all')"); await p.waitForTimeout(200);
  // after a build everything shows; chips jump and show state
  const id = await p.evaluate(() => [...performerVenueIndex().entries()].sort((a, b) => b[1].size - a[1].size)[0][0]);
  await p.evaluate((id) => { PLANNER.pickPerf.add(id); refreshPool(); }, id); await p.waitForTimeout(500);
  await p.click("#buildTour"); await p.waitForTimeout(2500);
  t.ok(await t.vis("#blkMust") && await t.vis("#blkStart"), "after a build all panels are showing");
  t.ok(await t.vis("#constraintRail"), "the rail stays as a menu after the build");
  t.ok(!(await t.vis("#moreOptions")), "'Show all' is gone once everything shows");
  await p.evaluate(() => { const it = mustItems().find((i) => i.type === "v"); PLANNER.mustRows = [{ ...it, date: "", alt: [], flex: 0, status: "wish", nights: 1 }]; drawMustRows(); }); await p.waitForTimeout(200);
  t.ok(/Must-visits \(1\)/.test(await p.textContent('.rail-chip[data-rail="blkMust"]')), "chip shows the number of must-visits set");
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.click('.rail-chip[data-rail="blkStart"]'); await p.waitForTimeout(800);
  t.ok(await p.evaluate(() => { const r = document.getElementById("blkStart").getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; }), "a chip after the build scrolls its panel into view");
  await p.locator(".mode-card[data-mode=club]").click(); await p.waitForTimeout(400);
  t.ok(!(await p.locator('.rail-chip[data-rail="stageBox"]').isVisible()) && !(await p.locator('.rail-chip[data-rail="blkMust"]').isVisible()), "pool-only chips are hidden in other modes");
});
