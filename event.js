// ---------------------------------------------------------------------------
// event.js — event.html
//
// Loads data, resolves one event via an ?event_id= URL param, renders the
// hero + tickets/flyer/video + performer info in the left column, reuses
// venues.js's map/nearby-venues/nearby-events pattern for the right column
// (map itself now sits in the left column next to performer info — see
// event_styles.css's .left-col-split), and wires up the top search box.
//
// Tickets / flyer(s) / video trailer mirror storyclub.js's per-event
// treatment (ticket_url + fb_event, getEventLevelFlyers(), video_trailer),
// scoped to this one event record rather than a whole club's calendar —
// club-dated flyers (clubRecord.club_flyers[]) and tour/show-level flyers
// (getTourLevelFlyers()) don't apply to a bare specificEvent, so they're
// not pulled in here.
//
// NOT yet wired up in this pass:
//   - event_id resolution against tour dates / repertoire show dates /
//     music / poetry events — only eventsData.specificEvents is searched
//     (both for event_id lookup and for the search box) for now
// That's a natural next step once this much is confirmed working.
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

// Step 1: only eventsData.specificEvents (one-off dated club events) is
// searchable. Extending this to tour dates / repertoire show dates / music
// / poetry events is the next pass, once this much is confirmed working.
function resolvableSpecificEvents() {
  return (eventsData.specificEvents || [])
    .map((e) => ({ ...e, _date: parseDateString(e.date) }))
    .filter((e) => e._date && e.name);
}

function findEventById(eventId) {
  const target = decodeURIComponent(eventId);
  return (
    resolvableSpecificEvents().find(
      (e) => buildEventId(e.name, e._date) === target,
    ) || null
  );
}

// No id given, or the given id didn't resolve: pick something so the shell
// is testable without needing a real permalink yet. Prefers an upcoming
// event whose venue has usable coordinates (so the map/nearby sections
// have something to show); falls back to any dated event if none qualify.
function pickSampleEvent() {
  const today = getTodayMidnight();
  const withVenue = resolvableSpecificEvents().filter(
    (e) =>
      e.venue_id &&
      venuesLookup[e.venue_id] &&
      hasLatlon(venuesLookup[e.venue_id]),
  );
  const upcoming = withVenue.filter((e) => e._date >= today);
  const pool = upcoming.length ? upcoming : withVenue;
  if (pool.length) return pool[Math.floor(Math.random() * pool.length)];

  const anyDated = resolvableSpecificEvents();
  return anyDated.length
    ? anyDated[Math.floor(Math.random() * anyDated.length)]
    : null;
}

// ---------------------------------------------------------------------------
// Search box
// ---------------------------------------------------------------------------

// Same Step 1 scope note as findEventById()/pickSampleEvent(): only
// eventsData.specificEvents is indexed for now.
function buildSearchIndex() {
  return resolvableSpecificEvents().map((e) => {
    const hostVenue = venuesLookup[e.venue_id] || null;
    const performerName =
      (e.performer_id && performersLookup[e.performer_id]?.name) ||
      e.performer ||
      null;
    const searchText = [
      e.showname || e.name,
      performerName,
      hostVenue?.name,
      hostVenue?.city,
      hostVenue?.full_address,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return { ev: e, hostVenue, performerName, searchText };
  });
}

// Wires the #eventSearchBox container up with createSearchBox()
// (shared_utils.js) — same component venues.js/performers.js use for
// their own directory search. Searches event name, performer, venue,
// town, and address (per the search index above); selecting a result
// navigates to that event's own page.
function initSearchBox() {
  const container = document.getElementById("eventSearchBox");
  if (!container) return;

  const index = buildSearchIndex();

  createSearchBox(container, {
    placeholder: "Search events by name, performer, venue, town\u2026",
    search: (term) =>
      index.filter((e) => e.searchText.includes(term)).slice(0, 8),
    renderItem: ({ ev, hostVenue, performerName }) => {
      const item = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = ev.showname || ev.name;
      item.appendChild(strong);

      const metaParts = [performerName, hostVenue?.name, hostVenue?.city]
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
    onSelect: ({ ev }) => {
      const eventId = buildEventId(ev.name, ev._date);
      window.location.href = `event.html?event_id=${encodeURIComponent(eventId)}`;
    },
    onChange: () => {
      // Nothing to re-filter on this page — event.html shows one event,
      // not a list — so this is deliberately a no-op.
    },
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
        `event.html: event_id "${eventIdParam}" not found (Step 1 only searches specificEvents) — showing a sample event instead.`,
      );
    } else {
      console.info(
        "event.html: no ?event_id= given — showing a sample event.",
      );
    }
    eventRecord = pickSampleEvent();
  }

  if (!eventRecord) {
    showNotFound();
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
// Main render
// ---------------------------------------------------------------------------

function renderPage() {
  const ev = eventRecord;
  const name = ev.showname || ev.name;
  document.title = `${name} — New Troubadours`;
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
  const flyerControls = document.getElementById("flyerControls");
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

  // Flyer(s) — event_flyer/event_flyer2/event_flyers, resolved by
  // getEventLevelFlyers() (shared_utils.js), same helper storyclub.js uses.
  const flyers = getEventLevelFlyers(ev);
  if (flyers.length) {
    anyContent = true;
    flyerControls.style.display = "";

    const flyerBtn = document.createElement("button");
    flyerBtn.className = "expand-btn";
    flyerBtn.textContent = flyers.length > 1 ? "Flyers" : "Flyer";

    const flyerExpandable = document.createElement("div");
    flyerExpandable.className = "expandable";

    flyers.forEach((flyer, index) => {
      const img = document.createElement("img");
      img.alt = `${ev.showname || ev.name} ${flyer.label}`;
      img.src = `./storyclub_assets/event_flyers/${sanitizeFlyerPath(flyer.filename)}`;
      img.className = "event-flyer-img";
      if (index > 0) img.classList.add("event-flyer-subsequent");
      flyerExpandable.appendChild(img);
    });

    flyerBtn.addEventListener("click", () => {
      const open = flyerExpandable.classList.toggle("open");
      flyerBtn.textContent = open
        ? flyers.length > 1
          ? "Hide flyers"
          : "Hide flyer"
        : flyers.length > 1
          ? "Flyers"
          : "Flyer";
    });

    flyerControls.appendChild(flyerBtn);
    flyerControls.appendChild(flyerExpandable);
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
  upcoming.forEach((entry) =>
    renderEventRow(list, entry, false, { showVenue: true }),
  );

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
