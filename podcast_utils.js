/**
 * podcast_utils.js
 * Shared RSS/Atom podcast feed fetching + parsing utilities.
 * Used by podcast-feed-curator.html and by the podcast section on
 * new_troubadours_performers.html.
 *
 * This file is deliberately DOM-rendering agnostic — it only fetches,
 * discovers, and parses feeds into plain data ({feed, items}). Each page
 * is responsible for turning that data into markup in its own style.
 *
 * Include this script before any page script that calls these functions.
 */

// ---------------------------------------------------------------------------
// CORS proxy fallback
// Many podcast hosts don't send CORS headers, so a direct fetch() from the
// browser fails even though the feed itself is public. corsproxy.nl is used
// as a fallback only — every function here tries the direct request first.
// ---------------------------------------------------------------------------

const PODCAST_CORS_PROXY = "https://corsproxy.nl/";

/**
 * Build a corsproxy.nl URL for a given target URL.
 * corsproxy.nl expects the target host+path appended after the proxy origin,
 * with an explicit /http/ prefix for non-https targets.
 * @param {string} url
 * @returns {string}
 */
function proxiedPodcastUrl(url) {
  return url.startsWith("http://")
    ? PODCAST_CORS_PROXY + "http/" + url.slice("http://".length)
    : PODCAST_CORS_PROXY + url.replace(/^https:\/\//, "");
}

/**
 * Fetch a URL's text, trying direct first and falling back to the CORS proxy.
 * @param {string} url
 * @returns {Promise<{text: string, viaProxy: boolean}>}
 */
async function fetchPodcastText(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    return { text: await res.text(), viaProxy: false };
  } catch (directErr) {
    try {
      const res = await fetch(proxiedPodcastUrl(url));
      if (!res.ok) throw new Error("HTTP " + res.status + " via proxy");
      return { text: await res.text(), viaProxy: true };
    } catch (proxyErr) {
      throw new Error(
        `Direct request failed (${directErr.message}). CORS proxy fallback also failed (${proxyErr.message}).`,
      );
    }
  }
}

function looksLikePodcastFeed(text) {
  return /<rss[\s>]|<feed[\s>][^]*xmlns=["']http:\/\/www\.w3\.org\/2005\/Atom["']/i.test(
    text.slice(0, 4000),
  );
}

/**
 * Resolve an arbitrary input (an exact feed URL, or just a podcast's website)
 * to an actual RSS/Atom feed URL + its text. Tries, in order: the URL as-is,
 * <link rel="alternate" type="application/rss+xml"> autodiscovery on that
 * page, a plausible "Subscribe"-style anchor, then a handful of conventional
 * feed paths on the same host.
 * @param {string} input
 * @returns {Promise<{feedUrl: string, text: string, viaProxy: boolean}>}
 */
async function resolvePodcastFeedUrl(input) {
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  // Most people will paste the exact feed URL — try it as-is first.
  // Some hosts (e.g. Podomatic) 301-redirect their bare homepage to a
  // different host entirely, which a simple proxy can't always follow — so
  // any failure here just falls through to autodiscovery/guessing rather
  // than aborting.
  let page = null;
  try {
    page = await fetchPodcastText(url);
    if (looksLikePodcastFeed(page.text)) return { feedUrl: url, ...page };
  } catch (e) {
    /* homepage unreachable directly — keep going */
  }

  if (page) {
    // Not a feed: treat the response as a webpage and look for a standard
    // <link rel="alternate" type="application/rss+xml"> autodiscovery tag.
    const doc = new DOMParser().parseFromString(page.text, "text/html");
    const link = doc.querySelector(
      'link[type="application/rss+xml"],link[type="application/atom+xml"],link[rel="alternate"][type*="rss"]',
    );
    if (link?.getAttribute("href")) {
      try {
        const href = new URL(link.getAttribute("href"), url).toString();
        const res = await fetchPodcastText(href);
        if (looksLikePodcastFeed(res.text)) return { feedUrl: href, ...res };
      } catch (e) {
        /* keep trying */
      }
    }
    // Some hosts (e.g. Podomatic) just link the feed as a plain "Subscribe"
    // anchor rather than a <link> autodiscovery tag — check anchors that
    // look feed-ish too.
    const anchor = [...doc.querySelectorAll("a[href]")].find((a) =>
      /\.(rss|xml)(\?|#|$)/i.test(a.getAttribute("href") || ""),
    );
    if (anchor) {
      try {
        const href = new URL(anchor.getAttribute("href"), url).toString();
        const res = await fetchPodcastText(href);
        if (looksLikePodcastFeed(res.text)) return { feedUrl: href, ...res };
      } catch (e) {
        /* keep trying */
      }
    }
  }

  // Last resort: try a handful of conventional feed paths on the same host
  // (podcast hosts like Podomatic, Libsyn, Buzzsprout, etc. are fairly
  // consistent here).
  const origin = new URL(url).origin + "/";
  const guesses = ["rss2.xml", "rss.xml", "feed.xml", "rss", "feed", "podcast.xml"];
  for (const g of guesses) {
    try {
      const candidate = new URL(g, origin).toString();
      const res = await fetchPodcastText(candidate);
      if (looksLikePodcastFeed(res.text)) return { feedUrl: candidate, ...res };
    } catch (e) {
      /* try the next guess */
    }
  }
  throw new Error(
    "Couldn't find an RSS/Atom feed at that address (checked the page itself, its autodiscovery link, and common feed paths).",
  );
}

// ---------------------------------------------------------------------------
// Feed parsing
// ---------------------------------------------------------------------------

function _podcastText(el, names) {
  for (const name of names) {
    const n = el.querySelector(name);
    if (n?.textContent) return n.textContent.trim();
  }
  return "";
}

function _podcastAttr(el, names, a) {
  for (const name of names) {
    const n = el.querySelector(name);
    if (n?.getAttribute(a)) return n.getAttribute(a);
  }
  return "";
}

/**
 * Parse RSS 2.0 / iTunes-podcast XML text into plain feed + episode data.
 * @param {string} xml
 * @returns {{feed: object, items: object[]}}
 */
function parsePodcastFeed(xml) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("Invalid XML");
  const channel = doc.querySelector("channel");
  if (!channel) throw new Error("No RSS channel found");

  const feed = {
    title: _podcastText(channel, ["title"]),
    description: _podcastText(channel, ["description", "itunes\\:summary"]),
    link: _podcastText(channel, ["link"]),
    language: _podcastText(channel, ["language"]) || "en-gb",
    author: _podcastText(channel, ["itunes\\:author", "author"]),
    image:
      _podcastAttr(channel, ["itunes\\:image"], "href") ||
      channel.querySelector("image>url")?.textContent?.trim() ||
      "",
  };
  const items = [...channel.children]
    .filter((x) => x.localName === "item")
    .map((el, i) => {
      const enc = el.querySelector("enclosure");
      const image = el.querySelector("itunes\\:image");
      const link = _podcastText(el, ["link"]);
      const guid = _podcastText(el, ["guid"]) || link || enc?.getAttribute("url") || "episode-" + i;
      return {
        id: crypto.randomUUID(),
        title: _podcastText(el, ["title"]) || "Untitled episode",
        link,
        description: _podcastText(el, ["description", "content\\:encoded", "itunes\\:summary"]),
        pubDate: _podcastText(el, ["pubDate", "dc\\:date", "published", "updated"]) || new Date().toISOString(),
        author: _podcastText(el, ["itunes\\:author", "author", "dc\\:creator"]),
        duration: _podcastText(el, ["itunes\\:duration"]),
        explicit: _podcastText(el, ["itunes\\:explicit"]) || "no",
        enclosureUrl: enc?.getAttribute("url") || "",
        enclosureType: enc?.getAttribute("type") || "audio/mpeg",
        enclosureLength: enc?.getAttribute("length") || "",
        image: image?.getAttribute("href") || "",
        guid,
      };
    });
  return { feed, items };
}

/**
 * High-level convenience wrapper: resolve + fetch + parse in one call.
 * @param {string} input An exact feed URL, or a podcast's website.
 * @returns {Promise<{feedUrl: string, feed: object, items: object[], viaProxy: boolean}>}
 */
async function loadPodcastFeed(input) {
  const { feedUrl, text, viaProxy } = await resolvePodcastFeedUrl(input);
  const { feed, items } = parsePodcastFeed(text);
  return { feedUrl, feed, items, viaProxy };
}

// ---------------------------------------------------------------------------
// Display formatting
// ---------------------------------------------------------------------------

/**
 * Format an episode/feed date for display. Falls back to the raw string
 * if it doesn't parse as a date.
 * @param {string} v
 * @returns {string}
 */
function formatPodcastDate(v) {
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? v
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Format an <itunes:duration> value (either raw seconds or an already
 * HH:MM:SS-ish string) into H:MM:SS / M:SS for display.
 * @param {string} d
 * @returns {string}
 */
function formatPodcastDuration(d) {
  if (!d) return "";
  if (/^\d+$/.test(d)) {
    const s = parseInt(d, 10),
      h = Math.floor(s / 3600),
      m = Math.floor((s % 3600) / 60),
      sec = s % 60;
    return h
      ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
      : `${m}:${String(sec).padStart(2, "0")}`;
  }
  return d; // already looks like HH:MM:SS
}
