// EventCollect must return exactly what the gig planner's own collector does.
const { run } = require("../lib");
run("shared collector equals gig planner collector", async (t) => {
  const p = t.page; await p.goto(`${t.base}/gig_planner.html`); await p.waitForTimeout(2500);
  await p.addScriptTag({ url: "/js/event_collect.js" });
  const res = await p.evaluate(() => {
    const today = getTodayMidnight(), out = [];
    for (const [a, b] of [[-30, 30], [0, 120], [0, 500], [200, 400]]) {
      const from = new Date(today), to = new Date(today); from.setDate(from.getDate() + a); to.setDate(to.getDate() + b);
      const sig = (r) => [r.id, r.title, r.venue_id, gKey(r.date), r.time, r.cat, r.kind, (r.performerList || []).join("+")].join("|");
      const g = gCollect(from, to).map(sig), c = EventCollect.collect(GC.data, from, to, { venueOk: gVenueOk }).map(sig);
      out.push({ range: [a, b], n: g.length, same: g.length === c.length && g.every((x, i) => x === c[i]) });
    }
    return out;
  });
  res.forEach((r) => t.ok(r.same, `days ${r.range[0]}..${r.range[1]}: ${r.n} records identical`));
});
