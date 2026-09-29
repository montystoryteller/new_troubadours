// ── gatekeeper ──────────────────────────────────────────────
// Sits on the newtroubadours.org/* route.
// Passes humans straight to GitHub Pages.
// Sends known crawlers (and social-preview bots) to the RENDERER worker
// for a prerendered snapshot, caches the result, and falls back cleanly
// if rendering fails or quota is exhausted.

const CRAWLER_UA_RE =
  /bingbot|googlebot|duckduckbot|slurp|baiduspider|yandexbot|sogou|exabot|facebookexternalhit|facebot|twitterbot|linkedinbot|discordbot|slackbot|telegrambot|whatsapp|pinterestbot|redditbot|applebot|petalbot|bytespider|semrushbot|ahrefsbot|mj12bot|dotbot/i;

const ASSET_EXTENSION_RE =
  /\.(js|mjs|css|png|jpe?g|gif|svg|webp|ico|avif|woff2?|ttf|eot|json|xml|txt|map|mp4|webm|pdf)$/i;

const CACHE_TTL_SECONDS = 60 * 60 * 36; // cache a rendered page for 36h
const RENDER_RETRY_AFTER_SECONDS = 60 * 60 * 24; // suggest crawlers retry in 24h if quota's exhausted

const DEBUG_HEADER = "x-force-render";
const PURGE_HEADER = "x-purge-cache";

function isCrawler(request) {
  return CRAWLER_UA_RE.test(request.headers.get("user-agent") || "");
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);

    // Manual purge: clear this URL's cached render, do nothing else.
    if (isAuthorized(request, env, PURGE_HEADER)) {
      const deleted = await cache.delete(cacheKey);
      return new Response(
        deleted
          ? `Purged cache for ${url.toString()}`
          : `No cache entry found for ${url.toString()}`,
        { status: 200 },
      );
    }

    const forced = isAuthorized(request, env, DEBUG_HEADER);
    const crawler = isCrawler(request);

    // Not a crawler, not asking for a page, and not a manual debug ping — pass straight through.
    if (!forced && (!crawler || !looksLikeHtmlRequest(request, url))) {
      return fetch(request);
    }

    // Serve from cache when we can (skip for debug pings so they always see a live render).
    if (!forced) {
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
    }

    // Ask the renderer worker for a prerendered copy.
    const renderUrl = new URL("https://renderer/");
    renderUrl.searchParams.set("url", url.toString());
    const rendered = await env.RENDERER.fetch(renderUrl);

    if (!rendered.ok) {
      // Render failed (e.g. hit the daily Browser Rendering quota).
      if (crawler) {
        // Tell the crawler this response is incomplete/temporary — don't index it.
        return new Response(
          "Prerendering temporarily unavailable — please retry later.",
          {
            status: 503,
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "retry-after": String(RENDER_RETRY_AFTER_SECONDS),
            },
          },
        );
      }
      // Not a crawler (e.g. a debug ping) — fall back to the plain origin page.
      return fetch(request);
    }

    const renderedHtml = await rendered.text();
    const finalHtml = injectPrerenderBadge(renderedHtml);

    const response = new Response(finalHtml, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": forced
          ? "no-store"
          : `public, max-age=${CACHE_TTL_SECONDS}`,
        "x-prerendered": "true",
      },
    });

    if (!forced) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }
    return response;
  },
};
