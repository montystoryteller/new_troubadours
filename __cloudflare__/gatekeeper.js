// ── gatekeeper ──────────────────────────────────────────────
// Sits on the newtroubadours.org/* route.
// Passes humans straight to GitHub Pages.
// Sends known crawlers (and social-preview bots) to the RENDERER worker
// for a prerendered snapshot, stores it in KV (global, unlike caches.default),
// serves stale snapshots while refreshing in the background, and falls back
// to the normal origin page (never a 503) if rendering fails.
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
// and a render-tier bot request also triggers one background refresh.
const FRESH_SECONDS = 60 * 60 * 48; // refresh-if-requested after ~2 days
// Keep entries much longer than the freshness window: if a snapshot expired,
// there would be nothing to serve and a scarce live render would be needed.
const KV_TTL_SECONDS = 60 * 60 * 24 * 14; // keep stale copies for 2 weeks
const CLIENT_MAX_AGE_SECONDS = 60 * 60;

const DEBUG_HEADER = "x-force-render";
const PURGE_HEADER = "x-purge-cache";
// Invalidation levels, from gentlest to harshest:
//  - mark-stale (one page): keep the snapshot, set its age to "ancient". It is
//    still served, and refreshed by the next prewarm / render-tier bot request.
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
// Pages not listed here never carry params. Verify the two guessed filenames
// (event_guide, tour_guide) against your real pages.
const PARAMS_BY_PATH = {
  "/storyclub": ["club"],
  "/performers": ["performer"],
  "/venues": ["venue"],
  "/promoters": ["promoter"],
  "/festival": ["festival"],
  "/event_guide": ["event", "event_id"],
  "/tour_guide": ["tour", "performer"],
  "/flyers": ["tour"],
  "/media": ["series"],
  "/books_merch": ["performer", "publisher", "view"],
};
// event.js treats ?event_id= as an alias and rewrites it to ?event=.
const PARAM_ALIASES = { event_id: "event" };
const MAX_PARAM_VALUE_LENGTH = 200;

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

function injectPrerenderBadge(html) {
  const badge = `
<div id="cf-prerender-badge" style="position:fixed;bottom:12px;right:12px;z-index:999999;
  background:#f6821f;color:#fff;font:600 12px/1.4 system-ui,sans-serif;
  padding:6px 10px;border-radius:6px;box-shadow:0 2px 6px rgba(0,0,0,.25);
  pointer-events:none;">
  ⚡ Prerendered by Cloudflare
</div>`;
  return html.includes("</body>")
    ? html.replace("</body>", `${badge}</body>`)
    : html + badge;
}

// Canonical form of the URL: path plus the identity params for that page,
// sorted, so ?club=x&utm=y and ?utm=z&club=x share one snapshot but
// ?club=a and ?club=b do not.
function normalisedUrl(url) {
  const out = new URL(url.origin + url.pathname);
  const allowed = new Set(
    PARAMS_BY_PATH[url.pathname.replace(/\.html$/, "")] || [],
  );
  const pairs = [...url.searchParams]
    .filter(([k, v]) => allowed.has(k) && v.length <= MAX_PARAM_VALUE_LENGTH)
    .map(([k, v]) => [PARAM_ALIASES[k] || k, v])
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  for (const [k, v] of pairs) out.searchParams.append(k, v);
  return out;
}

// One structured log line per bot request saying what the bot actually got.
// Pair it with "render failed <why> ..." lines (same rayId) to see the full story.
//   hit-fresh | hit-stale-refreshing | hit-stale
//   miss-rendered | miss-origin-render-failed | miss-origin-no-render
//   (no-render = a cache-only-tier bot such as Googlebot: never spends a render)
function logGate(request, tier, normUrl, outcome) {
  console.log({
    evt: "gate",
    outcome,
    tier,
    ua: (request.headers.get("user-agent") || "").slice(0, 60),
    page: normUrl.pathname + normUrl.search,
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
    return { html: injectPrerenderBadge(await res.text()) };
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const normUrl = normalisedUrl(url);
    const key = cacheKeyFor(normUrl);

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
        return htmlResponse(result.html, { "cache-control": "no-store" });
      }
      const markedStale = await markStale(env, key);
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
    // and refresh in the background.
    const [raw, { soft, hard }] = await Promise.all([
      env.RENDER_CACHE.get(key, "json"),
      getEpochs(env),
    ]);
    const entry = raw?.html && raw.ts >= hard ? raw : null;
    if (entry) {
      const stale =
        entry.ts < soft || Date.now() - entry.ts > FRESH_SECONDS * 1000;
      logGate(
        request,
        tier,
        normUrl,
        !stale ? "hit-fresh" : tier === "render" ? "hit-stale-refreshing" : "hit-stale",
      );
      // Only render-tier bots may spend a render refreshing a stale snapshot.
      if (stale && tier === "render") {
        ctx.waitUntil(refresh(env, key, normUrl.toString(), 1, "bg-refresh"));
      }
      return htmlResponse(entry.html, {
        "cache-control": `public, max-age=${CLIENT_MAX_AGE_SECONDS}`,
        "x-prerender-stale": stale ? "true" : "false",
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
