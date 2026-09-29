// Only render pages you control. This prevents the Worker from becoming
// an open browser-rendering proxy for arbitrary websites.
const ALLOWED_HOSTNAMES = new Set([
  "newtroubadours.org",
  "www.newtroubadours.org",
]);

const getTargetUrl = (request) => {
  const requestUrl = new URL(request.url);
  const target = requestUrl.searchParams.get("url");

  if (!target) {
    throw new Error("Missing url query parameter");
  }

  const targetUrl = new URL(target);

  // Only render HTTP(S) pages. Other protocols are not valid web pages.
  if (!["http:", "https:"].includes(targetUrl.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are allowed");
  }

  if (!ALLOWED_HOSTNAMES.has(targetUrl.hostname)) {
    throw new Error("This hostname is not allowed");
  }

  return targetUrl;
};

const renderHtml = async (env, targetUrl) => {
  // The /content Quick Actions endpoint loads the page in Browser Run and returns
  // a JSON envelope containing the rendered HTML in the result field.
  const response = await env.BROWSER.quickAction("content", {
    url: targetUrl.toString(),
    gotoOptions: {
      waitUntil: "networkidle2",
      timeout: 30000,
    },
    // If your page has a specific readiness signal, use waitForSelector
    // instead of relying only on network activity.
    // waitForSelector: { selector: "[data-prerender-ready='true']", timeout: 30000 },
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Browser Run failed with ${response.status}: ${detail}`);
  }

  const data = await response.json();

  if (!data.success || typeof data.result !== "string") {
    throw new Error("Browser Run returned an unsuccessful response");
  }

  return data.result;
};

export default {
  async fetch(request, env) {
    try {
      // Read and validate the URL before sending it to Browser Run.
      const targetUrl = getTargetUrl(request);
      const html = await renderHtml(env, targetUrl);

      // Return the rendered HTML to the crawler or integration.
      return new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        { status: 400 },
      );
    }
  },
};
