const { run } = require("../lib");
run("quick start (pool mode)", async (t) => {
  const p = t.page; await t.open("tour_planner.html");
  await p.locator(".mode-card[data-mode=pool]").click(); await p.waitForTimeout(400);
  t.ok(await t.vis("#blkDates"), "dates panel visible before first build");
  for (const s of ["#blkArea", "#blkMust", "#blkStart", "#plannerLive"]) t.ok(!(await t.vis(s)), `${s} hidden before first build`);
  t.ok(await t.vis("#moreOptions"), "'More options' button shown");
  await p.click("#moreOptions"); await p.waitForTimeout(200);
  for (const s of ["#blkArea", "#blkMust", "#blkStart", "#plannerLive"]) t.ok(await t.vis(s), `${s} visible after More options`);
  t.ok(!(await t.vis("#moreOptions")), "button goes away once used");
  // switching mode back and forth must not lose the opened panels
  await p.locator(".mode-card[data-mode=period]").click(); await p.waitForTimeout(300);
  t.ok(await t.vis("#blkStart") && await t.vis("#plannerLive"), "start/end and filters stay open after a mode change");
});
