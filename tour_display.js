let map;
let markers = [];
let eventsData = null;
let venuesLookup = {};
let performersLookup = {};
let toursLookup = {}; // combined: real tours + synthetic "rep:<id>" entries for repertoire shows — see buildCombinedToursLookup()
let repertoireShowsLookup = {};
let currentTour = null; // Store current tour for map filtering
let leafletPromise = null;
let mapInitPromise = null;

const LEAFLET_JS_URL =
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js";
const LEAFLET_CSS_URL =
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css";

// ---------------------------------------------------------------------------
// Lazy Leaflet/map loading — tour_guide.html no longer links/preloads
// Leaflet's CSS or JS at all. Loading it here, on demand, means a slow or
// unreachable cdnjs request can never hold up this file's own execution
// (previously a blocking <script> tag for leaflet.js sat *before*
// tour_display.js in the HTML, so the events-JSON fetch below couldn't
// even start until Leaflet had downloaded) or the tour's title/meta
// tags/dates list, which all land in the DOM well before the map now.
// Duplicated from event.js's loadLeaflet() rather than shared — matches
// that file's own precedent (it isn't in shared_utils.js either).
// ---------------------------------------------------------------------------

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

/**
 * Creates the Leaflet map the first time it's needed (lazily loading
 * Leaflet itself first). If a tour is already on screen (currentTour set
 * by displayTour() before the map was ready), its markers are added as
 * soon as the map exists, so nothing has to wait around for this to
 * resolve except the map/markers themselves.
 * Safe to call more than once — later calls resolve the same map/promise.
 * @returns {Promise<L.Map>}
 */
function ensureMapInitialized() {
  if (map) return Promise.resolve(map);
  if (mapInitPromise) return mapInitPromise;

  mapInitPromise = loadLeaflet()
    .then(() => {
      map = initMap("map", updateMapView);
      // The map may have been created while its container was hidden
      // (browse mode, no tour picked yet) or just became visible a moment
      // ago (displayTour() already flipped #tourContent to display:block);
      // either way Leaflet needs a nudge to size the tiles correctly.
      map.invalidateSize();
      if (currentTour) {
        addTourMarkersToMap(currentTour);
      }
      return map;
    })
    .catch((error) => {
      console.error("Failed to load tour map:", error);
      const mapContainer = document.getElementById("map-container");
      if (mapContainer) mapContainer.style.display = "none";
      throw error;
    });

  return mapInitPromise;
}

// ---------------------------------------------------------------------------
// "Touring Shows" merge — a repertoire show (top-level `repertoire_shows`)
// is treated as just another browsable item on this page, alongside real
// tours. Rather than duplicating every function below into a parallel
// "repertoire" version, each repertoire show is adapted into the same
// tour-shaped object (repertoireShowAsTourShape()) and merged into
// toursLookup under a synthetic id prefixed "rep:" (so it can never
// collide with a real tour id). Everything else in this file — dropdowns,
// the Now Touring/Upcoming/Past panels, the map, the dates list, flyer
// galleries — reads that combined toursLookup and never needs to know
// which kind of record it's actually looking at.
//
// buildCombinedToursLookup() returns a shallow copy, so this never mutates
// the shared eventsData.tours object other pages/reloads rely on.
// ---------------------------------------------------------------------------

const REPERTOIRE_ID_PREFIX = "rep:";

function repertoireShowAsTourShape(showId, show) {
  return {
    __repertoireShowId: showId,
    tour_name: show.name,
    name: show.showname || show.name,
    showname: show.showname || show.name,
    tour_description: show.description || "",
    tour_dates: show.show_dates || [],
    tour_flyer: show.touring_event_flyer || "",
    touring_event_flyer: show.touring_event_flyer || "",
    video_trailer: show.video_trailer || "",
    performer_id: show.performer_id || null,
    performer_ids: Array.isArray(show.performer_ids) ? show.performer_ids : [],
    isSpecial: !!show.isSpecial,
    isStoryWalk: !!show.isStoryWalk,
    isMusic: false,
    isPoetry: false,
    repertoire_id: null,
  };
}

function buildCombinedToursLookup(realTours, repertoireShows) {
  const combined = { ...(realTours || {}) };
  Object.entries(repertoireShows || {}).forEach(([showId, show]) => {
    combined[REPERTOIRE_ID_PREFIX + showId] = repertoireShowAsTourShape(
      showId,
      show,
    );
  });
  return combined;
}

/**
 * Builds the grouped dropdown entries for one performer: each repertoire
 * show they're in (with any tours that repertoire_id-link to it nested
 * right after, as "↳ Tour Name"), followed by an "Other Tours" group for
 * anything left over. Repertoire shows are listed first — see the
 * "Touring Shows" merge note above: a repertoire show represents the
 * more polished, established form of a show, so it leads.
 * @param {string} performerId
 * @returns {{groupLabel: string|null, items: {id: string, label: string}[]}[]}
 */
function buildTourDropdownGroups(performerId) {
  const troupeRecord = performersLookup[performerId];
  const aliasIds = new Set([performerId, ...(troupeRecord?.aliases || [])]);
  const showMatches = (show) =>
    aliasIds.has(show.performer_id) ||
    (Array.isArray(show.performer_ids) &&
      show.performer_ids.some((id) => aliasIds.has(id)));
  // Same idea as showMatches() above, via the shared performerIdsOf()
  // (shared_utils.js) — without this, a co-headlined tour (performer_ids
  // set, no singular performer_id) was invisible in every performer's own
  // tour dropdown, nested-under-a-show or "Other Tours" alike.
  const tourMatches = (t) => performerIdsOf(t).some((id) => aliasIds.has(id));

  const myShowIds = Object.entries(repertoireShowsLookup)
    .filter(([, show]) => showMatches(show))
    .map(([id]) => id)
    .sort((a, b) => {
      const na =
        repertoireShowsLookup[a].showname || repertoireShowsLookup[a].name;
      const nb =
        repertoireShowsLookup[b].showname || repertoireShowsLookup[b].name;
      return na.localeCompare(nb);
    });

  const usedTourIds = new Set();
  const groups = [];

  myShowIds.forEach((showId) => {
    const show = repertoireShowsLookup[showId];
    const items = [
      {
        id: REPERTOIRE_ID_PREFIX + showId,
        label: `${show.showname || show.name} — overview`,
      },
    ];
    Object.entries(toursLookup)
      .filter(
        ([, t]) => t.repertoire_id === showId && tourMatches(t),
      )
      .sort((a, b) =>
        (a[1].tour_name || a[1].name).localeCompare(
          b[1].tour_name || b[1].name,
        ),
      )
      .forEach(([tourId, t]) => {
        usedTourIds.add(tourId);
        items.push({ id: tourId, label: `↳ ${t.tour_name || t.name}` });
      });
    groups.push({ groupLabel: `🔁 ${show.showname || show.name}`, items });
  });

  const orphanItems = Object.entries(toursLookup)
    .filter(
      ([id, t]) =>
        !t.__repertoireShowId &&
        !usedTourIds.has(id) &&
        tourMatches(t),
    )
    .sort((a, b) =>
      (a[1].tour_name || a[1].name).localeCompare(b[1].tour_name || b[1].name),
    )
    .map(([id, t]) => ({ id, label: t.tour_name || t.name }));

  if (orphanItems.length > 0) {
    groups.push({
      groupLabel: groups.length > 0 ? "Other Tours" : null,
      items: orphanItems,
    });
  }

  return groups;
}

// getUkIrelandBounds(), ICON_SVG — defined in shared_utils.js

// getTodayMidnight() — defined in shared_utils.js

function getTourStatus(tour) {
  if (!tour.tour_dates || tour.tour_dates.length === 0) return "unknown";
  const today = getTodayMidnight();
  const dates = expandTourDates(tour.tour_dates)
    .map((d) => parseDateString(d.date))
    .filter(Boolean); // exclude entries with missing/malformed dates
  if (dates.length === 0) return "unknown";
  const allPast = dates.every((d) => d < today);

  // We'll consider a tour as in the future if the first date
  // is at least seven days in the future.
  const sevenDaysFromToday = new Date(today);
  sevenDaysFromToday.setDate(sevenDaysFromToday.getDate() + 7);
  const allFuture = dates.every((d) => d >= sevenDaysFromToday);
  //const allFuture = dates.every((d) => d >= today);
  if (allPast) return "past";
  if (allFuture) return "future";
  return "current"; // straddles today
}

// isDatePast(dateStr) — defined in shared_utils.js

// Some performer records are themselves just a "stepping stone" that
// bundles several real performers together (e.g. a combined billing id
// like "jess-silk-joe-solo" whose record carries its own performer_ids:
// ["jess-silk", "joe-solo"]). Given a raw id, this expands it to the real
// leaf performer id(s) it stands for, or returns the id unchanged if it's
// already a standalone performer.
function expandPerformerId(id, performersLookup) {
  const record = performersLookup && performersLookup[id];
  if (
    record &&
    Array.isArray(record.performer_ids) &&
    record.performer_ids.length > 0
  ) {
    return record.performer_ids.filter(Boolean);
  }
  return [id];
}

// Returns the set of performer ids to link to from the tour page: the
// tour's own performer_id (which may be an individual, a troupe, or a
// combined "stepping stone" billing id such as "jess-silk-joe-solo"),
// any explicit tour.performer_ids, plus — for legacy tours that only set
// performer_id and rely on the performer record itself to list the real
// lineup — the ids expanded out of that stepping-stone record. The
// combined id is deliberately kept in the set (not dropped) so its own
// homepage/profile links still show up alongside the individuals'; any
// duplicate website URL is filtered out later, at link-building time.
function getTourLinkPerformerIds(tour) {
  const ids = new Set();
  if (!tour) return ids;
  if (tour.performer_id) ids.add(tour.performer_id);
  if (Array.isArray(tour.performer_ids)) {
    tour.performer_ids.forEach((id) => {
      if (id) ids.add(id);
    });
  }
  if (tour.performer_id) {
    expandPerformerId(tour.performer_id, performersLookup).forEach((id) =>
      ids.add(id),
    );
  }
  return ids;
}


// Additional (non-headline) performers. tour.other_performer_ids lists
// the other performers on the tour as a whole; a tour date's own
// other_performer_ids, when it has at least one entry, REPLACES the
// tour-level list for that date (it doesn't merge with it). Returns
// de-duplicated ids that have a performer record, excluding anyone
// already billed as a headliner on the tour, and anyone already
// rendered via the more specific support_performer_ids relationship
// (see getSupportPerformerIds() below) — a performer only ever shows up
// in one of the two rows, never both.
function getAdditionalPerformerIds(tour, tourDate) {
  const dateIds =
    tourDate && Array.isArray(tourDate.other_performer_ids)
      ? tourDate.other_performer_ids.filter(Boolean)
      : [];
  const tourIds =
    tour && Array.isArray(tour.other_performer_ids)
      ? tour.other_performer_ids.filter(Boolean)
      : [];
  const source = dateIds.length > 0 ? dateIds : tourIds;

  const headliners = tour ? getTourLinkPerformerIds(tour) : new Set();
  const supportIds = new Set(getSupportPerformerIds(tour, tourDate));
  const seen = new Set();
  const result = [];
  source.forEach((id) => {
    if (seen.has(id) || headliners.has(id) || supportIds.has(id) || !performersLookup[id])
      return;
    seen.add(id);
    result.push(id);
  });
  return result;
}

// Support acts (support_performer_ids) — a more specific, always-"opening
// for the headliner" relationship than the arbitrary other_performer_ids
// above. Same per-date-replaces-tour-level semantics: a tour_dates entry's
// own support_performer_ids, when it has at least one entry, REPLACES the
// tour-level list for that date rather than merging with it. Excludes
// anyone already billed as a tour headliner, and — for a date whose
// billing is flipped via tourDate.headliner — the effective headliner
// for that date too, so a data slip can't render the same person as both
// headlining and supporting themselves on one date.
function getSupportPerformerIds(tour, tourDate) {
  const dateIds =
    tourDate && Array.isArray(tourDate.support_performer_ids)
      ? tourDate.support_performer_ids.filter(Boolean)
      : [];
  const tourIds =
    tour && Array.isArray(tour.support_performer_ids)
      ? tour.support_performer_ids.filter(Boolean)
      : [];
  const source = dateIds.length > 0 ? dateIds : tourIds;

  const headliners = tour ? getTourLinkPerformerIds(tour) : new Set();
  const effectiveHeadlinerId = getEffectiveHeadlinerId(tour, tourDate);
  const seen = new Set();
  const result = [];
  source.forEach((id) => {
    if (
      seen.has(id) ||
      headliners.has(id) ||
      id === effectiveHeadlinerId ||
      !performersLookup[id]
    )
      return;
    seen.add(id);
    result.push(id);
  });
  return result;
}

// Who's actually headlining a given tour date. Normally that's just the
// tour's own performer_id, but a tour_dates entry may set its own
// `headliner` to name someone else instead — used for a date where the
// tour's own act is really appearing in a support slot on somebody
// else's night, while the date is still tracked (and shown) as part of
// this tour. Pass tourDate as null/undefined for tour-header-level
// context, where there's no per-date override to consider.
function getEffectiveHeadlinerId(tour, tourDate) {
  if (tourDate && tourDate.headliner) return tourDate.headliner;
  return tour ? tour.performer_id : null;
}

// Resolves the effective isDoubleHeadline flag for a given context: a
// tour_dates entry's own isDoubleHeadline, when EXPLICITLY set (true or
// false), overrides the tour-level default; otherwise falls back to
// tour.isDoubleHeadline (default false when unset). Pass tourDate as
// null/undefined for tour-header-level rendering.
function isDoubleHeadlineForDate(tour, tourDate) {
  if (tourDate && typeof tourDate.isDoubleHeadline === "boolean") {
    return tourDate.isDoubleHeadline;
  }
  return !!(tour && tour.isDoubleHeadline);
}

// Builds a "label: [pill] [pill]" row of links to performer profile pages
// (reusing the .performer-tag pills), or null if there's nobody to show.
// `extraClass` distinguishes the tour-header row from the per-date one.
function buildAdditionalPerformersEl(ids, label, extraClass) {
  if (!ids || ids.length === 0) return null;
  const wrap = document.createElement("div");
  wrap.className = `additional-performers ${extraClass || ""}`.trim();

  const labelEl = document.createElement("span");
  labelEl.className = "additional-performers-label";
  labelEl.textContent = label;
  wrap.appendChild(labelEl);

  ids.forEach((id) => {
    const perf = performersLookup[id];
    if (!perf) return;
    const tag = document.createElement("a");
    tag.href = `performers.html?performer=${encodeURIComponent(id)}`;
    tag.className = "performer-tag";
    tag.textContent = perf.name;
    // Don't let a click on a tag also zoom the map (date cards do that).
    tag.addEventListener("click", (e) => e.stopPropagation());
    wrap.appendChild(tag);
  });
  return wrap;
}

// sanitizeUrl() — defined in shared_utils.js

// initMap() — defined in shared_utils.js

// loadEventsData() — defined in shared_utils.js
// Populates eventsData, toursLookup, venuesLookup, performersLookup and returns eventsData.

function shareTourLink() {
  const tourSelect = document.getElementById("tourSelect");
  const performerSelect = document.getElementById("performerSelect");

  const tourId = tourSelect.value;
  const performerId = performerSelect.value;

  if (!tourId) {
    alert("Please select a touring show first");
    return;
  }

  // Create the correct URL manually based on current selections
  const params = new URLSearchParams();
  params.set("tour", tourId);
  if (performerId) {
    params.set("performer", performerId);
  }

  const shareableUrl = `${window.location.origin}${window.location.pathname}?${params.toString()}`;

  navigator.clipboard
    .writeText(shareableUrl)
    .then(() => {
      // Feedback UI
      const btn = document.querySelector("button[onclick='shareTourLink()']");
      showCopyFeedback(btn);

      // Also update the browser's address bar so it matches what was copied
      window.history.pushState({ tourId }, "", shareableUrl);
    })
    .catch((err) => {
      console.error("Failed to copy link:", err);
    });
}

function populatePerformerDropdown() {
  const performerSelect = document.getElementById("performerSelect");

  // Get unique performers who have tours, resolving troupe configs to their parent
  const performersWithTours = new Map(); // resolved id -> name

  Object.values(toursLookup).forEach((tour) => {
    if (tour.performer_id && performersLookup[tour.performer_id]) {
      const { id, record } = resolvePerformerDisplay(
        tour.performer_id,
        performersLookup,
      );
      if (record) performersWithTours.set(id, record.name);
    }
  });

  // Sort performers by name
  const sortedPerformers = Array.from(performersWithTours.entries())
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  sortedPerformers.forEach((performer) => {
    const option = document.createElement("option");
    option.value = performer.id;
    option.textContent = performer.name;
    performerSelect.appendChild(option);
  });
}

/**
 * Collects every performer name associated with a repertoire show, for
 * the "Browse Repertoire Shows"/"Browse Story Walks" lists. A repertoire
 * show's own tour-shaped record (see repertoireShowAsTourShape() above)
 * often has no performer_id of its own — different performers can each
 * independently tour the same show — so most of the real performer
 * links actually live on the individual tours that point back at this
 * show via repertoire_id, not on the show record itself. This combines:
 *   - the show's own performer_id/performer_ids, if it happens to set
 *     them, and
 *   - every real tour with repertoire_id === this show's id.
 * Each id is run through the same troupe/combined-billing expansion
 * used for the tour page's own performer links (getTourLinkPerformerIds()),
 * resolved to a display name, and deduplicated.
 * @param {string} repId - the "rep:<showId>" key from toursLookup
 * @param {object} tour - the repertoire show's tour-shaped object
 * @returns {string[]} deduplicated, alphabetically sorted performer names
 */
function getRepertoireShowPerformerNames(repId, tour) {
  const showId = repId.startsWith(REPERTOIRE_ID_PREFIX)
    ? repId.slice(REPERTOIRE_ID_PREFIX.length)
    : repId;

  const ids = getTourLinkPerformerIds(tour);
  Object.values(toursLookup).forEach((t) => {
    if (t.repertoire_id === showId) {
      getTourLinkPerformerIds(t).forEach((id) => ids.add(id));
    }
  });

  const names = new Set();
  ids.forEach((id) => {
    const { record } = resolvePerformerDisplay(id, performersLookup);
    if (record && record.name) names.add(record.name);
  });

  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

/**
 * Builds one clickable row for the "Browse Repertoire Shows" collapsible
 * — reuses the same click-through behaviour as buildTouringCard() in the
 * Now Touring/Upcoming/Previous panels (fill in Performer + Touring show
 * to match, then display), but as a plain row rather than a full card,
 * and tolerant of a show having zero dates of its own (e.g. Troubled
 * Waters, whose dates all come via linked tours) — buildTouringCard()
 * assumes a non-empty date range, which doesn't hold here.
 */
function buildRepertoireBrowseRow(repId, tour) {
  const performerNames = getRepertoireShowPerformerNames(repId, tour);

  const dates = expandTourDates(tour.tour_dates || [])
    .map((d) => parseDateString(d.date))
    .filter(Boolean)
    .sort((a, b) => a - b);

  const row = document.createElement("div");
  row.className = "repertoire-browse-row";

  const flyers = getTourLevelFlyers(tour);
  if (flyers.length > 0) {
    const thumb = document.createElement("div");
    thumb.className = "now-touring-flyer-thumb";
    const img = document.createElement("img");
    img.dataset.src = `./storyclub_assets/event_flyers/${sanitizeFlyerPath(flyers[0].filename)}`;
    img.alt = `${tour.showname || tour.name} flyer`;
    img.addEventListener("load", () => img.classList.add("loaded"));
    flyerImgLoader.observe(img);
    thumb.appendChild(img);
    row.appendChild(thumb);
  }

  const body = document.createElement("div");
  body.className = "repertoire-browse-row-body";

  const name = document.createElement("div");
  name.className = "now-touring-show-name";
  name.textContent = tour.showname || tour.name;
  body.appendChild(name);

  if (performerNames.length > 0) {
    const perfName = document.createElement("div");
    perfName.className = "now-touring-performer";
    perfName.textContent = performerNames.join(", ");
    body.appendChild(perfName);
  }

  const stat = document.createElement("div");
  stat.className = "now-touring-dates";
  stat.textContent =
    dates.length === 0
      ? "See linked tours for dates"
      : dates.length === 1
        ? fmtShort(dates[0])
        : `${fmtShort(dates[0])} → ${fmtShort(dates[dates.length - 1])}`;
  body.appendChild(stat);

  row.appendChild(body);

  row.addEventListener("click", () => {
    const { id: resolvedPerformerId } = resolvePerformerDisplay(
      tour.performer_id,
      performersLookup,
    );
    document.getElementById("performerSelect").value = resolvedPerformerId;
    handlePerformerChange();
    document.getElementById("tourSelect").value = repId;
    displayTour(repId);
    updateURL(repId);
    document
      .getElementById("tourContent")
      .scrollIntoView({ behavior: "smooth", block: "start" });
  });

  return row;
}

/**
 * Populates the "Browse Repertoire Shows" collapsible — every repertoire
 * show, flat, regardless of whether any tour links to it (a
 * complementary entry point to the main Performer → Touring show flow
 * below, for when you know the show but not which performer to look
 * under first). Story walks are excluded here — see
 * renderStoryWalksBrowseList() below — even though they're still
 * repertoireShow records under the hood; this list is specifically
 * "shows", not "shows and walks".
 */
function renderRepertoireBrowseList() {
  const body = document.getElementById("repertoireBrowseBody");
  if (!body) return;
  body.innerHTML = "";

  const entries = Object.entries(toursLookup)
    .filter(([, t]) => t.__repertoireShowId && !t.isStoryWalk)
    .sort((a, b) =>
      (a[1].showname || a[1].name).localeCompare(b[1].showname || b[1].name),
    );

  const label = document.getElementById("repertoireBrowseSummaryLabel");
  if (label)
    label.textContent = `🔁 Browse Repertoire Shows (${entries.length})`;

  if (entries.length === 0) {
    body.innerHTML = '<p class="loading-state">No repertoire shows yet.</p>';
    return;
  }

  entries.forEach(([repId, tour]) =>
    body.appendChild(buildRepertoireBrowseRow(repId, tour)),
  );
}

/**
 * Populates the "Browse Story Walks" collapsible — the isStoryWalk
 * counterpart to renderRepertoireBrowseList() above. Reuses
 * buildRepertoireBrowseRow() unchanged (it works generically off any
 * tour-shaped object, story walk or not) and the same click-through into
 * displayTour(), since a story walk still has dates/venue/map exactly
 * like a repertoire show — only which LIST it appears in differs. If
 * repertoireBrowsePanel/storyWalksBrowsePanel markup isn't present on a
 * given page (only tour_guide.html has it), this is a silent no-op.
 */
function renderStoryWalksBrowseList() {
  const body = document.getElementById("storyWalksBrowseBody");
  if (!body) return;
  body.innerHTML = "";

  const entries = Object.entries(toursLookup)
    .filter(([, t]) => t.__repertoireShowId && t.isStoryWalk)
    .sort((a, b) =>
      (a[1].showname || a[1].name).localeCompare(b[1].showname || b[1].name),
    );

  const wrapper = document.getElementById("storyWalksBrowsePanel");
  const label = document.getElementById("storyWalksBrowseSummaryLabel");
  if (label) label.textContent = `Story Walks (${entries.length})`;

  if (entries.length === 0) {
    // No walks yet — hide the whole panel rather than show an empty
    // collapsible (matches how the touring panels hide via hideClass
    // when empty, e.g. no-now-touring).
    if (wrapper) wrapper.style.display = "none";
    return;
  }
  if (wrapper) wrapper.style.display = "";

  entries.forEach(([repId, tour]) =>
    body.appendChild(buildRepertoireBrowseRow(repId, tour)),
  );
}

function handlePerformerChange() {
  const performerId = document.getElementById("performerSelect").value;
  const tourSelect = document.getElementById("tourSelect");

  // Clear tour dropdown
  tourSelect.innerHTML = '<option value="">Select a touring show...</option>';

  if (!performerId) {
    // Optional: Clear the map/content if no performer is selected
    document.getElementById("tourContent").style.display = "none";
    return;
  }

  const groups = buildTourDropdownGroups(performerId);
  const allIds = [];

  groups.forEach(({ groupLabel, items }) => {
    let container = tourSelect;
    if (groupLabel) {
      const optgroup = document.createElement("optgroup");
      optgroup.label = groupLabel;
      tourSelect.appendChild(optgroup);
      container = optgroup;
    }
    items.forEach(({ id, label }) => {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = label;
      container.appendChild(option);
      allIds.push(id);
    });
  });

  // If there's exactly one selectable thing, handle the display logic
  if (allIds.length === 1) {
    // If only one, select and display it automatically
    const soleId = allIds[0];
    tourSelect.value = soleId;
    displayTour(soleId);
    updateURL(soleId);
  } else if (allIds.length > 1) {
    // Optional: If there are multiple, you might want to clear
    // the previous view until they pick one from the new list
    document.getElementById("tourContent").style.display = "none";
    // The map may not have loaded yet (it's now lazy — see
    // ensureMapInitialized()), in which case there's nothing to clear.
    markers = map ? clearMarkers(map, markers) : [];
  }
}

function handleTourChange() {
  // Auto-load tour when selection changes
  const tourId = document.getElementById("tourSelect").value;
  if (tourId) {
    displayTour(tourId);
    updateURL(tourId);
  }
}

function getTourURLParams() {
  const params = new URLSearchParams(window.location.search);
  return {
    tourId: params.get("tour"),
    performerId: params.get("performer"),
    cacheBuster: params.get("v"),
  };
}

// Shared by updateURL() and the tour share badge (renderShareBadge()), so the two never
// drift apart on which params make a tour's URL "canonical".
function buildTourURLParams(tourId) {
  const tour = toursLookup[tourId];
  const params = new URLSearchParams();
  params.set("tour", tourId);
  if (tour && tour.performer_id) {
    params.set("performer", tour.performer_id);
  }
  return params;
}

function updateURL(tourId) {
  if (!toursLookup[tourId]) return;

  const newURL = `${window.location.pathname}?${buildTourURLParams(tourId).toString()}`;
  window.history.pushState({ tourId }, "", newURL);
  setCanonical("tour");
}

function loadTour() {
  const tourId = document.getElementById("tourSelect").value;
  if (!tourId) {
    alert("Please select a touring show");
    return;
  }

  displayTour(tourId);
  updateURL(tourId);
}

function displayTour(tourId) {
  const tour = toursLookup[tourId];
  if (!tour) {
    console.error("Tour not found:", tourId);
    return;
  }

  document.title = `${tour.name}${tour.tour_name ? ` — ${tour.tour_name}` : ""} — New Troubadours`;
  // setMetaDescription() (not updateMeta()) so this REPLACES the
  // description each time rather than prepending to whatever the last
  // tour left there — displayTour() can run repeatedly in one page
  // session (browse-mode clicks, Back/Forward via the popstate handler
  // below), and updateMeta()'s prepend behaviour would otherwise grow the
  // tag by one more "Tour name — " fragment on every single switch.
  setMetaDescription(`${tour.tour_name || tour.name} — ${DEFAULT_META_DESCRIPTION}`);
  prependMetaKeyword(tour.tour_name || tour.name);

  // Switch into the same "clean" single-tour view that ?tour=<id> gets on
  // a fresh page load: hide the browse UI (panels + dropdowns) and show the
  // back link, so clicking a card/row (or the "Show" button) from browse
  // mode doesn't just render tourContent underneath the still-visible
  // browse panels. No-op if we're already in single-tour mode.
  const browseState = document.getElementById("tourBrowseState");
  if (browseState) browseState.style.display = "none";
  const backLinkWrap = document.getElementById("tourBackLinkWrap");
  if (backLinkWrap) backLinkWrap.style.display = "";

  // Store current tour for map filtering
  currentTour = tour;

  // Show tour content
  document.getElementById("tourContent").style.display = "block";

  if (map) {
    map.invalidateSize();
  }
  // If the map hasn't loaded yet, nothing to do here — ensureMapInitialized()
  // picks up `currentTour` (set just above) and adds its markers itself
  // once the map exists, so the text/meta rendering below is never made
  // to wait on it.

  // Set title and subtitle
  document.getElementById("tourTitle").textContent = tour.name;
  document.getElementById("tourSubtitle").textContent = tour.tour_name || "";

  // Additional tour performers, listed directly under the title/subtitle.
  // Cleared and rebuilt each time so switching tours never leaves stale tags.
  const addlContainer = document.getElementById("tourAdditionalPerformers");
  addlContainer.innerHTML = "";
  const tourAddlIds = getAdditionalPerformerIds(tour, null);
  const tourAddlEl = buildAdditionalPerformersEl(
    tourAddlIds,
    isDoubleHeadlineForDate(tour, null) ? "Co-headlining:" : "Also featuring:",
    "additional-performers-tour",
  );
  if (tourAddlEl) {
    tourAddlIds.forEach((id) => prependMetaKeyword(performersLookup[id].name));
    addlContainer.appendChild(tourAddlEl);
  }

  // Support acts for the tour as a whole (support_performer_ids) — a more
  // specific "opening for the headliner" relationship than the arbitrary
  // other_performer_ids row above, so it gets its own row/label.
  const tourSupportIds = getSupportPerformerIds(tour, null);
  const tourSupportEl = buildAdditionalPerformersEl(
    tourSupportIds,
    "Support:",
    "additional-performers-tour additional-performers-support",
  );
  if (tourSupportEl) {
    tourSupportIds.forEach((id) =>
      prependMetaKeyword(performersLookup[id].name),
    );
    addlContainer.appendChild(tourSupportEl);
  }

  addlContainer.style.display =
    addlContainer.children.length > 0 ? "" : "none";

  // Performer websites & profile pages. For a tour with a combined/troupe
  // performer_id (e.g. "jess-silk-joe-solo"), we want links to each real
  // performer's own homepage + site profile page, plus the troupe/combined
  // entry's own homepage too — but only if it has one and it's a different
  // URL to the individuals' (avoids a duplicate link when it's the same).
  //
  // Layout: all "Visit X's Website" links are grouped together in a row
  // above the flyer image (and again, footer-styled, below it), and the
  // performer-profile-page links are rendered as a separate row of small
  // pill/tag buttons, rather than being interleaved with the website links.
  // Styling for .performer-website-links / .performer-website-links-footer /
  // .performer-tags / .performer-tag lives in tour-styles.css.
  const performer = performersLookup[tour.performer_id];
  const performerIds = getTourLinkPerformerIds(tour);

  const flyerContainer = document.getElementById("tourFlyerContainer");

  // Rebuild container children in explicit order: top links → flyer(s) → bottom links.
  // This avoids positional insertBefore/appendChild drift across repeated displayTour calls.
  flyerContainer.innerHTML = "";

  const topWebsiteLinks = [];
  const bottomWebsiteLinks = [];
  const profileTags = [];
  const seenWebsiteUrls = new Set();

  performerIds.forEach((id) => {
    const perf = performersLookup[id];
    if (!perf) return;

    prependMetaKeyword(perf.name);

    // Website links — skip if we've already linked this exact URL
    // (e.g. troupe site == one of the individuals').
    if (perf.url) {
      const safeUrl = sanitizeUrl(perf.url);
      if (safeUrl && !seenWebsiteUrls.has(safeUrl)) {
        seenWebsiteUrls.add(safeUrl);

        const topLink = document.createElement("a");
        topLink.href = safeUrl;
        topLink.target = "_blank";
        topLink.rel = "noopener noreferrer";
        topLink.className = "performer-link site-link-header";
        topLink.textContent = `Visit ${perf.name}'s Website`;
        topWebsiteLinks.push(topLink);

        const bottomLink = document.createElement("a");
        bottomLink.href = safeUrl;
        bottomLink.target = "_blank";
        bottomLink.rel = "noopener noreferrer";
        bottomLink.className = "performer-link site-link-footer";
        bottomLink.textContent = `Official Website: ${perf.name}`;
        bottomWebsiteLinks.push(bottomLink);
      }
    }

    // Performer profile page — rendered as a small tag/pill button.
    const tag = document.createElement("a");
    tag.href = `performers.html?performer=${encodeURIComponent(id)}`;
    tag.className = "performer-tag";
    tag.textContent = perf.name;
    profileTags.push(tag);
  });

  // Top website links, grouped in one row.
  if (topWebsiteLinks.length > 0) {
    const topGroup = document.createElement("div");
    topGroup.className = "performer-website-links";
    topWebsiteLinks.forEach((l) => topGroup.appendChild(l));
    flyerContainer.appendChild(topGroup);
  }

  // Profile-page tag buttons, grouped in their own row.
  if (profileTags.length > 0) {
    const tagRow = document.createElement("div");
    tagRow.className = "performer-tags";
    profileTags.forEach((t) => tagRow.appendChild(t));
    flyerContainer.appendChild(tagRow);
  }

  // Tour-level flyer(s) — getTourLevelFlyers() (shared_utils.js) merges
  // tour_flyer + touring_event_flyer + touring_event_flyers. ALL of them
  // are shown here as heroes (side by side/stacked via CSS), since these
  // are the tour's own official artwork rather than per-date one-offs —
  // none are demoted into the collapsed "Per-date flyers" gallery further
  // down the page (see renderTourFlyers()), which covers only per-date
  // flyers. Clicking any hero opens the same lightbox used for that
  // gallery, scoped to just the tour-level set so prev/next flips between
  // them.
  const tourLevelFlyers = getTourLevelFlyers(tour);
  const heroFlyerRow = document.createElement("div");
  heroFlyerRow.className = "tour-hero-flyers";
  // Widen the outer container when there's more than one flyer, so two
  // (or more) get real room to sit side by side rather than being
  // squeezed into the width sized for a single hero image — flex-wrap
  // still falls back to stacked on any viewport too narrow for that.
  flyerContainer.classList.toggle(
    "tour-flyer-multi",
    tourLevelFlyers.length > 1,
  );
  const heroLightboxItems = tourLevelFlyers.map((f) => ({
    src: `./storyclub_assets/event_flyers/${sanitizeFlyerPath(f.filename)}`,
    label: f.label,
  }));
  tourLevelFlyers.forEach((f, i) => {
    const img = document.createElement("img");
    img.src = heroLightboxItems[i].src;
    img.alt =
      tourLevelFlyers.length > 1
        ? `${tour.name} tour flyer — ${f.label}`
        : `${tour.name} tour flyer`;
    img.className = "tour-hero-flyer-img";
    img.onclick = () => openTourFlyerLightbox(heroLightboxItems, i);
    heroFlyerRow.appendChild(img);
  });

  flyerContainer.appendChild(heroFlyerRow); // always re-attach flyer(s) in the middle

  // Bottom (footer-styled) website links, grouped in one row.
  if (bottomWebsiteLinks.length > 0) {
    const bottomGroup = document.createElement("div");
    bottomGroup.className = "performer-website-links-footer";
    bottomWebsiteLinks.forEach((l) => bottomGroup.appendChild(l));
    flyerContainer.appendChild(bottomGroup);
  }

  if (tourLevelFlyers.length > 0) {
    flyerContainer.style.display = "block";
  } else {
    // Show container if there are links, even if no flyer image
    flyerContainer.style.display = performerIds.size > 0 ? "block" : "none";
  }

  // Display tour description if available
  const descContainer = document.getElementById("tourDescriptionContainer");
  if (tour.tour_description) {
    descContainer.innerHTML = "";
    appendParagraphs(descContainer, tour.tour_description);
    descContainer.style.display = "block";
  } else {
    descContainer.style.display = "none";
  }

  // Display optional video trailer (YouTube only, sanitized to a
  // youtube-nocookie.com /embed/ URL — see getYouTubeEmbedUrl()).
  const trailerContainer = document.getElementById("tourTrailerContainer");
  const trailerFrame = document.getElementById("tourTrailerFrame");
  const embedUrl = getYouTubeEmbedUrl(tour.video_trailer);
  if (embedUrl) {
    trailerFrame.src = embedUrl;
    trailerContainer.style.display = "block";
  } else {
    // Clear src (not just hide) so playback stops when switching tours
    trailerFrame.src = "";
    trailerContainer.style.display = "none";
  }

  // Determine and show tour status banner
  const status = getTourStatus(tour);
  let existingBanner = document.getElementById("tourStatusBanner");
  if (existingBanner) existingBanner.remove();

  const STATUS_BANNER = {
    past: {
      cls: "tour-banner-past",
      text: "📅 This tour has ended — showing all dates.",
    },
    future: {
      cls: "tour-banner-future",
      text: "🗓 Upcoming tour — all dates still to come.",
    },
    current: {
      cls: "tour-banner-current",
      text: "🎭 Tour in progress — past dates shown in grey.",
    },
  };

  const banner = document.createElement("div");
  banner.id = "tourStatusBanner";
  banner.className = `tour-banner ${STATUS_BANNER[status]?.cls ?? "tour-banner-current"}`;
  banner.textContent = STATUS_BANNER[status]?.text ?? "";

  const datesSection = document.getElementById("tourDatesList").parentElement;
  datesSection.insertBefore(banner, document.getElementById("tourDatesList"));

  displayTourDates(tour, status);

  // Render flyer gallery (tour-level + per-date flyers)
  renderTourFlyers(tour);

  // Add markers to map, if it's ready (see the note near the top of this
  // function — ensureMapInitialized() handles it instead when it isn't).
  if (map) {
    addTourMarkersToMap(tour);
  }

  // "Find tour on" badge — links to this tour's own URL, incl. its performer
  // param (same as buildTourURLParams()).
  renderShareBadge("tour", tourId, { performer: tour.performer_id });
}

function displayTourDates(tour, status) {
  const datesContainer = document.getElementById("tourDatesList");
  datesContainer.innerHTML = "";

  // "Hide past dates" defaults to checked (see the checkbox's HTML) and
  // only makes sense as a *default* for a tour that's still ongoing
  // (status "current" straddles today) — that's the one case with a
  // genuinely useful past/upcoming split to hide. The label (and
  // checkbox) are hidden for any other status, with the checkbox
  // explicitly un-checked underneath so a fully completed ("past") tour
  // doesn't silently filter out every single date with no visible control
  // left to un-hide them. The control stays visible for "past" too (not
  // just "current") so it's still there to toggle if wanted — a "future"
  // tour has no past dates yet, so there's nothing for it to do there,
  // and it stays hidden in that case.
  const hidePastLabel = document.getElementById("hidePastLabel");
  const hidePastCheckbox = document.getElementById("hidePastDates");
  hidePastLabel.style.display =
    status === "current" || status === "past" ? "" : "none";
  hidePastCheckbox.checked = status === "current";

  // Set subtitle: show name + performer
  const subtitle = document.getElementById("tourDatesSubtitle");
  if (subtitle) {
    const performer = performersLookup[tour.performer_id];
    const parts = [tour.tour_name || tour.name];
    if (performer) parts.push(performer.name);
    subtitle.textContent = parts.join(" · ");
  }

  if (!tour.tour_dates || tour.tour_dates.length === 0) {
    datesContainer.innerHTML = "<p>No dates scheduled yet.</p>";
    return;
  }

  const sortedDates = [...expandTourDates(tour.tour_dates)].sort((a, b) => {
    const dateA = parseDateString(a.date);
    const dateB = parseDateString(b.date);
    if (!dateA && !dateB) return 0;
    if (!dateA) return 1;
    if (!dateB) return -1;
    return dateA - dateB;
  });

  let firstUpcomingEl = null;

  sortedDates.forEach((tourDate) => {
    const past = isDatePast(tourDate.date);
    const dateItem = createTourDateElement(tourDate, tour, past);

    datesContainer.appendChild(dateItem);

    if (!past && !firstUpcomingEl) {
      firstUpcomingEl = dateItem;
    }
  });

  // For current tours, scroll to next upcoming date after a brief delay
  if (status === "current" && firstUpcomingEl) {
    setTimeout(() => {
      firstUpcomingEl.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 400);
  }

  updateEventDisplayFilters();
}

// parseDateString() — defined in shared_utils.js

function createTourExpandable(parent, label, content, type) {
  const btn = document.createElement("div");
  btn.className = "event-expand-btn expand-btn-spaced";
  btn.textContent = label;

  const expandable = document.createElement("div");
  expandable.className = "event-expandable";
  expandable.style.display = "none";

  if (type === "image") {
    const img = document.createElement("img");
    img.dataset.src = `./storyclub_assets/event_flyers/${sanitizeFlyerPath(content)}`;
    img.className = "event-flyer-image";
    expandable.appendChild(img);
    // Load the image lazily when the expandable comes into view (i.e. after btn click)
    flyerImgLoader.observe(img);
  } else {
    const p = document.createElement("p");
    p.className = "event-description";
    p.textContent = content;
    expandable.appendChild(p);
  }

  btn.onclick = (e) => {
    e.stopPropagation(); // Don't zoom the map when clicking buttons
    const isHidden = expandable.style.display === "none";
    expandable.style.display = isHidden ? "block" : "none";
    btn.textContent = isHidden ? "Close" : label;
  };

  parent.appendChild(btn);
  parent.appendChild(expandable);
}

// createIcon() — defined in shared_utils.js

function createTourDateElement(tourDate, tour, past = false) {
  const div = document.createElement("div");
  // Use the standard event classes for gradients and borders
  div.className = "event tour-date-item";
  if (tour.isMusic) div.classList.add("music");
  if (tour.isPoetry) div.classList.add("poetry");
  if (past) div.classList.add("date-past");

  // Map Interaction: Zoom to venue on click
  div.addEventListener("click", () => {
    if (tourDate.venue_id && venuesLookup[tourDate.venue_id]) {
      const venue = venuesLookup[tourDate.venue_id];
      if (venue.latlon) {
        map.flyTo(venue.latlon, 14);
        markers.forEach((m) => {
          if (m.venue_id === tourDate.venue_id) m.openPopup();
        });
      }
    }
  });

  // Date Header
  const date = parseDateString(tourDate.date);
  if (!date) {
    console.warn("Invalid or missing date for tour date:", tourDate);
    return div;
  }
  const nameDiv = document.createElement("div");
  nameDiv.className = "event-name";
  const dateText = date.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  nameDiv.textContent = tourDate.time
    ? `${dateText} • ${tourDate.time}`
    : dateText;

  if (tourDate.isSoldOut) {
    div.classList.add("event-sold-out");
    nameDiv.appendChild(document.createTextNode(" "));
    const soldOutBadge = createBadge("❌ SOLD OUT");
    soldOutBadge.className = "event-badge event-badge-sold-out";
    nameDiv.appendChild(soldOutBadge);
  }

  if (tourDate.isCancelled) {
    div.classList.add("event-cancelled");
    nameDiv.appendChild(document.createTextNode(" "));
    const cancelBadge = createBadge("❌ CANCELLED");
    cancelBadge.className = "event-badge event-badge-cancelled";
    nameDiv.appendChild(cancelBadge);
  }

  div.appendChild(nameDiv);

  // Billing flip: tourDate.headliner names someone else as the actual
  // headliner for this one date, meaning the tour's own act is really
  // appearing in a support slot on that person's night. Flag it clearly
  // right on the date — everything else on this page (title, "Also
  // featuring"/"Support" rows, flyers, etc.) still describes the tour as
  // a whole, so without this row a flipped date would look like an
  // ordinary headline date for this tour. Rendered as the same label +
  // linked performer-tag row as "With:"/"Co-headliner(s):"/"Support:"
  // below (via buildAdditionalPerformersEl), rather than a single
  // free-text badge, so it reads consistently and the headliner's name
  // is a clickable link like every other billing relationship on this
  // card, instead of one long solid button.
  const effectiveHeadlinerId = getEffectiveHeadlinerId(tour, tourDate);
  if (tourDate.headliner && effectiveHeadlinerId !== tour.performer_id) {
    if (performersLookup[effectiveHeadlinerId]) {
      const headlinerEl = buildAdditionalPerformersEl(
        [effectiveHeadlinerId],
        "Supporting:",
        "additional-performers-date",
      );
      if (headlinerEl) div.appendChild(headlinerEl);
    } else {
      // No performer record for effectiveHeadlinerId — fall back to a
      // plain badge so a data typo doesn't silently drop the notice.
      nameDiv.appendChild(document.createTextNode(" "));
      const fallbackBadge = createBadge(`Supporting ${effectiveHeadlinerId}`);
      fallbackBadge.className = "event-badge event-badge-support-slot";
      nameDiv.appendChild(fallbackBadge);
    }
  }

  // Additional performers for this date: the date's own other_performer_ids
  // if it has any, otherwise the tour-level list.
  const dateDoubleHeadline = isDoubleHeadlineForDate(tour, tourDate);
  const dateAddlEl = buildAdditionalPerformersEl(
    getAdditionalPerformerIds(tour, tourDate),
    dateDoubleHeadline ? "Co-headliner(s):" : "With:",
    "additional-performers-date",
  );
  if (dateAddlEl) div.appendChild(dateAddlEl);

  // Support act(s) for this date (support_performer_ids) — a more specific
  // "opening for the headliner" relationship than other_performer_ids above.
  const dateSupportEl = buildAdditionalPerformersEl(
    getSupportPerformerIds(tour, tourDate),
    "Support:",
    "additional-performers-date additional-performers-support",
  );
  if (dateSupportEl) div.appendChild(dateSupportEl);

  // Venue Location with icons — createVenueElement() defined in shared_utils.js
  if (tourDate.venue_id && venuesLookup[tourDate.venue_id]) {
    const venueEl = createVenueElement(venuesLookup[tourDate.venue_id]);
    const venuePageLink = document.createElement("a");
    venuePageLink.href = `venues.html?venue=${encodeURIComponent(tourDate.venue_id)}`;
    venuePageLink.className = "venue-page-link";
    venuePageLink.title = "View venue page";
    venuePageLink.textContent = "i";
    venuePageLink.onclick = (e) => e.stopPropagation();
    venueEl.appendChild(venuePageLink);
    div.appendChild(venueEl);
  }

  // Tickets and Facebook Event — createTicketsElement() defined in shared_utils.js
  const ticketsEl = createTicketsElement(tourDate, past);
  if (ticketsEl) div.appendChild(ticketsEl);

  // --- More Info Button ---
  if (tourDate.description) {
    createTourExpandable(div, "More Info", tourDate.description, "text");
  }

  // --- Event Flyer Button(s) — one per flyer if this date has more than one ---
  const dateFlyers = getEventLevelFlyers(tourDate);
  dateFlyers.forEach((f, i) => {
    const label =
      dateFlyers.length > 1 ? `Event Flyer ${i + 1}` : "Event Flyer";
    createTourExpandable(div, label, f.filename, "image");
  });

  return div;
}

// getTourLevelFlyers() — defined in shared_utils.js. Normalizes the
// legacy singular `tour_flyer` and the current `touring_event_flyers`
// list into one ordered, de-duplicated array of {filename, label}.
// Shared with flyers.html so both pages agree on how
// tour-level flyers resolve.

// ── Shared lazy-image observer for tour flyers ────────────────────────────────
// See createLazyImageLoader() in shared_utils.js for the shared implementation
// (also used by the flyers page and performer flyer gallery). Used by both
// the gallery thumbnails and per-date expandable flyer images.
const flyerImgLoader = createLazyImageLoader({
  rootMargin: "200px 0px",
  wrapSelector: ".tour-flyer-thumb",
  errorMessage: "Flyer image<br>not available",
});

function renderTourFlyers(tour) {
  const BASE_EVENT = "./storyclub_assets/event_flyers/";

  // Per-date flyers only. Tour-level flyers (tour_flyer + touring_event_flyer
  // + touring_event_flyers) are all shown as heroes at the top of the page
  // instead (see displayTour()) — deliberately excluded here so the same
  // image isn't shown twice.
  const flyers = [];
  (tour.tour_dates || []).forEach((d) => {
    const dateFlyers = getEventLevelFlyers(d);
    if (dateFlyers.length === 0) return;
    const date = parseDateString(d.date);
    const venue = d.venue_id && venuesLookup[d.venue_id];
    const dateLabel = date
      ? date.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) +
        (venue ? " · " + venue.name : "")
      : venue
        ? venue.name
        : "Event flyer";
    dateFlyers.forEach((f, i) => {
      const label =
        dateFlyers.length > 1 ? `${dateLabel} (${i + 1})` : dateLabel;
      flyers.push({ src: BASE_EVENT + sanitizeFlyerPath(f.filename), label });
    });
  });

  // Remove any existing gallery
  const existing = document.getElementById("tourFlyerGallery");
  if (existing) existing.remove();

  if (flyers.length === 0) return;

  // ── Outer wrapper ──────────────────────────────────────────────────────────
  const gallery = document.createElement("div");
  gallery.id = "tourFlyerGallery";
  gallery.className = "tour-flyer-gallery";

  // ── <details> collapsible — closed by default ─────────────────────────────
  const details = document.createElement("details");
  details.className = "tour-flyer-details";

  const summary = document.createElement("summary");
  summary.className = "tour-flyer-summary";
  summary.textContent = `\u{1F5BC} Per-date flyers (${flyers.length})`;
  details.appendChild(summary);

  // ── Strip of thumbnails — images lazy-loaded when panel opens ─────────────
  const strip = document.createElement("div");
  strip.className = "tour-flyer-strip";

  flyers.forEach((f, i) => {
    const card = document.createElement("div");
    card.className = "tour-flyer-thumb";

    const img = document.createElement("img");
    img.dataset.src = f.src; // deferred — observer loads when visible
    img.alt = f.label;
    img.onclick = () => openTourFlyerLightbox(flyers, i);
    card.appendChild(img);

    const cap = document.createElement("div");
    cap.className = "tour-flyer-thumb-label";
    cap.textContent = f.label;
    card.appendChild(cap);

    strip.appendChild(card);
  });

  details.appendChild(strip);

  // Start observing thumbnails only after the panel is opened for the first time
  let observed = false;
  details.addEventListener("toggle", () => {
    if (details.open && !observed) {
      observed = true;
      strip
        .querySelectorAll("img[data-src]")
        .forEach((img) => flyerImgLoader.observe(img));
    }
  });

  gallery.appendChild(details);

  // Insert after the tour header, before the layout container
  const tourContent = document.getElementById("tourContent");
  const layout = tourContent.querySelector(".layout-container");
  tourContent.insertBefore(gallery, layout);
}

// ── Tour flyer lightbox (simple, self-contained) ──────────────────────────────
let _tfLbItems = [];
let _tfLbIndex = 0;

function openTourFlyerLightbox(items, index) {
  _tfLbItems = items;
  _tfLbIndex = index;

  let lb = document.getElementById("tourFlyerLightbox");
  if (!lb) {
    lb = document.createElement("div");
    lb.id = "tourFlyerLightbox";
    lb.className = "tf-lightbox";
    lb.innerHTML = `
      <button class="tf-lb-nav tf-lb-prev" id="tfLbPrev">&#8249;</button>
      <div class="tf-lb-inner">
        <button class="tf-lb-close" id="tfLbClose">×</button>
        <img id="tfLbImg" src="" alt="">
        <div id="tfLbCaption" class="tf-lb-caption"></div>
      </div>
      <button class="tf-lb-nav tf-lb-next" id="tfLbNext">&#8250;</button>`;
    document.body.appendChild(lb);

    document.getElementById("tfLbClose").onclick = closeTourFlyerLightbox;
    lb.addEventListener("click", (e) => {
      if (e.target === lb) closeTourFlyerLightbox();
    });
    document.getElementById("tfLbPrev").onclick = () => {
      if (_tfLbIndex > 0) {
        _tfLbIndex--;
        showTfSlide();
      }
    };
    document.getElementById("tfLbNext").onclick = () => {
      if (_tfLbIndex < _tfLbItems.length - 1) {
        _tfLbIndex++;
        showTfSlide();
      }
    };
    document.addEventListener("keydown", tfLbKey);
  }

  lb.classList.add("open");
  showTfSlide();
}

function closeTourFlyerLightbox() {
  const lb = document.getElementById("tourFlyerLightbox");
  if (lb) lb.classList.remove("open");
}

function showTfSlide() {
  const f = _tfLbItems[_tfLbIndex];
  document.getElementById("tfLbImg").src = f.src;
  document.getElementById("tfLbImg").alt = f.label;
  document.getElementById("tfLbCaption").textContent = f.label;
  document.getElementById("tfLbPrev").disabled = _tfLbIndex <= 0;
  document.getElementById("tfLbNext").disabled =
    _tfLbIndex >= _tfLbItems.length - 1;
}

function tfLbKey(e) {
  const lb = document.getElementById("tourFlyerLightbox");
  if (!lb?.classList.contains("open")) return;
  if (e.key === "Escape") closeTourFlyerLightbox();
  if (e.key === "ArrowLeft" && _tfLbIndex > 0) {
    _tfLbIndex--;
    showTfSlide();
  }
  if (e.key === "ArrowRight" && _tfLbIndex < _tfLbItems.length - 1) {
    _tfLbIndex++;
    showTfSlide();
  }
}

function updateEventDisplayFilters() {
  const hidePast = document.getElementById("hidePastDates").checked;
  const hideCancelled = document.getElementById("hideCancelledDates").checked;
  const hideSoldOut = document.getElementById("hideSoldOutDates").checked;

  document.querySelectorAll("#tourDatesList .tour-date-item").forEach((el) => {
    const isPast = el.classList.contains("date-past");
    const isCancelled = el.classList.contains("event-cancelled");
    const isSoldOut = el.classList.contains("event-sold-out");

    const shouldHide =
      (hidePast && isPast) ||
      (hideCancelled && isCancelled) ||
      (hideSoldOut && isSoldOut);

    el.style.display = shouldHide ? "none" : "";
  });
}

function resetMapZoom() {
  // Reads currentTour rather than #tourSelect's value: in singleTourMode
  // (see the bottom of this file) the dropdown is never populated, so
  // currentTour — set by displayTour() — is the only reliable source here.
  if (!currentTour) return;
  ensureMapInitialized().then(() => {
    addTourMarkersToMap(currentTour);
    // Reset to show all dates
    displayTourDates(currentTour, getTourStatus(currentTour));
  });
}

function updateMapView() {
  if (!currentTour) return;
  if (!currentTour.tour_dates || currentTour.tour_dates.length === 0) return;

  const bounds = map.getBounds();
  const visibleTourDates = expandTourDates(currentTour.tour_dates).filter(
    (tourDate) => {
      if (tourDate.venue_id && venuesLookup[tourDate.venue_id]) {
        const venue = venuesLookup[tourDate.venue_id];
        if (
          venue.latlon &&
          Array.isArray(venue.latlon) &&
          venue.latlon.length === 2
        ) {
          return bounds.contains([venue.latlon[0], venue.latlon[1]]);
        }
      }
      return false;
    },
  );

  const totalTourDates = expandTourDates(currentTour.tour_dates).length;
  console.log(
    `Tour dates in map view: ${visibleTourDates.length} of ${totalTourDates}`,
  );

  // Re-render the tour dates list with filtered dates
  const datesContainer = document.getElementById("tourDatesList");
  datesContainer.innerHTML = "";

  if (visibleTourDates.length === 0) {
    datesContainer.innerHTML =
      "<p>No tour dates visible in current map view. Zoom out or pan to see more dates.</p>";
    return;
  }

  // Sort dates chronologically; entries with missing/malformed dates sort to the end
  const sortedDates = [...visibleTourDates].sort((a, b) => {
    const dateA = parseDateString(a.date);
    const dateB = parseDateString(b.date);
    if (!dateA && !dateB) return 0;
    if (!dateA) return 1;
    if (!dateB) return -1;
    return dateA - dateB;
  });

  sortedDates.forEach((tourDate) => {
    const past = isDatePast(tourDate.date);
    const dateItem = createTourDateElement(tourDate, currentTour, past);
    datesContainer.appendChild(dateItem);
  });

  updateEventDisplayFilters();
}

function addTourMarkersToMap(tour) {
  // Clear existing markers
  markers = clearMarkers(map, markers);

  if (!tour.tour_dates || tour.tour_dates.length === 0) {
    console.warn("No tour dates found for tour:", tour.name || tour);
    return;
  }

  const bounds = [];

  expandTourDates(tour.tour_dates).forEach((tourDate) => {
    if (tourDate.venue_id && venuesLookup[tourDate.venue_id]) {
      const venue = venuesLookup[tourDate.venue_id];

      if (
        venue.latlon &&
        Array.isArray(venue.latlon) &&
        venue.latlon.length === 2
      ) {
        const [lat, lon] = venue.latlon;

        const past = isDatePast(tourDate.date);
        const markerColor = past
          ? "#aaaaaa"
          : tour.isMusic
            ? "#443cd7"
            : "#4CAF50";
        const markerOpacity = past ? 0.5 : 0.8;

        const marker = L.circleMarker([lat, lon], {
          radius: past ? 6 : 8,
          fillColor: markerColor,
          color: past ? "#999" : "#fff",
          weight: 2,
          opacity: 1,
          fillOpacity: markerOpacity,
        }).addTo(map);

        marker.venue_id = tourDate.venue_id;

        const date = parseDateString(tourDate.date);
        const dateStr = date
          ? date.toLocaleDateString("en-GB", {
              weekday: "short",
              day: "numeric",
              month: "short",
            })
          : tourDate.date || "Date unknown";

        const popupContent = `
          <div class="popup-content">
            <h3>${escapeHtml(venue.name)}</h3>
            <p><strong>${escapeHtml(dateStr)}</strong></p>
            <p>${escapeHtml(venue.full_address || "")}</p>
          </div>
        `;
        marker.bindPopup(popupContent);
        markers.push(marker);
        bounds.push([lat, lon]);
      }
    }
  });

  // Fit map to show all markers
  if (bounds.length > 0) {
    if (bounds.length === 1) {
      map.setView(bounds[0], 10);
    } else {
      map.fitBounds(L.latLngBounds(bounds), { padding: [50, 50] });
    }
  }
}

// ---------------------------------------------------------------------------
// Touring Panels — shared helpers
// ---------------------------------------------------------------------------

function fmtShort(d) {
  return d
    ? d.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "?";
}

function tourAllDates(tour) {
  return expandTourDates(tour.tour_dates)
    .map((d) => parseDateString(d.date))
    .filter(Boolean)
    .sort((a, b) => a - b);
}

/**
 * Build a single tour card and return it.
 * @param {string}   tourId
 * @param {object}   tour
 * @param {Date[]}   allDates   pre-computed sorted dates (from buildTouringRow)
 * @param {string}   badgeText  e.g. "3 dates remaining" or "4 dates"
 */
function buildTouringCard(tourId, tour, allDates, badgeText) {
  const { record: performer } = resolvePerformerDisplay(
    tour.performer_id,
    performersLookup,
  );

  const card = document.createElement("div");
  card.className = "now-touring-card";
  if (tour.isMusic) card.classList.add("music");
  if (tour.isPoetry) card.classList.add("poetry");

  // Flyer thumbnail — floats right, clicks to open lightbox
  const cardTourFlyers = getTourLevelFlyers(tour);
  if (cardTourFlyers.length > 0) {
    const thumb = document.createElement("div");
    thumb.className = "now-touring-flyer-thumb";
    thumb.title = cardTourFlyers.length > 1 ? "View flyers" : "View flyer";
    const img = document.createElement("img");
    img.dataset.src = `./storyclub_assets/event_flyers/${sanitizeFlyerPath(cardTourFlyers[0].filename)}`;
    img.alt = `${tour.showname || tour.name} flyer`;
    img.addEventListener("load", () => img.classList.add("loaded"));
    flyerImgLoader.observe(img);
    thumb.appendChild(img);

    // If there's more than one flyer, show a small count badge and let the
    // click open the lightbox strip (all of them, in order) rather than
    // just the first.
    if (cardTourFlyers.length > 1) {
      const badge = document.createElement("span");
      badge.className = "now-touring-flyer-count-badge";
      badge.textContent = `+${cardTourFlyers.length - 1}`;
      thumb.appendChild(badge);
    }

    thumb.addEventListener("click", (e) => {
      e.stopPropagation();
      openTourFlyerLightbox(
        cardTourFlyers.map((f) => ({
          src: `./storyclub_assets/event_flyers/${sanitizeFlyerPath(f.filename)}`,
          label: f.label,
        })),
        0,
      );
    });
    card.appendChild(thumb);
  }

  const showName = document.createElement("div");
  showName.className = "now-touring-show-name";
  showName.textContent = tour.showname || tour.name;
  if (tour.__repertoireShowId) {
    const repBadge = document.createElement("span");
    repBadge.className = "now-touring-repertoire-badge";
    repBadge.textContent = "🔁 Repertoire";
    showName.appendChild(document.createTextNode(" "));
    showName.appendChild(repBadge);
  }
  card.appendChild(showName);

  if (performer) {
    const perfName = document.createElement("div");
    perfName.className = "now-touring-performer";
    perfName.textContent = performer.name;
    card.appendChild(perfName);
  }

  const dateRange = document.createElement("div");
  dateRange.className = "now-touring-dates";
  dateRange.textContent = `${fmtShort(allDates[0])} → ${fmtShort(allDates[allDates.length - 1])}`;
  card.appendChild(dateRange);

  const badge = document.createElement("div");
  badge.className = "now-touring-badge";
  badge.textContent = badgeText;
  card.appendChild(badge);

  card.addEventListener("click", () => {
    const performerSelect = document.getElementById("performerSelect");
    const tourSelect = document.getElementById("tourSelect");

    if (tour.performer_id) {
      performerSelect.value = tour.performer_id;
      handlePerformerChange();
    }
    tourSelect.value = tourId;
    displayTour(tourId);
    updateURL(tourId);

    document
      .getElementById("tourContent")
      .scrollIntoView({ behavior: "smooth", block: "start" });
  });

  return card;
}

/**
 * Build a labelled row of tour cards and append it to container.
 * @param {Array}    tours      [[tourId, tour], ...]
 * @param {string}   label      display label
 * @param {string}   labelClass CSS modifier class for colour
 * @param {Element}  container  DOM node to append the row to
 * @param {Function} badgeFn    (tour, allDates) => string
 */
function buildTouringRow(tours, label, labelClass, container, badgeFn) {
  if (tours.length === 0) return;

  const row = document.createElement("div");
  row.className = "now-touring-row";

  const rowLabel = document.createElement("div");
  rowLabel.className = `now-touring-row-label ${labelClass}`;
  rowLabel.textContent = label;
  row.appendChild(rowLabel);

  const grid = document.createElement("div");
  grid.className = "now-touring-grid";

  tours.forEach(([tourId, tour]) => {
    const allDates = tourAllDates(tour);
    grid.appendChild(
      buildTouringCard(tourId, tour, allDates, badgeFn(tour, allDates)),
    );
  });

  row.appendChild(grid);
  container.appendChild(row);
}

// ---------------------------------------------------------------------------
// Now Touring Panel
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Touring Panels — renderers
// ---------------------------------------------------------------------------

// Groups shown within each touring panel (Now Touring / Upcoming / Past),
// in display order. Add a tuple here to introduce another tour-type row
// without touching renderTouringPanel itself. "test" should be mutually
// exclusive across entries for a given tour (first match wins in practice
// since a tour should only carry one of isMusic/isPoetry/neither).
const TOUR_PANEL_GROUPS = [
  {
    test: (t) => !t.isMusic && !t.isPoetry,
    label: "📖 Stories & Spoken Word",
    labelClass: "label-stories",
  },
  {
    test: (t) => !!t.isPoetry,
    label: "Poetry",
    labelClass: "label-poetry",
  },
  {
    test: (t) => !!t.isMusic,
    label: "Music",
    labelClass: "label-music",
  },
];

/**
 * Generic panel renderer. Filters toursLookup by status, builds rows into
 * the named body element, and hides the wrapper if there's nothing to show.
 *
 * @param {string} status      "current" | "future" | "past"
 * @param {string} bodyId      id of the <div> to populate
 * @param {string} wrapperId   id of the outer wrapper to hide when empty
 * @param {string} hideClass   CSS class to add when empty
 * @param {Function} badgeFn   (tour, allDates) => string
 */
function renderTouringPanel(status, bodyId, wrapperId, hideClass, badgeFn) {
  const container = document.getElementById(bodyId);
  const wrapper = document.getElementById(wrapperId);
  if (!container || !wrapper) return;

  // Story walks are excluded from the Now Touring / Upcoming / Previous
  // panels — they're not "touring shows" for display purposes (see the
  // dedicated Story Walks panel below), even though they still live in
  // toursLookup so displayTour()/the map/dates-list keep working when
  // reached via that panel or a direct link.
  const tours = Object.entries(toursLookup).filter(
    ([_, tour]) => getTourStatus(tour) === status && !tour.isStoryWalk,
  );

  if (tours.length === 0) {
    wrapper.classList.add(hideClass);
    return;
  }

  // Clear loading message before appending content
  container.innerHTML = "";

  TOUR_PANEL_GROUPS.forEach(({ test, label, labelClass }) => {
    buildTouringRow(
      tours.filter(([_, t]) => test(t)),
      label,
      labelClass,
      container,
      badgeFn,
    );
  });
}

function renderNowTouringPanel() {
  const today = getTodayMidnight();
  const badgeFn = (tour, allDates) => {
    const remaining = allDates.filter((d) => d >= today).length;
    return remaining === 1
      ? "1 date remaining"
      : `${remaining} dates remaining`;
  };
  renderTouringPanel(
    "current",
    "nowTouringBody",
    "nowTouringPanel",
    "no-now-touring",
    badgeFn,
  );
}

function renderUpcomingToursPanel() {
  const badgeFn = (_, allDates) =>
    allDates.length === 1 ? "1 date" : `${allDates.length} dates`;
  renderTouringPanel(
    "future",
    "upcomingToursBody",
    "upcomingToursPanel",
    "no-upcoming",
    badgeFn,
  );
}

function renderPastToursPanel() {
  const badgeFn = (_, allDates) =>
    allDates.length === 1 ? "1 date" : `${allDates.length} dates`;
  renderTouringPanel(
    "past",
    "pastToursBody",
    "pastToursPanel",
    "no-past",
    badgeFn,
  );
}

/**
 * Forces a genuinely fresh copy of events_normalized.json (bypassing the
 * normal auto-rolling cache window defined in shared_utils.js) and
 * re-renders the page with it. Wired up to the "Refresh data" button.
 */
function refreshEventsData() {
  const btn = document.getElementById("refreshDataBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Refreshing…";
  }
  sessionStorage.setItem("forceFreshEventsData", "1");
  window.location.reload();
}

// ---------------------------------------------------------------------------
// Initialize.
//
// Runs as soon as this script executes rather than waiting for the "load"
// event (which would also wait on the Leaflet CDN CSS/JS and anything else
// on the page), so the JSON fetch starts as early as possible.
//
// Two modes, decided purely from the URL, before any data has loaded:
//
//   - singleTourMode (?tour=<id> present): the page shows just that one
//     tour. The whole browse UI (#tourBrowseState — panels + dropdowns) is
//     skipped entirely rather than built and hidden, and once the data
//     arrives displayTour() runs immediately so the tour's title, meta
//     tags, description and dates list are in the DOM as fast as possible
//     — this is the content a shared link or a search engine crawler
//     actually wants. The map is loaded and initialised afterwards, in the
//     background (see ensureMapInitialized()), so it can never hold that
//     up.
//
//   - browse mode (no ?tour=): the original dropdown-driven landing page,
//     unchanged apart from the map likewise being deferred until just
//     after the panels/dropdowns are rendered.
//
// Neither mode is final, though: updateURL()/shareTourLink() push new
// history entries as the user picks tours, and the browser's Back/Forward
// buttons can land back on either shape of URL at any time. See the
// popstate handler at the very end of this file for how the page's own
// content is kept in sync with that — it reuses renderBrowseLandingPanels()
// below so the browse UI can also be built lazily, the first time it's
// actually needed, if the page was loaded directly into singleTourMode.
// ---------------------------------------------------------------------------

// Snapshot the page's own default title/meta before any tour overwrites
// them (displayTour() sets document.title and the description/keywords
// meta tags below) — popstate's return to the browse landing page restores
// these exactly, rather than leaving a previously-viewed tour's title/meta
// behind. Must run before displayTour() can possibly be called, hence
// right here rather than inside the async IIFE.
const DEFAULT_TITLE = document.title;
const DEFAULT_META_DESCRIPTION =
  document.querySelector('meta[name="description"]')?.getAttribute("content") ||
  "";
const DEFAULT_META_KEYWORDS =
  document.querySelector('meta[name="keywords"]')?.getAttribute("content") ||
  "";

// Renders the dropdown-driven landing page (Now Touring/Upcoming/Previous
// panels, the two browse lists, and the performer dropdown), guarded so it
// only ever runs once. Called from the browse-mode branch of the init IIFE
// below on a normal page load, and — lazily, the first time it's actually
// needed — from showBrowseLanding() if the page instead loaded straight
// into singleTourMode and the user then navigates Back to a bare
// tour_guide.html.
let browsePanelsRendered = false;
function renderBrowseLandingPanels() {
  if (browsePanelsRendered) return;
  browsePanelsRendered = true;

  populatePerformerDropdown();
  renderRepertoireBrowseList();
  renderStoryWalksBrowseList();
  renderNowTouringPanel();
  renderUpcomingToursPanel();
  renderPastToursPanel();

  // The map isn't needed until a tour is actually picked, so it's loaded
  // here too — after the panels/dropdowns above, never before them.
  ensureMapInitialized();
}

// The reverse of what singleTourMode/displayTour() do when showing one
// tour: switches the page back to the browse landing view. Used by the
// popstate handler below when Back/Forward lands on a URL with no ?tour=.
function showBrowseLanding() {
  document.getElementById("tourContent").style.display = "none";
  document.getElementById("tourNotFoundState").style.display = "none";
  document.getElementById("tourBackLinkWrap").style.display = "none";
  document.getElementById("tourBrowseState").style.display = "";

  document.title = DEFAULT_TITLE;
  setMetaDescription(DEFAULT_META_DESCRIPTION);
  const keywordsMeta = document.querySelector('meta[name="keywords"]');
  if (keywordsMeta) keywordsMeta.setAttribute("content", DEFAULT_META_KEYWORDS);
  
  setCanonical("tour");

  currentTour = null;
  renderBrowseLandingPanels();
}

setCanonical("tour");

(async () => {
  console.log("Page loaded, initializing...");

  const forcedRefresh = sessionStorage.getItem("forceFreshEventsData");
  if (forcedRefresh) sessionStorage.removeItem("forceFreshEventsData");

  const urlParams = getTourURLParams();
  console.log("URL params:", urlParams);

  const singleTourMode = !!urlParams.tourId;

  if (singleTourMode) {
    document.getElementById("tourBrowseState").style.display = "none";
    document.getElementById("tourBackLinkWrap").style.display = "";
  } else {
    const loadingHTML =
      '<div class="upcoming-tours-placeholder">Loading tours…</div>';
    ["nowTouringBody", "upcomingToursBody", "pastToursBody"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = loadingHTML;
    });
  }

  const result = await loadEventsData(
    urlParams.cacheBuster || (forcedRefresh ? Date.now() : null),
  );

  if (!result) {
    console.error("Failed to load events data");
    if (singleTourMode) {
      document.getElementById("tourNotFoundState").innerHTML =
        '<p class="no-tours">Couldn\'t load tour data. Please try refreshing the page.</p>';
      document.getElementById("tourNotFoundState").style.display = "";
    } else {
      ["nowTouringBody", "upcomingToursBody", "pastToursBody"].forEach(
        (id) => {
          const el = document.getElementById(id);
          if (el)
            el.innerHTML =
              '<div class="no-tours">Couldn\'t load tour data. Please try refreshing the page.</div>';
        },
      );
    }
    return;
  }

  eventsData = result.eventsData;
  repertoireShowsLookup = eventsData.repertoire_shows || {};
  toursLookup = buildCombinedToursLookup(
    result.toursLookup,
    repertoireShowsLookup,
  );
  venuesLookup = result.venuesLookup;
  performersLookup = result.performersLookup;

  // Display when data was last updated
  displayDataLastUpdated(result.lastUpdateTime);

  // Initialize navigation feedback
  initNavFeedback();

  console.log("Events data loaded successfully");
  console.log("Tours:", Object.keys(toursLookup).length);
  console.log("Performers:", Object.keys(performersLookup).length);
  console.log("Venues:", Object.keys(venuesLookup).length);

  if (singleTourMode) {
    const tour = toursLookup[urlParams.tourId];

    if (tour) {
      // Renders title/meta tags/description/dates list synchronously —
      // none of it touches the map, so it's all in the DOM before the
      // line below even starts loading Leaflet.
      console.log("Loading tour from URL:", urlParams.tourId);
      displayTour(urlParams.tourId);
    } else {
      console.warn(
        `tour_guide.html: tour "${urlParams.tourId}" not found.`,
      );
      document.getElementById("tourNotFoundState").style.display = "";
    }

    // Map is enhancement, not the text content this page needs indexed —
    // load it in the background so it never blocks the above.
    ensureMapInitialized();
    return;
  }

  // Browse mode: full dropdown UI.
  // Defer heavy rendering to background to allow loading state to display
  setTimeout(renderBrowseLandingPanels, 0);

  // performer= present but no tour= — just seed the performer dropdown
  if (urlParams.performerId) {
    console.log("Setting performer from URL:", urlParams.performerId);
    document.getElementById("performerSelect").value = urlParams.performerId;
    handlePerformerChange();
  }
})();

// Browser Back/Forward navigation doesn't re-run any of the above by
// itself — pushState() (used by updateURL()/shareTourLink()) only ever
// changes the address bar; it never fires popstate. This listener is what
// keeps the page's own content in sync when the user actually navigates
// with Back/Forward: a URL with no ?tour= switches back to the browse
// landing page (building it lazily via renderBrowseLandingPanels() if the
// page was loaded directly into singleTourMode and never needed it
// before), and a URL with ?tour=<id> shows that tour — mirroring what
// singleTourMode does on a fresh page load.
window.addEventListener("popstate", () => {
  const urlParams = getTourURLParams();

  if (!urlParams.tourId) {
    showBrowseLanding();
    return;
  }

  if (toursLookup[urlParams.tourId]) {
    document.getElementById("tourNotFoundState").style.display = "none";
    displayTour(urlParams.tourId);
    setCanonical("tour");
    ensureMapInitialized();
  } else {
    // Either genuinely unknown, or Back/Forward fired before the initial
    // data fetch finished (toursLookup still empty) — either way, match
    // singleTourMode's own "not found" treatment rather than leaving
    // whatever was on screen before.
    document.getElementById("tourBrowseState").style.display = "none";
    document.getElementById("tourBackLinkWrap").style.display = "";
    document.getElementById("tourContent").style.display = "none";
    document.getElementById("tourNotFoundState").style.display = "";
  }
});
