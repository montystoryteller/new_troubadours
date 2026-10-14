// ── gatekeeper ──────────────────────────────────────────────
// Sits on the newtroubadours.org/* route.
// Passes humans straight to GitHub Pages.
// Sends known crawlers (and social-preview bots) to the RENDERER worker
// for a prerendered snapshot, stores it in KV (global, unlike caches.default),
// serves stale snapshots while refreshing in the background, and falls back
// to the normal origin page (never a 503) if rendering fails.
// When Browser Run returns a 429, all rendering pauses: 2 min for the first 429 of
// the day, 20 min for the second, 60 for the third, 4.5 h for the fourth, 8 h for the
// fifth, then until just past UTC midnight; any step that would overshoot midnight is
// capped there (flag in KV under lock:quota, count under lock:strikes). A successful
// render resets the count; "time limit exceeded" (daily cap) goes straight to midnight.
// Also serves /sitemap.xml, generated from the meta:keys index in KV.
//
// Required bindings:
//   RENDERER      service binding -> renderer worker
//   RENDER_CACHE  KV namespace
//   DEBUG_SECRET  secret

// Bot tiers. Browser Run time is scarce (free plan: 10 browser-minutes/day), so
// only bots that benefit get a live render.
//  - RENDER: may trigger a live render on a cache miss. Bing/DuckDuckGo need it
//    most; Apple and the social-preview bots don't run JS at all.
//  - CACHE-ONLY: served an existing snapshot if we have one, but never spend a
//    render on them. Googlebot executes JS itself.
//  - Everyone else (SEO scrapers etc.): straight to the origin page.
const RENDER_BOT_RE =
  /bingbot|duckduckbot|applebot|facebookexternalhit|facebot|twitterbot|linkedinbot|discordbot|slackbot|telegrambot|whatsapp|pinterestbot|redditbot/i;
const CACHE_ONLY_BOT_RE = /googlebot|yandexbot|baiduspider|slurp/i;

const ASSET_EXTENSION_RE =
  /\.(js|mjs|css|png|jpe?g|gif|svg|webp|ico|avif|woff2?|ttf|eot|json|xml|txt|map|mp4|webm|pdf)$/i;

// A snapshot younger than this is served as-is. Older ones are STILL served,
// and a render-tier bot request may trigger one background refresh, but only
// if it wins the global render cooldown (see LOCK_KEY below).
const FRESH_SECONDS = 60 * 60 * 120; // refresh-if-requested after ~5 days
// Keep entries much longer than the freshness window: if a snapshot expired,
// there would be nothing to serve and a scarce live render would be needed.
const KV_TTL_SECONDS = 60 * 60 * 24 * 90; // keep stale copies for 90 days (safety net; the prewarm rotation refreshes every page well within this)
const CLIENT_MAX_AGE_SECONDS = 60 * 60;

const DEBUG_HEADER = "x-force-render";
const PURGE_HEADER = "x-purge-cache";
// Invalidation levels, from gentlest to harshest:
//  - mark-stale (one page): keep the snapshot, set its age to "ancient". It is
//    still served, and refreshed by the next prewarm run or render-tier bot request.
//  - soft purge (all pages): every snapshot older than `soft` counts as stale.
//  - hard purge (one page): delete the snapshot.
//  - hard purge (all pages): every snapshot older than `hard` counts as missing
//    (not served). Nothing is deleted; old entries just expire via their TTL.
const MARK_STALE_HEADER = "x-mark-stale";
const SOFT_PURGE_HEADER = "x-soft-purge";
const HARD_PURGE_ALL_HEADER = "x-hard-purge-all";
const EPOCHS_KEY = "meta:epochs"; // JSON: { soft, hard }
// Prewarm optimisation: with x-only-if-older-than: <seconds>, a forced request
// returns immediately (no browser launch) if the stored snapshot is younger.
const ONLY_IF_OLDER_HEADER = "x-only-if-older-than";
// Sent (value = DEBUG_SECRET) together with x-force-render ONLY by renders that follow a real
// content update (`updatecache --delta`). A successful, healthy render then stamps the page's
// <lastmod> in the sitemap (meta:lastmod). Routine refreshes (prewarm rotation, --refresh-stale,
// --fill-missing, bot-triggered refreshes) never send it, so they never move a lastmod.
const UPDATED_HEADER = "x-content-updated";
// Sent (value = DEBUG_SECRET) together with x-force-render by `updatecache --force`. The forced
// render then ignores a recorded pause (lock:quota) and TRIES the renderer anyway. Use it when
// you suspect the pause is stale (e.g. the quota actually reset, or a short back-off was set by
// a bot burst). If the renderer really is limited it just 429s again, and the existing pause
// stays as it was (a still-active pause is never extended or re-counted by this). A successful
// render clears the pause and the 429 count, like any other success.
const IGNORE_PAUSE_HEADER = "x-ignore-pause";

// Identity params per page: the ones that select a specific record and so
// produce a genuinely different, indexable page. Keyed by path without ".html".
// Everything else is dropped from the cache key and the render URL, notably
// UI-state params (q, types, time, start/end, zoom/lat/lng, open, date, v...),
// which have unlimited combinations and would burn render quota for nothing.
// Pages not listed here never carry params. Filenames were checked against the
// links in the page scripts (e.g. event.html?event=, tour_guide.html?tour=).
const PARAMS_BY_PATH = {
  "/storyclub": ["club"],
  "/performers": ["performer"],
  "/venues": ["venue"],
  "/promoters": ["promoter"],
  "/festival": ["festival"],
  "/event": ["event", "event_id"], // event.html?event=... (one page per event)
  // /event_guide (the calendar listing) takes only UI-state params, so none kept.
  "/tour_guide": ["tour", "performer"],
  "/flyers": ["tour"],
  "/media": ["series"],
  "/books_merch": ["performer", "publisher", "view"],
};
// event.js treats ?event_id= as an alias and rewrites it to ?event=.
const PARAM_ALIASES = { event_id: "event" };
const MAX_PARAM_VALUE_LENGTH = 200;

// Repertoire shows are addressed as tour_guide.html?tour=R-<show>. The old form
// tour=rep:<show> is DEPRECATED: it is folded into the "R-" form here so both
// share ONE snapshot/cache key, one render URL and one known-key check (the
// Cloudflare 301 normally catches it first; this is the belt-and-braces layer).
// Remove LEGACY_REPERTOIRE_TOUR_PREFIX handling once the 301 has been live a while.
const REPERTOIRE_TOUR_PREFIX = "R-";
const LEGACY_REPERTOIRE_TOUR_PREFIX = "rep:";
function canonicalParamValue(pagePath, name, value) {
  if (
    pagePath === "/tour_guide" &&
    name === "tour" &&
    value.startsWith(LEGACY_REPERTOIRE_TOUR_PREFIX)
  ) {
    return (
      REPERTOIRE_TOUR_PREFIX + value.slice(LEGACY_REPERTOIRE_TOUR_PREFIX.length)
    );
  }
  return value;
}

// Global render cooldown for crawler-triggered renders (cache misses AND
// stale-snapshot refreshes). Browser Run's rate limit is account-wide (~1
// render per 10s on the free plan), and bots like Bing fetch many different
// URLs in bursts. Before a bot-triggered render we check for this key; if
// present we skip the render (misses get the origin page, stale hits just keep
// the old snapshot), otherwise we set it (KV's minimum TTL is 60s) and render.
// So at most about one crawler render per minute, leaving the other slots for
// the prewarm.
// KV is eventually consistent, so two simultaneous requests can still both
// pass; this reduces collisions, it does not eliminate them.
const LOCK_KEY = "lock:render";
const LOCK_TTL_SECONDS = 60;

// ── daily quota flag ─────────────────────────────────────────
// When the renderer reports the daily browser-time cap is used up ("time limit
// exceeded"), there is no point trying again until the quota resets at UTC
// midnight. We record that in KV (key expires at the next UTC midnight) so ALL
// render paths stop calling the renderer: crawler misses go to the origin page,
// stale snapshots keep being served unrefreshed, and forced/prewarm requests
// get an immediate 429 + x-quota-exhausted without launching a browser or
// spending a KV write on markStale.
// A short in-memory copy avoids a KV read on every request in the same isolate.
//
// Escalating pause (replaces the old "any 429 = paused until midnight"): a 429 can be
// a short burst clash (the ~1 render per 10s limit) OR the daily cap, and the status
// code alone doesn't say which. So each 429 earns a pause that grows with the number
// of 429s seen today (PAUSE_LADDER_MINUTES); once the ladder runs out, or the body
// says "time limit exceeded" (unambiguously the daily cap), the pause runs to just
// past UTC midnight. Any successful render resets the count and lifts the pause.
//   lock:quota   value = pause-end as epoch ms; key expires when the pause ends
//   lock:strikes value = number of 429s today; key expires at UTC midnight
const QUOTA_KEY = "lock:quota";
const STRIKES_KEY = "lock:strikes";
// 1st..5th 429 today: 2 min, 20 min, 1 h, 4.5 h, 8 h. Each is capped at just past UTC
// midnight (whichever comes first), and the 6th 429 goes straight to midnight.
const PAUSE_LADDER_MINUTES = [2, 20, 60, 270, 480];
const RESUME_PAST_MIDNIGHT_MS = 60 * 1000; // resume a minute after the quota resets
// Short, so a pause set by another isolate is noticed quickly (the shortest pause is 2 min).
const QUOTA_NOT_EXHAUSTED_MEMORY_MS = 20 * 1000;
let quotaMemory = null; // { until: ms, exhausted: bool }

function nextUtcMidnightMs() {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}

// Epoch ms when renders may resume, or 0 if not paused. `fresh` skips the
// in-memory copy (used before counting a new 429, so a burst counts once).
// Fails OPEN (0) if KV can't be read: the per-minute render lock and the
// renderer's own limits still protect the quota in that case.
async function getPauseUntil(env, fresh = false) {
  const now = Date.now();
  if (!fresh && quotaMemory && now < quotaMemory.until)
    return quotaMemory.exhausted ? quotaMemory.until : 0;
  try {
    const v = await env.RENDER_CACHE.get(QUOTA_KEY);
    let until = 0;
    if (v) {
      // Legacy flag value "1" (old code): paused until the next UTC midnight.
      const n = Number(v);
      until = n > 1e12 ? n : nextUtcMidnightMs();
    }
    if (until > now) {
      quotaMemory = { until, exhausted: true };
      return until;
    }
    quotaMemory = { until: now + QUOTA_NOT_EXHAUSTED_MEMORY_MS, exhausted: false };
    return 0;
  } catch (err) {
    console.log("quota flag read failed", String(err));
    return 0;
  }
}

// "Paused" covers both a short back-off and the daily cap (name kept for the call sites).
async function isQuotaExhausted(env) {
  return (await getPauseUntil(env)) > 0;
}

// True when a pause lasts to the quota reset (so callers should stop for the day).
const isDailyPause = (until) => until >= nextUtcMidnightMs();

// Called on every 429 / limit response. Returns the pause-end (epoch ms).
// `definitive` = the body said the DAILY cap is used up: skip the ladder.
async function markRenderLimited(env, definitive = false) {
  const now = Date.now();
  const resumeAt = nextUtcMidnightMs() + RESUME_PAST_MIDNIGHT_MS;
  // Already paused (e.g. several in-flight renders all got 429): this is the
  // same incident, so don't count it again. A definitive daily signal still upgrades it.
  const existing = await getPauseUntil(env, true);
  if (existing && (!definitive || existing >= resumeAt)) return existing;

  let strikes = 0;
  try {
    strikes = Number(await env.RENDER_CACHE.get(STRIKES_KEY)) || 0;
  } catch (err) {
    console.log("strike count read failed", String(err));
  }
  strikes += 1;
  const stepMin = PAUSE_LADDER_MINUTES[strikes - 1];
  const until =
    definitive || stepMin === undefined
      ? resumeAt
      : Math.min(now + stepMin * 60 * 1000, resumeAt);
  quotaMemory = { until, exhausted: true }; // this isolate knows immediately
  try {
    // KV needs an expiration at least 60s in the future.
    await Promise.all([
      env.RENDER_CACHE.put(QUOTA_KEY, String(until), {
        expiration: Math.floor(Math.max(until, now + 61 * 1000) / 1000),
      }),
      env.RENDER_CACHE.put(STRIKES_KEY, String(strikes), {
        expiration: Math.floor(
          Math.max(nextUtcMidnightMs(), now + 61 * 1000) / 1000,
        ),
      }),
    ]);
  } catch (err) {
    console.log("quota flag write failed", String(err));
  }
  console.log({
    message: `render limited (429 #${strikes} today); renders paused until ${new Date(until).toISOString()}`,
    evt: "render-paused",
    strikes,
    definitive,
    daily: isDailyPause(until),
    resumesAt: new Date(until).toISOString(),
  });
  return until;
}

// A render succeeded, so Browser Run is clearly working: reset today's 429 count
// and lift any pause. Reads first so the usual case (nothing set) costs no writes.
async function clearRenderLimits(env) {
  quotaMemory = { until: Date.now() + QUOTA_NOT_EXHAUSTED_MEMORY_MS, exhausted: false };
  try {
    const [strikes, paused] = await Promise.all([
      env.RENDER_CACHE.get(STRIKES_KEY),
      env.RENDER_CACHE.get(QUOTA_KEY),
    ]);
    const ops = [];
    if (strikes !== null) ops.push(env.RENDER_CACHE.delete(STRIKES_KEY));
    if (paused !== null) ops.push(env.RENDER_CACHE.delete(QUOTA_KEY));
    if (ops.length) {
      await Promise.all(ops);
      console.log({ message: "render succeeded; 429 count reset", evt: "render-limits-cleared" });
    }
  } catch (err) {
    console.log("clear render limits failed", String(err));
  }
}

// Response headers for a refused/failed forced render while paused. x-quota-exhausted is
// sent ONLY for a pause that lasts to the daily reset; a short back-off carries
// x-render-paused (seconds) + retry-after so callers can wait and try again.
function pauseHeaders(until) {
  const secs = Math.max(1, Math.ceil((until - Date.now()) / 1000));
  return {
    "retry-after": String(secs),
    "x-render-paused": String(secs),
    ...(isDailyPause(until) ? { "x-quota-exhausted": "true" } : {}),
  };
}

// Try to claim the global crawler-render slot. Returns true if this request
// may render. If KV can't tell us, say no (protect the quota).
async function claimRenderSlot(env) {
  try {
    if (await isQuotaExhausted(env)) return false;
    if (await env.RENDER_CACHE.get(LOCK_KEY)) return false;
    await env.RENDER_CACHE.put(LOCK_KEY, "1", {
      expirationTtl: LOCK_TTL_SECONDS,
    });
    return true;
  } catch (err) {
    console.log("render lock failed", String(err));
    return false;
  }
}

// ── known-page check ─────────────────────────────────────────
// Crawlers (and typos) request pages like storyclub.html?club=nonexistent. Each
// one would burn a scarce render on a page that has no content. Before a
// crawler-triggered render we check the key against a small index stored in
// KV under KEYS_KEY (~20 KB: lists of valid performer/venue/club/... keys),
// built by `./updatecache --sync-keys` from events_normalized.json.
// Cost: only on the crawler render path (never for humans or snapshot hits),
// one KV read per isolate per 5 minutes thanks to the in-memory copy below.
// Fails OPEN: if the index is missing or unreadable, rendering is allowed.
const KEYS_KEY = "meta:keys";
// POST the index JSON with this header (value = DEBUG_SECRET) to replace it.
// Used by the daily prewarm Action and `updatecache --sync-keys`.
const SYNC_KEYS_HEADER = "x-sync-keys";
const KEYS_MEMORY_MS = 5 * 60 * 1000;
// path (no .html) -> { url param -> index list name }
const KEY_CHECKS = {
  "/performers": { performer: "performers" },
  "/venues": { venue: "venues" },
  "/storyclub": { club: "clubs" },
  "/promoters": { promoter: "promoters" },
  "/festival": { festival: "festivals" },
  "/tour_guide": { tour: "tours", performer: "performers" },
};
let keyIndex = null; // { at, sets: { performers: Set, ... } }

async function loadKeyIndex(env) {
  if (keyIndex && Date.now() - keyIndex.at < KEYS_MEMORY_MS) return keyIndex;
  const raw = await env.RENDER_CACHE.get(KEYS_KEY, "json");
  const sets = {};
  for (const [name, list] of Object.entries(raw || {})) {
    if (Array.isArray(list)) sets[name] = new Set(list);
  }
  keyIndex = { at: Date.now(), sets }; // cache "no index" too, so we don't re-read
  return keyIndex;
}

// True if the page is fine to render (or we can't tell); false only when the
// page carries a key that is definitely not in the index.
async function isKnownPage(env, normUrl) {
  const checks = KEY_CHECKS[normUrl.pathname.replace(/\.html$/, "")];
  if (!checks) return true;
  try {
    const { sets } = await loadKeyIndex(env);
    for (const [param, listName] of Object.entries(checks)) {
      const value = normUrl.searchParams.get(param);
      if (value === null) continue;
      if (sets[listName] && !sets[listName].has(value)) return false;
    }
  } catch (err) {
    console.log("key index failed", String(err));
  }
  return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function botTier(request) {
  const ua = request.headers.get("user-agent") || "";
  if (RENDER_BOT_RE.test(ua)) return "render";
  if (CACHE_ONLY_BOT_RE.test(ua)) return "cache";
  return null;
}

function isAuthorized(request, env, headerName) {
  return (
    env.DEBUG_SECRET && request.headers.get(headerName) === env.DEBUG_SECRET
  );
}

function looksLikeHtmlRequest(request, url) {
  if (ASSET_EXTENSION_RE.test(url.pathname)) return false;
  const dest = request.headers.get("sec-fetch-dest");
  if (dest && dest !== "document") return false;
  return true;
}

// Invisible marker recording that this HTML is a prerendered snapshot, and when
// it was made. Visible to scripts (document.documentElement.dataset.prerendered)
// and in saved source / Bing's live-test output, but not to visitors. The page
// JS is deliberately NOT told to skip its own render: a live re-render on top
// of the snapshot is fine.
function markPrerendered(html) {
  if (html.includes("data-prerendered=")) return html; // idempotent
  const stamp = new Date().toISOString();
  let out = html.replace(
    /<html(\s[^>]*)?>/i,
    (m, attrs = "") => `<html${attrs} data-prerendered="${stamp}">`,
  );
  if (/<\/head>/i.test(out)) {
    out = out.replace(
      /<\/head>/i,
      `<meta name="prerendered" content="cloudflare ${stamp}"></head>`,
    );
  }
  return out;
}

// Snapshots stored before this change carry the old visible badge. Strip it at
// serve time (no render quota needed). Safe to delete once every snapshot has
// been refreshed or has expired (KV_TTL_SECONDS, 90 days).
function stripLegacyBadge(html) {
  if (!html.includes("cf-prerender-badge")) return html;
  return html.replace(/\s*<div id="cf-prerender-badge"[\s\S]*?<\/div>/, "");
}

// Canonical form of the URL: path plus the identity params for that page,
// sorted, so ?club=x&utm=y and ?utm=z&club=x share one snapshot but
// ?club=a and ?club=b do not.
function normalisedUrl(url) {
  const out = new URL(url.origin + url.pathname);
  const pagePath = url.pathname.replace(/\.html$/, "");
  const allowed = new Set(PARAMS_BY_PATH[pagePath] || []);
  const pairs = [...url.searchParams]
    .filter(([k, v]) => allowed.has(k) && v.length <= MAX_PARAM_VALUE_LENGTH)
    .map(([k, v]) => [
      PARAM_ALIASES[k] || k,
      canonicalParamValue(pagePath, k, v),
    ])
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  for (const [k, v] of pairs) out.searchParams.append(k, v);
  return out;
}

// One structured log line per bot request saying what the bot actually got.
// Pair it with "render failed <why> ..." lines (same rayId) to see the full story.
//   hit-fresh | hit-stale-refreshing | hit-stale
//   (hit-stale = served stale without refreshing: cache-only bot, or the
//   render cooldown was busy)
//   miss-rendered | miss-origin-render-failed | miss-origin-no-render
//   miss-origin-render-busy  (global render cooldown active; served the origin page)
//   miss-origin-quota-exhausted  (daily browser quota used up; served the origin page)
//   hit-stale-quota-exhausted  (stale snapshot served; refresh skipped because the daily quota is used up)
//   forced-skipped-quota  (forced/prewarm request refused with 429, no render attempted)
//   miss-origin-unknown-key  (page key not in the meta:keys index; no render spent)
//   (no-render = a cache-only-tier bot such as Googlebot: never spends a render)
//   miss-origin-kv-error  (KV read threw; served the origin page, no render attempted)
//   forced-rendered | forced-failed  (tier "forced": updatecache / prewarm / debug ping)
function botName(request) {
  const ua = request.headers.get("user-agent") || "";
  const m = ua.match(RENDER_BOT_RE) || ua.match(CACHE_ONLY_BOT_RE);
  return m ? m[0].toLowerCase() : "";
}

function logGate(request, tier, normUrl, outcome, extra = {}) {
  const page = normUrl.pathname + normUrl.search;
  const rawUrl = new URL(request.url);
  const raw = rawUrl.pathname + rawUrl.search;
  const bot = botName(request);
  console.log({
    // "message" is what the Workers Logs list row displays.
    message: `gate ${outcome} [${bot || tier}] ${page}`,
    evt: "gate",
    outcome,
    tier,
    bot,
    page,
    // Original path+query as requested, only when normalisation changed it.
    // If a page you care about shows up here with its params stripped, add the
    // param to PARAMS_BY_PATH.
    ...(raw !== page ? { raw } : {}),
    ...extra,
    ua: (request.headers.get("user-agent") || "").slice(0, 200),
  });
}

const cacheKeyFor = (normUrl) => "render:" + normUrl.toString();

// Invalidation timestamps (see above). One KV read.
async function getEpochs(env) {
  try {
    const e = await env.RENDER_CACHE.get(EPOCHS_KEY, "json");
    return { soft: Number(e?.soft) || 0, hard: Number(e?.hard) || 0 };
  } catch {
    return { soft: 0, hard: 0 };
  }
}

// ── page health (LOG-ONLY for now) ───────────────────────────
// Pages that carry the PageHealth LED (shared_utils.js) set
// <html data-page-health="loading|ok|warn|error"> and put any JS errors / failed
// render checks in a hidden .page-health-message span. A prerendered snapshot
// contains both, so we can tell from the HTML alone whether the page really
// rendered. Nothing here changes what is stored or served: it only
//   - logs one "render-health" line per render (Workers Logs), and
//   - writes a small `health:<day>:<page>` KV key (metadata only needs a key
//     listing) for each page whose render was NOT ok, once per page per day,
//   - records the status on stored snapshots (entry.health + KV metadata.health)
//     and on x-page-health response headers.
// Pages without PageHealth (index, stats, the tool pages) report "n/a".
// "404" = the site's 404.html was rendered (a bot asked for a path that doesn't exist).
// KV keys here start with "health:" on purpose: updatecache only ever lists the
// "render:" prefix, and the other bookkeeping keys are meta:* and lock:*.
const HEALTH_PAGES = new Set([
  "/event_guide",
  "/event",
  "/storyclub",
  "/performers",
  "/venues",
  "/promoters",
  "/festival",
  "/tour_guide",
  "/flyers",
  "/media",
  "/books_merch",
]);
const HEALTH_KEY_PREFIX = "health:";
const HEALTH_TTL_SECONDS = 60 * 60 * 24 * 7; // keep the problem log for a week

const decodeEntities = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&amp;/g, "&");

// -> { status, reason, record } ; never throws.
//   status: ok | warn | error | loading | missing | 404 | n/a
//   record: true when the render is worth writing to the KV problem log
function analyseHealth(html, pathname) {
  try {
    const path = String(pathname || "").replace(/\.html$/, "");
    const m = html.match(/<html\b[^>]*?\sdata-page-health="([a-z-]+)"/i);
    let status;
    if (m) status = m[1].toLowerCase();
    else if (HEALTH_PAGES.has(path))
      status = "missing"; // PageHealth never ran
    else if (/<title>\s*Page not found/i.test(html)) status = "404";
    else status = "n/a";

    let reason = "";
    if (status !== "ok" && status !== "n/a") {
      const r = html.match(
        /class="page-health-message"[^>]*>([\s\S]*?)<\/span>/i,
      );
      if (r) reason = decodeEntities(r[1]).trim();
      if (!reason && status === "missing")
        reason =
          "no data-page-health attribute (shared_utils.js / PageHealth did not run)";
    }
    reason = reason.replace(/\s*\n\s*/g, " | ").slice(0, 300);
    return { status, reason, record: status !== "ok" && status !== "n/a" };
  } catch (err) {
    return { status: "n/a", reason: "", record: false };
  }
}

// Header-safe (printable ASCII only).
const headerSafe = (s) =>
  String(s || "")
    .replace(/[^\x20-\x7e]/g, "?")
    .slice(0, 200);

function logRenderHealth(why, targetUrl, health) {
  try {
    const u = new URL(targetUrl);
    const page = u.pathname + u.search;
    console.log({
      message: `render-health ${health.status} [${why}] ${page}`,
      evt: "render-health",
      status: health.status,
      why,
      page,
      ...(health.reason ? { reason: health.reason } : {}),
    });
  } catch {
    /* logging only */
  }
}

// One KV key per page per day (deduped with a read, so a page that fails on
// every render costs one write a day, not one per render). The details live in
// the key's METADATA, so `wrangler kv key list --prefix health:` shows them with
// no per-key reads. Errors are swallowed: this must never affect a render.
async function recordHealth(env, targetUrl, health, why) {
  try {
    const u = new URL(targetUrl);
    const page = u.pathname + u.search;
    const day = new Date().toISOString().slice(0, 10);
    const key = (
      HEALTH_KEY_PREFIX +
      day +
      ":" +
      encodeURIComponent(page)
    ).slice(0, 450);
    const existing = await env.RENDER_CACHE.get(key, "json");
    if (existing && existing.status === health.status) return;
    const record = {
      at: new Date().toISOString(),
      status: health.status,
      why,
      page: page.slice(0, 300),
      reason: health.reason,
    };
    await env.RENDER_CACHE.put(key, JSON.stringify(record), {
      expirationTtl: HEALTH_TTL_SECONDS,
      metadata: record, // well under KV's 1 KB metadata limit
    });
  } catch (err) {
    console.log("health log failed", String(err));
  }
}

// Browser Run (free plan) allows roughly one Quick Action request per 10s and
// 10 browser-minutes per day, account-wide. So retries must wait >10s, and
// crawler-triggered renders should NOT retry at all: retries from crawlers
// would steal the few slots the scheduled prewarm needs.
const RETRY_BASE_MS = 12000;

async function renderOnce(env, targetUrl, why = "?") {
  const renderUrl = new URL("https://renderer/");
  renderUrl.searchParams.set("url", targetUrl);
  try {
    const res = await env.RENDERER.fetch(renderUrl);
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      console.log("render failed", why, res.status, body, targetUrl);

      // "time limit exceeded" is the daily browser-time cap: pause to midnight at once.
      // Any other 429 / rate-limit body may just be a burst clash, so it climbs the ladder.
      const dailyCap = /time limit exceeded/i.test(body);
      const limited =
        dailyCap ||
        res.status === 429 ||
        /rate limit exceeded|code["']?\s*:\s*2001|browser run failed with 429/i.test(
          body,
        );

      // quotaExhausted now means "limited, renders paused"; pausedUntil says for how long.
      const pausedUntil = limited ? await markRenderLimited(env, dailyCap) : 0;
      return {
        html: null,
        status: res.status,
        quotaExhausted: limited,
        pausedUntil,
        health: null,
      };
    }
    await clearRenderLimits(env);
    const html = markPrerendered(await res.text());
    let health = { status: "n/a", reason: "", record: false };
    try {
      health = analyseHealth(html, new URL(targetUrl).pathname);
      logRenderHealth(why, targetUrl, health);
      if (health.record) await recordHealth(env, targetUrl, health, why);
    } catch {
      /* health reporting must never affect the render result */
    }
    return { html, status: 200, quotaExhausted: false, pausedUntil: 0, health };
  } catch (err) {
    console.log("render threw", why, String(err), targetUrl);
    return { html: null, status: 0, quotaExhausted: false, pausedUntil: 0, health: null };
  }
}

async function renderWithRetry(env, targetUrl, attempts = 1, why = "?") {
  let result = { html: null, status: 0, quotaExhausted: false, pausedUntil: 0, health: null };
  for (let i = 0; i < attempts; i++) {
    result = await renderOnce(env, targetUrl, why);
    if (result.html || result.quotaExhausted) return result;
    if (i < attempts - 1) {
      await sleep(RETRY_BASE_MS * (i + 1) + Math.random() * 2000);
    }
  }
  return result;
}

// Write a snapshot. ts and size are ALSO stored as KV metadata, so listing the
// namespace (wrangler kv key list / REST list) returns every page's age and
// size with no per-key reads, which is what makes it queryable in DuckDB.
async function putEntry(env, key, entry) {
  await env.RENDER_CACHE.put(key, JSON.stringify(entry), {
    expirationTtl: KV_TTL_SECONDS,
    metadata: {
      ts: entry.ts,
      bytes: entry.html.length,
      ...(entry.health ? { health: entry.health } : {}),
    },
  });
}

// What to do when a render comes back as the 404 page and a snapshot already exists for the key.
const DELETE_EXISTING_ON_404 = true;

async function storeSnapshot(env, key, html) {
  // Never let a KV failure (e.g. the free plan's 1,000 writes/day limit) break
  // the response: the freshly rendered HTML is still served, just not stored.
  try {
    let health;
    try {
      health = analyseHealth(
        html,
        new URL(key.slice("render:".length)).pathname,
      ).status;
    } catch {
      health = undefined;
    }
    // A "Page not found" render (the site's 404.html) is never worth caching: it would create a
    // junk entry for a path that doesn't exist (e.g. a forced render of a made-up URL), which
    // then shows up in the staleness / health reports forever. Skip the write. If a snapshot
    // already exists for this key the page has gone away, so drop it too (set
    // DELETE_EXISTING_ON_404 = false to leave the old snapshot alone instead).
    if (health === "404") {
      if (DELETE_EXISTING_ON_404) await env.RENDER_CACHE.delete(key);
      console.log("snapshot not stored: 404 page", key);
      return;
    }
    await putEntry(env, key, {
      html,
      ts: Date.now(),
      ...(health ? { health } : {}),
    });
  } catch (err) {
    console.log("KV put failed", String(err), key);
  }
}

// After a failed forced render, flag any existing snapshot as stale so the next
// prewarm run or render-tier bot request retries it. Without this, a snapshot
// that was still "fresh" would just sit there and never be retried.
// Returns true if a snapshot exists (now marked stale).
async function markStale(env, key) {
  try {
    const existing = await env.RENDER_CACHE.get(key, "json");
    if (!existing?.html) return false;
    if (existing.ts !== 0) {
      await putEntry(env, key, { ...existing, ts: 0 });
    }
    return true;
  } catch (err) {
    console.log("markStale failed", String(err), key);
    return false;
  }
}

async function refresh(env, key, targetUrl, attempts = 1, why = "?") {
  const result = await renderWithRetry(env, targetUrl, attempts, why);
  if (result.html) await storeSnapshot(env, key, result.html);
  return result;
}

const htmlResponse = (html, extra = {}) =>
  new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-prerendered": "true",
      ...extra,
    },
  });

// ── sitemap ──────────────────────────────────────────────────
// GET /sitemap.xml is generated from the meta:keys index (the same lists that
// gate renders), so it always matches the set of valid pages and needs no build
// step. URLs use the same form the site links to and canonicalises on:
// <page>.html?<param>=<key>. <lastmod> is emitted ONLY for pages that have a stamp in
// meta:lastmod (see stampLastmod): a wrong one is worse than none. Event pages (index list "events": last 30 days onward, built by updatecache/the prewarm Action) are listed too.
// NOTE: this route overrides any static sitemap.xml in the repo.
const SITE_ORIGIN = "https://newtroubadours.org";
const SITEMAP_ENTRIES = [
  // [index list name, page path, url param]
  ["performers", "/performers.html", "performer"],
  ["venues", "/venues.html", "venue"],
  ["clubs", "/storyclub.html", "club"],
  ["promoters", "/promoters.html", "promoter"],
  ["festivals", "/festival.html", "festival"],
  ["tours", "/tour_guide.html", "tour"],
  // Event ids (event.html?event=...), already limited to the last 30 days onward by the index builder. Sitemap only: NOT in KEY_CHECKS,
  // so every other event page still renders for crawlers exactly as before.
  ["events", "/event.html", "event"],
];
const SITEMAP_MAX_URLS = 50000; // protocol limit per file
const SITEMAP_CACHE_SECONDS = 60 * 60 * 6;

// ── lastmod ──────────────────────────────────────────────────
// meta:lastmod = JSON { "<path>?<param>=<key>": "YYYY-MM-DD" }, e.g.
//   "/performers.html?performer=ailsa-dixon": "2026-10-13"
// Written only when a render that followed a content update succeeded (UPDATED_HEADER), so the
// date means "the snapshot crawlers get now contains the update". A render that failed, hit the
// Browser Run quota (429 / x-quota-exhausted) or came back unhealthy stamps nothing; the page
// then stays pending in updatecache and keeps its previous lastmod until a render succeeds.
// One KV read + at most one write per stamped page; renders are quota-limited to a few dozen a
// day, so this is far below KV's write limit. Concurrent stamps could lose an entry
// (last write wins), but updatecache renders serially and a lost stamp only means no <lastmod>.
const LASTMOD_KEY = "meta:lastmod";
const LASTMOD_MAX_ENTRIES = 20000; // safety cap; the oldest stamps are dropped first
const LASTMOD_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Map-key for a normalised page URL, or null if the page isn't one the sitemap lists
// (or carries more than its one identity param).
function lastmodKeyFor(normUrl) {
  for (const [, path, param] of SITEMAP_ENTRIES) {
    if (normUrl.pathname !== path) continue;
    const params = [...normUrl.searchParams];
    if (params.length !== 1 || params[0][0] !== param || !params[0][1])
      return null;
    return `${path}?${param}=${params[0][1]}`;
  }
  return null;
}

// Same rule updatecache uses before it treats a render as done: a page that rendered its
// error / loading / "not found" state didn't really update, so it must not claim a lastmod.
function healthAllowsLastmod(health) {
  if (!health) return true; // not checked
  if (["error", "loading", "missing", "stalled", "404", "notfound"].includes(health.status))
    return false;
  if (health.status === "warn" && /not found/i.test(health.reason || ""))
    return false;
  return true;
}

// Returns the stamped date, or null if nothing was written. Never throws.
async function stampLastmod(env, normUrl, health) {
  try {
    const mapKey = lastmodKeyFor(normUrl);
    if (!mapKey || !healthAllowsLastmod(health)) return null;
    const today = new Date().toISOString().slice(0, 10);
    const map = (await env.RENDER_CACHE.get(LASTMOD_KEY, "json")) || {};
    if (map[mapKey] === today) return today; // already stamped today: no write
    map[mapKey] = today;
    const keys = Object.keys(map);
    if (keys.length > LASTMOD_MAX_ENTRIES) {
      keys
        .sort((a, b) => String(map[a]).localeCompare(String(map[b])))
        .slice(0, keys.length - LASTMOD_MAX_ENTRIES)
        .forEach((k) => delete map[k]);
    }
    await env.RENDER_CACHE.put(LASTMOD_KEY, JSON.stringify(map));
    return today;
  } catch (err) {
    console.log("lastmod stamp failed", String(err), normUrl.toString());
    return null;
  }
}

const xmlEscape = (str) =>
  str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

async function sitemapResponse(request, env) {
  let idx;
  try {
    idx = await env.RENDER_CACHE.get(KEYS_KEY, "json");
  } catch (err) {
    console.log("sitemap: key index read failed", String(err));
  }
  if (!idx) {
    return new Response("sitemap unavailable", {
      status: 503,
      headers: { "retry-after": "300", "cache-control": "no-store" },
    });
  }
  // A missing or unreadable lastmod map just means no <lastmod> tags; it never breaks the sitemap.
  let lastmods = {};
  try {
    lastmods = (await env.RENDER_CACHE.get(LASTMOD_KEY, "json")) || {};
  } catch (err) {
    console.log("sitemap: lastmod read failed", String(err));
  }
  const urls = [{ loc: `${SITE_ORIGIN}/` }];
  for (const [name, path, param] of SITEMAP_ENTRIES) {
    const list = Array.isArray(idx[name]) ? [...idx[name]].sort() : [];
    for (const key of list) {
      // The index still carries the DEPRECATED tour=rep:<show> keys alongside
      // R-<show> (so legacy requests aren't "unknown"); they are not canonical,
      // so keep them out of the sitemap. Remove with the rep: handling above.
      if (name === "tours" && key.startsWith(LEGACY_REPERTOIRE_TOUR_PREFIX))
        continue;
      const lm = lastmods[`${path}?${param}=${key}`];
      urls.push({
        loc: `${SITE_ORIGIN}${path}?${param}=${encodeURIComponent(key)}`,
        ...(typeof lm === "string" && LASTMOD_DATE_RE.test(lm)
          ? { lastmod: lm }
          : {}),
      });
    }
  }
  if (urls.length > SITEMAP_MAX_URLS) {
    console.log("sitemap truncated", urls.length);
    urls.length = SITEMAP_MAX_URLS;
  }
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls
      .map(
        (u) =>
          `  <url><loc>${xmlEscape(u.loc)}</loc>` +
          (u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : "") +
          "</url>",
      )
      .join("\n") +
    "\n</urlset>\n";
  return new Response(request.method === "HEAD" ? null : body, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": `public, max-age=${SITEMAP_CACHE_SECONDS}`,
      "x-sitemap-urls": String(urls.length),
      "x-sitemap-lastmods": String(urls.filter((u) => u.lastmod).length),
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (
      url.pathname === "/sitemap.xml" &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      return sitemapResponse(request, env);
    }

    const normUrl = normalisedUrl(url);
    const key = cacheKeyFor(normUrl);

    // Replace the valid-key index. Body: {"performers":[...],"venues":[...],...}
    // Every list must be a non-empty array of strings (an empty list would make
    // every page of that type look unknown).
    if (isAuthorized(request, env, SYNC_KEYS_HEADER)) {
      try {
        const idx = await request.json();
        const clean = {};
        for (const [name, list] of Object.entries(idx || {})) {
          if (
            !Array.isArray(list) ||
            list.length === 0 ||
            !list.every((x) => typeof x === "string")
          ) {
            throw new Error(`"${name}" must be a non-empty array of strings`);
          }
          clean[name] = list;
        }
        if (Object.keys(clean).length === 0) throw new Error("no lists given");
        await env.RENDER_CACHE.put(KEYS_KEY, JSON.stringify(clean));
        keyIndex = null; // this isolate re-reads on next use
        const counts = Object.entries(clean)
          .map(([k, v]) => `${k}: ${v.length}`)
          .join(", ");
        return new Response(`Key index updated (${counts})`, { status: 200 });
      } catch (err) {
        return new Response(`Bad key index: ${err.message}`, { status: 400 });
      }
    }

    // Soft purge everything: mark all snapshots stale, delete nothing.
    if (isAuthorized(request, env, SOFT_PURGE_HEADER)) {
      const e = await getEpochs(env);
      await env.RENDER_CACHE.put(
        EPOCHS_KEY,
        JSON.stringify({ soft: Date.now(), hard: e.hard }),
      );
      return new Response(
        "All snapshots marked stale (still served, refreshed gradually)",
        { status: 200 },
      );
    }

    // Hard purge everything: every existing snapshot counts as missing.
    if (isAuthorized(request, env, HARD_PURGE_ALL_HEADER)) {
      const e = await getEpochs(env);
      await env.RENDER_CACHE.put(
        EPOCHS_KEY,
        JSON.stringify({ soft: e.soft, hard: Date.now() }),
      );
      return new Response("All snapshots invalidated (treated as missing)", {
        status: 200,
      });
    }

    // Mark ONE page stale without removing it or using any browser time.
    if (isAuthorized(request, env, MARK_STALE_HEADER)) {
      const existing = await env.RENDER_CACHE.get(key, "json");
      if (!existing?.html) {
        return new Response(`No snapshot to mark stale for ${normUrl}`, {
          status: 200,
        });
      }
      await putEntry(env, key, { ...existing, ts: 0 });
      return new Response(`Marked stale: ${normUrl}`, { status: 200 });
    }

    // Manual purge: clear this URL's stored render, do nothing else.
    if (isAuthorized(request, env, PURGE_HEADER)) {
      await env.RENDER_CACHE.delete(key);
      return new Response(`Purged cache for ${normUrl.toString()}`, {
        status: 200,
      });
    }

    const forced = isAuthorized(request, env, DEBUG_HEADER);
    const tier = botTier(request);

    // Not a crawler, not asking for a page, and not a manual debug ping — pass straight through.
    if (!forced && (!tier || !looksLikeHtmlRequest(request, url))) {
      return fetch(request);
    }

    // Forced render (used by the prewarm workflow): always render live and
    // overwrite the stored snapshot.
    if (forced) {
      // A render that follows a content update must really happen, so the freshness skip is ignored.
      const updated = isAuthorized(request, env, UPDATED_HEADER);
      const olderThan = Number(request.headers.get(ONLY_IF_OLDER_HEADER));
      if (olderThan > 0 && !updated) {
        const existing = await env.RENDER_CACHE.get(key, "json");
        const { soft, hard } = await getEpochs(env);
        if (
          existing?.html &&
          existing.ts >= Math.max(soft, hard) &&
          Date.now() - existing.ts < olderThan * 1000
        ) {
          return new Response("fresh, skipped", {
            status: 200,
            headers: {
              "x-prerendered": "true",
              "x-prerender-skipped": "true",
              "cache-control": "no-store",
            },
          });
        }
      }
      // Quota already known to be used up: fail fast, no browser launch and no
      // markStale write. The caller should stop until the next UTC day.
      // x-ignore-pause skips this check so the render is attempted regardless.
      const ignorePause = isAuthorized(request, env, IGNORE_PAUSE_HEADER);
      const pausedUntil = ignorePause ? 0 : await getPauseUntil(env);
      if (ignorePause && (await getPauseUntil(env))) {
        logGate(request, "forced", normUrl, "forced-ignoring-pause");
      }
      if (pausedUntil) {
        logGate(request, "forced", normUrl, "forced-skipped-quota", {
          resumesAt: new Date(pausedUntil).toISOString(),
        });
        return new Response(
          isDailyPause(pausedUntil)
            ? "render quota exhausted until UTC midnight"
            : "renders paused briefly after a 429; retry after the pause",
          {
            status: 429,
            headers: { "cache-control": "no-store", ...pauseHeaders(pausedUntil) },
          },
        );
      }
      // The prewarm is the one caller that may retry (spaced past the 10s limit).
      const result = await refresh(env, key, normUrl.toString(), 3, "forced");
      if (result.html) {
        // Stamp only after a successful render (never on 429 / quota / failure, which return below).
        const lastmod = updated
          ? await stampLastmod(env, normUrl, result.health)
          : null;
        logGate(request, "forced", normUrl, "forced-rendered", {
          health: result.health?.status,
          ...(updated ? { lastmod: lastmod || "not-stamped" } : {}),
        });
        return htmlResponse(result.html, {
          "cache-control": "no-store",
          ...(lastmod ? { "x-lastmod": lastmod } : {}),
          ...(result.health
            ? {
                "x-page-health": result.health.status,
                ...(result.health.reason
                  ? { "x-page-health-reason": headerSafe(result.health.reason) }
                  : {}),
              }
            : {}),
        });
      }
      // Skip the markStale write only when the pause lasts to the daily reset: it can't be
      // retried today anyway, and the snapshot's real age already decides tomorrow's refresh.
      // After a short back-off the page is worth marking so a later run retries it.
      const dailyPause = result.pausedUntil && isDailyPause(result.pausedUntil);
      const markedStale = dailyPause ? false : await markStale(env, key);
      logGate(request, "forced", normUrl, "forced-failed", {
        status: result.status,
        quotaExhausted: result.quotaExhausted,
        ...(result.pausedUntil
          ? { resumesAt: new Date(result.pausedUntil).toISOString() }
          : {}),
        markedStale,
      });
      return new Response("render failed", {
        status: result.quotaExhausted || result.status === 429 ? 429 : 502,
        headers: {
          "cache-control": "no-store",
          ...(markedStale ? { "x-marked-stale": "true" } : {}),
          ...(result.pausedUntil ? pauseHeaders(result.pausedUntil) : {}),
        },
      });
    }

    // Serve from KV when we can. If the snapshot is stale, serve it anyway
    // and refresh in the background (render-tier bots only, and only if they
    // win the global render cooldown).
    // A KV failure must never break the page: fall back to the origin and
    // don't spend a scarce render while KV is misbehaving.
    let raw, soft, hard;
    try {
      [raw, { soft, hard }] = await Promise.all([
        env.RENDER_CACHE.get(key, "json"),
        getEpochs(env),
      ]);
    } catch (err) {
      console.log("KV read failed", String(err), key);
      logGate(request, tier, normUrl, "miss-origin-kv-error");
      return fetch(request);
    }
    const entry = raw?.html && raw.ts >= hard ? raw : null;
    if (entry) {
      const stale =
        entry.ts < soft || Date.now() - entry.ts > FRESH_SECONDS * 1000;
      let outcome = stale ? "hit-stale" : "hit-fresh";
      if (stale && tier === "render" && (await isKnownPage(env, normUrl))) {
        if (await isQuotaExhausted(env)) {
          // Daily quota used up: serve the stale snapshot, don't try to refresh.
          outcome = "hit-stale-quota-exhausted";
        } else if (await claimRenderSlot(env)) {
          outcome = "hit-stale-refreshing";
          ctx.waitUntil(refresh(env, key, normUrl.toString(), 1, "bg-refresh"));
        }
      }
      logGate(request, tier, normUrl, outcome);
      return htmlResponse(stripLegacyBadge(entry.html), {
        "cache-control": `public, max-age=${CLIENT_MAX_AGE_SECONDS}`,
        "x-prerender-stale": stale ? "true" : "false",
        "x-prerender-ts": String(entry.ts),
        ...(entry.health ? { "x-page-health": entry.health } : {}),
      });
    }

    // True cache miss: a single attempt, no waiting. If Browser Run is
    // rate limited we fall straight through to the origin page below; the
    // scheduled prewarm fills the cache later.
    // Cache-only bots (e.g. Googlebot) never trigger a render.
    if (tier !== "render") {
      logGate(request, tier, normUrl, "miss-origin-no-render");
      return fetch(request);
    }

    // Don't spend a render on a page whose key doesn't exist.
    if (!(await isKnownPage(env, normUrl))) {
      logGate(request, tier, normUrl, "miss-origin-unknown-key");
      return fetch(request);
    }

    // Daily quota used up: serve the origin page, don't try to render.
    if (await isQuotaExhausted(env)) {
      logGate(request, tier, normUrl, "miss-origin-quota-exhausted");
      return fetch(request);
    }

    // Global cooldown: skip the render if another crawler render started
    // within the last minute.
    if (!(await claimRenderSlot(env))) {
      logGate(request, tier, normUrl, "miss-origin-render-busy");
      return fetch(request);
    }

    const { html, health } = await renderWithRetry(
      env,
      normUrl.toString(),
      1,
      "miss",
    );
    if (html) {
      logGate(request, tier, normUrl, "miss-rendered", {
        health: health?.status,
      });
      ctx.waitUntil(storeSnapshot(env, key, html));
      return htmlResponse(html, {
        "cache-control": `public, max-age=${CLIENT_MAX_AGE_SECONDS}`,
      });
    }

    logGate(request, tier, normUrl, "miss-origin-render-failed");
    // Render unavailable: serve the normal origin page instead of a 503.
    // Googlebot/Bingbot execute JS themselves, so this is safe for them.
    return fetch(request);
  },
};
