// Shared helpers for the new-feature tests. Needs Node + Playwright (npm i -D playwright; npx playwright install chromium).
// Serves the repo root itself, stubs Leaflet (so no internet is needed) and gives each test a small assert API.
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..");
const MIME = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };

function serve(port = 0) {
  const srv = http.createServer((req, res) => {
    const f = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]).replace(/^\/+$/, "/index.html"));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((ok) => srv.listen(port, () => ok({ srv, base: `http://localhost:${srv.address().port}` })));
}

async function run(name, fn) {
  const { srv, base } = await serve();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  const stub = fs.readFileSync(path.join(__dirname, "leaflet-stub.js"), "utf8");
  await ctx.route("**/leaflet.js", (r) => r.fulfill({ contentType: "application/javascript", body: stub }));
  await ctx.route("**/leaflet.css", (r) => r.fulfill({ contentType: "text/css", body: "" }));
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  let pass = 0, fail = 0;
  const t = {
    base, page, errors,
    ok(cond, msg) { cond ? pass++ : fail++; console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`); },
    eq(a, b, msg) { const x = JSON.stringify(a), y = JSON.stringify(b); t.ok(x === y, x === y ? msg : `${msg}  (got ${x}, expected ${y})`); },
    async open(file) { await page.goto(`${base}/${file}`); await page.waitForSelector("#plannerForm", { state: "visible", timeout: 20000 }).catch(() => {}); await page.waitForTimeout(800); },
    vis: (sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!(e && e.offsetParent !== null); }, sel),
  };
  console.log(`\n== ${name}`);
  try { await fn(t); } catch (e) { fail++; console.log("  FAIL  threw: " + e.message); }
  t.ok(errors.length === 0, "no page errors" + (errors.length ? ": " + errors[0] : ""));
  await browser.close(); srv.close();
  console.log(`-- ${name}: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : process.exitCode || 0;
  return { pass, fail };
}
module.exports = { run };
