// ── gatekeeper ──────────────────────────────────────────────
// Sits on the newtroubadours.org/* route.
// Passes humans straight to GitHub Pages.
// Sends known crawlers (and social-preview bots) to the RENDERER worker
// for a prerendered snapshot, stores it in KV (global, unlike caches.default),
// serves stale snapshots while refreshing in the background, and falls back
// to the normal origin page (never a 503) if rendering fails.
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
const FRESH_SECONDS = 60 * 60 * 48; // refresh-if-requested after ~2 days
// Keep entries much longer than the freshness window: if a snapshot expired,
// there would be nothing to serve and a scarce live render would be needed.
const KV_TTL_SECONDS = 60 * 60 * 24 * 14; // keep stale copies for 2 weeks
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
    return REPERTOIRE_TOUR_PREFIX + value.slice(LEGACY_REPERTOIRE_TOUR_PREFIX.length);
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

// Try to claim the global crawler-render slot. Returns true if this request
// may render. If KV can't tell us, say no (protect the quota).
async function claimRenderSlot(env) {
  try {
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
// been refreshed or has expired (KV_TTL_SECONDS, 14 days).
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
    .map(([k, v]) => [PARAM_ALIASES[k] || k, canonicalParamValue(pagePath, k, v)])
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

// Browser Run (free plan) allows roughly one Quick Action request per 10s and
// 10 browser-minutes per day, account-wide. So retries must wait >10s, and
// crawler-triggered renders should NOT retry at all: retries from crawlers
// would steal the few slots the scheduled prewarm needs.
const RETRY_BASE_MS = 12000;

// Returns {html} on success, or {html: null, status, quotaExhausted}.
async function renderOnce(env, targetUrl, why = "?") {
  const renderUrl = new URL("https://renderer/");
  renderUrl.searchParams.set("url", targetUrl);
  try {
    const res = await env.RENDERER.fetch(renderUrl);
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      console.log("render failed", why, res.status, body, targetUrl);
      return {
        html: null,
        status: res.status,
        // Daily browser-time cap: no point retrying until tomorrow (UTC).
        quotaExhausted: /time limit exceeded/i.test(body),
      };
    }
    return { html: markPrerendered(await res.text()) };
  } catch (err) {
    console.log("render threw", why, String(err), targetUrl);
    return { html: null, status: 0, quotaExhausted: false };
  }
}

async function renderWithRetry(env, targetUrl, attempts = 1, why = "?") {
  let result = { html: null, status: 0, quotaExhausted: false };
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
    metadata: { ts: entry.ts, bytes: entry.html.length },
  });
}

async function storeSnapshot(env, key, html) {
  // Never let a KV failure (e.g. the free plan's 1,000 writes/day limit) break
  // the response: the freshly rendered HTML is still served, just not stored.
  try {
    await putEntry(env, key, { html, ts: Date.now() });
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
// <page>.html?<param>=<key>. No <lastmod> is emitted: a wrong one is worse than
// none. Event pages are not in the key index, so they are not listed.
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
];
const SITEMAP_MAX_URLS = 50000; // protocol limit per file
const SITEMAP_CACHE_SECONDS = 60 * 60 * 6;

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
  const urls = [`${SITE_ORIGIN}/`];
  for (const [name, path, param] of SITEMAP_ENTRIES) {
    const list = Array.isArray(idx[name]) ? [...idx[name]].sort() : [];
    for (const key of list) {
      urls.push(`${SITE_ORIGIN}${path}?${param}=${encodeURIComponent(key)}`);
    }
  }
  if (urls.length > SITEMAP_MAX_URLS) {
    console.log("sitemap truncated", urls.length);
    urls.length = SITEMAP_MAX_URLS;
  }
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map((u) => `  <url><loc>${xmlEscape(u)}</loc></url>`).join("\n") +
    "\n</urlset>\n";
  return new Response(request.method === "HEAD" ? null : body, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": `public, max-age=${SITEMAP_CACHE_SECONDS}`,
      "x-sitemap-urls": String(urls.length),
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
      const olderThan = Number(request.headers.get(ONLY_IF_OLDER_HEADER));
      if (olderThan > 0) {
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
      // The prewarm is the one caller that may retry (spaced past the 10s limit).
      const result = await refresh(env, key, normUrl.toString(), 3, "forced");
      if (result.html) {
        logGate(request, "forced", normUrl, "forced-rendered");
        return htmlResponse(result.html, { "cache-control": "no-store" });
      }
      const markedStale = await markStale(env, key);
      logGate(request, "forced", normUrl, "forced-failed", {
        status: result.status,
        quotaExhausted: result.quotaExhausted,
        markedStale,
      });
      return new Response("render failed", {
        status: result.status === 429 ? 429 : 502,
        headers: {
          "cache-control": "no-store",
          ...(markedStale ? { "x-marked-stale": "true" } : {}),
          ...(result.quotaExhausted ? { "x-quota-exhausted": "true" } : {}),
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
      if (
        stale &&
        tier === "render" &&
        (await isKnownPage(env, normUrl)) &&
        (await claimRenderSlot(env))
      ) {
        outcome = "hit-stale-refreshing";
        ctx.waitUntil(refresh(env, key, normUrl.toString(), 1, "bg-refresh"));
      }
      logGate(request, tier, normUrl, outcome);
      return htmlResponse(stripLegacyBadge(entry.html), {
        "cache-control": `public, max-age=${CLIENT_MAX_AGE_SECONDS}`,
        "x-prerender-stale": stale ? "true" : "false",
        "x-prerender-ts": String(entry.ts),
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

    // Global cooldown: skip the render if another crawler render started
    // within the last minute.
    if (!(await claimRenderSlot(env))) {
      logGate(request, tier, normUrl, "miss-origin-render-busy");
      return fetch(request);
    }

    const { html } = await renderWithRetry(env, normUrl.toString(), 1, "miss");
    if (html) {
      logGate(request, tier, normUrl, "miss-rendered");
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
