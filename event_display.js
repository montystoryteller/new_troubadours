let map;
let markers = [];
let allEventsData = [];
let isGeocoding = false;
let eventsData = null;

let venuesLookup = {};
let performersLookup = {};
let toursLookup = {};

let mapViewPinned = false;
let pinnedMapView = null;

// UK_IRELAND_BOUNDS — defined in shared_utils.js

const EVENT_TYPES = {
  SESSION: "session",
  FOLK: "folk",
  MUSIC: "music",
  SPECIAL: "special",
  STORYCLUB: "storyclub",
  FESTIVAL: "festival",
};

const DAYS_OF_WEEK = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

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

const DAY_MAP = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const OCCURRENCE_MAP = { "1st": 1, "2nd": 2, "3rd": 3, "4th": 4, last: "last" };

/**
 * Parse a single "DD/MM/YYYY : H.MMpm" datetime string into { date, time }.
 * Returns null if the string is malformed.
 * @param {string} str
 * @returns {{ date: Date, time: string }|null}
 */
function parseDatetimeString(str) {
  if (!str) return null;
  const sep = str.indexOf(" : ");
  if (sep === -1) return null;
  const datePart = str.slice(0, sep).trim();
  const timePart = str.slice(sep + 3).trim();
  const date = parseDateString(datePart);
  if (!date) return null;
  return { date, time: timePart };
}

/**
 * Expand an event's `datetimes` array into an array of { event, date, time }
 * objects, one per entry.  Each returned object is a shallow clone of the
 * base event with `date` and `time` overridden so it can be handed straight
 * to createEventData() / buildEventSearchText().
 *
 * If the event has no `datetimes` array (or it is empty), returns a single
 * object using the event's existing `date` / `time` fields — so callers can
 * always iterate the result without special-casing.
 *
 * @param {object} event - Raw event record from the JSON.
 * @returns {{ flatEvent: object, date: Date }[]}
 */
function expandDatetimes(event) {
  if (Array.isArray(event.datetimes) && event.datetimes.length > 0) {
    const results = [];
    for (const dtStr of event.datetimes) {
      const parsed = parseDatetimeString(dtStr);
      if (!parsed) {
        console.warn(
          `Could not parse datetime string: "${dtStr}" in event: ${event.name}`,
        );
        continue;
      }
      // Shallow clone with date/time overridden
      results.push({
        flatEvent: { ...event, date: undefined, time: parsed.time },
        date: parsed.date,
      });
    }
    return results;
  }
  // Fallback: single entry using the existing date field
  const date = parseDateString(event.date);
  if (!date) return [];
  return [{ flatEvent: event, date }];
}

// escapeHtml() — defined in shared_utils.js

// sanitizeUrl() — defined in shared_utils.js

// loadEventsData() — defined in shared_utils.js

function extractPostcodeArea(location) {
  if (!location) return "";
  const parts = location.split(",");
  const lastPart = parts[parts.length - 1].trim();
  const postcodeMatch = lastPart.match(/^([A-Z]+)/i);
  return postcodeMatch ? postcodeMatch[1] : "";
}

// initMap() — defined in shared_utils.js

function findNthDayInMonth(year, month, targetDay, occurrence) {
  const lastDay = new Date(year, month + 1, 0);

  if (occurrence === "last") {
    // Count backwards from end of month
    for (let d = lastDay.getDate(); d >= 1; d--) {
      const testDate = new Date(year, month, d);
      testDate.setHours(0, 0, 0, 0);
      if (testDate.getDay() === targetDay) {
        return testDate;
      }
    }
  } else {
    // Count forwards from start of month
    let count = 0;
    for (let d = 1; d <= lastDay.getDate(); d++) {
      const testDate = new Date(year, month, d);
      testDate.setHours(0, 0, 0, 0);
      if (testDate.getDay() === targetDay) {
        count++;
        if (count === occurrence) {
          return testDate;
        }
      }
    }
  }
  return null;
}

function parseSchedule(schedule, startDate, endDate) {
  const results = [];

  // Normalize dates to midnight for consistent comparison
  const normalizeDate = (date) => {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
  };

  const normalizedStart = normalizeDate(startDate);
  const normalizedEnd = normalizeDate(endDate);

  // Handle specific dates (DD/MM/YYYY)
  if (schedule.includes("/")) {
    const [day, month, year] = schedule
      .split("/")
      .map((num) => parseInt(num, 10));
    const specificDate = normalizeDate(new Date(year, month - 1, day));
    if (specificDate >= normalizedStart && specificDate <= normalizedEnd) {
      results.push(specificDate);
    }
    return results;
  }

  // Handle "every [dayname]" schedules
  if (schedule.toLowerCase().startsWith("every ")) {
    const dayName = schedule.toLowerCase().replace("every ", "").trim();
    const targetDay = DAY_MAP[dayName];

    if (targetDay === undefined) {
      console.warn(`Invalid day name in schedule: ${schedule}`);
      return results;
    }

    const current = new Date(normalizedStart);

    // Find the first occurrence of the target day on or after the start date
    while (current.getDay() !== targetDay) {
      current.setDate(current.getDate() + 1);
    }

    // Add all occurrences of this day within the date range
    while (current <= normalizedEnd) {
      const eventDate = normalizeDate(new Date(current));
      if (eventDate >= normalizedStart && eventDate <= normalizedEnd) {
        results.push(eventDate);
      }
      current.setDate(current.getDate() + 7); // Move to next week
    }

    return results;
  }

  // Handle multiple occurrences in same month (e.g., "1st and 3rd wednesday")
  // TO DO - this only really handles a case of X, or, X and Y?
  if (schedule.toLowerCase().includes(" and ")) {
    const [occurrence1Str, rest] = schedule.toLowerCase().split(" and ");
    const parts = rest.trim().split(/\s+/);
    const occurrence2Str = parts[0];
    const dayName = parts[1];

    const targetDay = DAY_MAP[dayName];

    const occurrence1 = OCCURRENCE_MAP[occurrence1Str.trim()];
    const occurrence2 = OCCURRENCE_MAP[occurrence2Str.trim()];

    const current = new Date(
      normalizedStart.getFullYear(),
      normalizedStart.getMonth() - 1,
      1,
    );
    const extendedEnd = new Date(
      normalizedEnd.getFullYear(),
      normalizedEnd.getMonth() + 1,
      0,
    );

    while (current <= extendedEnd) {
      const year = current.getFullYear();
      const month = current.getMonth();
      //const lastDay = new Date(year, month + 1, 0);

      // Find both occurrences
      const occurrences = [occurrence1, occurrence2];

      occurrences.forEach((occ) => {
        const eventDate = findNthDayInMonth(year, month, targetDay, occ);

        if (
          eventDate &&
          eventDate >= normalizedStart &&
          eventDate <= normalizedEnd
        ) {
          results.push(eventDate);
        }
      });

      current.setMonth(current.getMonth() + 1);
    }

    return results.sort((a, b) => a - b);
  }

  // Handle alternating schedules (e.g., "1st wednesday (even months) | 1st thursday (odd months)")
  if (schedule.includes("|")) {
    const parts = schedule.split("|").map((s) => s.trim());

    parts.forEach((part) => {
      // Extract the pattern and condition
      const match = part.match(/^(.+?)\s*\((\w+)\s+months\)$/i);
      if (!match) return;

      const pattern = match[1].trim(); // e.g., "1st wednesday"
      const condition = match[2].toLowerCase(); // "even" or "odd"

      // Parse the base pattern
      const [occurrence, dayName] = pattern.toLowerCase().split(/\s+/);
      const targetDay = DAY_MAP[dayName];

      const current = new Date(
        normalizedStart.getFullYear(),
        normalizedStart.getMonth() - 1,
        1,
      );
      const extendedEnd = new Date(
        normalizedEnd.getFullYear(),
        normalizedEnd.getMonth() + 1,
        0,
      );

      while (current <= extendedEnd) {
        const year = current.getFullYear();
        const month = current.getMonth();

        // Check if this month matches the condition
        const monthNumber = month + 1; // 1-12
        const isEvenMonth = monthNumber % 2 === 0;
        const matchesCondition =
          (condition === "even" && isEvenMonth) ||
          (condition === "odd" && !isEvenMonth);

        if (!matchesCondition) {
          current.setMonth(current.getMonth() + 1);
          continue;
        }

        const occurrenceNum = OCCURRENCE_MAP[occurrence.trim()];

        const eventDate = findNthDayInMonth(
          year,
          month,
          targetDay,
          occurrenceNum,
        );

        if (
          eventDate &&
          eventDate >= normalizedStart &&
          eventDate <= normalizedEnd
        ) {
          results.push(eventDate);
        }

        current.setMonth(current.getMonth() + 1);
      }
    });

    return results.sort((a, b) => a - b);
  }

  // Handle standard recurring schedules (existing code)
  const [occurrence, dayName] = schedule.toLowerCase().split(/\s+/);
  const targetDay = DAY_MAP[dayName];

  const current = new Date(
    normalizedStart.getFullYear(),
    normalizedStart.getMonth() - 1,
    1,
  );
  const extendedEnd = new Date(
    normalizedEnd.getFullYear(),
    normalizedEnd.getMonth() + 1,
    0,
  );

  while (current <= extendedEnd) {
    const year = current.getFullYear();
    const month = current.getMonth();

    const occurrenceNum = OCCURRENCE_MAP[occurrence.trim()];

    const eventDate = findNthDayInMonth(year, month, targetDay, occurrenceNum);

    if (
      eventDate &&
      eventDate >= normalizedStart &&
      eventDate <= normalizedEnd
    ) {
      results.push(eventDate);
    }

    current.setMonth(current.getMonth() + 1);
  }

  return results;
}

function getMonthParity(date) {
  return (date.getMonth() + 1) % 2 === 0 ? "even" : "odd";
}

function getEventDescription(event) {
  // First priority: event-specific description
  if (event.description && event.description.trim()) {
    return event.description;
  }

  // Second priority: tour description via tour_id lookup
  if (event.tour_id && toursLookup[event.tour_id]?.tour_description) {
    return toursLookup[event.tour_id].tour_description;
  }

  return "";
}

function resolveEventVenue(event, date) {
  const parity = getMonthParity(date);

  let venue_id = event.venue_id || null;
  let location = null;
  let latlon = null;
  let venue_url = null;

  // Check alternate locations first
  if (event.alternate_locations?.[parity]) {
    venue_id = event.alternate_locations[parity].venue_id || venue_id;
  }

  // Look up venue details from venues collection
  if (venue_id && venuesLookup[venue_id]) {
    const venue = venuesLookup[venue_id];
    location = venue.full_address || venue.name;
    latlon = venue.latlon || null;
    venue_url = venue.url || null;
  }

  return { location, latlon, venue_url, venue_id };
}

function parseExceptionDate(str) {
  let [d, m, y] = str.split("/").map(Number);

  // normalize year (assume 00–99 means 2000–2099)
  if (y < 100) y += 2000;

  // JS months are 0-based
  return new Date(y, m - 1, d);
}

function createSafePopup(eventData) {
  const container = document.createElement("div");
  container.className = "popup-content";

  const h3 = document.createElement("h3");
  h3.textContent = eventData.name;
  container.appendChild(h3);

  const dateP = document.createElement("p");
  const dateStrong = document.createElement("strong");
  dateStrong.textContent = formatDate(eventData.date);
  dateP.appendChild(dateStrong);
  container.appendChild(dateP);

  const locationP = document.createElement("p");
  locationP.textContent = eventData.location;
  container.appendChild(locationP);

  if (eventData.performer) {
    const performerP = document.createElement("p");
    const performerEm = document.createElement("em");
    performerEm.textContent = eventData.performer;
    performerP.appendChild(performerEm);
    container.appendChild(performerP);
  }

  return container;
}

function createEventData(baseEvent, date, eventType) {
  const { location, latlon, venue_url, venue_id } = resolveEventVenue(
    baseEvent,
    date,
  );

  const eventData = {
    name: baseEvent.name,
    date: date,
    time: baseEvent.time || null,
    location: location,
    latlon: latlon,
    venue_url: venue_url,
    venue_id: venue_id,
    price: baseEvent.price || null,
    isStoryclub: eventType === "storyclub",
    isSpecial: eventType === "special",
    isMusic: eventType === "music",
    isFolk: eventType === "folk",
    isSession: eventType === "session",
    isTouringShow: !!baseEvent.isTouringShow,
    isCancelled: !!baseEvent.isCancelled,
    isSoldOut: !!baseEvent.isSoldOut,
  };

  // Add type-specific fields
  if (
    eventType === "storyclub" ||
    eventType === "folk" ||
    eventType === "session"
  ) {
    eventData.club = baseEvent.club;
    eventData.facebook = baseEvent.facebook || null;
    eventData.email = baseEvent.email || null;
    eventData.link = baseEvent.link || null;
    eventData.schedule = baseEvent.schedule || null;
    eventData.alternate_locations = baseEvent.alternate_locations || null;
    eventData.exceptions = baseEvent.exceptions || null;
    eventData.club_flyer = baseEvent.club_flyer || null;

    if (eventType === "folk") {
      eventData.storiesWelcome = baseEvent.storiesWelcome || false;
      eventData.byInvitation = baseEvent.byInvitation || null;
    }
  }

  if (eventType === "special" || eventType === "music") {
    eventData.tour_id = baseEvent.tour_id || null;
    eventData.performer_id = baseEvent.performer_id || null;

    // Look up performer details from collection
    const performer_id = baseEvent.performer_id;
    if (performer_id && performersLookup[performer_id]) {
      eventData.performer = performersLookup[performer_id].name;
      eventData.performer_url = performersLookup[performer_id].url || null;
    } else {
      eventData.performer = baseEvent.performer || null;
      eventData.performer_url = null;
    }
    eventData.description = baseEvent.description || null;
    eventData.event_flyer = baseEvent.event_flyer || null;
    eventData.tour_flyer = baseEvent.tour_flyer || null;
    eventData.fb_event = baseEvent.fb_event || null;
    eventData.ticket_url = baseEvent.ticket_url || null;
  }

  return eventData;
}

// ---------------------------------------------------------------------------
// Merged-event builders
// These extract the object-construction logic that was previously duplicated
// between the process* functions and searchAllUpcoming.
// ---------------------------------------------------------------------------

/**
 * Build the merged event object for a single tour date.
 * Used by both processTourEvents() and searchAllUpcoming().
 *
 * @param {object} tour     - The tour record from toursLookup.
 * @param {string} tourKey  - The tour's key (used as tour_id).
 * @param {object} tourDate - One entry from tour.tour_dates[].
 * @returns {object}
 */
function buildTourMergedEvent(tour, tourKey, tourDate) {
  return {
    name: tour.name,
    tour_id: tourKey,
    performer_id: tour.performer_id,
    date: tourDate.date,
    time: tourDate.time || tour.time || null,
    price: tourDate.price || tour.price || null,
    venue_id: tourDate.venue_id,
    description: tour.tour_description || null,
    event_flyer: tourDate.event_flyer || null,
    tour_flyer: tour.tour_flyer || null,
    fb_event: tourDate.fb_event || null,
    ticket_url: tourDate.ticket_url || null,
    isCancelled: !!tourDate.isCancelled,
    isSoldOut: !!tourDate.isSoldOut,
  };
}

/**
 * Build the merged event object for a single touring-show date.
 * Used by both processTouringShows() and searchAllUpcoming().
 *
 * @param {object} show     - The show record from touring_shows.
 * @param {string} showKey  - The show's key.
 * @param {object} showDate - One entry from show.show_dates[].
 * @returns {object}
 */
function buildShowMergedEvent(show, showKey, showDate) {
  return {
    name: show.name,
    showname: show.showname,
    touring_show_id: showKey,
    performer_id: show.performer_id,
    date: showDate.date,
    time: showDate.time || show.time || null,
    price: showDate.price || show.price || null,
    venue_id: showDate.venue_id,
    club: showDate.club || show.club || null,
    description: show.description || null,
    event_flyer: showDate.event_flyer || null,
    touring_event_flyer: show.touring_event_flyer || null,
    fb_event: showDate.fb_event || null,
    ticket_url: showDate.ticket_url || null,
    isTouringShow: true,
    isCancelled: !!showDate.isCancelled,
    isSoldOut: !!showDate.isSoldOut,
  };
}

/** @returns {string} Performer display name, or "" if not found. */
function resolvePerformerName(performer_id) {
  return (performer_id && performersLookup[performer_id]?.name) || "";
}

/** @returns {{venueName: string, venueLocation: string}} */
function resolveVenue(venue_id) {
  const venue = venue_id && venuesLookup[venue_id];
  return {
    venueName: venue?.name || "",
    venueLocation: venue?.full_address || "",
  };
}

/** Search text for a tour date. Used only by searchAllUpcoming(). */
function buildTourSearchText(tour, tourDate) {
  const performerName = resolvePerformerName(tour.performer_id);
  const { venueName, venueLocation } = resolveVenue(tourDate.venue_id);
  return `${tour.name} ${tour.tour_name || ""} ${performerName} ${tour.tour_description || ""} ${venueName} ${venueLocation} ${tourDate.time || ""} ${tourDate.price || ""}`.toLowerCase();
}

/** Search text for a touring show date. Used only by searchAllUpcoming(). */
function buildShowSearchText(show, showDate) {
  const performerName = resolvePerformerName(show.performer_id);
  const { venueName, venueLocation } = resolveVenue(showDate.venue_id);
  return `${show.name} ${show.showname || ""} ${performerName} ${show.description || ""} ${venueName} ${venueLocation} ${showDate.time || ""} ${showDate.price || ""}`.toLowerCase();
}

/** Search text for a flat specificEvent or musicEvent. Used only by searchAllUpcoming(). */
function buildEventSearchText(event) {
  const performerName = resolvePerformerName(event.performer_id);
  const { venueName, venueLocation } = resolveVenue(event.venue_id);
  return `${event.name} ${performerName} ${venueName} ${venueLocation} ${event.time || ""} ${event.price || ""}`.toLowerCase();
}

/**
 * Search text for a recurring event (storyclub, folk night, Irish session).
 * Used only by searchRecurringEvents().
 *
 * Recurring events store their venue via venue_id rather than a flat .location
 * field, so we dereference through venuesLookup here. Events with
 * alternate_locations (e.g. rotating between two venues on odd/even months)
 * include all alternate venue names so a search for either venue finds the event.
 */
function buildRecurringEventSearchText(event) {
  const { venueName, venueLocation } = resolveVenue(event.venue_id);

  // Collect any alternate venue names so searches for either venue hit this event
  const alternateVenueText = Object.values(event.alternate_locations || {})
    .map((alt) => {
      const { venueName: n, venueLocation: a } = resolveVenue(alt.venue_id);
      return `${n} ${a}`;
    })
    .join(" ");

  return `${event.name} ${event.club || ""} ${venueName} ${venueLocation} ${alternateVenueText} ${event.time || ""} ${event.price || ""}`.toLowerCase();
}

/**
 * Build a festival data object from raw festival data and a resolved venue.
 * Used by both processFestivals() and searchAllUpcoming() to avoid duplication.
 *
 * @param {string} festKey   - The festival's key in eventsData.festivals.
 * @param {object} fest      - The raw festival record.
 * @param {object} venue     - The resolved venue object (may be empty {}).
 * @param {Date}   festStart - Pre-parsed start date.
 * @param {Date}   festEnd   - Pre-parsed end date.
 * @returns {object}
 */
function buildFestivalData(festKey, fest, venue, festStart, festEnd) {
  const location = venue.full_address || venue.name || "";

  const performerNames = (fest.performers || [])
    .map((p) => performersLookup[p.performer_id]?.name || null)
    .filter(Boolean);
  const performerStr = performerNames.length
    ? performerNames.join(", ") + (fest.performers_tbc ? " + more TBA" : "")
    : null;

  return {
    isFestival: true,
    primary_type: fest.primary_type || "storytelling",
    name: fest.name,
    festival_id: festKey,
    start_date: festStart,
    end_date: festEnd,
    date: festStart, // used for sort order
    location: location,
    latlon: venue.latlon || null,
    venue_url: venue.url || null,
    performer: performerStr,
    ticket_url: fest.ticket_url || null,
    facebook: fest.facebook || null,
    website: fest.website || null,
    description: fest.description || null,
    event_flyer: fest.event_flyer || null,
    schedule_populated:
      Array.isArray(fest.schedule) && fest.schedule.length > 0,
  };
}

async function processTouringShows(startDate, endDate) {
  const touringShows = eventsData.touring_shows || {};

  for (const showKey in touringShows) {
    const show = touringShows[showKey];
    const eventType = show.isSpecial ? "special" : "storyclub";

    await forEachDateInRange(
      show.show_dates,
      startDate,
      endDate,
      `touring show in ${show.name}`,
      async (showDate, eventDate) => {
        const mergedEvent = buildShowMergedEvent(show, showKey, showDate);
        const eventData = createEventData(mergedEvent, eventDate, eventType);
        allEventsData.push(eventData);
        await addMarkerForEvent(eventData);
      },
    );
  }
}

async function processTourEvents(startDate, endDate) {
  const tours = eventsData.tours || {};

  for (const tourKey in tours) {
    const tour = tours[tourKey];

    if (!tour.isMusic && !tour.isSpecial) continue;
    const eventType = tour.isMusic ? "music" : "special";

    await forEachDateInRange(
      tour.tour_dates,
      startDate,
      endDate,
      `tour event in ${tour.name}`,
      async (tourDate, eventDate) => {
        const mergedEvent = buildTourMergedEvent(tour, tourKey, tourDate);
        const eventData = createEventData(mergedEvent, eventDate, eventType);
        allEventsData.push(eventData);
        await addMarkerForEvent(eventData);
      },
    );
  }
}

async function processSpecialEvents(events, typ, startDate, endDate) {
  for (const event of events || []) {
    // If datetimes array is present, expand it; otherwise fall back to single date
    const hasDatetimes =
      Array.isArray(event.datetimes) && event.datetimes.length > 0;
    if (!hasDatetimes && !event.date) {
      console.warn(`Missing date for ${typ} event:`, event);
      continue;
    }

    const expanded = expandDatetimes(event);
    for (const { flatEvent, date: eventDate } of expanded) {
      if (!eventDate) {
        console.warn(`Invalid date format for ${typ} event:`, event);
        continue;
      }
      if (eventDate >= startDate && eventDate <= endDate) {
        const eventData = createEventData(flatEvent, eventDate, typ);
        allEventsData.push(eventData);
        await addMarkerForEvent(eventData);
      }
    }
  }
}

async function processRecurringEvents(events, eventType, startDate, endDate) {
  for (const event of events || []) {
    const exceptions = event.exceptions || [];

    // Parse exception dates
    const exceptionDates = exceptions.map(parseExceptionDate);

    // Expand range to capture context
    let expandedStart = new Date(startDate);
    let expandedEnd = new Date(endDate);

    if (exceptionDates.length > 0) {
      expandedStart = new Date(Math.min(startDate, ...exceptionDates));
      expandedStart.setMonth(expandedStart.getMonth() - 1);

      expandedEnd = new Date(Math.max(endDate, ...exceptionDates));
      expandedEnd.setMonth(expandedEnd.getMonth() + 1);
    }

    // Get all scheduled dates in expanded range
    const allScheduledDates = parseSchedule(
      event.schedule,
      expandedStart,
      expandedEnd,
    );

    // Build reschedule map: for each exception date, find the regularly scheduled date in that same month
    const rescheduleMap = new Map(); // Key: cancelled date, Value: rescheduled date

    exceptionDates.forEach((excDate) => {
      // Find the regularly scheduled date in the SAME month as the exception
      const regularDateInSameMonth = allScheduledDates.find(
        (schedDate) =>
          schedDate.getFullYear() === excDate.getFullYear() &&
          schedDate.getMonth() === excDate.getMonth(),
      );

      if (regularDateInSameMonth) {
        // The regular date is cancelled, exception date is the reschedule
        const cancelKey = `${regularDateInSameMonth.getFullYear()}-${regularDateInSameMonth.getMonth()}-${regularDateInSameMonth.getDate()}`;
        rescheduleMap.set(cancelKey, excDate);
      }
    });

    // Process dates in the REQUESTED range
    const dates = parseSchedule(event.schedule, startDate, endDate);

    for (const date of dates) {
      const eventData = createEventData(event, date, eventType);

      // Check if THIS specific date was cancelled
      const dateKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      const rescheduledTo = rescheduleMap.get(dateKey);

      if (rescheduledTo) {
        eventData.isCancelled = true;
        eventData.rescheduledTo = rescheduledTo;
        eventData.rescheduledToStr = rescheduledTo.toLocaleDateString("en-GB", {
          weekday: "short",
          day: "numeric",
          month: "short",
          year: "numeric",
        });
      }

      allEventsData.push(eventData);
      await addMarkerForEvent(eventData);
    }

    // Add rescheduled dates that fall within the current range
    for (const excDate of exceptionDates) {
      if (excDate >= startDate && excDate <= endDate) {
        const eventData = createEventData(event, excDate, eventType);
        eventData.isRescheduled = true;

        allEventsData.push(eventData);
        await addMarkerForEvent(eventData);
      }
    }
  }
}

/**
 * Merge duplicate tour dates in allEventsData.
 * When the same performer appears on the same date in multiple tours,
 * collapse them into one event with all tour_ids collected into an array.
 * Non-tour events are always kept as-is.
 */
function mergeDuplicateTourDates() {
  const mergeMap = new Map();
  for (const evt of allEventsData) {
    if (!evt.tour_id) {
      mergeMap.set(Symbol(), evt); // non-tour events: always keep as-is
      continue;
    }
    // Include venue_id in key: same performer on same day at different venues
    // are separate events; same performer on same day at the SAME venue are
    // multiple show-times that should be collapsed into one card.
    const key = `${evt.performer_id || evt.name}|${evt.date.toISOString()}|${evt.venue_id || ""}`;
    if (mergeMap.has(key)) {
      const existing = mergeMap.get(key);
      // Only push tour_id if not already present (avoid duplicates)
      if (!existing.tour_ids.includes(evt.tour_id)) {
        existing.tour_ids.push(evt.tour_id);
      }
      // Collect the additional show time alongside its ticket URL and price.
      // Only build show_times when we have at least one real time value.
      if (evt.time || existing.time) {
        if (!existing.show_times) {
          existing.show_times = [];
          if (existing.time) {
            existing.show_times.push({
              time: existing.time,
              ticket_url: existing.ticket_url,
              price: existing.price,
            });
          }
        }
        if (evt.time) {
          existing.show_times.push({
            time: evt.time,
            ticket_url: evt.ticket_url,
            price: evt.price,
          });
        }
        // Clear the top-level fields — they are now in show_times
        existing.time = null;
        existing.ticket_url = null;
        existing.price = null;
      }
    } else {
      evt.tour_ids = [evt.tour_id];
      mergeMap.set(key, evt);
    }
  }
  allEventsData = Array.from(mergeMap.values());
}

async function processFestivals(startDate, endDate) {
  const festivals = eventsData.festivals || {};

  for (const [festKey, fest] of Object.entries(festivals)) {
    const festStart = parseDateString(fest.start_date);
    const festEnd = parseDateString(fest.end_date);

    if (!festStart || !festEnd) {
      console.warn(`Festival ${festKey} missing valid start/end date`);
      continue;
    }

    // Show whenever the festival overlaps with the current view window at all
    if (festStart > endDate || festEnd < startDate) continue;

    const venue = venuesLookup[fest.venue_id] || {};
    const festData = buildFestivalData(
      festKey,
      fest,
      venue,
      festStart,
      festEnd,
    );

    allEventsData.push(festData);
    await addMarkerForEvent(festData);
  }
}

async function displayEvents(startDate, endDate) {
  if (!eventsData) {
    console.error("Events data not loaded");
    return;
  }

  allEventsData = [];
  markers.forEach((marker) => map.removeLayer(marker));
  markers = [];

  // Process all recurring event types with one function
  await processRecurringEvents(
    eventsData.events,
    "storyclub",
    startDate,
    endDate,
  );
  await processRecurringEvents(
    eventsData.folkNights,
    "folk",
    startDate,
    endDate,
  );
  await processRecurringEvents(
    eventsData.irishSessions,
    "session",
    startDate,
    endDate,
  );

  // Process one-off events (these don't have schedules/exceptions)
  await processSpecialEvents(
    eventsData.specificEvents,
    "special",
    startDate,
    endDate,
  );
  await processSpecialEvents(
    eventsData.musicEvents,
    "music",
    startDate,
    endDate,
  );

  // Add tour dates
  await processTourEvents(startDate, endDate);

  // Add touring show dates
  await processTouringShows(startDate, endDate);

  // Add festival entries (show if date range overlaps at all)
  await processFestivals(startDate, endDate);

  mergeDuplicateTourDates();
  allEventsData.sort((a, b) => a.date - b.date);

  renderEventsList(allEventsData);
  fitMapToEvents();
}

function togglePinMapView() {
  mapViewPinned = document.getElementById("pinMapView").checked;

  if (mapViewPinned) {
    // Save current map view
    pinnedMapView = {
      center: map.getCenter(),
      zoom: map.getZoom(),
    };
    console.log("Map view pinned:", pinnedMapView);
  } else {
    pinnedMapView = null;
    console.log("Map view unpinned - fitting to current events");
    // When unpinning, immediately fit to current events
    fitMapToEvents();
  }
}

function fitMapToEvents() {
  // If map view is pinned, don't auto-zoom
  if (mapViewPinned && pinnedMapView) {
    map.setView(pinnedMapView.center, pinnedMapView.zoom);
    return;
  }

  // Get all events with valid coordinates
  const eventsWithCoords = allEventsData.filter((event) => event.coords);

  if (eventsWithCoords.length === 0) {
    // No events with coordinates, zoom to UK
    map.setView([53.0, -2.0], 6);
    return;
  }

  if (eventsWithCoords.length === 1) {
    // Only one event, zoom to it
    const event = eventsWithCoords[0];
    map.setView([event.coords.lat, event.coords.lon], 12);
    return;
  }

  // Multiple events - fit bounds to show all
  const bounds = L.latLngBounds(
    eventsWithCoords.map((event) => [event.coords.lat, event.coords.lon]),
  );
  map.fitBounds(bounds, { padding: [50, 50] });
}

// Color coding: grey for story clubs, green for special events, blue for music
const EVENT_COLORS = {
  session: "#90ee90",
  folk: "#8b4513",
  music: "#443cd7",
  special: "#4CAF50",
  storyclub: "#808080",
  festival: "#1b5e20",
  default: "#808080",
};

const EVENT_MARKER_CONFIG = {
  session: { radius: 8, fillOpacity: 0.8 },
  folk: { radius: 8, fillOpacity: 0.8 },
  music: { radius: 8, fillOpacity: 0.8 },
  special: { radius: 8, fillOpacity: 0.8 },
  storyclub: { radius: 8, fillOpacity: 0.7 },
  festival: { radius: 11, fillOpacity: 0.9 },
  default: { radius: 5, fillOpacity: 0.8 },
};

// Helper function to get event type
function getEventType(eventData) {
  if (eventData.isFestival) return EVENT_TYPES.FESTIVAL;
  if (eventData.isSession) return EVENT_TYPES.SESSION;
  if (eventData.isFolk) return EVENT_TYPES.FOLK;
  if (eventData.isMusic) return EVENT_TYPES.MUSIC;
  if (eventData.isSpecial) return EVENT_TYPES.SPECIAL;
  if (eventData.isStoryclub) return EVENT_TYPES.STORYCLUB;
  return "default";
}

function addEventTypeClasses(element, eventData) {
  const type = getEventType(eventData);
  if (type !== "default") {
    element.classList.add(type);
  }
}

async function addMarkerForEvent(eventData) {
  // Check if latlon is provided directly
  let coords;

  // Accept [lat, lon]
  if (Array.isArray(eventData.latlon) && eventData.latlon.length === 2) {
    coords = {
      lat: eventData.latlon[0],
      lon: eventData.latlon[1],
    };
  }

  // Accept { lat, lon }
  else if (
    eventData.latlon &&
    typeof eventData.latlon === "object" &&
    "lat" in eventData.latlon &&
    "lon" in eventData.latlon
  ) {
    coords = {
      lat: eventData.latlon.lat,
      lon: eventData.latlon.lon,
    };
  } else {
    console.warn(
      `No usable coordinates for event: ${eventData.name} at ${eventData.location}`,
    );
    return;
  }

  if (coords) {
    eventData.coords = coords;

    const eventType = getEventType(eventData);
    const markerColor = EVENT_COLORS[eventType];
    const markerConfig = EVENT_MARKER_CONFIG[eventType];

    const marker = L.circleMarker([coords.lat, coords.lon], {
      radius: markerConfig.radius,
      fillColor: markerColor,
      color: "#fff",
      weight: 2,
      opacity: 1,
      fillOpacity: markerConfig.fillOpacity,
    }).addTo(map);

    marker.bindPopup(createSafePopup(eventData));
    marker.eventData = eventData;

    marker.on("click", () => {
      highlightEvent(eventData);
    });

    markers.push(marker);
  }
}

function updateMapView() {
  // Filter events by map bounds
  const bounds = map.getBounds();
  const visibleEvents = allEventsData.filter((event) => {
    // Always show festivals — they span multiple days/locations and
    // shouldn't be hidden just because the map isn't centred on them
    if (event.isFestival) return true;
    // Always show events with "Various" location and no coords
    if (
      !event.coords &&
      event.location &&
      event.location.startsWith("Various")
    ) {
      return true;
    }
    if (!event.coords) return false;
    return bounds.contains([event.coords.lat, event.coords.lon]);
  });

  console.log(
    `Events in map view: ${visibleEvents.length} of ${allEventsData.length}`,
  );
  renderEventsList(visibleEvents);
}

function toggleEventExpandable(eventId, event) {
  event.stopPropagation(); // Prevent map zoom when clicking the button
  const expandable = document.getElementById(eventId);
  if (expandable) {
    if (expandable.style.display === "none") {
      expandable.style.display = "block";
    } else {
      expandable.style.display = "none";
    }
  }
}

// ICON_SVG — defined in shared_utils.js

// createIcon() — defined in shared_utils.js

function createEventElement(event) {
  const eventDiv = document.createElement("div");
  eventDiv.className = "event";
  addEventTypeClasses(eventDiv, event);
  if (event.isCancelled) {
    eventDiv.classList.add("event-cancelled");
  }

  // Add click handler
  if (event.coords?.lat && event.coords?.lon) {
    eventDiv.onclick = () => zoomToEvent(event.coords.lat, event.coords.lon);
  }

  eventDiv.setAttribute(
    "data-event-id",
    `${escapeHtml(event.name)}-${event.date.getTime()}`,
  );

  // Build event content
  eventDiv.appendChild(createEventHeader(event));

  if (event.performer) {
    eventDiv.appendChild(createPerformerSection(event));
  }

  if (event.location) {
    eventDiv.appendChild(createLocationSection(event));
  }

  eventDiv.appendChild(createDateSection(event));

  const ticketsSection = createTicketsSection(event);
  if (ticketsSection) {
    eventDiv.appendChild(ticketsSection);
  }

  const expandable = createExpandableSection(event);
  if (expandable) {
    eventDiv.appendChild(expandable);
  }

  return eventDiv;
}

function createEventHeader(event) {
  const header = document.createElement("div");
  header.className = "event-name";

  // Club name: link to their own website if they have one, else plain text
  if (event.isStoryclub && event.link) {
    const nameLink = document.createElement("a");
    nameLink.href = sanitizeUrl(event.link);
    nameLink.target = "_blank";
    nameLink.rel = "noopener noreferrer";
    nameLink.textContent = event.name;
    nameLink.style.cssText =
      "color:inherit;text-decoration:none;border-bottom:1px dotted rgba(0,0,0,0.3);";
    nameLink.addEventListener("click", (e) => e.stopPropagation());
    header.appendChild(nameLink);
  } else {
    header.appendChild(document.createTextNode(event.name));
  }

  // Info icon → club page (for any story club with an id)
  if (event.isStoryclub && event.club) {
    const infoLink = document.createElement("a");
    infoLink.href = `new_troubadours_storyclub.html?club=${encodeURIComponent(event.club)}`;
    infoLink.title = `More about ${event.name}`;
    infoLink.style.cssText =
      "display:inline-block;margin-left:7px;vertical-align:middle;text-decoration:none;";
    infoLink.addEventListener("click", (e) => e.stopPropagation());
    infoLink.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" style="width:17px;height:17px;vertical-align:middle;">
      <circle cx="10" cy="10" r="10" fill="#1976d2"/>
      <text x="10" y="15" text-anchor="middle" font-family="Arial,sans-serif" font-size="13" font-weight="bold" fill="white">i</text>
    </svg>`;
    header.appendChild(infoLink);
  }

  // Add badges

  if (event.isSoldOut) {
    header.appendChild(document.createTextNode(" "));
    const soldOutBadge = createBadge("❌ SOLD OUT");
    soldOutBadge.className = "event-badge event-badge-sold-out";
    header.appendChild(soldOutBadge);
  }

  if (event.isCancelled) {
    header.appendChild(document.createTextNode(" "));
    const cancelBadge = createBadge("❌ CANCELLED");
    cancelBadge.className = "event-badge event-badge-cancelled";
    header.appendChild(cancelBadge);
  }

  if (event.isFolk && event.storiesWelcome) {
    header.appendChild(document.createTextNode(" "));
    header.appendChild(createBadge("📖 Stories Welcome"));
  }

  if (event.isFolk && event.byInvitation) {
    header.appendChild(document.createTextNode(" "));
    header.appendChild(createBadge("By Invitation"));
  }

  if (event.isTouringShow) {
    header.appendChild(document.createTextNode(" "));
    header.appendChild(createBadge("🎭 Touring Show"));
  }

  // Add icons
  header.appendChild(createIconsContainer(event));

  return header;
}

function createIconsContainer(event) {
  const container = document.createElement("span");

  if (event.link) {
    createIcon(container, "website", event.link);
  }

  if (event.email) {
    createIcon(container, "email", `mailto:${event.email}`);
  }

  if (event.facebook) {
    createIcon(container, "facebook", normaliseFacebookUrl(event.facebook));
  }

  return container;
}

function createPerformerSection(event) {
  const performerDiv = document.createElement("div");
  performerDiv.className = "event-performer";

  // Primary link: performer's own website (unchanged behaviour)
  if (event.performer_url) {
    const safePerformerUrl = sanitizeUrl(event.performer_url);
    if (safePerformerUrl) {
      const performerLink = document.createElement("a");
      performerLink.href = safePerformerUrl;
      performerLink.target = "_blank";
      performerLink.className = "event-performer-link";
      performerLink.onclick = (e) => e.stopPropagation();
      const performerStrong = document.createElement("strong");
      performerStrong.textContent = event.performer;
      performerLink.appendChild(performerStrong);
      performerDiv.appendChild(performerLink);
    } else {
      performerDiv.textContent = event.performer;
    }
  } else {
    performerDiv.textContent = event.performer;
  }

  // Secondary link: performer profile page (small icon, only if we have a performer_id)
  if (event.performer_id) {
    const perfPageLink = document.createElement("a");
    perfPageLink.href = `new_troubadours_performers.html?performer=${encodeURIComponent(event.performer_id)}`;
    perfPageLink.className = "venue-page-link";
    perfPageLink.title = "View performer profile";
    perfPageLink.textContent = "i";
    perfPageLink.onclick = (e) => e.stopPropagation();
    performerDiv.appendChild(perfPageLink);
  }

  return performerDiv;
}

function createLocationSection(event) {
  // createVenueElement() defined in shared_utils.js
  // Build a compatible venue-like object from event fields
  // Also append a venue page link if we have a venue_id
  const venueEl = createVenueElement({
    url: event.venue_url || null,
    full_address: event.location || "",
    name: event.location || "",
  });
  if (event.venue_id) {
    const venuePageLink = document.createElement("a");
    venuePageLink.href = `new_troubadours_venues.html?venue=${encodeURIComponent(event.venue_id)}`;
    venuePageLink.className = "venue-page-link";
    venuePageLink.title = "View venue page";
    venuePageLink.textContent = "i";
    venuePageLink.onclick = (e) => e.stopPropagation();
    venueEl.appendChild(venuePageLink);
  }
  return venueEl;
}

function createDateSection(event) {
  // DAYS_OF_WEEK, MONTHS_SHORT — module-level constants above
  const dateDiv = document.createElement("div");
  dateDiv.className = "event-date";

  const dayName = DAYS_OF_WEEK[event.date.getDay()];
  const day = event.date.getDate();
  const month = MONTHS_SHORT[event.date.getMonth()];
  const year = event.date.getFullYear();
  const scheduleText = event.schedule ? ` (${event.schedule})` : "";

  let dateText = `${dayName}, ${day} ${month} ${year}`;
  if (!event.isRescheduled) {
    dateText += scheduleText;
  }

  if (event.isCancelled) {
    const cancelledSpan = document.createElement("span");
    cancelledSpan.className = "event-date-cancelled";
    cancelledSpan.textContent = `${dayName}, ${day} ${month} ${year} ${scheduleText}`;
    dateDiv.appendChild(cancelledSpan);

    if (event.rescheduledTo) {
      const rescheduledSpan = document.createElement("span");
      rescheduledSpan.className = "event-date-rescheduled-notice";
      rescheduledSpan.textContent = ` (Rescheduled to ${event.rescheduledToStr})`;
      dateDiv.appendChild(rescheduledSpan);
    }
  } else {
    dateDiv.appendChild(document.createTextNode(dateText));

    if (event.isRescheduled) {
      const usuallySpan = document.createElement("span");
      usuallySpan.className = "event-date-usually";
      usuallySpan.textContent = ` (usually ${event.schedule})`;
      dateDiv.appendChild(usuallySpan);
    }
  }

  if (Array.isArray(event.show_times) && event.show_times.length > 0) {
    // Multiple show-times on same day/venue — render as "• 3.30pm / 7.30pm"
    // with per-show price appended if it differs between shows.
    const allSamePrice = event.show_times.every(
      (st) => (st.price || "") === (event.show_times[0].price || ""),
    );
    const timeParts = event.show_times.map((st) => {
      let part = st.time || "";
      if (!allSamePrice && st.price) part += ` (${st.price})`;
      return part;
    });
    dateDiv.appendChild(document.createTextNode(` • ${timeParts.join(" / ")}`));
    if (allSamePrice && event.show_times[0].price) {
      dateDiv.appendChild(
        document.createTextNode(` • ${event.show_times[0].price}`),
      );
    }
  } else {
    if (event.time) {
      dateDiv.appendChild(document.createTextNode(` • ${event.time}`));
    }
    if (event.price) {
      dateDiv.appendChild(document.createTextNode(` • ${event.price}`));
    }
  }

  return dateDiv;
}

function createTicketsSection(event) {
  if (!event.isSpecial && !event.isMusic) return null;

  // Multi-show case: show_times holds [{time, ticket_url, price}, ...]
  if (Array.isArray(event.show_times) && event.show_times.length > 0) {
    const ticketsDiv = document.createElement("div");
    ticketsDiv.className = "event-tickets";

    // Tour VIEW link(s) first — same for all shows
    const tourIdList = event.tour_ids || (event.tour_id ? [event.tour_id] : []);
    const uniqueTourIds = [...new Set(tourIdList)];
    for (let i = 0; i < uniqueTourIds.length; i++) {
      if (i > 0) {
        appendSeparator(ticketsDiv);
      }
      const tid = uniqueTourIds[i];
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

    // Per-show ticket links
    const showsWithTickets = event.show_times.filter(
      (st) => st.ticket_url && sanitizeUrl(st.ticket_url),
    );
    if (showsWithTickets.length > 0) {
      // Separator after tour links if any
      if (uniqueTourIds.length > 0) {
        appendSeparator(ticketsDiv);
      }
      // Label row: "Tickets:" then per-show links
      ticketsDiv.appendChild(document.createTextNode("Tickets: "));
      showsWithTickets.forEach((st, i) => {
        if (i > 0) {
          appendSeparator(ticketsDiv);
        }
        const safeUrl = sanitizeUrl(st.ticket_url);
        const a = document.createElement("a");
        a.href = safeUrl;
        a.target = "_blank";
        a.textContent = st.time ? `${st.time} show` : `Show ${i + 1}`;
        a.addEventListener("click", (e) => e.stopPropagation());
        ticketsDiv.appendChild(a);
      });
    }

    return ticketsDiv.children.length > 0 ? ticketsDiv : null;
  }

  // Single-show fallback
  // createTicketsElement() defined in shared_utils.js
  return createTicketsElement(event, event.isCancelled, event.isSoldOut);
}

function getExpandableContent(event) {
  // Get description using the proper lookup function
  const description = getEventDescription(event);

  const flyers = [];

  // event flyer
  if (event.event_flyer && event.event_flyer.trim()) {
    flyers.push({
      path: event.event_flyer,
      basePath: "./storyclub_assets/event_flyers/",
      altSuffix: "event flyer",
    });
  }

  // club flyer
  if (event.club_flyer && event.club_flyer.trim()) {
    flyers.push({
      path: event.club_flyer,
      basePath: "./storyclub_assets/club_flyers/",
      altSuffix: "club flyer",
    });
  }

  // Add tour flyer - check event first, then tour lookup
  let tourFlyer = event.tour_flyer;
  if (!tourFlyer && event.tour_id && toursLookup[event.tour_id]) {
    tourFlyer = toursLookup[event.tour_id].tour_flyer;
  }

  // tour flyer
  if (tourFlyer && tourFlyer.trim()) {
    flyers.push({
      path: tourFlyer,
      basePath: "./storyclub_assets/event_flyers/",
      altSuffix: "tour flyer",
    });
  }

  return {
    hasDescription: Boolean(description?.trim()),
    hasFlyers: flyers.length > 0,
    description,
    flyers,
  };
}

function createExpandableSection(event) {
  const { hasDescription, hasFlyers, description, flyers } =
    getExpandableContent(event);

  // Check if performer has a bio
  const performer_id = event.performer_id;
  const hasBio = performer_id && performersLookup[performer_id]?.bio;

  // Return null if no expandable content at all
  if (!hasDescription && !hasFlyers && !hasBio) {
    return null;
  }

  const container = document.createElement("div");

  // Create unique IDs for this event's expandables
  const bioExpandableId = `event-bio-${Math.random().toString(36).substr(2, 9)}`;
  const infoExpandableId = `event-info-${Math.random().toString(36).substr(2, 9)}`;
  const flyersExpandableId = `event-flyers-${Math.random().toString(36).substr(2, 9)}`;

  // Helper function to toggle expandables (close others)
  const toggleExpandable = (targetId) => {
    const bioDiv = document.getElementById(bioExpandableId);
    const infoDiv = document.getElementById(infoExpandableId);
    const flyersDiv = document.getElementById(flyersExpandableId);

    if (targetId === bioExpandableId) {
      const isCurrentlyOpen = bioDiv.style.display === "block";
      bioDiv.style.display = isCurrentlyOpen ? "none" : "block";
      if (infoDiv) infoDiv.style.display = "none";
      if (flyersDiv) flyersDiv.style.display = "none";
    } else if (targetId === infoExpandableId) {
      const isCurrentlyOpen = infoDiv.style.display === "block";
      infoDiv.style.display = isCurrentlyOpen ? "none" : "block";
      if (bioDiv) bioDiv.style.display = "none";
      if (flyersDiv) flyersDiv.style.display = "none";
    } else if (targetId === flyersExpandableId) {
      const isCurrentlyOpen = flyersDiv.style.display === "block";
      flyersDiv.style.display = isCurrentlyOpen ? "none" : "block";
      if (bioDiv) bioDiv.style.display = "none";
      if (infoDiv) infoDiv.style.display = "none";
    }
  };

  // Create button container
  const buttonContainer = document.createElement("div");
  buttonContainer.className = "expand-button-row";

  // More info button (only if description exists)
  if (hasDescription) {
    const expandBtn = document.createElement("div");
    expandBtn.className = "event-expand-btn";
    expandBtn.textContent = "More info...";
    expandBtn.onclick = (e) => {
      e.stopPropagation();
      toggleExpandable(infoExpandableId);
    };
    buttonContainer.appendChild(expandBtn);
  }

  // Flyer(s) button (only if flyers exist)
  if (hasFlyers) {
    const flyersBtn = document.createElement("div");
    flyersBtn.className = "event-expand-btn";
    flyersBtn.textContent = flyers.length > 1 ? "Flyers" : "Flyer";
    flyersBtn.onclick = (e) => {
      e.stopPropagation();
      toggleExpandable(flyersExpandableId);
    };
    buttonContainer.appendChild(flyersBtn);
  }

  // Bio button (if bio exists)
  if (hasBio) {
    const bioBtn = document.createElement("div");
    bioBtn.className = "event-expand-btn";
    bioBtn.textContent = "Bio";
    bioBtn.onclick = (e) => {
      e.stopPropagation();
      toggleExpandable(bioExpandableId);
    };
    buttonContainer.appendChild(bioBtn);
  }

  container.appendChild(buttonContainer);

  // Create bio expandable content
  if (hasBio) {
    const bioExpandableDiv = document.createElement("div");
    bioExpandableDiv.className = "event-expandable";
    bioExpandableDiv.id = bioExpandableId;
    bioExpandableDiv.style.display = "none";

    const bioDiv = document.createElement("div");
    bioDiv.className = "event-description";

    const bio = performersLookup[performer_id].bio;
    appendParagraphs(bioDiv, bio);

    bioExpandableDiv.appendChild(bioDiv);
    container.appendChild(bioExpandableDiv);
  }

  // Create info expandable content (description only)
  if (hasDescription) {
    const expandableDiv = document.createElement("div");
    expandableDiv.className = "event-expandable";
    expandableDiv.id = infoExpandableId;
    expandableDiv.style.display = "none";

    const descDiv = document.createElement("div");
    descDiv.className = "event-description";

    appendParagraphs(descDiv, description);

    expandableDiv.appendChild(descDiv);
    container.appendChild(expandableDiv);
  }

  // Create flyers expandable content (flyers only)
  if (hasFlyers) {
    const flyersExpandableDiv = document.createElement("div");
    flyersExpandableDiv.className = "event-expandable";
    flyersExpandableDiv.id = flyersExpandableId;
    flyersExpandableDiv.style.display = "none";

    flyers.forEach((flyer, index) => {
      if (flyer.path) {
        const img = document.createElement("img");
        img.alt = `${event.name} ${flyer.altSuffix}`;
        const flyerPath = flyer.path.replace(/[^a-zA-Z0-9._-]/g, "");
        img.src = `${flyer.basePath}${flyerPath}`;
        img.className = "event-flyer-image";
        if (index > 0) {
          img.classList.add("event-flyer-subsequent");
        }
        flyersExpandableDiv.appendChild(img);
      }
    });

    container.appendChild(flyersExpandableDiv);
  }

  return container;
}

function createFestivalElement(fest) {
  const div = document.createElement("div");
  // CSS class "festival" drives styling; no "special" class so filter logic stays clean
  div.className = "event festival";
  if (fest.primary_type === "music") div.classList.add("festival-music");
  div.setAttribute("data-event-id", `festival-${fest.festival_id}`);

  if (fest.coords?.lat && fest.coords?.lon) {
    div.onclick = () => zoomToEvent(fest.coords.lat, fest.coords.lon);
  }

  // --- Name line + badge + icons ---
  const nameDiv = document.createElement("div");
  nameDiv.className = "event-name";

  const nameText = document.createTextNode(fest.name);
  nameDiv.appendChild(nameText);

  const badge = document.createElement("span");
  badge.className = "event-badge festival-badge";
  badge.textContent = "🎪 Festival";
  nameDiv.appendChild(badge);

  // Website / facebook icons
  const icons = document.createElement("span");
  if (fest.website) createIcon(icons, "website", fest.website);
  if (fest.facebook)
    createIcon(icons, "facebook", normaliseFacebookUrl(fest.facebook));
  nameDiv.appendChild(icons);
  div.appendChild(nameDiv);

  // --- Performers ---
  if (fest.performer) {
    const perfDiv = document.createElement("div");
    perfDiv.className = "event-performer festival-performers";
    perfDiv.textContent = fest.performer;
    div.appendChild(perfDiv);
  }

  // --- Venue ---
  if (fest.location) {
    div.appendChild(createLocationSection(fest));
  }

  // --- Date range ---
  const dateDiv = document.createElement("div");
  dateDiv.className = "event-date festival-date-range";
  const s = fest.start_date;
  const e = fest.end_date;
  const sameMonth =
    s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear();
  const dayCount = Math.round((e - s) / 86400000) + 1;
  const rangeStr = sameMonth
    ? `${s.getDate()}–${e.getDate()} ${MONTHS_SHORT[e.getMonth()]} ${e.getFullYear()}`
    : `${s.getDate()} ${MONTHS_SHORT[s.getMonth()]} – ${e.getDate()} ${MONTHS_SHORT[e.getMonth()]} ${e.getFullYear()}`;
  dateDiv.appendChild(document.createTextNode(rangeStr));
  const daySpan = document.createElement("span");
  daySpan.className = "festival-day-count";
  daySpan.textContent = ` · ${dayCount} day${dayCount !== 1 ? "s" : ""}`;
  dateDiv.appendChild(daySpan);
  div.appendChild(dateDiv);

  // --- Tickets + programme link ---
  const ticketDiv = document.createElement("div");
  ticketDiv.className = "event-tickets";

  if (fest.ticket_url) {
    const safeUrl = sanitizeUrl(fest.ticket_url);
    if (safeUrl) {
      const a = document.createElement("a");
      a.href = safeUrl;
      a.target = "_blank";
      a.textContent = "🎟 Tickets";
      a.onclick = (ev) => ev.stopPropagation();
      ticketDiv.appendChild(a);
      const sep = document.createElement("span");
      sep.className = "separator";
      sep.textContent = "·";
      ticketDiv.appendChild(sep);
    }
  }

  const progLink = document.createElement("a");
  progLink.href = `new_troubadours_festival.html?festival=${fest.festival_id}`;
  progLink.className = "festival-programme-link";
  progLink.textContent = fest.schedule_populated
    ? "📋 Full programme →"
    : "📋 Programme TBA →";
  progLink.onclick = (ev) => ev.stopPropagation();
  ticketDiv.appendChild(progLink);
  div.appendChild(ticketDiv);

  return div;
}

function renderEventsList(eventsToShow) {
  const eventsList = document.getElementById("eventsList");

  if (eventsToShow.length === 0) {
    eventsList.innerHTML =
      '<div class="no-events">No events in this view</div>';
    return;
  }

  console.log(`Rendering ${eventsToShow.length} events`);
  eventsList.innerHTML = "";

  eventsToShow.forEach((event) => {
    const el = event.isFestival
      ? createFestivalElement(event)
      : createEventElement(event);
    eventsList.appendChild(el);
  });

  filterEvents();
}

function zoomToEvent(lat, lon) {
  if (lat && lon) {
    map.setView([lat, lon], 13);
  }
}

function highlightEvent(eventData) {
  const eventId = `${eventData.name}-${eventData.date.getTime()}`;
  document
    .querySelectorAll(".event")
    .forEach((el) => el.classList.remove("highlighted"));
  const eventEl = document.querySelector(`[data-event-id="${eventId}"]`);
  if (eventEl) {
    eventEl.classList.add("highlighted");
    eventEl.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function formatDate(date) {
  // DAYS_OF_WEEK, MONTHS_SHORT — module-level constants above
  return `${DAYS_OF_WEEK[date.getDay()]}, ${date.getDate()} ${MONTHS_SHORT[date.getMonth()]} ${date.getFullYear()}`;
}

// formatDateForInput() — defined in shared_utils.js

function shouldShowEvent(eventData, filters) {
  const { storyclubsOn, specialOn, showMusic, showFolk, showSessions } =
    filters;

  if (eventData.isFestival && specialOn) return true;
  if (storyclubsOn && eventData.isStoryclub) return true;
  if (specialOn && eventData.isSpecial) return true;
  if (showMusic && eventData.isMusic) return true;
  if (showFolk && eventData.isFolk) return true;
  if (showSessions && eventData.isSession) return true;

  return false;
}

function filterEvents() {
  const searchTerm = document.getElementById("searchInput").value.toLowerCase();
  const hideCancelled = document.getElementById("hideCancelled").checked;
  const filters = {
    storyclubsOn: document.getElementById("storyclubsOn").checked,
    specialOn: document.getElementById("specialOn").checked,
    showMusic: document.getElementById("showMusic").checked,
    showFolk: document.getElementById("showFolk").checked,
    showSessions: document.getElementById("showSessions").checked,
  };

  // Filter event list items
  document.querySelectorAll(".event").forEach((event) => {
    const isStoryclub = event.classList.contains("storyclub");
    const isSpecial = event.classList.contains("special");
    const isFestival = event.classList.contains("festival");
    const isMusic = event.classList.contains("music");
    const isFolk = event.classList.contains("folk");
    const isSession = event.classList.contains("session");
    const isCancelled = event.classList.contains("event-cancelled");

    const eventData = {
      isStoryclub,
      isSpecial,
      isFestival,
      isMusic,
      isFolk,
      isSession,
    };
    let visible = shouldShowEvent(eventData, filters);

    if (visible && hideCancelled && isCancelled) {
      visible = false;
    }

    if (visible && searchTerm) {
      visible = event.textContent.toLowerCase().includes(searchTerm);
    }

    event.classList.toggle("hidden", !visible);
  });

  // Filter map markers
  markers.forEach((marker) => {
    let visible = shouldShowEvent(marker.eventData, filters);

    if (visible && hideCancelled && marker.eventData.isCancelled) {
      visible = false;
    }

    if (visible && searchTerm) {
      const searchableText =
        `${marker.eventData.name} ${marker.eventData.location} ${marker.eventData.performer || ""}`.toLowerCase();
      visible = searchableText.includes(searchTerm);
    }

    if (visible) {
      marker.setStyle({ opacity: 1, fillOpacity: 0.8 });
    } else {
      marker.setStyle({ opacity: 0, fillOpacity: 0 });
    }
  });

  const visibleCount = document.querySelectorAll(".event:not(.hidden)").length;
  console.log(`Visible events after filtering: ${visibleCount}`);
}

function clearActiveButtons() {
  document
    .querySelectorAll(".button-group button")
    .forEach((btn) => btn.classList.remove("active"));
}

/**
 * Read the current date inputs and return a resolved { startDate, endDate }
 * pair, using end-of-start's-week as the endDate fallback.
 * Returns null if startDate input is empty.
 */
function getActiveDateRange() {
  const startInput = document.getElementById("startDate").value;
  const endInput = document.getElementById("endDate").value;
  if (!startInput) return null;

  const startDate = new Date(startInput);
  const endDate = endInput
    ? new Date(endInput)
    : getWeekEnd(getWeekStart(startDate));
  return { startDate, endDate };
}

function clearSearch() {
  document.getElementById("searchInput").value = "";
  const range = getActiveDateRange();
  if (range) {
    displayEvents(range.startDate, range.endDate);
    clearActiveButtons();
  } else {
    filterEvents();
  }
}

/**
 * Search recurring events (storyclubs, folk nights, Irish sessions) for
 * searchAllUpcoming(). Finds the first upcoming occurrence of any event
 * whose name/location/club matches searchTerm, then adds it to allEventsData.
 *
 * Note: the resolveEventVenue() call that previously appeared inline here
 * was dead code — createEventData() calls it internally and the
 * destructured variables were never used.
 *
 * @param {object[]} list       - Array of recurring event objects.
 * @param {string}   eventType  - e.g. "storyclub", "folk", "session".
 * @param {string}   searchTerm - Lower-cased search string.
 * @param {Date}     today      - Range start.
 * @param {Date}     futureDate - Range end.
 */
async function searchRecurringEvents(
  list,
  eventType,
  searchTerm,
  today,
  futureDate,
) {
  for (const event of list || []) {
    const searchableText = buildRecurringEventSearchText(event);
    if (searchableText.includes(searchTerm)) {
      const dates = parseSchedule(event.schedule, today, futureDate);
      if (dates.length > 0) {
        const eventData = createEventData(event, dates[0], eventType);
        allEventsData.push(eventData);
        await addMarkerForEvent(eventData);
      }
    }
  }
}

async function searchAllUpcoming() {
  const searchTerm = document
    .getElementById("searchInput")
    .value.toLowerCase()
    .trim();

  if (!searchTerm) {
    alert("Please enter a search term first");
    return;
  }

  if (!eventsData) {
    console.error("Events data not loaded");
    return;
  }

  // getTodayMidnight() defined in shared_utils.js
  const today = getTodayMidnight();

  // Search 2 years into the future
  const futureDate = new Date(today);
  futureDate.setFullYear(futureDate.getFullYear() + 2);

  // Clear the list and markers
  allEventsData = [];
  markers.forEach((marker) => map.removeLayer(marker));
  markers = [];

  // The checkboxes will filter visibility after loading

  // Search recurring events by type
  await searchRecurringEvents(
    eventsData.events,
    "storyclub",
    searchTerm,
    today,
    futureDate,
  );
  await searchRecurringEvents(
    eventsData.folkNights,
    "folk",
    searchTerm,
    today,
    futureDate,
  );
  await searchRecurringEvents(
    eventsData.irishSessions,
    "session",
    searchTerm,
    today,
    futureDate,
  );

  // Search specific events (story shows)
  for (const event of eventsData.specificEvents || []) {
    const hasDatetimes =
      Array.isArray(event.datetimes) && event.datetimes.length > 0;
    if (!hasDatetimes && !event.date) continue;

    if (buildEventSearchText(event).includes(searchTerm)) {
      const expanded = expandDatetimes(event);
      for (const { flatEvent, date: eventDate } of expanded) {
        if (!eventDate) continue;
        if (eventDate >= today && eventDate <= futureDate) {
          const eventData = createEventData(flatEvent, eventDate, "special");
          allEventsData.push(eventData);
          await addMarkerForEvent(eventData);
        }
      }
    }
  }

  // Search music events
  for (const event of eventsData.musicEvents || []) {
    if (!event.date) continue;
    // parseDateString() defined in shared_utils.js
    const eventDate = parseDateString(event.date);
    if (!eventDate) continue;
    if (eventDate >= today && eventDate <= futureDate) {
      if (buildEventSearchText(event).includes(searchTerm)) {
        const eventData = createEventData(event, eventDate, "music");
        allEventsData.push(eventData);
        await addMarkerForEvent(eventData);
      }
    }
  }

  // Search tour events (special and music tours)
  const tours = eventsData.tours || {};
  for (const tourKey in tours) {
    const tour = tours[tourKey];

    // Skip tours that are neither music nor special
    if (!tour.isMusic && !tour.isSpecial) continue;

    // Determine event type (same as processTourEvents)
    const eventType = tour.isMusic ? "music" : "special";

    for (const tourDate of tour.tour_dates || []) {
      if (!tourDate.date) continue;
      // parseDateString() defined in shared_utils.js
      const eventDate = parseDateString(tourDate.date);
      if (!eventDate) continue;
      if (eventDate >= today && eventDate <= futureDate) {
        if (buildTourSearchText(tour, tourDate).includes(searchTerm)) {
          const mergedEvent = buildTourMergedEvent(tour, tourKey, tourDate);
          const eventData = createEventData(mergedEvent, eventDate, eventType);
          allEventsData.push(eventData);
          await addMarkerForEvent(eventData);
        }
      }
    }
  }

  const touringShows = eventsData.touring_shows || {};
  for (const showKey in touringShows) {
    const show = touringShows[showKey];
    const eventType = show.isSpecial ? "special" : "storyclub";

    for (const showDate of show.show_dates || []) {
      if (!showDate.date) continue;
      // parseDateString() defined in shared_utils.js
      const eventDate = parseDateString(showDate.date);
      if (!eventDate) continue;
      if (eventDate >= today && eventDate <= futureDate) {
        if (buildShowSearchText(show, showDate).includes(searchTerm)) {
          const mergedEvent = buildShowMergedEvent(show, showKey, showDate);
          const eventData = createEventData(mergedEvent, eventDate, eventType);
          allEventsData.push(eventData);
          await addMarkerForEvent(eventData);
        }
      }
    }
  }

  // Search festivals
  const festivals = eventsData.festivals || {};
  for (const [festKey, fest] of Object.entries(festivals)) {
    const festStart = parseDateString(fest.start_date);
    const festEnd = parseDateString(fest.end_date);
    if (!festStart || !festEnd) continue;
    if (festStart > futureDate || festEnd < today) continue;

    // Build searchable text from name, performers, venue
    const venue = venuesLookup[fest.venue_id] || {};
    const performerNames = (fest.performers || [])
      .map((p) => performersLookup[p.performer_id]?.name || "")
      .join(" ");
    const festSearchText =
      `${fest.name} ${fest.short_name || ""} ${performerNames} ${venue.name || ""} ${venue.full_address || ""}`.toLowerCase();

    if (festSearchText.includes(searchTerm)) {
      const festData = buildFestivalData(
        festKey,
        fest,
        venue,
        festStart,
        festEnd,
      );
      allEventsData.push(festData);
      await addMarkerForEvent(festData);
    }
  }

  mergeDuplicateTourDates();
  allEventsData.sort((a, b) => a.date - b.date);

  // Update the date inputs to reflect the search range
  updateDateInputs(today, futureDate);

  // Clear any active week button
  clearActiveButtons();

  renderEventsList(allEventsData);
  fitMapToEvents();

  if (allEventsData.length === 0) {
    const eventsList = document.getElementById("eventsList");
    eventsList.innerHTML = `<div class="no-events">No upcoming events found matching "${searchTerm}"</div>`;
  }
}
function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff));
}

function getWeekEnd(weekStart) {
  const end = new Date(weekStart);
  end.setDate(end.getDate() + 6);
  return end;
}

function setActiveMode(mode) {
  clearActiveButtons();
  if (mode === "thisWeek")
    document.getElementById("thisWeekBtn").classList.add("active");
  else if (mode === "nextWeek1")
    document.getElementById("nextWeekBtn").classList.add("active");
  else if (mode === "nextWeek2")
    document.getElementById("afterThatWeekBtn").classList.add("active");
  else if (mode === "nextWeek3")
    document.getElementById("andAnotherWeekBtn").classList.add("active");
  else if (mode === "lastWeek1")
    document.getElementById("lastWeekBtn").classList.add("active");
}

function updateDateInputs(startDate, endDate) {
  // formatDateForInput() defined in shared_utils.js
  document.getElementById("startDate").value = formatDateForInput(startDate);
  document.getElementById("endDate").value = formatDateForInput(endDate);
}

function showThisWeek() {
  const today = new Date();
  const weekStart = getWeekStart(today);
  const weekEnd = getWeekEnd(weekStart);
  updateDateInputs(weekStart, weekEnd);
  displayEvents(weekStart, weekEnd);
  setActiveMode("thisWeek");
}

function showWeek(weeksAhead = 1) {
  const today = new Date();
  const thisWeekStart = getWeekStart(today);
  const targetWeekStart = new Date(thisWeekStart);
  targetWeekStart.setDate(targetWeekStart.getDate() + 7 * weeksAhead);
  const targetWeekEnd = getWeekEnd(targetWeekStart);
  updateDateInputs(targetWeekStart, targetWeekEnd);
  displayEvents(targetWeekStart, targetWeekEnd);
  setActiveMode(
    weeksAhead > 0
      ? `nextWeek${weeksAhead}`
      : `lastWeek${Math.abs(weeksAhead)}`,
  );
}

function showDateRange(clearActiveButton = true) {
  const range = getActiveDateRange();
  if (!range) {
    alert("Please select at least a start date");
    return;
  }
  displayEvents(range.startDate, range.endDate);
  if (clearActiveButton) {
    clearActiveButtons();
  }
}

// formatDateForInput() — defined in shared_utils.js
/**
 * Parse the current start/end date inputs into Date objects.
 * Returns { startDate, endDate } — endDate is null if the field is empty.
 */
function parseDateInputs() {
  const startInput = document.getElementById("startDate").value;
  const endInput = document.getElementById("endDate").value;
  if (!startInput) return null;

  const [sy, sm, sd] = startInput.split("-").map(Number);
  const startDate = new Date(sy, sm - 1, sd);
  const endDate = endInput
    ? (() => {
        const [ey, em, ed] = endInput.split("-").map(Number);
        return new Date(ey, em - 1, ed);
      })()
    : null;
  return { startDate, endDate };
}

function handleStartDateChange() {
  const parsed = parseDateInputs();
  if (!parsed) return;
  const { startDate, endDate } = parsed;

  if (endDate && startDate > endDate) {
    document.getElementById("endDate").value = formatDateForInput(
      getWeekEnd(getWeekStart(startDate)),
    );
  }
  showDateRange(true);
}

function handleEndDateChange() {
  const parsed = parseDateInputs();
  if (!parsed) return;
  const { startDate, endDate } = parsed;

  if (endDate && endDate < startDate) {
    document.getElementById("startDate").value = formatDateForInput(
      getWeekStart(endDate),
    );
  }
  showDateRange(true);
}

function generateShareableURL(startDate, endDate) {
  // formatDateForInput() defined in shared_utils.js
  const params = new URLSearchParams();
  params.set("start", formatDateForInput(startDate));
  params.set("end", formatDateForInput(endDate));

  // Add filter states
  params.set(
    "storyclubs",
    document.getElementById("storyclubsOn").checked ? "1" : "0",
  );
  params.set(
    "special",
    document.getElementById("specialOn").checked ? "1" : "0",
  );
  params.set("music", document.getElementById("showMusic").checked ? "1" : "0");
  params.set("folk", document.getElementById("showFolk").checked ? "1" : "0");
  params.set(
    "sessions",
    document.getElementById("showSessions").checked ? "1" : "0",
  );
  params.set(
    "hidecancelled",
    document.getElementById("hideCancelled").checked ? "1" : "0",
  );

  const center = map.getCenter();
  const lat = center.lat;
  const lng = center.lng;
  const zoom = map.getZoom();
  params.set("lat", lat);
  params.set("lng", lng);
  params.set("zoom", zoom);
  params.set(
    "pinmap",
    document.getElementById("pinMapView").checked ? "1" : "0",
  );

  const searchTerm = document.getElementById("searchInput").value.trim();
  if (searchTerm) {
    params.set("q", searchTerm);
  }

  return `${window.location.origin}${window.location.pathname}?${params.toString()}`;
}

async function copyShareableLink() {
  const range = getActiveDateRange();
  if (!range) {
    alert("Please select a date range first");
    return;
  }

  const shareableURL = generateShareableURL(range.startDate, range.endDate);

  try {
    await navigator.clipboard.writeText(shareableURL);
    const feedback = document.getElementById("copyFeedback");
    feedback.style.display = "inline";
    setTimeout(() => {
      feedback.style.display = "none";
    }, 2000);
  } catch (err) {
    // Fallback for older browsers
    const tempInput = document.createElement("input");
    tempInput.value = shareableURL;
    document.body.appendChild(tempInput);
    tempInput.select();
    document.execCommand("copy");
    document.body.removeChild(tempInput);

    const feedback = document.getElementById("copyFeedback");
    feedback.style.display = "inline";
    setTimeout(() => {
      feedback.style.display = "none";
    }, 2000);
  }
}

function getEventURLParams() {
  const params = new URLSearchParams(window.location.search);
  const start = params.get("start");
  const end = params.get("end");

  if (start) {
    const storyclubs = params.get("storyclubs") === "1";
    const special = params.get("special") === "1";
    const music = params.get("music") === "1";
    const folk = params.get("folk") === "1";
    const sessions = params.get("sessions") === "1";
    const pinmap = params.get("pinmap") === "1";
    // hidecancelled defaults to true (checked) when absent from URL
    const hidecancelledParam = params.get("hidecancelled");
    const hidecancelled =
      hidecancelledParam === null ? true : hidecancelledParam === "1";
    const zoom = params.get("zoom") ? parseInt(params.get("zoom"), 10) : 6;
    const lat = params.get("lat") ? parseFloat(params.get("lat")) : 53.0;
    const lng = params.get("lng") ? parseFloat(params.get("lng")) : 0.0;
    // If none are selected, default storyclubs and special to true
    const noneSelected =
      !storyclubs && !special && !music && !folk && !sessions;

    const q = params.get("q");

    return {
      startDate: new Date(start),
      endDate: end ? new Date(end) : null,
      storyclubs: noneSelected ? true : storyclubs,
      special: noneSelected ? true : special,
      folk: noneSelected ? true : folk,
      sessions: noneSelected ? true : sessions,
      music: music,
      pinmap: pinmap,
      hidecancelled: hidecancelled,
      lat: lat,
      lng: lng,
      zoom: zoom,
      searchTerm: q,
    };
  }
  return null;
}

function toggleTabContent(tabId, event) {
  const allTabs = document.querySelectorAll(".tab-content-area");
  const clickedTab = document.getElementById(tabId);
  const allButtons = document.querySelectorAll(".header-tab-button");

  // If clicking the already-open tab, close it
  if (clickedTab.style.display === "block") {
    clickedTab.style.display = "none";
    event.target.classList.remove("active");
  } else {
    // Close all tabs
    allTabs.forEach((tab) => (tab.style.display = "none"));
    allButtons.forEach((btn) => btn.classList.remove("active"));

    // Open clicked tab
    clickedTab.style.display = "block";
    event.target.classList.add("active");
  }
}

// Initialize
window.addEventListener("load", async () => {
  const result = await loadEventsData();
  if (!result) {
    console.error("Failed to load events data");
    return;
  }
  eventsData = result.eventsData;
  toursLookup = result.toursLookup;
  venuesLookup = result.venuesLookup;
  performersLookup = result.performersLookup;

  // Log event-guide-specific counts
  console.log(`  - ${eventsData.events?.length || 0} recurring events`);
  console.log(`  - ${eventsData.specificEvents?.length || 0} specific events`);
  console.log(`  - ${eventsData.musicEvents?.length || 0} music events`);
  console.log(`  - ${eventsData.folkNights?.length || 0} folk nights`);
  console.log(`  - ${eventsData.irishSessions?.length || 0} Irish sessions`);
  console.log(
    `  - ${Object.keys(eventsData.touring_shows || {}).length} touring shows`,
  );
  console.log(
    `  - ${Object.keys(eventsData.festivals || {}).length} festivals`,
  );

  // Flag events with missing geocode
  const checkMissing = (eventsList, label) => {
    const missing = eventsList?.filter((e) => e.geocode_missing) || [];
    if (missing.length > 0) {
      console.warn(`⚠ ${missing.length} ${label} missing geocode data:`);
      missing.forEach((e) => console.warn(`  - ${e.name}: ${e.location}`));
    }
  };
  checkMissing(eventsData.events, "recurring events");
  checkMissing(eventsData.specificEvents, "specific events");
  checkMissing(eventsData.musicEvents, "music events");

  map = initMap("map", updateMapView);

  // Check for URL parameters first
  const urlParams = getEventURLParams();
  if (urlParams) {
    const startDate = urlParams.startDate;
    const endDate = urlParams.endDate || getWeekEnd(getWeekStart(startDate));

    document.getElementById("storyclubsOn").checked = urlParams.storyclubs;
    document.getElementById("specialOn").checked = urlParams.special;
    document.getElementById("showMusic").checked = urlParams.music;
    document.getElementById("showFolk").checked = urlParams.folk;
    document.getElementById("showSessions").checked = urlParams.sessions;

    updateDateInputs(startDate, endDate);

    document.getElementById("pinMapView").checked = urlParams.pinmap;
    document.getElementById("hideCancelled").checked = urlParams.hidecancelled;
    console.log("pinmap", urlParams, urlParams.pinmap);
    mapViewPinned = urlParams.pinmap;

    // Apply specific map view if provided
    if (urlParams.lat && urlParams.lng && urlParams.zoom) {
      map.setView([urlParams.lat, urlParams.lng], urlParams.zoom);
      if (mapViewPinned) {
        pinnedMapView = {
          center: [urlParams.lat, urlParams.lng],
          zoom: urlParams.zoom,
        };
      }
    }

    //  restore search term
    if (urlParams.searchTerm) {
      document.getElementById("searchInput").value = urlParams.searchTerm;

      // Behave exactly like "Search All Upcoming"
      await searchAllUpcoming();
    } else {
      await displayEvents(startDate, endDate);
    }
  } else {
    showThisWeek();
  }
});
