// ---------------------------------------------------------------------------
// event.js — event.html
//
// With a resolvable ?event_id=: loads data, resolves the event, and renders
// the hero + tickets/video + performer info in the left column, flyer
// thumbnail(s) at the top of the right-hand sidebar, and reuses venues.js's
// map/nearby-venues/nearby-events pattern for the rest of the right column
// (map itself sits in the left column next to performer info — see
// event_styles.css's .left-col-split). Also wires up the top search box.
//
// With no ?event_id= (or one that doesn't resolve): shows a filterable
// list of today's one-off dated events instead (see showTodayEvents()).
//
// Tickets / flyer(s) / video trailer mirror storyclub.js's per-event
// treatment (ticket_url + fb_event, getEventLevelFlyers(), video_trailer),
// scoped to this one event record rather than a whole club's calendar —
// club-dated flyers (clubRecord.club_flyers[]) and tour/show-level flyers
// (getTourLevelFlyers()) don't apply to a bare specificEvent, so they're
// not pulled in here.
//
// NOT yet wired up in this pass:
//   - the search box indexes specificEvents, musicEvents, poetryEvents,
//     tour dates, and repertoire show dates (with Story/Music/Poetry
//     checkboxes and an Upcoming/Previous/All filter) — festivals aren't
//     indexed yet
//   - today's-events / more-by-performer panels don't include recurring
//     club/folk/session nights, since matching those against a specific
//     date needs the recurrence engine wired in here too
// Natural next steps once this much is confirmed working.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Data + state
// ---------------------------------------------------------------------------

let eventsData = null;
let venuesLookup = {};
let performersLookup = {};
let toursLookup = {};
let eventRecord = null; // resolved specificEvent for this page, with a _date added
let map = null;
let leafletPromise = null;

const LEAFLET_JS_URL =
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js";
const LEAFLET_CSS_URL =
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css";

// Lazy leaflet loader — the map here is secondary sidebar content, same
// as on venues.html, so there's no static leaflet <link>/<script> tag in
// event.html; loaded on demand instead. Duplicated from venues.js rather
// than shared, matching that file's own precedent (it isn't in
// shared_utils.js either).
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletPromise) return leafletPromise;

  leafletPromise = new Promise((resolve, reject) => {
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = LEAFLET_CSS_URL;
    document.head.appendChild(stylesheet);

    const script = document.createElement("script");
    script.src = LEAFLET_JS_URL;
    script.async = true;
    script.onload = () => resolve(window.L);
    script.onerror = () => reject(new Error("Leaflet could not be loaded"));
    document.head.appendChild(script);
  });

  return leafletPromise;
}

// ---------------------------------------------------------------------------
// Event identity
// ---------------------------------------------------------------------------

// Mirrors the data-event-id scheme event_display.js already uses for
// same-page anchor matching (`${name}-${date.getTime()}`) — reusing the
// same formula here means an id copied from that page's DOM will already
// resolve correctly on this one, with no separate id scheme to invent.
function buildEventId(name, date) {
  return `${name}-${date.getTime()}`;
}

// One-off dated flat events — specificEvents, musicEvents, and poetryEvents
// all share this exact shape (flat array, single/array .date, .venue_id) —
// expanded and filtered down to ones the search box / findEventById() can
// actually resolve.
//
// expandTourDates() (shared_utils.js) is reused here even though it's named
// for tour_dates — it's a generic "date may be a string or string[]"
// flattener (same normalisation forEachDateInRange() does inline), and
// specificEvents/musicEvents/poetryEvents can carry the same
// `"date": ["21/01/2026", "22/01/2026"]` shorthand as tour_dates. Without
// this, a multi-date entry's raw array `.date` fails parseDateString()
// (which warns and returns null for arrays), so the whole entry was
// silently dropped by the `e._date` filter below.
function resolvableFlatEvents(list) {
  return expandTourDates(list || [])
    .map((e) => ({ ...e, _date: parseDateString(e.date) }))
    .filter((e) => e._date && e.name);
}

// Resolves an event_id against any one-off dated event that uses the plain
// name+date id scheme (specific/music/poetry events) — this is also used to
// build permalinks out from the "More by this performer" and "Events today"
// panels. Tour dates and touring-show dates use a different identity
// (tourId/tsId + date) and don't have a standalone event.html permalink —
// see buildSearchIndex() below, which links those to tour_guide.html instead.
function findEventById(eventId) {
  const target = decodeURIComponent(eventId);
  const pools = [
    eventsData.specificEvents,
    eventsData.musicEvents,
    eventsData.poetryEvents,
  ];
  for (const list of pools) {
    const found = resolvableFlatEvents(list).find(
      (e) => buildEventId(e.name, e._date) === target,
    );
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Search box
// ---------------------------------------------------------------------------

// Upcoming (default) / previous / all — narrows which events the search box
// below can match, independent of the typed search term. "Upcoming" means
// today or later, matching the >= comparisons used elsewhere on this page
// (e.g. collectUpcomingEventsForPerformer's today cutoff).
let eventSearchTimeFilter = "upcoming";
let eventSearchInputEl = null; // set once createSearchBox() returns, so
// changing the time filter can re-run whatever search term is already typed

function matchesEventSearchTimeFilter(eventDate, today) {
  if (eventSearchTimeFilter === "all") return true;
  if (eventSearchTimeFilter === "previous") return eventDate < today;
  return eventDate >= today; // "upcoming"
}

// performer_id/performer_ids normalisation, shared by every search-index
// builder below — mirrors collectPerformerAppearances()/
// collectPerformerVideoAppearances() in shared_utils.js. A co-headlined
// entry carries performer_ids (plural) instead of a single performer_id.
function performerNamesOf(entity) {
  const ids = Array.isArray(entity.performer_ids)
    ? entity.performer_ids
    : entity.performer_id
      ? [entity.performer_id]
      : [];
  return ids.map((id) => performersLookup[id]?.name).filter(Boolean);
}

// A repertoire show is browsed on tour_guide.html by merging it into that
// page's own toursLookup under a synthetic "rep:<id>" key — see
// tour_display.js's buildCombinedToursLookup()/REPERTOIRE_ID_PREFIX. There's
// no separate repertoire-show page, so a search result for one of its dates
// links here with the same prefixed id, exactly as tour_guide.html expects.
const TOUR_GUIDE_REPERTOIRE_ID_PREFIX = "rep:";

// Builds one search-index entry with a common shape, regardless of which
// record type it came from — buildSearchIndex()'s sections below each just
// gather their own fields and hand them here. `category` is "story" /
// "music" / "poetry", the same story-first/opt-in split
// collectEventsOnDate() already uses for the "Events today" panel — reused
// here to drive the search box's own Story/Music/Poetry checkboxes.
function searchIndexEntry({
  displayName,
  altName,
  performerNames,
  hostVenue,
  date,
  href,
  kindLabel,
  category,
}) {
  const performerName = performerNames.join(", ") || null;
  const searchText = [
    displayName,
    // altName is indexed alongside displayName, not instead of it — some
    // records only credit performers in a free-text name (e.g. "... [Holly
    // Medland & Merl Fluin]") rather than performer_id(s), so dropping it
    // whenever a showname exists could hide that credit from search
    // entirely.
    altName,
    performerName,
    hostVenue?.name,
    hostVenue?.city,
    hostVenue?.full_address,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return {
    displayName,
    performerName,
    hostVenue,
    date,
    href,
    kindLabel,
    category,
    searchText,
  };
}

// Indexes one-off specificEvents/musicEvents/poetryEvents, tour dates, and
// repertoire show dates — each dated occurrence becomes its own entry, with
// its own venue, its own navigation target (an event.html permalink for a
// flat event; the shared tour_guide.html?tour= page, real or synthetic
// "rep:" id, for a tour/repertoire date, matching how those are already
// browsed there), and its own story/music/poetry category for the Story/
// Music/Poetry checkboxes. Festivals aren't indexed yet — a further step.
const FLAT_SEARCH_SOURCES = [
  { key: "specificEvents", category: "story" },
  { key: "musicEvents", category: "music" },
  { key: "poetryEvents", category: "poetry" },
];

function buildSearchIndex() {
  const entries = [];

  FLAT_SEARCH_SOURCES.forEach(({ key, category }) => {
    resolvableFlatEvents(eventsData[key]).forEach((e) => {
      entries.push(
        searchIndexEntry({
          displayName: e.showname || e.name,
          altName: e.name,
          performerNames: performerNamesOf(e),
          hostVenue: venuesLookup[e.venue_id] || null,
          date: e._date,
          href: `event.html?event_id=${encodeURIComponent(buildEventId(e.name, e._date))}`,
          // "story" is the always-on default bucket, so it needs no badge
          // of its own — same reasoning as TODAY_EVENTS_TYPE_LABELS not
          // badging specificEvents rows either.
          kindLabel: category === "story" ? undefined : category === "music" ? "Music" : "Poetry",
          category,
        }),
      );
    });
  });

  Object.entries(toursLookup).forEach(([tourId, tour]) => {
    // Same isMusic/isPoetry precedence as collectEventsOnDate()'s tour
    // mapping below and TOUR_PANEL_GROUPS in tour_display.js — a tour with
    // neither flag set defaults to "story".
    const category = tour.isMusic ? "music" : tour.isPoetry ? "poetry" : "story";
    expandTourDates(tour.tour_dates || []).forEach((td) => {
      const date = parseDateString(td.date);
      if (!date) return;
      entries.push(
        searchIndexEntry({
          displayName: tour.tour_name || tour.name,
          altName: tour.showname,
          performerNames: performerNamesOf(tour),
          hostVenue: venuesLookup[td.venue_id] || null,
          date,
          href: `tour_guide.html?tour=${encodeURIComponent(tourId)}`,
          kindLabel: "Tour date",
          category,
        }),
      );
    });
  });

  Object.entries(eventsData.repertoire_shows || {}).forEach(([tsId, ts]) => {
    expandTourDates(ts.show_dates || []).forEach((sd) => {
      const date = parseDateString(sd.date);
      if (!date) return;
      entries.push(
        searchIndexEntry({
          displayName: ts.showname || ts.name,
          altName: ts.name,
          performerNames: performerNamesOf(ts),
          hostVenue: venuesLookup[sd.venue_id] || null,
          date,
          href: `tour_guide.html?tour=${encodeURIComponent(TOUR_GUIDE_REPERTOIRE_ID_PREFIX + tsId)}`,
          kindLabel: ts.isStoryWalk ? "Story walk" : "Touring show",
          // Repertoire shows are always "story", same as collectEventsOnDate()'s
          // showDatesHere mapping — story walks stay in this scope too, not a
          // separate opt-in category (matching renderEventRow's comment on
          // the same point).
          category: "story",
        }),
      );
    });
  });

  return entries;
}

// ---------------------------------------------------------------------------
// Persisted search-type filter preferences (localStorage)
// ---------------------------------------------------------------------------
// Same pattern as event_display.js's FILTER_PREFS_STORAGE_KEY for the
// calendar page's own checkboxes — localStorage, not a cookie, so it never
// leaves the browser. Stored under its own key rather than folded into
// event_display.js's prefs object: this is a search-scope filter local to
// this page, not one of the calendar's category/display filters.
const SEARCH_TYPE_FILTER_STORAGE_KEY = "ntEventSearchTypePrefs";

// Story-first, opt-in music/poetry — Story on by default, Music/Poetry off,
// matching EVENT_TYPE_FILTERS' music/poetry entries in event_display.js
// (and TODAY_EVENTS_TYPE_LABELS' all-on default further down, which is a
// deliberately different bias for that panel).
const SEARCH_TYPE_FILTER_DEFAULTS = { story: true, music: false, poetry: false };

function readStoredSearchTypeFilters() {
  try {
    const raw = localStorage.getItem(SEARCH_TYPE_FILTER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (err) {
    // Storage disabled/unavailable (private browsing, locked-down browser
    // settings, corrupted value, etc.) — treat as "nothing stored" rather
    // than breaking the page.
    return null;
  }
}

function writeStoredSearchTypeFilters() {
  const prefs = {};
  Object.keys(SEARCH_TYPE_FILTER_DEFAULTS).forEach((category) => {
    const el = document.getElementById(`eventSearchTypeFilter-${category}`);
    if (el) prefs[category] = el.checked;
  });
  try {
    localStorage.setItem(SEARCH_TYPE_FILTER_STORAGE_KEY, JSON.stringify(prefs));
  } catch (err) {
    // No usable storage — the page still works, the choice just won't
    // carry over to next time.
  }
}

function activeSearchTypeCategories() {
  return new Set(
    Object.keys(SEARCH_TYPE_FILTER_DEFAULTS).filter((category) => {
      const el = document.getElementById(`eventSearchTypeFilter-${category}`);
      return el ? el.checked : SEARCH_TYPE_FILTER_DEFAULTS[category];
    }),
  );
}

// Story/Music/Poetry checkboxes, shown under the search box. Initial state
// comes from localStorage (falling back to SEARCH_TYPE_FILTER_DEFAULTS for
// a first-ever visit or a category added since); every change both saves
// the new state and — same re-dispatch trick as initSearchFilters() below —
// re-runs whatever search term is already typed.
function initSearchTypeFilters() {
  const container = document.getElementById("eventSearchTypeFilters");
  if (!container || container.dataset.wired) return;
  container.dataset.wired = "true";

  const stored = readStoredSearchTypeFilters() || {};
  const SEARCH_TYPE_FILTER_LABELS = [
    ["story", "Storytelling"],
    ["music", "Music"],
    ["poetry", "Poetry"],
  ];

  SEARCH_TYPE_FILTER_LABELS.forEach(([category, label]) => {
    const id = `eventSearchTypeFilter-${category}`;
    const wrap = document.createElement("label");
    wrap.className = "event-search-type-filter";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = id;
    checkbox.value = category;
    checkbox.checked =
      typeof stored[category] === "boolean"
        ? stored[category]
        : SEARCH_TYPE_FILTER_DEFAULTS[category];
    checkbox.addEventListener("change", () => {
      writeStoredSearchTypeFilters();
      if (eventSearchInputEl && eventSearchInputEl.value.trim().length >= 1) {
        eventSearchInputEl.dispatchEvent(new Event("input"));
      }
    });

    wrap.appendChild(checkbox);
    wrap.appendChild(document.createTextNode(` ${label}`));
    container.appendChild(wrap);
  });
}

// Wires the #eventSearchBox container up with createSearchBox()
// (shared_utils.js) — same component venues.js/performers.js use for
// their own directory search. Searches event/tour/show name, performer,
// venue, town, and address (per the search index above); selecting a
// result navigates to its own permalink (event.html for a specificEvent,
// tour_guide.html for a tour or repertoire show date).
function initSearchBox() {
  const container = document.getElementById("eventSearchBox");
  if (!container) return;

  const index = buildSearchIndex();
  const today = getTodayMidnight();

  const { input } = createSearchBox(container, {
    placeholder: "Search events by name, performer, venue, town\u2026",
    search: (term) => {
      const activeCategories = activeSearchTypeCategories();
      return index
        .filter((e) => matchesEventSearchTimeFilter(e.date, today))
        .filter((e) => activeCategories.has(e.category))
        .filter((e) => e.searchText.includes(term))
        .slice(0, 8);
    },
    renderItem: (entry) => {
      const item = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = entry.displayName;
      item.appendChild(strong);

      const metaParts = [
        entry.kindLabel,
        formatShortDateWithYear(entry.date),
        entry.performerName,
        entry.hostVenue?.name,
        entry.hostVenue?.city,
      ]
        .filter(Boolean)
        .join(" \u2022 ");
      if (metaParts) {
        const meta = document.createElement("span");
        meta.className = "dir-search-item-meta";
        meta.textContent = metaParts;
        item.appendChild(meta);
      }
      return item;
    },
    onSelect: (entry) => {
      window.location.href = entry.href;
    },
    onChange: () => {
      // Nothing to re-filter on this page — event.html shows one event,
      // not a list — so this is deliberately a no-op.
    },
  });

  eventSearchInputEl = input;
  initSearchFilters();
  initSearchTypeFilters();
}

// Upcoming (default) / Previous / All radio group, shown under the search
// box. Changing it doesn't re-search by itself (createSearchBox has no
// "re-run" hook) — instead, if there's already a typed term, re-dispatch an
// "input" event on the search box's own input element, which re-invokes the
// search() callback above (now reading the newly-changed time filter).
function initSearchFilters() {
  const container = document.getElementById("eventSearchFilters");
  if (!container || container.dataset.wired) return;
  container.dataset.wired = "true";

  const EVENT_SEARCH_TIME_FILTERS = [
    ["upcoming", "Upcoming"],
    ["previous", "Previous"],
    ["all", "All"],
  ];

  EVENT_SEARCH_TIME_FILTERS.forEach(([value, label]) => {
    const id = `eventSearchFilter-${value}`;
    const wrap = document.createElement("label");
    wrap.className = "event-search-filter";

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "eventSearchFilter";
    radio.id = id;
    radio.value = value;
    radio.checked = value === eventSearchTimeFilter;
    radio.addEventListener("change", () => {
      eventSearchTimeFilter = value;
      if (eventSearchInputEl && eventSearchInputEl.value.trim().length >= 1) {
        eventSearchInputEl.dispatchEvent(new Event("input"));
      }
    });

    wrap.appendChild(radio);
    wrap.appendChild(document.createTextNode(` ${label}`));
    container.appendChild(wrap);
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

// Initialize immediately (don't wait for DOMContentLoaded) so data starts
// loading early, matching venues.js/storyclub.js.
setCanonical("event_id");

(async () => {
  const params = new URLSearchParams(window.location.search);
  const eventIdParam = params.get("event_id");

  const loaded = await loadEventsData();
  if (!loaded) return showNotFound();

  eventsData = loaded.eventsData;
  venuesLookup = loaded.venuesLookup;
  performersLookup = loaded.performersLookup;
  toursLookup = loaded.toursLookup;
  displayDataLastUpdated(loaded.lastUpdateTime);
  initNavFeedback();
  initSearchBox();

  eventRecord = eventIdParam ? findEventById(eventIdParam) : null;
  if (!eventRecord) {
    if (eventIdParam) {
      console.warn(
        `event.html: event_id "${eventIdParam}" not found — showing today's events instead.`,
      );
    } else {
      console.info("event.html: no ?event_id= given — showing today's events.");
    }
    document.getElementById("loadingState").style.display = "none";
    showTodayEvents();
    return;
  }

  // Defer heavy rendering to background to allow loading state to display
  setTimeout(() => {
    renderPage();
    document.getElementById("loadingState").style.display = "none";
    document.getElementById("eventContent").style.display = "";

    const hostVenue = venuesLookup[eventRecord.venue_id] || null;
    if (hostVenue && hasLatlon(hostVenue)) {
      loadLeaflet()
        .then(() => {
          initEventMap(hostVenue);
          setTimeout(() => map.invalidateSize(), 0);
        })
        .catch((error) => {
          console.error("Failed to load event map:", error);
          document.getElementById("map-container").style.display = "none";
        });
    } else {
      document.getElementById("map-container").style.display = "none";
    }
  }, 0);
})();

// ---------------------------------------------------------------------------
// Today's events (no-?event_id= fallback). One-off dated events only
// (specific/music/poetry events, tour dates, touring-show dates, festivals
// in progress) — recurring club/folk/session nights aren't matched against
// today's date yet, since that needs the recurrence engine wired in here
// too. Mixes several event types together, so — unlike the performer-
// upcoming panel, which is already scoped to one performer — this gets its
// own type filter checkboxes rather than dumping everything in unfiltered.
// ---------------------------------------------------------------------------

// Which filter checkbox group each entry's category belongs to — reuses
// the same story/music/poetry categorization shared_utils.js's
// collectDatedEventsForVenue() computes (tours/shows fall in "story"
// unless their tour record says isMusic/isPoetry; festivals are always
// "story" and so always shown, mirroring event_display.js's getEventType(),
// which checks isFestival before any story/music/poetry opt-in).
const TODAY_EVENTS_TYPE_LABELS = [
  ["story", "Storytelling"],
  ["music", "Music"],
  ["poetry", "Poetry"],
];

let todayEventsAll = [];

function collectEventsOnDate(targetDate) {
  const sameDate = (d) => d && d.getTime() === targetDate.getTime();

  const specificEvents = (eventsData.specificEvents || []).filter((e) =>
    sameDate(parseDateString(e.date)),
  );
  const musicEvents = (eventsData.musicEvents || []).filter((e) =>
    sameDate(parseDateString(e.date)),
  );
  const poetryEvents = (eventsData.poetryEvents || []).filter((e) =>
    sameDate(parseDateString(e.date)),
  );

  const tourDatesHere = [];
  Object.entries(toursLookup).forEach(([tourId, tour]) => {
    expandTourDates(tour.tour_dates).forEach((tourDate) => {
      if (sameDate(parseDateString(tourDate.date))) {
        tourDatesHere.push({ tour, tourId, tourDate });
      }
    });
  });

  const showDatesHere = [];
  Object.entries(eventsData.repertoire_shows || {}).forEach(([tsId, ts]) => {
    expandTourDates(ts.show_dates).forEach((showDate) => {
      if (sameDate(parseDateString(showDate.date))) {
        showDatesHere.push({ ts, tsId, showDate });
      }
    });
  });

  const festivalsHere = Object.entries(eventsData.festivals || {}).filter(
    ([, f]) => {
      const start = parseDateString(f.start_date);
      const end = parseDateString(f.end_date) || start;
      return start && targetDate >= start && targetDate <= end;
    },
  );

  return [
    ...specificEvents.map((e) => ({
      type: "specific",
      date: parseDateString(e.date),
      data: e,
      venueId: e.venue_id,
      category: "story",
    })),
    ...musicEvents.map((e) => ({
      type: "music",
      date: parseDateString(e.date),
      data: e,
      venueId: e.venue_id,
      category: "music",
    })),
    ...poetryEvents.map((e) => ({
      type: "poetry",
      date: parseDateString(e.date),
      data: e,
      venueId: e.venue_id,
      category: "poetry",
    })),
    ...tourDatesHere.map((t) => ({
      type: "tour",
      date: parseDateString(t.tourDate.date),
      data: t,
      venueId: t.tourDate.venue_id,
      category: t.tour.isMusic ? "music" : t.tour.isPoetry ? "poetry" : "story",
    })),
    ...showDatesHere.map((s) => ({
      type: "show",
      date: parseDateString(s.showDate.date),
      data: s,
      venueId: s.showDate.venue_id,
      category: "story",
    })),
    ...festivalsHere.map(([fid, f]) => ({
      type: "festival",
      date: targetDate,
      data: { fid, festival: f },
      venueId: f.venue_id,
      category: "story",
      alwaysShown: true,
    })),
  ]
    .map((e) => ({ ...e, venue: venuesLookup[e.venueId] || null }))
    .sort((a, b) => {
      const nameOf = (e) =>
        e.data.showname ||
        e.data.name ||
        e.data.tour?.tour_name ||
        e.data.ts?.show_name ||
        e.data.festival?.name ||
        "";
      return nameOf(a).localeCompare(nameOf(b));
    });
}

function activeTodayEventsCategories() {
  return new Set(
    Array.from(
      document.querySelectorAll(
        '#todayEventsFilters input[type="checkbox"]:checked',
      ),
    ).map((cb) => cb.value),
  );
}

function renderTodayEventsList() {
  const list = document.getElementById("todayEventsList");
  list.innerHTML = "";

  const active = activeTodayEventsCategories();
  const filtered = todayEventsAll.filter(
    (e) => e.alwaysShown || active.has(e.category),
  );

  if (!filtered.length) {
    const p = document.createElement("p");
    p.className = "today-events-empty";
    p.textContent = todayEventsAll.length
      ? "No events match the selected filters."
      : "No dated events found for today.";
    list.appendChild(p);
    return;
  }

  filtered.forEach((entry) => {
    const row = renderEventRow(list, entry, false, { showVenue: true });
    addEventPageLink(row, entry);
  });
}

function initTodayEventsFilters() {
  const container = document.getElementById("todayEventsFilters");
  if (container.dataset.wired) return;
  container.dataset.wired = "true";

  TODAY_EVENTS_TYPE_LABELS.forEach(([category, label]) => {
    const id = `todayEventsFilter-${category}`;
    const wrap = document.createElement("label");
    wrap.className = "today-events-filter";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = id;
    checkbox.value = category;
    checkbox.checked = true;
    checkbox.addEventListener("change", renderTodayEventsList);

    wrap.appendChild(checkbox);
    wrap.appendChild(document.createTextNode(` ${label}`));
    container.appendChild(wrap);
  });
}

function showTodayEvents() {
  document.getElementById("todayEventsState").style.display = "";

  const today = getTodayMidnight();
  document.getElementById("todayEventsDate").textContent =
    formatDate(today) || "";

  todayEventsAll = collectEventsOnDate(today);
  initTodayEventsFilters();
  renderTodayEventsList();
}

function renderPage() {
  const ev = eventRecord;
  const name = ev.showname || ev.name;
  const performerForTitle =
    (ev.performer_id && performersLookup[ev.performer_id]?.name) ||
    ev.performer ||
    null;
  document.title = performerForTitle
    ? `${name} — ${performerForTitle} — New Troubadours`
    : `${name} — New Troubadours`;
  document.getElementById("eventName").textContent = name;

  const metaParts = [formatDate(ev._date), ev.time || null, ev.price || null]
    .filter(Boolean)
    .join(" • ");
  document.getElementById("eventMeta").textContent = metaParts;

  const hostVenue = venuesLookup[ev.venue_id] || null;
  const venueDiv = document.getElementById("eventVenue");
  if (hostVenue) {
    const a = document.createElement("a");
    a.href = `venues.html?venue=${encodeURIComponent(ev.venue_id)}`;
    a.textContent =
      hostVenue.name + (hostVenue.city ? `, ${hostVenue.city}` : "");
    venueDiv.appendChild(a);
  }

  if (ev.description && ev.description.trim()) {
    const descDiv = document.getElementById("eventDescription");
    descDiv.style.display = "";
    appendParagraphs(descDiv, ev.description);
  }

  renderTicketsFlyersVideo(ev);
  renderEventFlyers(ev);
  renderPerformerSection(ev);
  renderPerformerUpcomingEvents(ev);
  renderVenueDescription(hostVenue);
  renderInfoTable(hostVenue);

  if (hostVenue && hasLatlon(hostVenue)) {
    const nearby = findNearbyByLatLon(
      hostVenue.latlon[0],
      hostVenue.latlon[1],
      Object.entries(venuesLookup),
      { excludeKey: ev.venue_id, radiusKm: 20, limit: 8 },
    );
    renderNearbyVenues(nearby);
    renderNearbyEvents(nearby, getTodayMidnight());
  }
}

// ---------------------------------------------------------------------------
// Tickets / flyer(s) / video trailer (mirrors storyclub.js's per-event
// tickets/flyer/video treatment, scoped to this one event record — see
// the file header comment for what's deliberately left out)
// ---------------------------------------------------------------------------

function renderTicketsFlyersVideo(ev) {
  const aboutSection = document.getElementById("aboutSection");
  const ticketsDiv = document.getElementById("eventTickets");
  const videoControls = document.getElementById("videoControls");

  let anyContent = false;

  // Tickets link + Facebook event icon (shared_utils.js's ICON_SVG.facebook)
  const hasTickets = !!ev.ticket_url;
  const hasFbEvent = !!ev.fb_event;
  if (hasTickets || hasFbEvent) {
    anyContent = true;
    ticketsDiv.style.display = "";

    if (hasTickets) {
      const a = document.createElement("a");
      a.href = ev.ticket_url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = "Tickets available here";
      ticketsDiv.appendChild(a);
    }

    if (hasFbEvent) {
      if (hasTickets) {
        const sep = document.createElement("span");
        sep.className = "separator";
        sep.textContent = "|";
        ticketsDiv.appendChild(sep);
      }
      const fbA = document.createElement("a");
      fbA.href = `https://www.facebook.com/events/${ev.fb_event}`;
      fbA.target = "_blank";
      fbA.rel = "noopener noreferrer";
      fbA.innerHTML = ICON_SVG.facebook;
      fbA.querySelector("svg").style.cssText =
        "width:20px;height:20px;vertical-align:middle;";
      ticketsDiv.appendChild(fbA);
    }
  }

  // Video trailer (shared_utils.js's getYouTubeEmbedUrl()/createVideoTrailerEmbed())
  const videoEmbedUrl = getYouTubeEmbedUrl(ev.video_trailer);
  if (videoEmbedUrl) {
    anyContent = true;
    videoControls.style.display = "";

    const videoBtn = document.createElement("button");
    videoBtn.className = "expand-btn";
    videoBtn.textContent = "Video preview";

    const videoExpandable = document.createElement("div");
    videoExpandable.className = "expandable";

    const { wrapper, iframe } = createVideoTrailerEmbed(
      `${ev.showname || ev.name} trailer`,
    );
    videoExpandable.appendChild(wrapper);

    videoBtn.addEventListener("click", () => {
      const open = videoExpandable.classList.toggle("open");
      videoBtn.textContent = open ? "Hide video" : "Video preview";
      iframe.src = open ? videoEmbedUrl : "";
    });

    videoControls.appendChild(videoBtn);
    videoControls.appendChild(videoExpandable);
  }

  aboutSection.style.display = anyContent ? "" : "none";
}

// ---------------------------------------------------------------------------
// Flyer thumbnails — small, always-visible images at the top of the right
// column (rather than behind an expand button, which wasn't working).
// Event-level flyers only (event_flyer/event_flyer2/event_flyers), resolved
// by getEventLevelFlyers() (shared_utils.js) — same helper storyclub.js uses.
// Each thumbnail links to the full-size image in a new tab.
// ---------------------------------------------------------------------------

function renderEventFlyers(ev) {
  const section = document.getElementById("eventFlyersSection");
  const list = document.getElementById("eventFlyersList");
  list.innerHTML = "";

  const flyers = getEventLevelFlyers(ev);
  if (!flyers.length) {
    section.style.display = "none";
    return;
  }

  section.querySelector(".section-heading").textContent =
    flyers.length > 1 ? "Flyers" : "Flyer";

  flyers.forEach((flyer) => {
    const src = `./storyclub_assets/event_flyers/${sanitizeFlyerPath(flyer.filename)}`;
    const a = document.createElement("a");
    a.href = src;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.className = "event-flyer-thumb-link";

    const img = document.createElement("img");
    img.src = src;
    img.alt = `${ev.showname || ev.name} ${flyer.label}`;
    img.className = "event-flyer-thumb";

    a.appendChild(img);
    list.appendChild(a);
  });

  section.style.display = "";
}

// ---------------------------------------------------------------------------
// Performer info (name/link, musician/poet badges, bio, website — a
// trimmed-down version of performers.js's renderPerformer(), just enough
// for a sidebar-style panel rather than the full performer page)
// ---------------------------------------------------------------------------

function renderPerformerSection(ev) {
  const section = document.getElementById("performerSection");
  const container = document.getElementById("performerInfo");
  container.innerHTML = "";

  const performer = ev.performer_id
    ? performersLookup[ev.performer_id]
    : null;
  const name = (performer && performer.name) || ev.performer || null;
  if (!name) {
    section.style.display = "none";
    return;
  }
  section.style.display = "";

  const header = document.createElement("div");
  header.className = "event-performer-header";

  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase())
    .slice(0, 2)
    .join("");
  const avatar = document.createElement("div");
  avatar.className = "event-performer-avatar";
  avatar.textContent = initials;
  header.appendChild(avatar);

  const nameWrap = document.createElement("div");
  if (ev.performer_id && performer) {
    const a = document.createElement("a");
    a.href = `performers.html?performer=${encodeURIComponent(ev.performer_id)}`;
    a.className = "event-performer-name";
    a.textContent = name;
    nameWrap.appendChild(a);
  } else {
    const span = document.createElement("span");
    span.className = "event-performer-name";
    span.textContent = name;
    nameWrap.appendChild(span);
  }

  if (performer && (performer.musician || performer.poet)) {
    const badges = document.createElement("div");
    badges.className = "event-performer-badges";
    if (performer.musician) {
      const b = document.createElement("span");
      b.className = "event-performer-badge";
      b.textContent = "Musician";
      badges.appendChild(b);
    }
    if (performer.poet) {
      const b = document.createElement("span");
      b.className = "event-performer-badge";
      b.textContent = "Poet";
      badges.appendChild(b);
    }
    nameWrap.appendChild(badges);
  }

  header.appendChild(nameWrap);
  container.appendChild(header);

  if (performer && performer.bio && performer.bio.trim()) {
    const bioDiv = document.createElement("div");
    bioDiv.className = "event-performer-bio";
    appendParagraphs(bioDiv, performer.bio);
    container.appendChild(bioDiv);
  }

  if (performer && performer.url) {
    const href = sanitizeUrl(performer.url);
    if (href) {
      const a = document.createElement("a");
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.className = "event-performer-website";
      a.textContent = href
        .replace(/^https?:\/\/(www\.)?/, "")
        .replace(/\/$/, "");
      container.appendChild(a);
    }
  }

  if (ev.performer_id && performer) {
    const profileLink = document.createElement("a");
    profileLink.href = `performers.html?performer=${encodeURIComponent(ev.performer_id)}`;
    profileLink.className = "event-performer-profile-link";
    profileLink.textContent = "View full profile \u2192";
    container.appendChild(profileLink);
  }
}

// ---------------------------------------------------------------------------
// Upcoming events by the same performer (right-col panel, top). Mirrors
// performers.js's own performer-page collection: a compound-id match (so a
// duo/troupe billing that includes this performer is picked up too — see
// performers.js's compoundIdsForMe/performerMatches()) across tours,
// touring shows, and specific/music/poetry events, rendered with
// shared_utils.js's renderEventRow() (the same row used for this page's own
// nearby-events list) rather than a bespoke row here.
// ---------------------------------------------------------------------------

function compoundIdsForPerformer(performerId) {
  const ids = new Set();
  Object.entries(performersLookup).forEach(([pid, p]) => {
    const members = p.performer_ids || p.ids || [];
    if (Array.isArray(members) && members.includes(performerId)) {
      ids.add(pid);
    }
  });
  return ids;
}

function performerRecordMatches(obj, performerId, compoundIds) {
  if (obj.performer_id === performerId) return true;
  if (
    Array.isArray(obj.performer_ids) &&
    obj.performer_ids.includes(performerId)
  )
    return true;
  if (obj.performer_id && compoundIds.has(obj.performer_id)) return true;
  return false;
}

// Collects this performer's upcoming dates across every event type that
// carries a performer_id, resolving each to the venue-row shape
// renderEventRow() expects (type/date/data/venue/venueId).
function collectUpcomingEventsForPerformer(performerId, today) {
  const compoundIds = compoundIdsForPerformer(performerId);
  const matches = (obj) =>
    performerRecordMatches(obj, performerId, compoundIds);

  const specificEvents = (eventsData.specificEvents || []).filter(matches);
  const musicEvents = (eventsData.musicEvents || []).filter(matches);
  const poetryEvents = (eventsData.poetryEvents || []).filter(matches);

  const tourDatesHere = [];
  Object.entries(toursLookup).forEach(([tourId, tour]) => {
    if (!matches(tour)) return;
    expandTourDates(tour.tour_dates).forEach((tourDate) => {
      tourDatesHere.push({ tour, tourId, tourDate });
    });
  });

  const showDatesHere = [];
  Object.entries(eventsData.repertoire_shows || {}).forEach(
    ([tsId, ts]) => {
      if (!matches(ts)) return;
      expandTourDates(ts.show_dates).forEach((showDate) => {
        showDatesHere.push({ ts, tsId, showDate });
      });
    },
  );

  return [
    ...specificEvents.map((e) => ({
      type: "specific",
      date: parseDateString(e.date),
      data: e,
      venueId: e.venue_id,
    })),
    ...musicEvents.map((e) => ({
      type: "music",
      date: parseDateString(e.date),
      data: e,
      venueId: e.venue_id,
    })),
    ...poetryEvents.map((e) => ({
      type: "poetry",
      date: parseDateString(e.date),
      data: e,
      venueId: e.venue_id,
    })),
    ...tourDatesHere.map((t) => ({
      type: "tour",
      date: parseDateString(t.tourDate.date),
      data: t,
      venueId: t.tourDate.venue_id,
    })),
    ...showDatesHere.map((s) => ({
      type: "show",
      date: parseDateString(s.showDate.date),
      data: s,
      venueId: s.showDate.venue_id,
    })),
  ]
    .filter((e) => e.date && e.date >= today)
    // Drop this page's own event out of its performer's "more dates" list.
    .filter(
      (e) =>
        !(
          e.type === "specific" &&
          e.data.name === eventRecord.name &&
          e.data.date === eventRecord.date
        ),
    )
    .map((e) => ({ ...e, venue: venuesLookup[e.venueId] || null }))
    .sort((a, b) => a.date - b.date);
}

const PERFORMER_UPCOMING_MAX = 6;

// Wraps a renderEventRow() row's title in a link to this event's own
// event.html permalink, when it's a type findEventById() can resolve
// (specific/music/poetry events all share the plain name+date id scheme —
// see findEventById()). Tour dates and touring-show dates aren't linked,
// since they don't have a standalone event.html permalink yet.
function addEventPageLink(row, entry) {
  if (!["specific", "music", "poetry"].includes(entry.type) || !entry.date) {
    return;
  }
  const titleEl = row.querySelector(".event-row-title");
  if (!titleEl) return;

  const eventId = buildEventId(entry.data.name, entry.date);
  const a = document.createElement("a");
  a.href = `event.html?event_id=${encodeURIComponent(eventId)}`;
  a.textContent = titleEl.textContent;
  titleEl.textContent = "";
  titleEl.appendChild(a);
}

function renderPerformerUpcomingEvents(ev) {
  const section = document.getElementById("performerUpcomingSection");
  if (!ev.performer_id || !performersLookup[ev.performer_id]) {
    section.style.display = "none";
    return;
  }

  const upcoming = collectUpcomingEventsForPerformer(
    ev.performer_id,
    getTodayMidnight(),
  ).slice(0, PERFORMER_UPCOMING_MAX);

  if (!upcoming.length) {
    section.style.display = "none";
    return;
  }

  const performerLabel = performersLookup[ev.performer_id].name;
  section.querySelector(".section-heading").textContent =
    `More by ${performerLabel}`;

  const list = document.getElementById("performerUpcomingList");
  list.innerHTML = "";
  upcoming.forEach((entry) => {
    const row = renderEventRow(list, entry, false, { showVenue: true });
    addEventPageLink(row, entry);
  });

  section.style.display = "";
}

// ---------------------------------------------------------------------------
// Venue description (shown at the bottom of the map panel, if the host
// venue record has its own description text)
// ---------------------------------------------------------------------------

function renderVenueDescription(hostVenue) {
  const div = document.getElementById("venueDescription");
  if (hostVenue && hostVenue.description && hostVenue.description.trim()) {
    div.style.display = "";
    appendParagraphs(div, hostVenue.description);
  }
}

// ---------------------------------------------------------------------------
// Info table (mirrors venues.js's renderInfoTable(), for the host venue)
// ---------------------------------------------------------------------------

function renderInfoTable(hostVenue) {
  if (!hostVenue) return;
  const table = document.getElementById("venueInfoTable");

  const rows = [
    hostVenue.name && ["Name", hostVenue.name],
    hostVenue.full_address && [
      "Address",
      hostVenue.full_address.replace(/^[^,]*,\s*/, '')
    ],
    hostVenue.city && ["Town", hostVenue.city],
    hostVenue.postcode && ["Postcode", hostVenue.postcode],
    hostVenue.description && ["About", hostVenue.description],
  ].filter(Boolean);

  rows.forEach(([label, value]) => {
    const row = document.createElement("div");
    row.className = "info-table-row";
    const l = document.createElement("span");
    l.className = "info-table-label";
    l.textContent = label;
    const v = document.createElement("span");
    v.className = "info-table-value";
    v.textContent = value;
    row.appendChild(l);
    row.appendChild(v);
    table.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Map (mirrors venues.js's initVenueMap(), for the host venue)
// ---------------------------------------------------------------------------

function initEventMap(hostVenue) {
  const [lat, lon] = hostVenue.latlon;
  map = L.map("map", { minZoom: 5, maxZoom: 18 }).setView([lat, lon], 14);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors",
  }).addTo(map);

  const marker = L.marker([lat, lon]).addTo(map);
  marker
    .bindPopup(
      `<strong>${escapeHtml(hostVenue.name)}</strong><br>${escapeHtml(hostVenue.city || "")}`,
    )
    .openPopup();
}

// ---------------------------------------------------------------------------
// Nearby venues (mirrors venues.js's renderNearbyVenues(), parameterized
// by the nearby list computed in renderPage() rather than read off a
// module-scope venue/venueId — this page's "self" is the event's host
// venue, not a venue record of the page's own).
// ---------------------------------------------------------------------------

function renderNearbyVenues(nearby) {
  if (nearby.length === 0) return;

  document.getElementById("nearbySection").style.display = "";
  const list = document.getElementById("nearbyList");

  nearby.forEach(({ key: vid, item: v, dist }) => {
    const row = document.createElement("div");
    row.className = "nearby-row";

    const a = document.createElement("a");
    a.href = `venues.html?venue=${encodeURIComponent(vid)}`;
    a.className = "nearby-name";
    a.textContent = v.name;
    row.appendChild(a);

    if (v.city) {
      const city = document.createElement("span");
      city.className = "nearby-city";
      city.textContent = v.city;
      row.appendChild(city);
    }

    const distSpan = document.createElement("span");
    distSpan.className = "nearby-dist";
    distSpan.textContent = `${dist.toFixed(1)} km`;
    row.appendChild(distSpan);

    list.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Nearby events (mirrors venues.js's renderNearbyEvents()/
// renderNearbyEventsList(), across the same nearby-venue set computed
// above rather than a single module-scope venueId).
// ---------------------------------------------------------------------------

let nearbyVenuesForEvents = [];
let nearbyEventsToday = null;

function renderNearbyEvents(nearby, today) {
  if (nearby.length === 0) return;

  nearbyVenuesForEvents = nearby;
  nearbyEventsToday = today;
  document.getElementById("nearbyEventsSection").style.display = "";

  const horizonSelect = document.getElementById("nearbyEventsHorizon");
  if (!horizonSelect.dataset.wired) {
    horizonSelect.dataset.wired = "true";
    horizonSelect.addEventListener("change", () =>
      renderNearbyEventsList(Number(horizonSelect.value)),
    );
  }

  renderNearbyEventsList(Number(horizonSelect.value));
}

function renderNearbyEventsList(days) {
  const list = document.getElementById("nearbyEventsList");
  list.innerHTML = "";

  const today = nearbyEventsToday;
  const horizon = new Date(today);
  horizon.setDate(horizon.getDate() + days);

  const MAX_EVENTS = 15;
  const upcomingNearby = nearbyVenuesForEvents
    .flatMap(({ key: vid, item: v }) => [
      ...collectDatedEventsForVenue(vid)
        .filter((e) => e.date >= today && e.date < horizon)
        .map((e) => ({ ...e, venueId: vid, venue: v })),
      ...collectRecurringEventsForVenue(vid, today, horizon).map((e) => ({
        ...e,
        venueId: vid,
        venue: v,
      })),
    ])
    .sort((a, b) => a.date - b.date)
    .slice(0, MAX_EVENTS);

  if (upcomingNearby.length === 0) {
    const empty = document.createElement("div");
    empty.className = "no-events";
    empty.textContent = `No nearby events found in the next ${days} days.`;
    list.appendChild(empty);
    return;
  }

  upcomingNearby.forEach((entry) =>
    renderEventRow(list, entry, false, { showVenue: true }),
  );
}
