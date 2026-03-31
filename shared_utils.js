/**
 * shared_utils.js
 * Shared utilities for New Troubadours event guide and tour display apps.
 * Include this script before app-specific scripts in each HTML page.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PARAGRAPH_SEPARATOR = "\n\n\n\n";

const UK_IRELAND_BOUNDS = L.latLngBounds(
  [49.5, -11.0], // SW corner (Atlantic)
  [61.0, 2.5], // NE corner (North Sea)
);

// Icon SVGs used for website, email, and Facebook links.
// The email icon uses a stroked envelope style (from the event guide).
const ICON_SVG = {
  website:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>',
  email:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>',
  facebook:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#1877f2"/><path d="M16.5 8H14c-.3 0-.5.2-.5.5V10H16l-.3 2.5H13.5V19h-2.5v-6.5H9V10h2V8.5C11 6.6 12.3 5.5 14 5.5c.8 0 2.5.1 2.5.1V8z" fill="#ffffff"/></svg>',
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

// ---------------------------------------------------------------------------
// Date utilities
// ---------------------------------------------------------------------------

/**
 * Parse a DD/MM/YYYY date string into a midnight-normalised Date object.
 * Returns null if the string is missing or malformed.
 * @param {string} dateStr
 * @returns {Date|null}
 */
function parseDateString(dateStr) {
  if (!dateStr) return null;
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
 * Sanitize a flyer filename, stripping any characters that are not
 * alphanumeric, dots, underscores, or hyphens.
 * @param {string} filename
 * @returns {string}
 */
function sanitizeFlyerPath(filename) {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "");
}

// ---------------------------------------------------------------------------
// DOM / UI utilities
// ---------------------------------------------------------------------------

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
    const safeUrl = sanitizeUrl(venue.url);
    if (safeUrl) {
      const venueLink = document.createElement("a");
      venueLink.href = safeUrl;
      venueLink.target = "_blank";
      venueLink.className = "venue-link";
      venueLink.addEventListener("click", (e) => e.stopPropagation());
      const strong = document.createElement("strong");
      strong.textContent = venueName;
      venueLink.appendChild(strong);
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
    tourLink.href = `new_troubadours_tour_guide.html?tour=${tid}`;
    tourLink.target = "_blank";
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
 * Fetch events_normalized.json and populate the three shared lookup objects.
 * Pass the returned eventsData and populated lookups back via the returned object.
 * @param {string|null} [cacheBuster]  - Optional version string; defaults to timestamp.
 * @returns {Promise<{eventsData: object, venuesLookup: object, performersLookup: object, toursLookup: object}|null>}
 */
async function loadEventsData(cacheBuster) {
  try {
    const version = cacheBuster || new Date().getTime();
    const response = await fetch(`events_normalized.json?v=${version}`);
    if (!response.ok) {
      console.error("Failed to load events_normalized.json");
      return null;
    }
    const eventsData = await response.json();
    const toursLookup = eventsData.tours || {};
    const venuesLookup = eventsData.venues || {};
    const performersLookup = eventsData.performers || {};

    console.log(`✓ Loaded events data`);
    console.log(`  - ${Object.keys(venuesLookup).length} venues`);
    console.log(`  - ${Object.keys(performersLookup).length} performers`);
    console.log(`  - ${Object.keys(toursLookup).length} tours`);

    return { eventsData, venuesLookup, performersLookup, toursLookup };
  } catch (error) {
    console.error("Error loading events:", error);
    return null;
  }
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

// ---------------------------------------------------------------------------
// Date-range iteration
// ---------------------------------------------------------------------------

/**
 * Iterate a collection of objects that each have a `.date` string (DD/MM/YYYY),
 * calling `callback(item, parsedDate)` for each item whose date falls within
 * [startDate, endDate] inclusive. Items with a missing or malformed date are
 * skipped with a console.warn.
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
 * @param {object[]|null|undefined} items     - Array of objects with a .date string.
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
    const parsed = parseDateString(item.date);
    if (!parsed) {
      console.warn(`Invalid date format for ${label}:`, item);
      continue;
    }
    if (parsed >= startDate && parsed <= endDate) {
      await callback(item, parsed);
    }
  }
}
