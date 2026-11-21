// The manager reads the events-data tour format (from the listings, a file, or ?tour=) and writes it back.
const { run } = require("../lib");
const fs = require("fs"), os = require("os"), path = require("path");
run("tours in the events-data format", async (t) => {
  const p = t.page;
  await p.goto(`${t.base}/tour_manager.html`); await p.waitForSelector("#mgrMain:not([hidden])"); await p.waitForTimeout(1000);
  const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  const opts = await p.locator("#mgrTourSel option").count();
  t.ok(opts > 2, `the listings tours are offered in a list (${opts - 1})`);
  t.ok((await p.locator("#mgrTourSel optgroup").count()) >= 1, "grouped into upcoming / past");
  // choose a tour that has at least two dates
  const tid = await p.evaluate(() => Object.entries(MGR.eventsData.tours).find(([id, tr]) => (tr.tour_dates || []).filter((d) => d.venue_id && !d.isCancelled && !d.cancelled && !d.online && MGR.venues[d.venue_id] && llOf(d.venue_id)).length >= 2)[0]);
  await p.selectOption("#mgrTourSel", tid); await p.click("#mgrTourOpen"); await p.waitForTimeout(800);
  t.ok(await p.evaluate(() => !document.getElementById("mgrWork").hidden), "opening a listed tour loads it");
  const n1 = await p.evaluate(() => MGR.groups.reduce((a, g) => a + g.picks.length, 0));
  const expected = await p.evaluate((tid) => { const tr = MGR.eventsData.tours[tid]; return tr.tour_dates.filter((d) => d.venue_id && !d.isCancelled && !d.cancelled && !d.online && MGR.venues[d.venue_id]).reduce((a, d) => a + EventHelpers.eventDates(d, parseDateString).length, 0); }, tid);
  t.eq(n1, expected, `every usable date of the tour is a stop (${n1})`);
  t.ok((await p.inputValue("#tourName")).length > 0, "the tour's own name fills Tour name");
  t.ok(/No start point/.test(await p.textContent("#startNow")), "a listed tour has no start point yet, and says so");
  // set a start (postcode lookup stubbed)
  await p.route("https://api.postcodes.io/**", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { postcode: "BS1 5TR", latitude: 51.4545, longitude: -2.5879 } }) }));
  await p.fill("#startPlace", "BS1 5TR"); await p.click("#startSet"); await p.waitForTimeout(600);
  t.ok(/Starting from/.test(await p.textContent("#startNow")), "the start point can be set in the manager");
  t.ok(/from BS1|from Bristol|from start/i.test(await p.textContent("#runSheet")) || (await p.locator(".run-leg").count()) > 0, "legs now run from the start");
  // export, check the format, and re-import it
  const text = await p.evaluate(async () => { let got = null; const O = Blob; window.Blob = class extends O { constructor(a, o) { super(a, o); got = a; } };
    [...document.querySelectorAll("#runActions button")].find((b) => /events format/.test(b.textContent)).click(); await new Promise((r) => setTimeout(r, 300)); window.Blob = O; return got ? got.join("") : ""; });
  const out = JSON.parse(text), ids = Object.keys(out), tour = out[ids[0]];
  t.eq(ids.length, 1, "one tour is exported");
  t.ok(tour.tour_name && tour.name && "performer_id" in tour && Array.isArray(tour.tour_dates), "it has the fields the schema requires (tour_name, name, performer_id, tour_dates)");
  t.ok(tour.tour_dates.every((d) => /^\d\d\/\d\d\/\d{4}$/.test(d.date) && d.venue_id), "each date is dd/mm/yyyy with a venue_id");
  t.eq(tour.tour_dates.length, n1, "same number of dates out as in");
  t.ok(tour.performer_id === (await p.evaluate((tid) => MGR.eventsData.tours[tid].performer_id, tid)), "the performer id is carried through");
  const f = path.join(os.tmpdir(), "nt_export_tour.json"); fs.writeFileSync(f, text);
  await p.setInputFiles("#mgrFile", f); await p.waitForTimeout(800);
  t.eq(await p.evaluate(() => MGR.groups.reduce((a, g) => a + g.picks.length, 0)), n1, "the exported file opens again with the same stops (round trip)");
  // a bare tour object (not keyed by id) and a file of several tours
  const bare = path.join(os.tmpdir(), "nt_bare_tour.json"); fs.writeFileSync(bare, JSON.stringify(tour));
  await p.setInputFiles("#mgrFile", bare); await p.waitForTimeout(600);
  t.ok(await p.evaluate(() => !document.getElementById("mgrWork").hidden), "a single tour object is accepted too");
  const multi = path.join(os.tmpdir(), "nt_multi_tour.json"); fs.writeFileSync(multi, JSON.stringify({ a: tour, b: { ...tour, tour_name: "Second" } }));
  await p.setInputFiles("#mgrFile", multi); await p.waitForTimeout(600);
  t.ok(/2 tours/.test(await p.textContent("#mgrStatus")), "a file with several tours asks which one");
  t.eq(await p.locator("#mgrTourSel option").count(), 3, "and lists them in the chooser");
  // ?tour= opens a listed tour directly
  await p.goto(`${t.base}/tour_manager.html?tour=${encodeURIComponent(tid)}`); await p.waitForSelector("#mgrMain:not([hidden])"); await p.waitForTimeout(1200);
  t.ok(await p.evaluate(() => !document.getElementById("mgrWork").hidden), "?tour=<id> opens that tour straight from a link");
  t.ok(errs.length === 0, "no page errors" + (errs[0] ? ": " + errs[0] : ""));
});
