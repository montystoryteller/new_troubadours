/**
 * shared_utils.js
 * Shared utilities for New Troubadours event guide and tour display apps.
 * Include this script before app-specific scripts in each HTML page.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PARAGRAPH_SEPARATOR = "\n\n\n\n";

const UK_IRELAND_BOUNDS =
  typeof L !== "undefined"
    ? L.latLngBounds(
        [49.5, -11.0], // SW corner (Atlantic)
        [61.0, 2.5], // NE corner (North Sea)
      )
    : null;

// Icon SVGs used for website, email, and Facebook links.
// The email icon uses a stroked envelope style (from the event guide).
const ICON_SVG = {
  website:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>',
  email:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>',
  facebook:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#1877f2"/><path d="M16.5 8H14c-.3 0-.5.2-.5.5V10H16l-.3 2.5H13.5V19h-2.5v-6.5H9V10h2V8.5C11 6.6 12.3 5.5 14 5.5c.8 0 2.5.1 2.5.1V8z" fill="#ffffff"/></svg>',
  link:
    '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 2H14V6M14 2L8 8M12 9V13C12 13.55 11.55 14 11 14H3C2.45 14 2 13.55 2 13V5C2 4.45 2.45 4 3 4H7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

// ---------------------------------------------------------------------------
// Presentation Helper
// ---------------------------------------------------------------------------

/**
 * Append a pipe separator span to a container element.
 * Used wherever ticket/tour links are separated by " | ".
 * @param {HTMLElement} container
 */
function appendSeparator(container) {
  const sep = document.createElement("span");
  sep.className = "separator";
  sep.textContent = " | ";
  container.appendChild(sep);
}

/**
 * Show "✅ Link Copied!" feedback on a button, then restore original text after 2 seconds.
 * Safe for all copy-to-clipboard operations (tours, festivals, events).
 * @param {HTMLElement} btn - The button element to provide feedback on
 * @param {string} feedbackText - Text to show (default: "✅ Link Copied!")
 * @param {number} duration - Duration in ms before restoring (default: 2000)
 */
function showCopyFeedback(
  btn,
  feedbackText = "✅ Link Copied!",
  duration = 2000,
) {
  if (!btn) return;
  const originalText = btn.innerHTML;
  btn.innerHTML = feedbackText;
  setTimeout(() => {
    btn.innerHTML = originalText;
  }, duration);
}

// ---------------------------------------------------------------------------
// Date utilities
// ---------------------------------------------------------------------------

/**
 * Short month names, indexed by Date#getMonth() (0-11).
 * Shared by event_display.js, storyclub.js, and venues.js — previously
 * three identical copies of this exact array.
 */
const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * Full day names, indexed by Date#getDay() (0 = Sunday).
 * Shared by event_display.js (as DAYS_OF_WEEK) and storyclub.js (as
 * DAYS) — previously two identical copies of this exact array.
 */
const DAYS_OF_WEEK = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Lower-case day name -> Date#getDay() index. Used when parsing recurring
 * schedule strings/objects like "3rd wednesday" or {day: "wednesday"}.
 * Consumed directly (as the bare global DAY_MAP) by event_display.js,
 * storyclub.js, and flyers.js. Previously a locally-defined literal here;
 * now aliased from recurrence-engine.js so there's exactly one copy of this
 * object instead of two near-identical ones drifting independently.
 * recurrence-engine.js must be loaded (as a <script>) before this file.
 */
const DAY_MAP = RecurrenceEngine.DAY_MAP;

/**
 * "1st"/"2nd"/"3rd"/"4th"/"5th"/"last" (plus word-form aliases "first",
 * "second", etc.) -> the value findNthDayInMonth()-style helpers expect
 * for `occurrence`. Consumed directly (as the bare global OCCURRENCE_MAP)
 * by event_display.js and storyclub.js. Previously a locally-defined
 * literal missing the word-form aliases — "first wednesday" silently
 * resolved to zero dates everywhere. Now aliased from recurrence-engine.js,
 * which must be loaded (as a <script>) before this file.
 */
const OCCURRENCE_MAP = RecurrenceEngine.OCCURRENCE_MAP;

function formatShortDate(d) {
  if (!d) return "";
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}

/**
 * Day + short month + year, no weekday — e.g. "9 May 2026". Distinct from
 * formatShortDate() above (which omits the year); previously duplicated
 * in flyers.js as formatDateShort(), a name one letter-order away from
 * this file's formatShortDate() despite returning something different —
 * renamed on the move here to make that distinction explicit.
 * @param {Date} dt
 * @returns {string}
 */
function formatShortDateWithYear(dt) {
  return `${dt.getDate()} ${MONTHS_SHORT[dt.getMonth()]} ${dt.getFullYear()}`;
}

function formatMediumDate(d) {
  if (!d) return "";
  return `${DAYS_SHORT[d.getDay()]} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * Format a Date as "Weekday, D Mon YYYY", e.g. "Saturday, 6 Sep 2026".
 * Shared by event_display.js and storyclub.js — previously two identical
 * implementations (one read DAYS_OF_WEEK, the other DAYS; same array).
 * @param {Date} date
 * @returns {string}
 */
function formatDate(date) {
  return `${DAYS_OF_WEEK[date.getDay()]}, ${date.getDate()} ${MONTHS_SHORT[date.getMonth()]} ${date.getFullYear()}`;
}

/**
 * Parse a DD/MM/YYYY date string into a midnight-normalised Date object.
 * Returns null if the string is missing or malformed.
 * @param {string} dateStr
 * @returns {Date|null}
 */
function parseDateString(dateStr) {
  if (!dateStr) return null;
  if (Array.isArray(dateStr)) {
    console.warn(
      "parseDateString received an array; use the first element or expandDatetimes instead:",
      dateStr,
    );
    return null;
  }
  const parts = dateStr.split("/");
  if (parts.length !== 3) return null;
  const [day, month, year] = parts.map(Number);
  return new Date(year, month - 1, day);
}

/**
 * Return today's date normalised to midnight.
 * @returns {Date}
 */
function getTodayMidnight() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

/**
 * Return true if the given DD/MM/YYYY date string is in the past.
 * @param {string} dateStr
 * @returns {boolean}
 */
function isDatePast(dateStr) {
  const d = parseDateString(dateStr);
  return d !== null && d < getTodayMidnight();
}

/**
 * Format a Date as YYYY-MM-DD for use in <input type="date"> elements.
 * @param {Date} date
 * @returns {string}
 */
function formatDateForInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// URL / security utilities
// ---------------------------------------------------------------------------

/**
 * Validate and sanitize a URL, allowing only http, https, and mailto.
 * Returns null if the URL is missing or uses a disallowed protocol.
 * @param {string} url
 * @returns {string|null}
 */
function sanitizeUrl(url) {
  if (!url) return null;
  url = url.trim();
  const allowedProtocols = ["http:", "https:", "mailto:"];
  try {
    const urlObj = new URL(url, window.location.origin);
    if (!allowedProtocols.includes(urlObj.protocol)) {
      console.warn("Blocked potentially dangerous URL:", url);
      return null;
    }
    return urlObj.href;
  } catch (e) {
    console.warn("Invalid URL:", url);
    return null;
  }
}

/**
 * Validate a YouTube URL and convert it to a safe, privacy-enhanced
 * embed URL (youtube-nocookie.com). Accepts standard watch URLs,
 * youtu.be short links, /embed/ links, and /shorts/ links. Returns
 * null for anything else (including other video hosts), so it can
 * never be used to inject an arbitrary iframe source.
 * @param {string} url
 * @returns {string|null}
 */
function getYouTubeEmbedUrl(url) {
  if (!url) return null;
  url = url.trim();

  let urlObj;
  try {
    urlObj = new URL(url);
  } catch (e) {
    return null;
  }

  if (urlObj.protocol !== "https:" && urlObj.protocol !== "http:") return null;

  const host = urlObj.hostname.replace(/^www\./, "");
  let videoId = null;

  if (host === "youtu.be") {
    videoId = urlObj.pathname.slice(1).split("/")[0];
  } else if (host === "youtube.com" || host === "m.youtube.com") {
    if (urlObj.pathname === "/watch") {
      videoId = urlObj.searchParams.get("v");
    } else if (urlObj.pathname.startsWith("/embed/")) {
      videoId = urlObj.pathname.split("/embed/")[1];
    } else if (urlObj.pathname.startsWith("/shorts/")) {
      videoId = urlObj.pathname.split("/shorts/")[1];
    }
  }

  if (!videoId) return null;
  videoId = videoId.split("?")[0].split("&")[0];

  // YouTube video IDs are 11 chars of [A-Za-z0-9_-]
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;

  return `https://www.youtube-nocookie.com/embed/${videoId}`;
}

/**
 * Build the wrapper + iframe DOM nodes for an embedded YouTube trailer.
 * Shared by the events page (event_display.js) and the story club page
 * (storyclub.js) so the iframe's permissions/attributes stay in sync if
 * either ever needs to change — the two pages otherwise have their own,
 * different button/toggle implementations, which this doesn't touch.
 *
 * The iframe's `src` is intentionally left unset: callers are
 * responsible for setting it to the resolved embed URL when the trailer
 * is opened, and clearing it back to "" when closed (or when another
 * expandable takes its place), so playback actually stops rather than
 * continuing to play off-screen.
 * @param {string} title - accessible iframe title, e.g. "<event name> trailer"
 * @returns {{wrapper: HTMLDivElement, iframe: HTMLIFrameElement}}
 */
function createVideoTrailerEmbed(title) {
  const wrapper = document.createElement("div");
  wrapper.className = "event-video-wrapper";

  const iframe = document.createElement("iframe");
  iframe.title = title;
  iframe.frameBorder = "0";
  iframe.allow =
    "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
  iframe.referrerPolicy = "strict-origin-when-cross-origin";
  iframe.allowFullscreen = true;

  wrapper.appendChild(iframe);
  return { wrapper, iframe };
}

/**
 * Sanitize HTML to prevent XSS: convert text to safe HTML entities.
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  if (!text) return "";
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Normalise a Facebook handle or URL to a full https://facebook.com/... URL.
 * @param {string} fb  - Either a full URL or a bare handle/path.
 * @returns {string}
 */
function normaliseFacebookUrl(fb) {
  return fb.startsWith("http") ? fb : `https://facebook.com/${fb}`;
}

/**
 * Normalise an Instagram handle or URL to a full, sanitized
 * https://www.instagram.com/... URL — so data entry can just be a bare
 * username (with or without a leading @) instead of a full URL.
 *
 * Deliberately goes through sanitizeUrl() before returning, unlike
 * normaliseFacebookUrl() above (a known, currently-unfixed gap — every
 * Facebook link on the site skips protocol validation; this one doesn't).
 * Was previously two separately hand-rolled, byte-for-byte identical
 * copies of this exact logic in venues.js and performers.js.
 * @param {string} ig - Either a full URL or a bare handle (with or without @).
 * @returns {string} A sanitized instagram.com URL, or "#" if `ig` was a
 *   malformed/dangerous full URL (mirrors sanitizeUrl()'s own fallback
 *   convention rather than returning null, since every call site here
 *   sets this straight onto an <a href> and wants a safe href regardless).
 */
function normaliseInstagramUrl(ig) {
  if (!ig) return "#";
  const url = /^https?:\/\//i.test(ig)
    ? ig
    : `https://www.instagram.com/${ig.replace(/^@/, "")}`;
  return sanitizeUrl(url) || "#";
}

/**
 * Does this record have a usable [lat, lon] pair? Used to filter out
 * venues/records with no known location before any distance math.
 * @param {object} v - anything with an optional .latlon field
 * @returns {boolean}
 */
function hasLatlon(v) {
  return Array.isArray(v?.latlon) && v.latlon.length === 2;
}

/**
 * Haversine great-circle distance between two lat/lon points, in km.
 */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Find nearby lat/lon-bearing records within a radius, sorted closest
 * first, capped to a limit. Originally a venues.js-only helper
 * (getNearbyVenues()); generalised here as the first non-venues.js
 * consumer (a storyclub.js "nearby clubs" feature) was being planned —
 * pulled out before that second copy got written, rather than after.
 * @param {number} lat - reference latitude
 * @param {number} lon - reference longitude
 * @param {Array<[string, object]>} entries - [key, record] pairs; each
 *   record should have an optional .latlon = [lat, lon]
 * @param {object} [options]
 * @param {string} [options.excludeKey] - key to exclude (e.g. the
 *   current venue/club itself, so it doesn't appear in its own "nearby" list)
 * @param {number} [options.radiusKm=20]
 * @param {number} [options.limit=8]
 * @returns {{key: string, item: object, dist: number}[]}
 */
function findNearbyByLatLon(
  lat,
  lon,
  entries,
  { excludeKey, radiusKm = 20, limit = 8 } = {},
) {
  return entries
    .filter(([key, item]) => key !== excludeKey && hasLatlon(item))
    .map(([key, item]) => ({
      key,
      item,
      dist: haversineKm(lat, lon, item.latlon[0], item.latlon[1]),
    }))
    .filter((x) => x.dist <= radiusKm)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit);
}

/**
 * A recurringClubEvent's actual venue for a given date — some clubs
 * alternate between two venues by month parity (`alternate_locations`),
 * so the base `venue_id` alone isn't always where a specific occurrence
 * is really happening. Previously local to storyclub.js only; moved here
 * as venues.js's nearby-events computation needs the same resolution
 * (matching a club occurrence to the correct nearby venue by date), not
 * just the club's own page.
 * @param {object} c - a recurringClubEvent record
 * @param {Date} [date] - the occurrence's date; without one, falls back
 *   to the base venue_id (can't resolve parity with no date)
 * @returns {string|null}
 */
function resolveClubVenueId(c, date) {
  if (!date || !c.alternate_locations) return c.venue_id || null;
  const parity = (date.getMonth() + 1) % 2 === 0 ? "even" : "odd";
  return c.alternate_locations[parity]?.venue_id || c.venue_id || null;
}

/**
 * Could this recurring club/folk-night/session record ever be found at
 * this venue — checking its base venue_id AND both alternate_locations
 * entries, not just the base field. A cheap "is it possible" pre-check
 * (e.g. for filtering "what's regularly on at this venue" before
 * bothering to expand a schedule); resolveClubVenueId() above resolves
 * which ONE of them actually applies for a specific date.
 * @param {object} rec
 * @param {string} vid
 * @returns {boolean}
 */
function couldBeAtVenue(rec, vid) {
  return (
    rec.venue_id === vid ||
    rec.alternate_locations?.even?.venue_id === vid ||
    rec.alternate_locations?.odd?.venue_id === vid
  );
}

/**
 * Renders one dated-event row for a venue/nearby-events/nearby-clubs
 * listing — moved here from venues.js as storyclub.js's nearby-events
 * feature is a second consumer (same row shapes: specific/music/poetry,
 * tour, show, club/folk/session, festival). Depends on performersLookup
 * being populated as a global by the calling page (see loadEventsData()),
 * same convention as eventsData/toursLookup.
 */
function renderEventRow(container, entry, isPast, options = {}) {
  const row = document.createElement("div");
  row.className = `event-row${isPast ? " event-row-past" : ""}`;

  const dateCol = document.createElement("div");
  dateCol.className = "event-row-date";
  dateCol.textContent = entry.date ? formatMediumDate(entry.date) : "TBC";
  row.appendChild(dateCol);

  const detail = document.createElement("div");
  detail.className = "event-row-detail";

  if (options.showVenue && entry.venue) {
    const venueLine = document.createElement("a");
    venueLine.className = "event-row-venue";
    venueLine.href = `venues.html?venue=${encodeURIComponent(entry.venueId)}`;
    venueLine.textContent =
      entry.venue.name + (entry.venue.city ? `, ${entry.venue.city}` : "");
    detail.appendChild(venueLine);
  }

  if (
    entry.type === "specific" ||
    entry.type === "music" ||
    entry.type === "poetry"
  ) {
    const e = entry.data;
    const title = document.createElement("div");
    title.className = "event-row-title";
    title.textContent = e.showname || e.name;
    detail.appendChild(title);

    if (e.time) {
      const t = document.createElement("span");
      t.className = "event-row-time";
      t.textContent = e.time;
      detail.appendChild(t);
    }

    // Performer link
    if (e.performer_id && performersLookup[e.performer_id]) {
      const perf = performersLookup[e.performer_id];
      const p = document.createElement("div");
      p.className = "event-row-performer";
      const a = document.createElement("a");
      a.href = `performers.html?performer=${encodeURIComponent(e.performer_id)}`;
      a.textContent = perf.name;
      p.appendChild(a);
      detail.appendChild(p);
    }

    const badges = document.createElement("div");
    badges.className = "badge-row";
    if (e.isMusic) {
      badges.appendChild(makeBadge("badge-music", "Music"));
    } else if (e.isPoetry) {
      badges.appendChild(makeBadge("badge-poetry", "Poetry"));
    } else {
      badges.appendChild(makeBadge("badge-special", "Story show"));
    }
    if (e.price) {
      badges.appendChild(makeBadge("badge-price", e.price));
    }
    if (e.ticket_url && !isPast) {
      const a = document.createElement("a");
      a.href = sanitizeUrl(e.ticket_url) || "#";
      a.target = "_blank";
      a.className = "ticket-link";
      a.textContent = "Tickets";
      badges.appendChild(a);
    }
    detail.appendChild(badges);
  } else if (entry.type === "tour") {
    const { tour, tourId, tourDate } = entry.data;
    const title = document.createElement("div");
    title.className = "event-row-title";
    title.textContent = tour.tour_name || tour.name;
    detail.appendChild(title);

    if (tourDate.time) {
      const t = document.createElement("span");
      t.className = "event-row-time";
      t.textContent = tourDate.time;
      detail.appendChild(t);
    }

    if (tour.performer_id && performersLookup[tour.performer_id]) {
      const perf = performersLookup[tour.performer_id];
      const p = document.createElement("div");
      p.className = "event-row-performer";
      const a = document.createElement("a");
      a.href = `performers.html?performer=${encodeURIComponent(tour.performer_id)}`;
      a.textContent = perf.name;
      p.appendChild(a);
      detail.appendChild(p);
    }

    const badges = document.createElement("div");
    badges.className = "badge-row";
    badges.appendChild(makeBadge("badge-special", "Tour date"));
    if (tourDate.price) {
      badges.appendChild(makeBadge("badge-price", tourDate.price));
    }
    if (tourDate.ticket_url && !isPast) {
      const a = document.createElement("a");
      a.href = sanitizeUrl(tourDate.ticket_url) || "#";
      a.target = "_blank";
      a.className = "ticket-link";
      a.textContent = "Tickets";
      badges.appendChild(a);
    }
    const viewLink = document.createElement("a");
    viewLink.href = `tour_guide.html?tour=${encodeURIComponent(tourId)}`;
    viewLink.className = "ticket-link";
    viewLink.textContent = "View tour";
    badges.appendChild(viewLink);
    detail.appendChild(badges);
  } else if (entry.type === "show") {
    const { ts, tsId, showDate } = entry.data;
    const title = document.createElement("div");
    title.className = "event-row-title";
    title.textContent = ts.showname || ts.name;
    detail.appendChild(title);

    if (showDate.time) {
      const t = document.createElement("span");
      t.className = "event-row-time";
      t.textContent = showDate.time;
      detail.appendChild(t);
    }

    if (ts.performer_id && performersLookup[ts.performer_id]) {
      const perf = performersLookup[ts.performer_id];
      const p = document.createElement("div");
      p.className = "event-row-performer";
      const a = document.createElement("a");
      a.href = `performers.html?performer=${encodeURIComponent(ts.performer_id)}`;
      a.textContent = perf.name;
      p.appendChild(a);
      detail.appendChild(p);
    }

    const badges = document.createElement("div");
    badges.className = "badge-row";
    if (ts.isStoryWalk) {
      badges.appendChild(makeBadge("badge-walk", "🚶 Story walk"));
    } else {
      badges.appendChild(makeBadge("badge-special", "Touring show"));
    }
    if (showDate.ticket_url && !isPast) {
      const a = document.createElement("a");
      a.href = sanitizeUrl(showDate.ticket_url) || "#";
      a.target = "_blank";
      a.className = "ticket-link";
      a.textContent = "Tickets";
      badges.appendChild(a);
    }
    detail.appendChild(badges);
  } else if (
    entry.type === "club" ||
    entry.type === "folk" ||
    entry.type === "session"
  ) {
    const { club } = entry.data;
    const title = document.createElement("div");
    title.className = "event-row-title";
    title.textContent = club.name;
    detail.appendChild(title);

    if (club.time) {
      const t = document.createElement("span");
      t.className = "event-row-time";
      t.textContent = club.time;
      detail.appendChild(t);
    }

    // Only recurringClubEvent records have a storyclub.html detail page
    // (via their .club slug) — folk nights/Irish sessions have no
    // equivalent page to link to today.
    if (entry.type === "club" && club.club) {
      const p = document.createElement("div");
      p.className = "event-row-performer";
      const a = document.createElement("a");
      a.href = `storyclub.html?club=${encodeURIComponent(club.club)}`;
      a.textContent = "View club details";
      p.appendChild(a);
      detail.appendChild(p);
    }

    const badges = document.createElement("div");
    badges.className = "badge-row";
    badges.appendChild(
      entry.type === "club"
        ? makeBadge("badge-club", "Storyclub")
        : makeBadge(
            "badge-folk",
            entry.type === "folk" ? "Folk night" : "Irish session",
          ),
    );
    if (club.price) {
      badges.appendChild(makeBadge("badge-price", club.price));
    }
    detail.appendChild(badges);
  } else if (entry.type === "festival") {
    const { fid, festival } = entry.data;
    const title = document.createElement("div");
    title.className = "event-row-title";
    title.textContent = festival.name;
    detail.appendChild(title);

    const endDate = parseDateString(festival.end_date);
    if (endDate && endDate.toDateString() !== entry.date.toDateString()) {
      const t = document.createElement("span");
      t.className = "event-row-time";
      t.textContent = `until ${formatShortDate(endDate)}`;
      detail.appendChild(t);
    }

    const badges = document.createElement("div");
    badges.className = "badge-row";
    badges.appendChild(makeBadge("badge-special", "Festival"));
    if (festival.ticket_url && !isPast) {
      const a = document.createElement("a");
      a.href = sanitizeUrl(festival.ticket_url) || "#";
      a.target = "_blank";
      a.className = "ticket-link";
      a.textContent = "Tickets";
      badges.appendChild(a);
    }
    detail.appendChild(badges);
  }

  row.appendChild(detail);
  container.appendChild(row);
  return row;
}


/**
 * Category used for "story-first, opt-in music/poetry/folk" filtering on
 * nearby/upcoming event listings (venues.js's own-venue and nearby-venue
 * lists; storyclub.js's nearby-clubs-and-events feature). "story" is the
 * always-on default bucket (storyclub nights, story walks, special/
 * repertoire storytelling shows, festivals); "music"/"poetry"/"folk" are
 * what an opt-in checkbox widens into. Irish sessions are bundled under
 * "folk" rather than given their own bucket, matching how the venue
 * page's own regular-club styling already groups them.
 */

function collectTourDatesForVenue(vid) {
  const tourDatesHere = [];
  Object.entries(toursLookup).forEach(([tourId, tour]) => {
    (tour.tour_dates || []).forEach((td) => {
      if (td.venue_id === vid) {
        tourDatesHere.push({ tour, tourId, tourDate: td });
      }
    });
  });
  return tourDatesHere;
}

function collectShowDatesForVenue(vid) {
  const showDatesHere = [];
  Object.entries(eventsData.repertoire_shows || {}).forEach(([tsId, ts]) => {
    (ts.show_dates || []).forEach((sd) => {
      if (sd.venue_id === vid) {
        showDatesHere.push({ ts, tsId, showDate: sd });
      }
    });
  });
  return showDatesHere;
}

/**
 * One-off DATED events (a single explicit date each) at a venue — tours,
 * repertoire shows/walks, specificEvents, musicEvents, poetryEvents,
 * festivals. Recurring club/folk/session nights have no single date of
 * their own and are NOT included here — see
 * collectRecurringEventsForVenue() below for those. Originally
 * venues.js-only; moved here (along with collectTourDatesForVenue()/
 * collectShowDatesForVenue() above, which this calls) as storyclub.js's
 * nearby-events feature is a second consumer.
 * @param {string} vid
 * @returns {{type: string, date: Date, data: object, category: string}[]}
 */
function collectDatedEventsForVenue(vid) {
  const specificEvents = (eventsData.specificEvents || []).filter(
    (e) => e.venue_id === vid,
  );
  const musicEvents = (eventsData.musicEvents || []).filter(
    (e) => e.venue_id === vid,
  );
  const poetryEvents = (eventsData.poetryEvents || []).filter(
    (e) => e.venue_id === vid,
  );
  const tourDatesHere = collectTourDatesForVenue(vid);
  const showDatesHere = collectShowDatesForVenue(vid);
  const festivalsHere = Object.entries(eventsData.festivals || {}).filter(
    ([, f]) => f.venue_id === vid,
  );

  return [
    ...specificEvents.map((e) => ({
      type: "specific",
      date: parseDateString(e.date),
      data: e,
      category: "story",
    })),
    ...musicEvents.map((e) => ({
      type: "music",
      date: parseDateString(e.date),
      data: e,
      category: "music",
    })),
    ...poetryEvents.map((e) => ({
      type: "poetry",
      date: parseDateString(e.date),
      data: e,
      category: "poetry",
    })),
    ...tourDatesHere.map((t) => ({
      type: "tour",
      date: parseDateString(t.tourDate.date),
      data: t,
      // Repertoire-derived synthetic tours set isMusic/isPoetry: false, so
      // this correctly falls through to "story" for those, same as a
      // genuine storytelling tour.
      category: t.tour.isMusic
        ? "music"
        : t.tour.isPoetry
          ? "poetry"
          : "story",
    })),
    ...showDatesHere.map((s) => ({
      type: "show",
      date: parseDateString(s.showDate.date),
      data: s,
      // Story walks stay in the "story" scope (not a separate opt-in
      // category) — entry.data.ts.isStoryWalk drives the badge, not this.
      category: "story",
    })),
    ...festivalsHere.map(([fid, f]) => ({
      type: "festival",
      date: parseDateString(f.start_date),
      data: { fid, festival: f },
      // Always in-scope regardless of the story/music/poetry/folk opt-ins —
      // mirrors event_display.js's getEventType(), which checks isFestival
      // before any other type and shows festivals unconditionally.
      category: "story",
    })),
  ]
    .filter((e) => e.date)
    .sort((a, b) => a.date - b.date);
}

/**
 * Recurring club/folk/session-night occurrences at a venue within
 * [from, to] — the recurring-schedule counterpart to
 * collectDatedEventsForVenue() above. Kept separate because a recurring
 * schedule has no natural end and needs an explicit window to expand
 * against, whereas the one-off collections above are naturally finite.
 *
 * Uses resolveClubVenueId() rather than a plain venue_id match, since a
 * club/folk-night/session alternating between two venues by month parity
 * isn't reliably at its base venue_id for every occurrence.
 * @param {string} vid
 * @param {Date} from
 * @param {Date} to
 * @returns {{type: string, date: Date, data: {club: object}, category: string}[]}
 */
function collectRecurringEventsForVenue(vid, from, to) {
  const out = [];
  const sources = [
    { list: eventsData.events || [], type: "club", category: "story" },
    { list: eventsData.folkNights || [], type: "folk", category: "folk" },
    {
      list: eventsData.irishSessions || [],
      type: "session",
      category: "folk",
    },
  ];

  sources.forEach(({ list, type, category }) => {
    list.forEach((rec) => {
      // Cheap pre-filter before bothering to expand a schedule at all.
      if (!couldBeAtVenue(rec, vid)) return;

      RecurrenceEngine.scheduledOccurrencesInRange(
        rec.schedule,
        from,
        to,
        rec.exceptions || [],
      ).forEach((occ) => {
        // "cancelled" isn't happening at all; "moved_from" is the
        // ORIGINAL date before a reschedule — only "scheduled" and
        // "moved_to" represent something really happening on occ.date.
        if (occ.status === "cancelled" || occ.status === "moved_from") return;
        if (resolveClubVenueId(rec, occ.date) !== vid) return;
        out.push({ type, date: occ.date, data: { club: rec }, category });
      });
    });
  });
  return out;
}

/**
 * Sanitize a flyer filename, stripping any characters that are not
 * alphanumeric, dots, underscores, or hyphens.
 * @param {string} filename
 * @returns {string}
 */
function sanitizeFlyerPath(filename) {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "");
}

/**
 * Regex matching a club flyer filename prefixed with an explicit date —
 * YYYY_MM_DD, e.g. "2026_07_26_loveshack-birds.jpg". Such a filename in a
 * recurring club's `flyers[]` list is a one-off/legacy flyer for that
 * specific date, rather than generic ongoing club artwork.
 */
const DATED_CLUB_FLYER_RE = /^(\d{4})_(\d{2})_(\d{2})(?:[_.-]|$)/;

/**
 * Parse a club flyer filename's YYYY_MM_DD date prefix, if it has one.
 * Used by event_display.js (to attach the flyer to the matching recurring
 * occurrence), flyers.html (to file it as a dated "story"
 * card instead of a generic always-on club card), storyclub.html
 * (to caption/grey it on the club's own page), and venues.html
 * (to grey it once past) — keep this the single implementation so the four
 * pages can't drift out of sync on what counts as a "dated" flyer.
 * @param {string} filename
 * @returns {Date|null}
 */
function parseDatedClubFlyer(filename) {
  const m = (filename || "").trim().match(DATED_CLUB_FLYER_RE);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const date = new Date(year, month - 1, day);
  // JS Date silently rolls over out-of-range values (e.g. month 13, day 40)
  // instead of producing an invalid date, so confirm it round-trips back to
  // the same y/m/d before trusting a hand-authored filename.
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

/**
 * Resolve all tour-level flyers for a tour into one normalized, ordered,
 * de-duplicated list. Three data shapes are supported and may all be
 * present on the same tour record:
 *   - `tour_flyer` (legacy): a single filename string.
 *   - `touring_event_flyer` (legacy, singular): another single-filename
 *     alias for the same idea, previously handled ad hoc in the flyers
 *     grid page only.
 *   - `touring_event_flyers` (current, plural): an array, where each
 *     entry is either a plain filename string, or an object such as
 *     `{ flyer: "poster.jpg", label: "2026 redesign" }`
 *     (also accepts `src`/`path`/`filename` and `caption`/`title` as
 *     aliases for `flyer`/`label`, to tolerate hand-authored data).
 *
 * Entries are ordered `tour_flyer`, then `touring_event_flyer`, then the
 * `touring_event_flyers` list, and de-duplicated by filename so listing
 * the same flyer under more than one field (e.g. during a migration)
 * doesn't produce a duplicate card/thumbnail.
 *
 * Used by both tour_display.js (tour guide page) and flyers.html
 * (flyers grid) — keep this the single implementation rather than copying it,
 * so the two pages can't drift out of sync with each other.
 *
 * @param {object} tour
 * @returns {{filename: string, label: string}[]}
 */
function getTourLevelFlyers(tour) {
  const out = [];
  const seen = new Set();

  function add(filename, customLabel) {
    const clean = (filename || "").trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    out.push({ filename: clean, label: customLabel || null });
  }

  if (tour.tour_flyer?.trim()) {
    add(tour.tour_flyer);
  }

  if (tour.touring_event_flyer?.trim()) {
    add(tour.touring_event_flyer);
  }

  if (Array.isArray(tour.touring_event_flyers)) {
    tour.touring_event_flyers.forEach((entry) => {
      if (typeof entry === "string") {
        add(entry);
      } else if (entry && typeof entry === "object") {
        const filename =
          entry.flyer || entry.src || entry.path || entry.filename;
        const label = entry.label || entry.caption || entry.title || null;
        add(filename, label);
      }
    });
  }

  // Fill in default labels: plain "Tour flyer" when it's the only one,
  // else numbered "Tour flyer 1", "Tour flyer 2", ... for any entry that
  // didn't come with its own label.
  out.forEach((f, i) => {
    if (!f.label)
      f.label = out.length > 1 ? `Tour flyer ${i + 1}` : "Tour flyer";
  });

  return out;
}

/**
 * Resolve all per-date/per-event flyers for a single tourDate, showDate,
 * specificEvent, musicEvent, poetryEvent, or festival record into one
 * normalized, ordered, de-duplicated list — the same shape/approach as
 * getTourLevelFlyers() above, but for an individual event/date rather
 * than a whole tour. Three data shapes are supported and may all be
 * present on the same record:
 *   - `event_flyer` (primary): a single filename string.
 *   - `event_flyer2` (legacy, specificEvents only — being phased out):
 *     a second filename string, previously the only way to give an event
 *     more than one flyer. Still read here for any old data that hasn't
 *     been migrated yet, but new data should use `event_flyers` instead.
 *   - `event_flyers` (current, plural): an array, where each entry is
 *     either a plain filename string, or an object such as
 *     `{ flyer: "poster.jpg", label: "Reprint" }` (also accepts
 *     `src`/`path`/`filename` and `caption`/`title` as aliases for
 *     `flyer`/`label`).
 *
 * Entries are ordered `event_flyer`, then `event_flyer2`, then the
 * `event_flyers` list, and de-duplicated by filename.
 *
 * @param {object} eventOrDate
 * @returns {{filename: string, label: string}[]}
 */
function getEventLevelFlyers(eventOrDate) {
  const out = [];
  const seen = new Set();

  function add(filename, customLabel) {
    const clean = (filename || "").trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    out.push({ filename: clean, label: customLabel || null });
  }

  if (eventOrDate?.event_flyer?.trim()) {
    add(eventOrDate.event_flyer);
  }

  if (eventOrDate?.event_flyer2?.trim()) {
    add(eventOrDate.event_flyer2);
  }

  if (Array.isArray(eventOrDate?.event_flyers)) {
    eventOrDate.event_flyers.forEach((entry) => {
      if (typeof entry === "string") {
        add(entry);
      } else if (entry && typeof entry === "object") {
        const filename =
          entry.flyer || entry.src || entry.path || entry.filename;
        const label = entry.label || entry.caption || entry.title || null;
        add(filename, label);
      }
    });
  }

  out.forEach((f, i) => {
    if (!f.label)
      f.label = out.length > 1 ? `Event flyer ${i + 1}` : "Event flyer";
  });

  return out;
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ---------------------------------------------------------------------------
// DOM / UI utilities
// ---------------------------------------------------------------------------

function simpleList(panel, items) {
  const list = el("div", "simple-list");
  items.forEach((item) => {
    const row = el("div", "simple-list-row");
    const nameEl = el("span", "");
    if (item.href) {
      const a = document.createElement("a");
      a.href = item.href;
      a.textContent = item.label;
      nameEl.appendChild(a);
    } else {
      nameEl.textContent = item.label;
    }
    row.appendChild(nameEl);
    if (item.meta !== undefined) {
      row.appendChild(el("span", "simple-list-meta", item.meta));
    }
    list.appendChild(row);
  });
  panel.appendChild(list);
}

function showNotFound() {
  document.getElementById("loadingState").style.display = "none";
  document.getElementById("notFoundState").style.display = "";
}

/**
 * Append a social/contact icon link to a container element.
 * Does nothing if the URL is absent or fails sanitization.
 * @param {HTMLElement} container
 * @param {'website'|'email'|'facebook'} type
 * @param {string} url
 */
function createIcon(container, type, url) {
  if (!url) return;
  const safeUrl = sanitizeUrl(url);
  if (!safeUrl) return;
  const link = document.createElement("a");
  link.href = safeUrl;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.className = `event-${type}`;
  link.title = String(type).charAt(0).toUpperCase() + String(type).slice(1);
  link.onclick = (e) => e.stopPropagation();
  link.innerHTML = ICON_SVG[type];
  container.appendChild(link);
}

/**
 * Append website, email, and Facebook icon links for a venue or event object.
 * Expects the object to have optional .url, .email, and .facebook properties.
 * @param {HTMLElement} container
 * @param {{ url?: string, email?: string, facebook?: string }} obj
 */
function appendContactIcons(container, obj) {
  if (obj.url) createIcon(container, "website", obj.url);
  if (obj.email) createIcon(container, "email", `mailto:${obj.email}`);
  if (obj.facebook)
    createIcon(container, "facebook", normaliseFacebookUrl(obj.facebook));
}

/**
 * Build a venue location div with an optional linked venue name,
 * remaining address text, and contact icons.
 * @param {{ url?: string, full_address?: string, name?: string, email?: string, facebook?: string }} venue
 * @returns {HTMLElement}
 */
function createVenueElement(venue) {
  const venueDiv = document.createElement("div");
  venueDiv.className = "event-location";

  const fullAddress = venue.full_address || venue.name || "";
  const commaIndex = fullAddress.indexOf(",");
  const venueName =
    commaIndex > 0 ? fullAddress.substring(0, commaIndex) : fullAddress;
  const remainder = commaIndex > 0 ? fullAddress.substring(commaIndex) : "";

  if (venue.url) {
    const strong = document.createElement("strong");
    strong.textContent = venueName;
    const venueLink = createExternalLink(venue.url, strong, {
      className: "venue-link",
    });
    if (venueLink) {
      venueDiv.appendChild(venueLink);
      if (remainder) venueDiv.appendChild(document.createTextNode(remainder));
    } else {
      venueDiv.textContent = fullAddress;
    }
  } else {
    venueDiv.textContent = fullAddress;
  }

  const iconsContainer = document.createElement("span");
  iconsContainer.className = "venue-icons";
  appendContactIcons(iconsContainer, venue);
  if (iconsContainer.hasChildNodes()) {
    venueDiv.appendChild(iconsContainer);
  }

  return venueDiv;
}

/**
 * Build a tickets/Facebook-event div for a special or music event.
 * Returns null if there is nothing to show.
 * @param {{ ticket_url?: string, fb_event?: string, tour_id?: string }} eventData
 * @param {boolean} [past=false]  - If true, ticket link text uses past tense.
 * @param {boolean} [soldOut=false] - If true, suppress the ticket link.
 * @returns {HTMLElement|null}
 */
function createTicketsElement(eventData, past = false, soldOut = false) {
  const { ticket_url, fb_event, tour_id } = eventData;
  if (!ticket_url && !fb_event && !tour_id) return null;

  const ticketsDiv = document.createElement("div");
  ticketsDiv.className = "event-tickets";

  const tourIdList = eventData.tour_ids || (tour_id ? [tour_id] : []);
  for (let i = 0; i < tourIdList.length; i++) {
    const tid = tourIdList[i];
    if (i > 0) {
      appendSeparator(ticketsDiv);
    }
    const tourName =
      typeof toursLookup !== "undefined" && toursLookup[tid]?.tour_name
        ? toursLookup[tid].tour_name
        : "TOUR";
    const tourLink = document.createElement("a");
    tourLink.href = `tour_guide.html?tour=${tid}`;
    tourLink.target = "_blank";
    tourLink.rel = "noopener noreferrer";
    tourLink.textContent = `VIEW: ${tourName}`;
    tourLink.className = "tour-link";
    tourLink.addEventListener("click", (e) => e.stopPropagation());
    ticketsDiv.appendChild(tourLink);
  }
  if (tourIdList.length > 0 && ticket_url && !soldOut) {
    appendSeparator(ticketsDiv);
  }

  if (ticket_url && !soldOut) {
    const safeUrl = sanitizeUrl(ticket_url);
    if (safeUrl) {
      const ticketLink = document.createElement("a");
      ticketLink.href = safeUrl;
      ticketLink.target = "_blank";
      ticketLink.rel = "noopener noreferrer";
      ticketLink.textContent = past
        ? "Tickets were available here"
        : "Tickets available here";
      ticketLink.addEventListener("click", (e) => e.stopPropagation());
      ticketsDiv.appendChild(ticketLink);
    }
  }

  if (fb_event) {
    const fbEventUrl = sanitizeUrl(
      `https://www.facebook.com/events/${fb_event}`,
    );
    if (fbEventUrl) {
      if (ticket_url || tourIdList.length > 0) {
        appendSeparator(ticketsDiv);
      }
      const fbLink = document.createElement("a");
      fbLink.href = fbEventUrl;
      fbLink.target = "_blank";
      fbLink.rel = "noopener noreferrer";
      fbLink.className = "event-facebook-inline";
      fbLink.title = "Facebook Event";
      fbLink.onclick = (e) => e.stopPropagation();
      fbLink.innerHTML = ICON_SVG.facebook;
      ticketsDiv.appendChild(fbLink);
    }
  }

  return ticketsDiv.children.length > 0 ? ticketsDiv : null;
}

// ---------------------------------------------------------------------------
// Map initialisation
// ---------------------------------------------------------------------------

/**
 * Initialise a Leaflet map centred on the UK, constrained to UK/Ireland bounds.
 * @param {string}   elementId   - The HTML element id for the map container.
 * @param {Function} onMoveEnd   - Callback fired on map 'moveend' events.
 * @returns {L.Map}
 */
function initMap(elementId, onMoveEnd) {
  const map = L.map(elementId, {
    maxBounds: UK_IRELAND_BOUNDS,
    maxBoundsViscosity: 1.0,
    minZoom: 5,
    maxZoom: 16,
  }).setView([53.0, -2.0], 6);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors",
  }).addTo(map);

  if (onMoveEnd) {
    map.on("moveend", onMoveEnd);
  }

  return map;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

/**
 * Auto-rolling cache-buster window for the fetch URL query param.
 * Within one time window, every page load requests the *same* URL, so the browser
 * (and GitHub Pages' edge cache) can serve it from cache instead of re-downloading
 * ~580KB every visit. After the window elapses, the URL changes.
 *
 * Note: This does NOT control the localStorage TTL. The localStorage cache now
 * persists indefinitely, with freshness determined by HTTP header checks
 * (Last-Modified/ETag) which run in the background.
 *
 * Tune to taste: 1 = hourly, 4 = every 4 hours, 24 = daily.
 */
const CACHE_BUCKET_HOURS = 24;

/**
 * Cache keys for localStorage. Centralized to avoid duplication.
 * @type {Object}
 */
const CACHE_KEYS = {
  DATA: "troubadours_events_data",
  HEADERS: "troubadours_events_headers",
  LAST_CHECK: "troubadours_events_last_check",
  SCHEDULES: "troubadours_schedules_cache",
};

/**
 * Outcome of the most recent loadEventsData() call, so the colophon's
 * status LED (see displayDataLastUpdated()) can reflect it:
 *   "ok"          — fresh data, from a valid cache or a successful fetch.
 *   "stale-cache" — the live feed failed (bad response or corrupt JSON),
 *                   but a previously cached copy existed and is being
 *                   shown instead.
 *   "error"       — the live feed failed and there was no cache to fall
 *                   back on; the page has no events data at all.
 */
let dataHealthStatus = { status: "ok", timestamp: null };

/**
 * Build the small "LED" status dot shown in the colophon next to the
 * "Data last updated" line. Just constructs the element — callers decide
 * where it goes.
 * @param {"ok"|"stale-cache"|"error"} status
 * @param {string} title - tooltip / accessible label text
 * @returns {HTMLSpanElement}
 */
function buildDataHealthLed(status, title) {
  const led = document.createElement("span");
  led.className = `data-health-led data-health-${status}`;
  led.title = title;
  led.setAttribute("role", "img");
  led.setAttribute("aria-label", title);
  return led;
}

/**
 * Cache duration for computed schedules (24 hours in milliseconds).
 * Schedules are deterministic based on the raw data, so they only need to
 * be recalculated if the data changes or 24 hours have passed.
 */
const SCHEDULE_CACHE_TTL = 24 * 60 * 60 * 1000;

/**
 * Flag to prevent concurrent background checks.
 * @type {boolean}
 */
let backgroundCheckInProgress = false;

/**
 * Returns a version string that stays constant for CACHE_BUCKET_HOURS at a
 * time, then changes. Used as the default cache-busting query param.
 * @returns {string}
 */
function getAutoCacheVersion() {
  const bucketMs = CACHE_BUCKET_HOURS * 60 * 60 * 1000;
  return Math.floor(Date.now() / bucketMs).toString();
}

/**
 * Build a human-readable diagnostic for a JSON.parse SyntaxError, since the
 * native error message's position isn't always easy to locate in a large file.
 * @param {string} text - The raw text that was passed to JSON.parse.
 * @param {SyntaxError} error - The error thrown by JSON.parse.
 * @returns {string} e.g. "Unexpected token } in JSON at position 123 (line 5, column 10): ...snippet..."
 */
function describeJsonParseError(text, error) {
  const positionMatch = /position (\d+)/.exec(error.message);
  if (!positionMatch) return error.message;

  const position = Number(positionMatch[1]);
  const before = text.slice(0, position);
  const line = (before.match(/\n/g) || []).length + 1;
  const column = position - before.lastIndexOf("\n");
  const snippet = text.slice(
    Math.max(0, position - 20),
    Math.min(text.length, position + 20),
  );

  return `${error.message} (line ${line}, column ${column}) near: "...${snippet}..."`;
}

/**
 * Fetch events_normalized.json and populate the three shared lookup objects.
 * Uses localStorage to cache data within the same session (browser tab/window).
 * This avoids re-downloading the ~580KB JSON when navigating between pages.
 *
 * Also checks HTTP headers (Last-Modified/ETag) in the background to detect
 * newer data on the server, and refreshes the cache if a newer version is found.
 * This happens silently without blocking the page load.
 *
 * Pass the returned eventsData and populated lookups back via the returned object.
 * @param {string|null} [cacheBuster]  - Optional version string or timestamp.
 *   Defaults to an auto-rolling version (see CACHE_BUCKET_HOURS) so normal page
 *   loads can be served from browser cache. Pass Date.now() (or similar) to force
 *   a genuinely fresh fetch from the network, e.g. from a manual "Refresh data" button.
 * @returns {Promise<{eventsData: object, venuesLookup: object, performersLookup: object, toursLookup: object}|null>}
 */
async function loadEventsData(cacheBuster) {
  try {
    // If a cacheBuster is provided, skip localStorage and force a fresh fetch
    if (!cacheBuster) {
      const cached = localStorage.getItem(CACHE_KEYS.DATA);
      if (cached) {
        try {
          let parsed;
          try {
            parsed = JSON.parse(cached);
          } catch (parseError) {
            throw new Error(
              `Cached events data is corrupted: ${describeJsonParseError(cached, parseError)}`,
            );
          }
          const { timestamp, data } = parsed;
          const { eventsData, venuesLookup, performersLookup, toursLookup } =
            data;
          applyRepertoireInheritance(eventsData);
          const podcastsLookup = buildPodcastsLookup(eventsData);
          console.log(`✓ Loaded events data from cache`);
          console.log(`  - ${Object.keys(venuesLookup).length} venues`);
          console.log(`  - ${Object.keys(performersLookup).length} performers`);
          console.log(`  - ${Object.keys(toursLookup).length} tours`);

          // Check for newer data on the server in the background (doesn't block)
          checkForNewerEventsDataBackground();

          dataHealthStatus = { status: "ok", timestamp };
          return {
            eventsData,
            venuesLookup,
            performersLookup,
            toursLookup,
            podcastsLookup,
            lastUpdateTime: timestamp,
          };
        } catch (e) {
          console.warn(`${e.message} — fetching fresh copy instead`);
          localStorage.removeItem(CACHE_KEYS.DATA);
        }
      }
    }

    // Fetch fresh data from network
    const version = cacheBuster || getAutoCacheVersion();
    const response = await fetch(`events_normalized.json?v=${version}`);
    if (!response.ok) {
      console.error("Failed to load events_normalized.json");
      return handleEventsLoadFailure();
    }
    const responseText = await response.text();
    let eventsData;
    try {
      eventsData = JSON.parse(responseText);
    } catch (parseError) {
      console.error(
        `events_normalized.json is corrupted: ${describeJsonParseError(responseText, parseError)}`,
      );
      return handleEventsLoadFailure();
    }
    applyRepertoireInheritance(eventsData);
    const toursLookup = eventsData.tours || {};
    const venuesLookup = eventsData.venues || {};
    const performersLookup = eventsData.performers || {};
    const podcastsLookup = buildPodcastsLookup(eventsData);

    // Cache the data and headers in localStorage for other pages to use
    const now = Date.now();
    try {
      localStorage.setItem(
        CACHE_KEYS.DATA,
        JSON.stringify({
          timestamp: now,
          data: { eventsData, venuesLookup, performersLookup, toursLookup },
        }),
      );

      // Store Last-Modified and ETag for future comparison
      localStorage.setItem(
        CACHE_KEYS.HEADERS,
        JSON.stringify({
          lastModified: response.headers.get("Last-Modified"),
          etag: response.headers.get("ETag"),
        }),
      );
    } catch (e) {
      console.warn("Failed to cache events data to localStorage", e);
    }

    console.log(`✓ Loaded events data from network`);
    console.log(`  - ${Object.keys(venuesLookup).length} venues`);
    console.log(`  - ${Object.keys(performersLookup).length} performers`);
    console.log(`  - ${Object.keys(toursLookup).length} tours`);

    dataHealthStatus = { status: "ok", timestamp: now };
    return {
      eventsData,
      venuesLookup,
      performersLookup,
      toursLookup,
      podcastsLookup,
      lastUpdateTime: now,
    };
  } catch (error) {
    console.error("Error loading events:", error);
    return handleEventsLoadFailure();
  }
}

/**
 * Called from every failure path inside loadEventsData() (bad response, a
 * live feed that failed to parse, or any other thrown error). Tries to
 * recover a previously cached copy so the site can keep working with
 * slightly stale data rather than showing nothing; sets dataHealthStatus
 * accordingly either way, and — since displayDataLastUpdated() is never
 * called by a page when loadEventsData() returns null — paints the
 * colophon's status LED directly for the no-cache-available case, as
 * that's the only place it would otherwise get shown.
 * @returns {object|null} same shape loadEventsData() normally returns, or
 *   null if there was no cache to fall back on either.
 */
function handleEventsLoadFailure() {
  try {
    const cached = localStorage.getItem(CACHE_KEYS.DATA);
    if (cached) {
      const { timestamp, data } = JSON.parse(cached);
      const { eventsData, venuesLookup, performersLookup, toursLookup } = data;
      applyRepertoireInheritance(eventsData);
      const podcastsLookup = buildPodcastsLookup(eventsData);
      console.warn(
        "⚠ Live events feed failed — falling back to stale cached data",
      );
      dataHealthStatus = { status: "stale-cache", timestamp };
      return {
        eventsData,
        venuesLookup,
        performersLookup,
        toursLookup,
        podcastsLookup,
        lastUpdateTime: timestamp,
      };
    }
  } catch (e) {
    console.warn("Stale-cache fallback also failed:", e);
  }

  dataHealthStatus = { status: "error", timestamp: null };
  renderDataHealthIndicatorNow();
  return null;
}

/**
 * Paints the colophon's status LED directly, for the one outcome
 * displayDataLastUpdated() never gets a chance to handle: the events feed
 * failed and there's no cache to fall back on, so the page never receives
 * a truthy `loaded` result and bails out before calling it.
 */
function renderDataHealthIndicatorNow() {
  const el = document.getElementById("dataLastUpdated");
  if (!el) return;
  el.innerHTML = "";
  el.appendChild(
    buildDataHealthLed(
      "error",
      "Event data feed failed to load and no cached copy is available",
    ),
  );
  const textSpan = document.createElement("span");
  textSpan.className = "data-updated-text";
  textSpan.textContent = "Event data unavailable";
  el.appendChild(textSpan);
}

/**
 * Build a lookup of the top-level `podcasts` registry (see events-schema.json
 * → $defs.podcast), keyed by podcast_id, for resolving
 * performer.podcast_appearances[].podcast_id references.
 * @param {object} eventsData
 * @returns {Object<string, object>}
 */
function buildPodcastsLookup(eventsData) {
  const podcasts = Array.isArray(eventsData?.podcasts)
    ? eventsData.podcasts
    : [];
  const lookup = {};
  podcasts.forEach((p) => {
    if (p?.podcast_id) lookup[p.podcast_id] = p;
  });
  return lookup;
}

/** True for undefined/null/""/[] — the "nothing set here" values a field
 * needs to have before inheritance is allowed to fill it in. */
function isBlankValue(v) {
  return (
    v === undefined ||
    v === null ||
    v === "" ||
    (Array.isArray(v) && v.length === 0)
  );
}

// Fields copied from a repertoire_shows entry onto a tour that references
// it via repertoire_id, when the tour doesn't set its own value. tour_
// description is handled separately below since it maps to a
// differently-named field (repertoire.description) rather than a same-
// name one.
const TOUR_REPERTOIRE_INHERITABLE_FIELDS = [
  "name",
  "showname",
  "performer_id",
  "performer_ids",
  "video_trailer",
  "touring_event_flyer",
];

/**
 * A tour that carries a repertoire_id (see events-schema.json →
 * $defs.tour.repertoire_id) is a touring run of a show already registered
 * in the top-level `repertoire_shows` — rather than repeat that show's
 * title, performer, description and video trailer on every tour, they can
 * be inherited from the repertoire_shows entry and only overridden where
 * the tour listing sets its own value. Mutates each tour in `eventsData`
 * in place, so this only needs to run once when the data is loaded —
 * every downstream consumer (tour page, calendar/search merges in
 * event_display.js, flyers, etc.) then just reads the tour's own fields
 * as normal. Safe to call more than once: a field that's already been
 * inherited looks identical to one set directly on the tour, so re-running
 * this is a no-op for it.
 * @param {object} eventsData
 */
function applyRepertoireInheritance(eventsData) {
  const tours = eventsData?.tours || {};
  const repertoireShows = eventsData?.repertoire_shows || {};

  Object.values(tours).forEach((tour) => {
    if (!tour?.repertoire_id) return;
    const rep = repertoireShows[tour.repertoire_id];
    if (!rep) {
      console.warn(
        `Tour "${tour.tour_name || tour.name}" references unknown repertoire_id: ${tour.repertoire_id}`,
      );
      return;
    }

    TOUR_REPERTOIRE_INHERITABLE_FIELDS.forEach((field) => {
      if (isBlankValue(tour[field]) && !isBlankValue(rep[field])) {
        tour[field] = rep[field];
      }
    });

    // Special case: tour_description <- repertoire.description (different
    // field names, so it can't go through the same-name loop above).
    if (isBlankValue(tour.tour_description) && !isBlankValue(rep.description)) {
      tour.tour_description = rep.description;
    }
  });
}

/**
 * Combine a per-date `description_prefix` (see events-schema.json →
 * $defs.tourDate.description_prefix / $defs.showDate.description_prefix)
 * with a tour/show's resolved description, in the paragraph-separated
 * shape appendParagraphs() expects — the prefix becomes its own leading
 * paragraph, not text merged into the description itself. If there's no
 * base description, the prefix is returned alone; if there's no prefix,
 * the description is returned unchanged.
 * @param {string|null|undefined} prefix
 * @param {string|null|undefined} description
 * @returns {string|null}
 */
function combineDescriptionWithPrefix(prefix, description) {
  const parts = [prefix, description].filter((p) => p && p.trim());
  return parts.length > 0 ? parts.join(PARAGRAPH_SEPARATOR) : null;
}

/**
 * Downgrades the colophon's status LED from green to orange when a
 * background check discovers the live feed is unreachable or serving bad
 * data, even though the page is still working fine from a cached copy
 * (that's what makes it "stale-cache" rather than "error" — see
 * dataHealthStatus above). By the time this runs, displayDataLastUpdated()
 * has usually already painted the LED green, so this dispatches
 * "eventsDataHealthChanged" for it to pick up and update in place.
 * @param {string} reason - short human-readable explanation, used in the tooltip
 */
function flagBackgroundFeedDegraded(reason) {
  if (dataHealthStatus.status !== "ok") return; // already reflects a problem
  dataHealthStatus = { ...dataHealthStatus, status: "stale-cache", reason };
  window.dispatchEvent(
    new CustomEvent("eventsDataHealthChanged", {
      detail: { status: "stale-cache", reason },
    }),
  );
}

/**
 * Background check for newer events data on the server using HTTP HEAD request.
 * If a newer version is found (based on Last-Modified or ETag), silently
 * updates the cache. This doesn't block the page or show any UI.
 * Called automatically when loading from cache.
 */
async function checkForNewerEventsDataBackground() {
  try {
    const CACHE_HEADERS_KEY = "troubadours_events_headers";
    const cachedHeaders = JSON.parse(
      localStorage.getItem(CACHE_HEADERS_KEY) || "{}",
    );

    // Do a HEAD request to check the server headers without downloading the body
    const headResponse = await fetch("events_normalized.json", {
      method: "HEAD",
    });
    if (!headResponse.ok) {
      flagBackgroundFeedDegraded(
        `Live feed returned ${headResponse.status} on a background check`,
      );
      return;
    }

    const serverLastModified = headResponse.headers.get("Last-Modified");
    const serverEtag = headResponse.headers.get("ETag");

    let needsRefresh = false;

    // Check if server has a newer Last-Modified date
    if (serverLastModified && cachedHeaders.lastModified) {
      const serverDate = new Date(serverLastModified);
      const cachedDate = new Date(cachedHeaders.lastModified);
      if (serverDate > cachedDate) {
        needsRefresh = true;
        console.log(
          "Newer events data detected on server (Last-Modified header)",
        );
      }
    }

    // Check if ETag changed (file content differs)
    if (serverEtag && cachedHeaders.etag && serverEtag !== cachedHeaders.etag) {
      needsRefresh = true;
      console.log("Events data changed on server (ETag differs)");
    }

    // If there's a newer version, fetch and update cache silently
    if (needsRefresh) {
      const response = await fetch(`events_normalized.json?v=${Date.now()}`);
      if (!response.ok) {
        flagBackgroundFeedDegraded(
          `Live feed returned ${response.status} while fetching an update`,
        );
        return;
      }
      const responseText = await response.text();
      let eventsData;
      try {
        eventsData = JSON.parse(responseText);
      } catch (parseError) {
        console.error(
          `DATA LOADING ERROR: fetched events data was corrupted, keeping existing cached data: ${describeJsonParseError(responseText, parseError)}`,
        );
        flagBackgroundFeedDegraded(
          "Live feed is currently returning corrupted data",
        );
        return;
      }
      applyRepertoireInheritance(eventsData);
      const toursLookup = eventsData.tours || {};
      const venuesLookup = eventsData.venues || {};
      const performersLookup = eventsData.performers || {};
      const newTimestamp = Date.now();

      localStorage.setItem(
        CACHE_KEYS.DATA,
        JSON.stringify({
          timestamp: newTimestamp,
          data: { eventsData, venuesLookup, performersLookup, toursLookup },
        }),
      );

      localStorage.setItem(
        CACHE_KEYS.HEADERS,
        JSON.stringify({
          lastModified: response.headers.get("Last-Modified"),
          etag: response.headers.get("ETag"),
        }),
      );

      // Clear schedule cache since the data has changed
      clearSchedulesCache();

      console.log("✓ Background update: refreshed cached events data");

      // Dispatch event so pages can show a notification
      window.dispatchEvent(
        new CustomEvent("eventsDataUpdated", {
          detail: { timestamp: newTimestamp },
        }),
      );
    }
  } catch (e) {
    // Network-level failure reaching the feed at all (offline, DNS, CORS,
    // etc). The page is still working fine from cache, so flag it as
    // orange rather than leaving the LED silently green.
    flagBackgroundFeedDegraded("Could not reach the live events feed");
    console.debug(
      "Background events data check failed (this is fine):",
      e.message,
    );
  }
}

// ---------------------------------------------------------------------------
// Troupe helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if this performer record is a troupe configuration
 * (i.e. one specific lineup of a parent troupe) rather than a
 * standalone performer or the troupe itself.
 * Troupe configs carry a "troupe" field pointing to their parent.
 */
function isTroupeConfig(performer) {
  return !!(performer && performer.troupe);
}

/**
 * Returns true if this performer record is a troupe (the parent).
 */
function isTroupe(performer) {
  return !!(performer && performer.type === "troupe");
}

/**
 * Resolve a performer ID to its display record.
 * If the ID belongs to a troupe configuration (has a "troupe" field),
 * return the parent troupe record instead, so names and URLs are shown
 * as the troupe rather than the specific lineup config.
 * Falls back to the original record if the parent isn't found.
 *
 * @param {string} id
 * @param {object} performersLookup
 * @returns {{ id, record }} — resolved id and performer record
 */
function resolvePerformerDisplay(id, performersLookup) {
  if (!id || !performersLookup) return { id, record: null };
  const record = performersLookup[id];
  if (!record) return { id, record: null };
  if (isTroupeConfig(record) && record.troupe) {
    const parentRecord = performersLookup[record.troupe];
    if (parentRecord) return { id: record.troupe, record: parentRecord };
  }
  return { id, record };
}

// ---------------------------------------------------------------------------
// Map utilities
// ---------------------------------------------------------------------------

/**
 * Remove all markers from the map and return an empty array.
 * Replaces the repeated: markers.forEach(m => map.removeLayer(m)); markers = [];
 * @param {L.Map} map
 * @param {L.CircleMarker[]} markersArray
 * @returns {[]}  Always returns an empty array to reassign the variable.
 */
function clearMarkers(map, markersArray) {
  markersArray.forEach((marker) => map.removeLayer(marker));
  return [];
}

// ---------------------------------------------------------------------------
// Badge creation and formatting
// ---------------------------------------------------------------------------

function createBadge(text) {
  const badge = document.createElement("span");
  badge.className = "event-badge";
  badge.textContent = text;
  return badge;
}

/**
 * Build one "badge badge-<variant>" <span> — the "create element, set
 * class, set text" pattern repeated ~25 times across renderEventRow()
 * and performers.js. Distinct from createBadge() above, which always
 * uses the single fixed "event-badge" class (the calendar card-header
 * badge) rather than a variant + the shared .badge/.badge-row styling
 * used everywhere else. Caller appends the result wherever needed
 * (usually to a .badge-row container).
 * @param {string} variantClass - e.g. "badge-music", "badge-price" (the
 *   base "badge" class is added automatically, don't include it)
 * @param {string} text
 * @returns {HTMLSpanElement}
 */
function makeBadge(variantClass, text) {
  const b = document.createElement("span");
  b.className = `badge ${variantClass}`;
  b.textContent = text;
  return b;
}

/**
 * Create an anchor element pointing to an external URL.
 * Returns null if the URL fails sanitization.
 * @param {string} href          - Raw URL (will be sanitized).
 * @param {string|Node} content  - Text content or DOM node for the link.
 * @param {{ className?: string, title?: string, rel?: string, style?: string }} [options]
 * @returns {HTMLAnchorElement|null}
 */
function createExternalLink(href, content, options = {}) {
  const safeUrl = sanitizeUrl(href);
  if (!safeUrl) return null;
  const link = document.createElement("a");
  link.href = safeUrl;
  link.target = "_blank";
  link.rel = options.rel || "noopener noreferrer";
  if (options.className) link.className = options.className;
  if (options.title) link.title = options.title;
  if (options.style) link.style.cssText = options.style;
  if (typeof content === "string") {
    link.textContent = content;
  } else {
    link.appendChild(content);
  }
  link.addEventListener("click", (e) => e.stopPropagation());
  return link;
}

// ---------------------------------------------------------------------------
// Text formatting
// ---------------------------------------------------------------------------

function appendParagraphs(container, text) {
  const paragraphs = text.split(PARAGRAPH_SEPARATOR);
  paragraphs.forEach((p) => {
    if (p.trim()) {
      const pElem = document.createElement("p");
      pElem.textContent = p.replace(/\n\n/g, "\n");
      container.appendChild(pElem);
    }
  });
}

function capitalise(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : "";
}

// ---------------------------------------------------------------------------
// Date-range iteration
// ---------------------------------------------------------------------------

/**
 * Iterate a collection of objects that each have a `.date` field (DD/MM/YYYY
 * string, or an array of DD/MM/YYYY strings), calling
 * `callback(item, parsedDate)` for each date that falls within
 * [startDate, endDate] inclusive.  When `.date` is an array each element is
 * treated as a separate occurrence; a shallow clone of the item is passed to
 * the callback with `.date` set to that single string so downstream code sees
 * the same shape as a normal single-date item.
 *
 * Items with a missing or malformed date are skipped with a console.warn.
 *
 * The callback may be async; iteration is sequential (each callback is awaited
 * before moving to the next item), preserving the same ordering behaviour as
 * the original for-loops this replaces.
 *
 * Usage — display path (no search filter):
 *
 *   await forEachDateInRange(
 *     tour.tour_dates, startDate, endDate,
 *     `tour event in ${tour.name}`,
 *     async (tourDate, eventDate) => {
 *       const merged = buildTourMergedEvent(tour, tourKey, tourDate);
 *       const eventData = createEventData(merged, eventDate, eventType);
 *       allEventsData.push(eventData);
 *       await addMarkerForEvent(eventData);
 *     }
 *   );
 *
 * Usage — search path (guard inside callback, silent skip on no-match):
 *
 *   await forEachDateInRange(
 *     eventsData.specificEvents, today, futureDate,
 *     "specific event",
 *     async (event, eventDate) => {
 *       if (!buildEventSearchText(event).includes(searchTerm)) return;
 *       const eventData = createEventData(event, eventDate, "special");
 *       allEventsData.push(eventData);
 *       await addMarkerForEvent(eventData);
 *     }
 *   );
 *
 * NOTE — known limitation of searchRecurringEvents (not introduced here):
 * That function matches recurring events on event.name, event.location, and
 * event.club. However, recurring events store their venue via venue_id rather
 * than a flat .location field, so venue-name searches will only hit events
 * that happen to have a raw .location value in the data. This pre-dates
 * forEachDateInRange and is unchanged by it; fixing it requires resolving the
 * venue name from venuesLookup inside the search text builder, which is a
 * broader refactor of searchRecurringEvents.
 *
 * @param {object[]|null|undefined} items     - Array of objects with a .date string or string[].
 * @param {Date}                    startDate - Range start (inclusive).
 * @param {Date}                    endDate   - Range end (inclusive).
 * @param {string}                  label     - Used in warning messages, e.g. "tour event in My Tour".
 * @param {Function}                callback  - Called as callback(item, parsedDate). May be async.
 * @returns {Promise<void>}
 */
async function forEachDateInRange(items, startDate, endDate, label, callback) {
  for (const item of items ?? []) {
    if (!item.date) {
      console.warn(`Missing date for ${label}:`, item);
      continue;
    }

    // Normalise: date may be a single string or an array of strings.
    const dateField = item.date;
    const dateStrings = Array.isArray(dateField) ? dateField : [dateField];

    for (const dateStr of dateStrings) {
      const parsed = parseDateString(dateStr);
      if (!parsed) {
        console.warn(`Invalid date format for ${label}:`, item);
        continue;
      }
      if (parsed >= startDate && parsed <= endDate) {
        // When expanding a multi-date item, give the callback a clone with the
        // resolved single date string so it looks like a normal single-date item.
        const resolvedItem = Array.isArray(dateField)
          ? { ...item, date: dateStr }
          : item;
        await callback(resolvedItem, parsed);
      }
    }
  }
}

/**
 * Expand a tour_dates array so that any entry whose `.date` is an array of
 * DD/MM/YYYY strings (e.g. several nights at the same venue) becomes
 * multiple entries, each with `.date` set to a single string. Entries that
 * already have a single string date are passed through unchanged.
 *
 * This lets tour pages accept the same `"date": ["21/01/2026", "22/01/2026"]`
 * shorthand that the event/calendar listing already supports via
 * forEachDateInRange(), without having to touch every call site that reads
 * tour.tour_dates directly (sorting, status, map markers, etc.) — they can
 * just call expandTourDates(tour.tour_dates) once up front instead.
 *
 * @param {object[]|null|undefined} tourDates - Raw tour_dates array.
 * @returns {object[]} Flat array with one single-date entry per occurrence.
 */
function expandTourDates(tourDates) {
  const expanded = [];
  for (const item of tourDates ?? []) {
    if (!item.date) {
      expanded.push(item); // keep as-is; downstream code already warns on missing date
      continue;
    }
    const dateField = item.date;
    if (Array.isArray(dateField)) {
      dateField.forEach((dateStr) => expanded.push({ ...item, date: dateStr }));
    } else {
      expanded.push(item);
    }
  }
  return expanded;
}

// ---------------------------------------------------------------------------
// Performance type classification (story / music / poetry / troupe)
// Single source of truth for the colours and story/music/poetry precedence
// used across the events calendar, tours, performers, venues, and flyers
// pages, so a colour or classification rule only needs updating in one
// place. Per-page filter button LABELS (e.g. "Storytellers" vs "Story" vs
// "Stories & Spoken Word") are deliberately NOT centralised here, since
// each page's phrasing is contextual — only the keys and colours are.
// ---------------------------------------------------------------------------

/**
 * Fill colour per performance type. Matches the CSS custom properties of
 * the same name (--color-story etc.) defined in shared-styles.css — keep
 * both in sync if a colour changes.
 * @type {Object.<string,string>}
 */
const PERFORMANCE_TYPE_COLOURS = {
  story: "#2e7d32",
  music: "#443cd7",
  poetry: "#d6006e",
  troupe: "#795548",
};

/**
 * Classifies a tour or one-off event as "music", "poetry", or "story"
 * based on its isMusic/isPoetry flags. Defaults to "story" — both because
 * that's the fallback if neither flag is set, and because it's the
 * sensible default for an entity with no classification data at all
 * (e.g. a newly-added performer with no appearances listed yet).
 * @param {{isMusic?: boolean, isPoetry?: boolean}} entity
 * @returns {"music"|"poetry"|"story"}
 */
function classifyPerformanceType(entity) {
  if (entity && entity.isMusic) return "music";
  if (entity && entity.isPoetry) return "poetry";
  return "story";
}

// ---------------------------------------------------------------------------
// Lazy image loading (data-src / IntersectionObserver)
// Single shared implementation for the flyers page, tour flyer galleries,
// and performer flyer galleries — previously three separate hand-rolled
// copies with inconsistent behaviour (only one had error handling).
//
// Resolved images are cached by URL for the lifetime of the page, so an
// image that's already been loaded (or already failed) elsewhere on the
// same page — e.g. the same flyer file reappearing after toggling a
// filter off and back on, or across several tour dates that share one
// flyer — resolves instantly instead of re-running the lazy-load/
// IntersectionObserver dance from scratch.
// ---------------------------------------------------------------------------

const _lazyImageCache = new Map(); // resolved url -> "loaded" | "error"

function _applyLazyImageResult(img, url, result, opts) {
  const wrap = opts.wrapSelector ? img.closest(opts.wrapSelector) : null;
  if (result === "error") {
    if (wrap) {
      wrap.innerHTML = `<div class="${opts.errorClass}">${opts.errorMessage}</div>`;
    } else {
      img.alt = opts.errorMessage.replace(/<br\s*\/?>/gi, " ");
    }
    return;
  }
  img.src = url;
  img.removeAttribute(opts.srcAttr);
  img.classList.add(opts.revealedClass);
  wrap?.classList.add(opts.loadedClass);
}

function _resolveLazyImage(img, opts) {
  const url = img.dataset[opts.srcDataKey];
  if (!url) return;

  const cached = _lazyImageCache.get(url);
  if (cached) {
    _applyLazyImageResult(img, url, cached, opts);
    return;
  }

  img.addEventListener(
    "load",
    () => {
      _lazyImageCache.set(url, "loaded");
      _applyLazyImageResult(img, url, "loaded", opts);
    },
    { once: true },
  );
  img.addEventListener(
    "error",
    () => {
      _lazyImageCache.set(url, "error");
      _applyLazyImageResult(img, url, "error", opts);
    },
    { once: true },
  );
  img.src = url;
  img.removeAttribute(opts.srcAttr);
}

/**
 * Creates a shared IntersectionObserver for lazy-loading `data-src` (or a
 * custom data attribute) images.
 *
 * @param {object} [options]
 * @param {string} [options.rootMargin="250px 0px"] - how far ahead of the
 *   viewport to start loading.
 * @param {string} [options.srcAttribute="src"] - the data-* attribute
 *   holding the real image URL, e.g. "src" reads `data-src`, "pfSrc" reads
 *   `data-pf-src`.
 * @param {string} [options.wrapSelector=null] - optional ancestor selector
 *   (via closest()) that gets a "loaded" class added on success, and has
 *   its content replaced with an error message on failure. If omitted, the
 *   <img>'s alt text is used for the error message instead.
 * @param {string} [options.revealedClass="revealed"] - class added to the
 *   <img> itself once its src is set (for a CSS fade-in transition).
 * @param {string} [options.loadedClass="loaded"] - class added to the
 *   wrapSelector match once loaded.
 * @param {string} [options.errorClass="img-error"] - class on the injected
 *   error message element.
 * @param {string} [options.errorMessage="Image not available"] - error
 *   message shown when the image fails to load.
 * @returns {{observe: (img: HTMLImageElement) => void}}
 */
function createLazyImageLoader(options = {}) {
  const opts = {
    rootMargin: "250px 0px",
    srcAttribute: "src",
    wrapSelector: null,
    revealedClass: "revealed",
    loadedClass: "loaded",
    errorClass: "img-error",
    errorMessage: "Image not available",
    ...options,
  };
  opts.srcAttr =
    "data-" + opts.srcAttribute.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
  opts.srcDataKey = opts.srcAttribute;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        _resolveLazyImage(entry.target, opts);
      });
    },
    { rootMargin: opts.rootMargin },
  );

  // Parses the rootMargin's px value (e.g. "250px 0px" -> 250) for the
  // requestAnimationFrame fallback check below.
  const marginPx = parseInt(opts.rootMargin, 10) || 0;

  function observe(img) {
    if (!img.dataset[opts.srcDataKey]) return;
    observer.observe(img);
    // Safety net: IntersectionObserver's initial callback for an element
    // that's already on-screen at the moment observe() is called should
    // fire promptly, but when many images are created and appended in the
    // same synchronous batch (e.g. right after a filter change rebuilds
    // an entire grid), callback delivery has been observed to be missed
    // or significantly delayed in practice. This double-checks geometry
    // on the next frame and force-resolves if the observer hasn't
    // already done so.
    requestAnimationFrame(() => {
      if (!img.dataset[opts.srcDataKey]) return; // already resolved
      const rect = img.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight;
      const vw = window.innerWidth || document.documentElement.clientWidth;
      const nearViewport =
        rect.bottom > -marginPx &&
        rect.top < vh + marginPx &&
        rect.right > -marginPx &&
        rect.left < vw + marginPx;
      if (nearViewport) {
        observer.unobserve(img);
        _resolveLazyImage(img, opts);
      }
    });
  }

  return { observe };
}

// ---------------------------------------------------------------------------
// Venue type classification
// ---------------------------------------------------------------------------

/**
 * Canonical display order for venue types.
 * @type {string[]}
 */
const VTYPE_ORDER = [
  "Pub / bar / café",
  "Village / community hall",
  "Arts centre / venue",
  "Theatre",
  "Church / faith venue",
  "Museum / historic",
  "Barn / rural / outdoor",
  "Online",
  "Other / unknown",
];

/**
 * Fill colour per venue type, used for map markers and legend swatches.
 * @type {Object.<string,string>}
 */
const VTYPE_COLOURS = {
  "Pub / bar / café": "#795548",
  "Village / community hall": "#00796b",
  "Arts centre / venue": "#443cd7",
  Theatre: "#c62828",
  "Church / faith venue": "#e8a020",
  "Museum / historic": "#546e7a",
  "Barn / rural / outdoor": "#2e7d32",
  Online: "#888",
  "Other / unknown": "#bbb",
};

/**
 * Infer a venue type label from the venue name string.
 * Returns one of the keys in VTYPE_ORDER.
 * @param {string} name
 * @returns {string}
 */
function classifyVenueType(name) {
  if (!name) return "Other / unknown";
  const n = name.toLowerCase();
  if (
    /village hall|memorial hall|parish hall|community hall|town hall|assembly room|public hall|welfare hall|memorial institute|parish room|working men|community centre|community center|bowling club|\binstitute\b|kingsley hall|lowther parish|mcgrigor hall|public rooms|pullens centre|imperial rooms|adastra hall|david hall|alexander centre|three villages hall|mushroom hall|torriano meeting|folk preservation|joinery|malt cross|liskeard|folk of gloucester|old customs house|ventnor british legion|bolton socialist|\bnewstead\b|scout hut/.test(
      n,
    )
  )
    return "Village / community hall";
  if (
    /church hall|church room|\bchurch\b|st\.\s|saint\s|\bpriory\b|\bchapel\b|quaker|salvation army|buddhist|assumption|our lady|st john|st peter|st mary|st nicholas|st anne|st lawrence|meeting house/.test(
      n,
    )
  )
    return "Church / faith venue";
  if (
    /\btheatre\b|\btheater\b|playhouse|lyric\b|wardrobe|backyard theatre|front room theatre|omnibus|storyhouse|unicorn|dragon|torch|palace theatre|borough theatre|alphabetti|capstone|cygnet|knutsford little|lantern|georgian|\bcube\b|burton taylor|prohibition recording|palladium club/.test(
      n,
    )
  )
    return "Theatre";
  if (
    /arts cent|art cent|arts centr|artcentre|centre for the arts|arts center|llanover|pontardawe|ropetackle|exeter phoenix|chapter arts|quay arts|pound arts|bureau|wycombe|barnoldswick|gregson|moor imagination|riverfront|cambridge junction|john peel centre|ruskin mill|ffwrnes|theatr clwyd|royal welsh college|university|making space|st anne.s arts|rougemont|corn exchange|yellow book|october books|riff factory|spin the black|portico|next door at|\bstudio\b/.test(
      n,
    )
  )
    return "Arts centre / venue";
  if (
    /\bpub\b|tavern|\binn\b|\barms\b|\btap\b|brewery|\bbar\b|\bale house\b|the fleece|brunswick|britons|half moon|station pub|black swan|fountain inn|dove st|locks inn|three swans|stubbing|dairyman|portland arms|porter club|rat and ratchet|duke william|embankment|castle tap|castle inn|bodega|star coffee|temperance|chillingham|the hoops|the grove|the victoria|waverley|hop sun|ropemakers|bear club|hop inn|foxtails|bargeman|alder\b|hearth\b|the fold|the elm tree|katie fitzgerald|chagford inn|ship inn|the acorn|joiners|love shack|\byes\b|department\b|lock 91|cafe|coffee|kitchen garden|merlin|carvel lane|foremans|travellers joy|fat cat|nelly|angels cut|ltb showroom|stables at the bull|snapdragons|avalon|calverts|hotel indigo|swiss cottage|micklethwait|better days|b side|cwrw|\bsocial club\b|crown.*sceptre/.test(
      n,
    )
  )
    return "Pub / bar / café";
  if (
    /museum|library|guildhall|roman villa|darwin house|physic garden|dr johnson|food museum|haslemere museum|story museum|the hold\b/.test(
      n,
    )
  )
    return "Museum / historic";
  if (
    /\bbarn\b|farm|retreat|vineyard|earthhouse|ancient farm|harta|caddaford|circle barn|arty barn|old stables|rectory|plot 9|cranborne|wroot|the big retreat|dart music festival|gibraltar/.test(
      n,
    )
  )
    return "Barn / rural / outdoor";
  if (/online/.test(n)) return "Online";
  return "Other / unknown";
}

// ---------------------------------------------------------------------------
// Collapsible map
// ---------------------------------------------------------------------------

/**
 * Build and append a lazy-initialised collapsible map inside a <details> element.
 *
 * The map is only created the first time the user opens the panel, avoiding a
 * Leaflet layout bug where tiles don't render correctly in a hidden container.
 *
 * @param {HTMLElement} container       - Parent element to append the toggle to.
 * @param {string}      mapDivId        - Unique id for the inner map div (must be page-unique).
 * @param {string}      labelText       - Text shown in the summary, e.g. "Show map of all venues".
 * @param {number}      [mapHeight=400] - Height of the map div in px.
 * @param {Function}    onInit          - Called once with the initialised L.Map instance.
 *                                        Add markers / layers here.
 * @param {Function}    [loadMapLibrary] - Optional async function that loads
 *                                        Leaflet before the map is created.
 * @returns {{ details: HTMLElement, map: L.Map|null }}
 *   `details` is the <details> element (appended to container).
 *   `map` starts null and is populated after the first open.
 */
function createCollapsibleMap(
  container,
  mapDivId,
  labelText,
  mapHeight,
  onInit,
  loadMapLibrary,
) {
  if (mapHeight == null) mapHeight = 400;

  const mapToggle = document.createElement("details");
  mapToggle.className = "dir-card";

  const mapSummary = document.createElement("summary");
  mapSummary.className = "dir-map-summary";
  mapSummary.textContent = "\uD83D\uDDFA " + labelText;
  mapToggle.appendChild(mapSummary);

  const mapDiv = document.createElement("div");
  mapDiv.id = mapDivId;
  mapDiv.className = "dir-map-div";
  mapDiv.style.height = mapHeight + "px";
  mapToggle.appendChild(mapDiv);

  container.appendChild(mapToggle);

  const handle = { details: mapToggle, map: null };
  let mapInitialised = false;
  let mapInitialising = false;

  const openLabel = "\uD83D\uDDFA Hide map";
  const closeLabel = "\uD83D\uDDFA " + labelText;

  mapToggle.addEventListener("toggle", async () => {
    if (mapToggle.open && !mapInitialised && !mapInitialising) {
      mapInitialising = true;
      mapSummary.textContent = "Loading map...";
      try {
        await loadMapLibrary?.();
        if (!mapToggle.open) return;
        handle.map = initMap(mapDivId, null);
        mapInitialised = true;
        // invalidateSize must be called after the container becomes visible;
        // without it Leaflet measures a 0×0 box and only renders a tiny tile region,
        // causing most markers to be silently dropped.
        handle.map.invalidateSize();
        onInit(handle.map);
      } catch (error) {
        console.error("Failed to load map library:", error);
        mapDiv.textContent = "Map unavailable.";
      } finally {
        mapInitialising = false;
      }
    }
    mapSummary.textContent = mapToggle.open ? openLabel : closeLabel;
  });

  return handle;
}

// ---------------------------------------------------------------------------
// Search box with autocomplete dropdown
// ---------------------------------------------------------------------------

/**
 * Build and append a search input with a live autocomplete dropdown.
 *
 * The caller supplies:
 *   - a search function that receives the lowercased term and returns an array
 *     of result objects (max results should be applied inside the function),
 *   - a renderer that turns one result object into a populated <div> item
 *     (the div will receive the shared CSS classes automatically),
 *   - an onSelect callback fired when the user clicks a suggestion,
 *   - an onChange callback fired on every keystroke (for re-filtering the list).
 *
 * The clear button, dropdown show/hide, blur/focus wiring, and hover styling
 * are all handled here; callers never touch those.
 *
 * @param {HTMLElement} container
 * @param {{
 *   placeholder: string,
 *   search:    (term: string) => object[],
 *   renderItem: (result: object) => HTMLElement,
 *   onSelect:  (result: object, searchInput: HTMLInputElement, clearBtn: HTMLButtonElement, dropdown: HTMLElement) => void,
 *   onChange:  (term: string) => void
 * }} options
 * @returns {{ wrap: HTMLElement, input: HTMLInputElement, clearBtn: HTMLButtonElement, dropdown: HTMLElement }}
 */
function createSearchBox(container, options) {
  const { placeholder, search, renderItem, onSelect, onChange } = options;

  const searchWrap = document.createElement("div");
  searchWrap.className = "dir-search-wrap";

  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.placeholder = placeholder;
  searchInput.className = "dir-search-input";

  const clearBtn = document.createElement("button");
  clearBtn.textContent = "\u2715";
  clearBtn.title = "Clear search";
  clearBtn.className = "dir-search-clear";
  clearBtn.style.display = "none";

  const dropdown = document.createElement("div");
  dropdown.className = "dir-search-dropdown";
  dropdown.style.display = "none";

  clearBtn.addEventListener("click", () => {
    searchInput.value = "";
    clearBtn.style.display = "none";
    dropdown.style.display = "none";
    dropdown.innerHTML = "";
    onChange("");
  });

  searchInput.addEventListener("input", () => {
    const term = searchInput.value.trim();
    clearBtn.style.display = term ? "block" : "none";
    dropdown.innerHTML = "";

    if (term.length >= 1) {
      const results = search(term.toLowerCase());
      if (results.length > 0) {
        results.forEach((result) => {
          const item = renderItem(result);
          item.classList.add("dir-search-dropdown-item");
          item.addEventListener("mousedown", (e) => {
            e.preventDefault();
            onSelect(result, searchInput, clearBtn, dropdown);
          });
          dropdown.appendChild(item);
        });
        dropdown.style.display = "block";
      } else {
        dropdown.style.display = "none";
      }
    } else {
      dropdown.style.display = "none";
    }
    onChange(term);
  });

  searchInput.addEventListener("blur", () => {
    setTimeout(() => {
      dropdown.style.display = "none";
    }, 150);
  });
  searchInput.addEventListener("focus", () => {
    if (dropdown.children.length) dropdown.style.display = "block";
  });

  searchWrap.appendChild(searchInput);
  searchWrap.appendChild(clearBtn);
  searchWrap.appendChild(dropdown);
  container.appendChild(searchWrap);

  return { wrap: searchWrap, input: searchInput, clearBtn, dropdown };
}

// ---------------------------------------------------------------------------
// Navigation feedback
// ---------------------------------------------------------------------------

/**
 * Initialize navigation feedback: adds visual indication when nav links are clicked.
 * Shows body opacity change and adds a loading indicator to the clicked link.
 * Also automatically cleans up the dimming effect when the page fully loads.
 * Call this once on page load, typically from your page's main script.
 * Requires CSS classes: .nav-loading, .nav-link-pending (add to shared-styles.css).
 */
function initNavFeedback() {
  const navLinks = document.querySelectorAll(".site-nav a[href]");

  // Clean up any lingering nav-loading class from previous navigation
  document.body.classList.remove("nav-loading");
  navLinks.forEach((link) => link.classList.remove("nav-link-pending"));

  navLinks.forEach((link) => {
    link.addEventListener("click", (e) => {
      // Don't add feedback if this is the current page link or has aria-current
      if (link.hasAttribute("aria-current")) {
        e.preventDefault();
        return;
      }

      // Add visual feedback to the clicked link and page
      link.classList.add("nav-link-pending");
      document.body.classList.add("nav-loading");

      // Remove dimming when navigation completes
      // The next page's initNavFeedback() call will clean up the classes
      // But add a safety timeout in case something goes wrong
      const cleanupTimeout = setTimeout(() => {
        document.body.classList.remove("nav-loading");
        navLinks.forEach((l) => l.classList.remove("nav-link-pending"));
      }, 5000); // 5 second timeout as safety net

      // Store timeout ID on the link for potential cleanup
      link._navCleanupTimeout = cleanupTimeout;
    });
  });
}

// ---------------------------------------------------------------------------
// Data update display
// ---------------------------------------------------------------------------

/**
 * Format a timestamp into a human-readable "last updated" string.
 * Examples: "Today at 2:30 PM", "Yesterday at 11:15 AM", "Jan 15 at 3:45 PM"
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @returns {string}
 */
function formatLastUpdateTime(timestamp) {
  if (!timestamp) return "Unknown";

  const date = new Date(timestamp);
  const now = new Date();

  // Check if it's today
  const isToday = date.toDateString() === now.toDateString();

  // Check if it's yesterday
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  // Format time part (e.g., "2:30 PM")
  const timeStr = date.toLocaleString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    meridiem: "short",
  });

  if (isToday) {
    return `Today at ${timeStr}`;
  } else if (isYesterday) {
    return `Yesterday at ${timeStr}`;
  } else {
    // Format as "Jan 15 at 3:45 PM"
    const dateStr = date.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
    });
    return `${dateStr} at ${timeStr}`;
  }
}

/**
 * Update the colophon to show when data was last updated.
 * Creates an interactive display with timestamp and manual refresh link.
 * Looks for an element with id "dataLastUpdated" and populates it.
 * @param {number} lastUpdateTime - Unix timestamp in milliseconds
 */
function displayDataLastUpdated(lastUpdateTime) {
  if (!lastUpdateTime) return;

  const el = document.getElementById("dataLastUpdated");
  if (!el) return;

  const formatted = formatLastUpdateTime(lastUpdateTime);

  // Build the display with a status LED, timestamp, and refresh link
  el.innerHTML = "";

  const { status } = dataHealthStatus;
  const LED_TITLES = {
    ok: "Event data feed loaded successfully",
    "stale-cache": `Event data feed failed to load — showing cached data from ${formatted}`,
  };
  el.appendChild(
    buildDataHealthLed(status, LED_TITLES[status] || LED_TITLES.ok),
  );

  const textSpan = document.createElement("span");
  textSpan.className = "data-updated-text";
  textSpan.textContent =
    status === "stale-cache"
      ? `Showing cached data from: ${formatted} (live feed unavailable)`
      : `Data last updated: ${formatted}`;
  el.appendChild(textSpan);

  const refreshLink = document.createElement("a");
  refreshLink.href = "#";
  refreshLink.className = "data-refresh-link";
  refreshLink.textContent = "[refresh]";
  refreshLink.title = "Clear cache and fetch latest data";
  refreshLink.addEventListener("click", (e) => {
    e.preventDefault();
    clearCacheAndRefresh();
  });
  el.appendChild(document.createTextNode(" "));
  el.appendChild(refreshLink);

  // Listen for background data updates
  if (!el._eventsDataUpdatedListenerAttached) {
    el._eventsDataUpdatedListenerAttached = true;
    window.addEventListener("eventsDataUpdated", (e) => {
      const newFormatted = formatLastUpdateTime(e.detail.timestamp);
      dataHealthStatus = { status: "ok", timestamp: e.detail.timestamp };
      textSpan.textContent = `Data last updated: ${newFormatted}`;

      // The background refresh succeeded, so the feed is healthy again —
      // reflect that even if the LED had been orange/red up to now.
      const ledEl = el.querySelector(".data-health-led");
      if (ledEl) {
        ledEl.className = "data-health-led data-health-ok";
        ledEl.title = LED_TITLES.ok;
        ledEl.setAttribute("aria-label", LED_TITLES.ok);
      }

      // Show "just refreshed" status
      const statusSpan = document.createElement("span");
      statusSpan.className = "data-refresh-status";
      statusSpan.textContent = " ✓ just refreshed";
      el.appendChild(statusSpan);

      // Remove status after 3 seconds
      setTimeout(() => {
        if (statusSpan.parentNode) statusSpan.remove();
      }, 3000);
    });
  }

  // Listen for a background check discovering the live feed is currently
  // broken (unreachable, non-OK response, or corrupted body) even though
  // we're serving perfectly good cached data — downgrades the LED from
  // green to orange in place, since it was already painted green above
  // before this background check had a chance to run.
  if (!el._eventsDataHealthListenerAttached) {
    el._eventsDataHealthListenerAttached = true;
    window.addEventListener("eventsDataHealthChanged", (e) => {
      const { status, reason } = e.detail;
      dataHealthStatus = { ...dataHealthStatus, status };

      const title = `Event data feed failed to load — showing cached data from ${formatted}${reason ? ` (${reason})` : ""}`;
      const ledEl = el.querySelector(".data-health-led");
      if (ledEl) {
        ledEl.className = `data-health-led data-health-${status}`;
        ledEl.title = title;
        ledEl.setAttribute("aria-label", title);
      }
      textSpan.textContent = `Showing cached data from: ${formatted} (live feed unavailable)`;
    });
  }
}

/**
 * Clear the events data cache and reload the page to fetch fresh data.
 * Also clears the schedule cache since schedules are computed from the data.
 * Called by the refresh link in the colophon.
 */
function clearCacheAndRefresh() {
  try {
    localStorage.removeItem(CACHE_KEYS.DATA);
    localStorage.removeItem(CACHE_KEYS.HEADERS);
    localStorage.removeItem(CACHE_KEYS.SCHEDULES);
    sessionStorage.setItem("forceFreshEventsData", "1");
    window.location.reload();
  } catch (e) {
    console.error("Failed to clear cache:", e);
  }
}

/**
 * Check if a meaningful calendar boundary has been crossed since cache was created.
 * Schedule calculations only change at boundaries: date changes, Mondays (week), month changes.
 * @param {number} cacheTimestamp - milliseconds when cache was created
 * @returns {boolean} true if cache should be cleared
 */
function hasScheduleCacheBoundaryCrossed(cacheTimestamp) {
  const cacheDate = new Date(cacheTimestamp);
  const today = new Date();

  // Different calendar date (midnight crossed)?
  if (cacheDate.toDateString() !== today.toDateString()) {
    return true;
  }

  // Different month (1st of month)?
  if (cacheDate.getMonth() !== today.getMonth()) {
    return true;
  }

  // Is it Monday now but wasn't when cached? (new week context)
  if (today.getDay() === 1 && cacheDate.getDay() !== 1) {
    return true;
  }

  return false;
}

/**
 * Retrieve cached computed schedules.
 * Returns null if cache crossed a calendar boundary or is missing.
 * Cache stays valid until date changes, month changes, or Monday arrives.
 * @returns {Object|null}
 */
function getSchedulesCache() {
  try {
    const cached = localStorage.getItem(CACHE_KEYS.SCHEDULES);
    if (!cached) return null;
    const { timestamp, data } = JSON.parse(cached);

    // Check if we've crossed a meaningful calendar boundary
    if (hasScheduleCacheBoundaryCrossed(timestamp)) {
      localStorage.removeItem(CACHE_KEYS.SCHEDULES);
      return null;
    }

    return data;
  } catch (e) {
    console.warn("Failed to read schedules cache:", e);
    return null;
  }
}

/**
 * Store computed schedules in cache.
 * @param {Object} schedules - Map of schedule keys to computed date objects
 */
function setSchedulesCache(schedules) {
  try {
    localStorage.setItem(
      CACHE_KEYS.SCHEDULES,
      JSON.stringify({
        timestamp: Date.now(),
        data: schedules,
      }),
    );
  } catch (e) {
    console.warn("Failed to cache schedules:", e);
  }
}

/**
 * Clear the schedule cache without clearing data.
 * Called when background refresh detects updated data.
 */
function clearSchedulesCache() {
  try {
    localStorage.removeItem(CACHE_KEYS.SCHEDULES);
  } catch (e) {
    console.warn("Failed to clear schedules cache:", e);
  }
}

// ---------------------------------------------------------------------------
// Podcast/video appearance resolution — shared by the performer profile
// page (performers.js) and the cross-performer Watch & Listen page
// (media.js), so both stay in sync with the podcasts registry schema
// (podcast_id/format/type, item performer_id/performer_ids/yt_url — see
// events-schema.json → $defs.podcast/$defs.podcastEpisode) instead of
// media.js quietly drifting from whatever performers.js does, which is
// what had happened before this was pulled out to one place.
// ---------------------------------------------------------------------------

/**
 * Extracts an 11-char YouTube video id from a watch/youtu.be/shorts/embed
 * URL, or null if `url` isn't a recognisable YouTube URL.
 * @param {string} url
 * @returns {string|null}
 */
function extractYoutubeId(url) {
  try {
    const u = new URL(url);
    if (/(^|\.)youtu\.be$/.test(u.hostname))
      return u.pathname.slice(1).split("/")[0] || null;
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const embedMatch = u.pathname.match(/\/embed\/([^/?]+)/);
    if (embedMatch) return embedMatch[1];
    const shortsMatch = u.pathname.match(/\/shorts\/([^/?]+)/);
    if (shortsMatch) return shortsMatch[1];
  } catch (e) {
    /* not a valid URL */
  }
  return null;
}

/**
 * Resolves a single podcast appearance's display name/url/format, whether
 * it came from the podcasts registry (podcast_id set) or an older inline
 * performer.podcast_appearances entry (bare podcast/podcast_url strings).
 * @param {object} appearance
 * @param {Object<string, object>} podcastsLookup
 * @returns {{name: string, url: string, format: string}}
 */
function resolvePodcastAppearanceMeta(appearance, podcastsLookup) {
  if (appearance.podcast_id && podcastsLookup[appearance.podcast_id]) {
    const p = podcastsLookup[appearance.podcast_id];
    return {
      name: p.series_title || appearance.podcast_id,
      url: p.url || "",
      // podcasts[].format (e.g. "telling", "interview") — purely
      // descriptive, shown alongside the series name if present.
      format: p.format || "",
    };
  }
  return {
    name: appearance.podcast || "Podcast",
    url: appearance.podcast_url || "",
    format: "",
  };
}

/**
 * Merges two sources of a performer's AUDIO podcast appearances into one
 * list:
 *   1. Registry-sourced — episodes tagged with this performer's id (via
 *      performer_id/performer_ids) on any podcast's items[]. Preferred
 *      home for anything on a registered series.
 *   2. Inline — performer.podcast_appearances, for one-off guest spots on
 *      a podcast that isn't registered (older entries carrying a
 *      podcast_id are still honoured for backward compatibility).
 * Items with a yt_url are excluded — those belong in
 * collectPerformerVideoAppearances() instead (an item wouldn't normally
 * carry both an enclosureUrl and a yt_url, but if it did, video wins
 * rather than showing the same appearance twice).
 * @param {object} performer
 * @param {string} performerId
 * @param {Object<string, object>} podcastsLookup
 * @returns {object[]}
 */
function collectPerformerAppearances(performer, performerId, podcastsLookup) {
  const inline = Array.isArray(performer.podcast_appearances)
    ? performer.podcast_appearances.filter((a) => a && a.episode_name)
    : [];
  const fromRegistry = [];
  Object.values(podcastsLookup).forEach((podcast) => {
    (podcast.items || []).forEach((item) => {
      const ids = Array.isArray(item.performer_ids)
        ? item.performer_ids
        : item.performer_id
          ? [item.performer_id]
          : [];
      if (!ids.includes(performerId)) return;
      if (!item.title || !item.enclosureUrl) return;
      if (item.yt_url) return;
      fromRegistry.push({
        episode_name: item.title,
        audio_url: item.enclosureUrl,
        episode_url: item.link || "",
        podcast_id: podcast.podcast_id,
      });
    });
  });
  return [...fromRegistry, ...inline];
}

/**
 * Merges two sources of a performer's VIDEO appearances into one list:
 * registry-sourced episodes with a yt_url (tagged via performer_id/
 * performer_ids on any podcast's items[]) plus the performer's own inline
 * youtube_videos. De-duped by YouTube video id — a video that's since
 * been added to the registry may still carry an old inline entry for the
 * same video; the registry-sourced version (listed first) wins.
 * @param {object} performer
 * @param {string} performerId
 * @param {Object<string, object>} podcastsLookup
 * @returns {{story_name: string, yt_url: string, source?: string, format?: string}[]}
 */
function collectPerformerVideoAppearances(
  performer,
  performerId,
  podcastsLookup,
) {
  const fromRegistry = [];
  Object.values(podcastsLookup).forEach((podcast) => {
    (podcast.items || []).forEach((item) => {
      const ids = Array.isArray(item.performer_ids)
        ? item.performer_ids
        : item.performer_id
          ? [item.performer_id]
          : [];
      if (!ids.includes(performerId)) return;
      if (!item.yt_url || !extractYoutubeId(item.yt_url)) return;
      fromRegistry.push({
        story_name: item.title || podcast.series_title || "Untitled video",
        yt_url: item.yt_url,
        source: podcast.series_title || "",
        format: podcast.format || "",
        podcast_id: podcast.podcast_id,
      });
    });
  });

  const inline = Array.isArray(performer.youtube_videos)
    ? performer.youtube_videos
        .filter((v) => v && v.yt_url && extractYoutubeId(v.yt_url))
        .map((v) => ({
          story_name: v.story_name,
          yt_url: v.yt_url,
          format: v.format || "",
        }))
    : [];

  const seen = new Set();
  const merged = [];
  [...fromRegistry, ...inline].forEach((v) => {
    const vid = extractYoutubeId(v.yt_url);
    if (!vid || seen.has(vid)) return;
    seen.add(vid);
    merged.push(v);
  });
  return merged;
}
