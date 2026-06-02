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
  if (Array.isArray(dateStr)) {
    console.warn("parseDateString received an array; use the first element or expandDatetimes instead:", dateStr);
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
    const venueLink = createExternalLink(venue.url, strong, { className: "venue-link" });
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
    tourLink.href = `new_troubadours_tour_guide.html?tour=${tid}`;
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
        const resolvedItem =
          Array.isArray(dateField) ? { ...item, date: dateStr } : item;
        await callback(resolvedItem, parsed);
      }
    }
  }
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

  const openLabel = "\uD83D\uDDFA Hide map";
  const closeLabel = "\uD83D\uDDFA " + labelText;

  mapToggle.addEventListener("toggle", () => {
    if (mapToggle.open && !mapInitialised) {
      mapInitialised = true;
      handle.map = initMap(mapDivId, null);
      // invalidateSize must be called after the container becomes visible;
      // without it Leaflet measures a 0×0 box and only renders a tiny tile region,
      // causing most markers to be silently dropped.
      handle.map.invalidateSize();
      onInit(handle.map);
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
