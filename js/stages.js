// Tour in stages (pool mode): quiet by default, stage 2 avoids stage 1's venues, overlap is refused, plan file round trip.
const { run } = require("../lib");
const fs = require("fs"), os = require("os"), path = require("path");
run("tour in stages", async (t) => {
  const p = t.page; await t.open("tour_planner.html");
  await p.locator(".mode-card[data-mode=pool]").click(); await p.waitForTimeout(300);
  t.ok(await t.vis("#stageBox"), "stage hint line is in the dates block");
  t.eq(await p.locator("#stageBox button").count(), 1, "before use it is one quiet 'Plan it in stages' link and nothing else");
  t.ok(!(await t.vis(".stage-chips")), "no stage strip yet");
  const id = await p.evaluate(() => [...performerVenueIndex().entries()].sort((a, b) => b[1].size - a[1].size)[0][0]);
  await p.evaluate((id) => { PLANNER.pickPerf.add(id); refreshPool(); }, id); await p.waitForTimeout(500);
  const build = async () => { await p.click("#buildTour"); await p.waitForTimeout(2500); };
  const shortest = async () => { await p.evaluate(() => { const b = [...document.querySelectorAll("#plannerResults button")].find((x) => /shortest route/i.test(x.textContent)); b && b.click(); }); await p.waitForTimeout(400); };
  await build(); await shortest();
  const picks1 = await p.evaluate(() => [...PLANNER.chosen.values()].map((c) => c.venue_id));
  t.ok(picks1.length > 0, `stage 1 has ${picks1.length} picked gigs`);
  await p.click("#stageBox button:has-text('Plan it in stages')"); await p.waitForTimeout(200);
  t.ok(await t.vis(".stage-chips"), "stage strip appears after opting in");
  t.ok(await t.vis("#stageBox .stage-develop"), "a Develop stage button sits in the stage strip");
  await p.click("#stageBox button:has-text('Save stage 1')"); await p.waitForTimeout(800);
  t.eq(await p.evaluate(() => PLANNER.stages.length), 1, "stage 1 saved");
  const d = await p.evaluate(() => ({ s: document.getElementById("periodStart").value, e: document.getElementById("periodEnd").value, chosen: PLANNER.chosen.size, musts: PLANNER.mustRows.length, st: PLANNER.stages[0].plan.settings.values }));
  t.ok(d.s > d.st.periodEnd, `stage 2 starts after stage 1 ends (${d.s} > ${d.st.periodEnd})`);
  t.eq(new Date(d.s + "T00:00:00").getDay(), 5, "stage 2 starts on a Friday");
  t.eq(d.chosen, 0, "stage 2 starts with no picks");
  // overlap refused
  await p.evaluate((v) => { document.getElementById("periodStart").value = v.periodStart; document.getElementById("periodEnd").value = v.periodEnd; }, d.st);
  await p.click("#buildTour"); await p.waitForTimeout(800);
  t.ok(/overlap stage 1/i.test(await p.textContent("#plannerStatus")), "overlapping dates are refused");
  // stage 2 builds without stage 1 venues
  await p.evaluate((v) => { document.getElementById("periodStart").value = v[0]; document.getElementById("periodEnd").value = v[1]; }, [d.s, d.e]);
  await p.click("#stageBox .stage-develop"); await p.waitForTimeout(2500); // no scrolling up to the main Develop tour button
  const offered = await p.evaluate(() => [...new Set([...PLANNER.byDay.values()].flat().map((n) => n.venue_id))]);
  t.ok(offered.length > 0, `stage 2 offers ${offered.length} venues`);
  t.eq(offered.filter((v) => picks1.includes(v)), [], "none of stage 1's venues are offered again");
  t.ok(/already used in other stages/.test(await p.textContent("#stageBox")), "the left-out venues are listed");
  await shortest();
  await p.click("#stageBox button:has-text('Save stage 2')"); await p.waitForTimeout(800);
  t.eq(await p.evaluate(() => PLANNER.stages.length), 2, "stage 2 saved");
  t.ok(/2 stages saved/.test(await p.textContent("#stageBox")), "running totals shown");
  // plan file round trip
  const text = await p.evaluate(async () => { let got = null; const O = Blob; window.Blob = class extends O { constructor(a, o) { super(a, o); got = a; } };
    document.getElementById("planSave").click(); await new Promise((r) => setTimeout(r, 400)); window.Blob = O; return got ? got.join("") : ""; });
  const plan = JSON.parse(text);
  t.eq(plan.stages && plan.stages.list.length, 2, "plan file holds both stages");
  const file = path.join(os.tmpdir(), "nt_stage_plan.json"); fs.writeFileSync(file, text);
  await p.reload(); await t.open("tour_planner.html");
  await p.locator(".mode-card[data-mode=period]").click(); await p.waitForTimeout(300);
  await p.setInputFiles("#planFile", file); await p.waitForTimeout(4000);
  t.eq(await p.evaluate(() => PLANNER.stages.length), 2, "stages restored from file");
  t.ok(await t.vis(".stage-chips"), "stage strip back after loading");
  await p.click("#stageBox .stage-chip:has-text('Stage 1')"); await p.waitForTimeout(3500);
  t.eq(await p.evaluate(() => PLANNER.stageIdx), 0, "can reopen stage 1");
  t.eq(await p.evaluate(() => [...PLANNER.chosen.values()].map((c) => c.venue_id).sort()), [...picks1].sort(), "stage 1 picks restored");
  await p.click("#stageBox button:has-text('Remove this stage')"); await p.waitForTimeout(500);
  t.eq(await p.evaluate(() => PLANNER.stages.length), 1, "stage can be removed");
});
