let map;
let markers = [];
let eventsData = null;
let venuesLookup = {};
let performersLookup = {};
let toursLookup = {};
let currentTour = null; // Store current tour for map filtering

// UK_IRELAND_BOUNDS, ICON_SVG — defined in shared_utils.js

// getTodayMidnight() — defined in shared_utils.js

function getTourStatus(tour) {
  if (!tour.tour_dates || tour.tour_dates.length === 0) return "unknown";
  const today = getTodayMidnight();
  const dates = tour.tour_dates
    .map((d) => parseDateString(d.date))
    .filter(Boolean); // exclude entries with missing/malformed dates
  if (dates.length === 0) return "unknown";
  const allPast = dates.every((d) => d < today);
  const allFuture = dates.every((d) => d >= today);
  if (allPast) return "past";
  if (allFuture) return "future";
  return "current"; // straddles today
}

// isDatePast(dateStr) — defined in shared_utils.js

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
    alert("Please select a tour first");
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
      const originalText = btn.innerHTML;
      btn.innerHTML = "✅ Link Copied!";

      // Also update the browser's address bar so it matches what was copied
      window.history.pushState({ tourId }, "", shareableUrl);

      setTimeout(() => {
        btn.innerHTML = originalText;
      }, 2000);
    })
    .catch((err) => {
      console.error("Failed to copy link:", err);
    });
}

function populatePerformerDropdown() {
  const performerSelect = document.getElementById("performerSelect");

  // Get unique performers who have tours
  const performersWithTours = new Set();

  Object.values(toursLookup).forEach((tour) => {
    if (tour.performer_id && performersLookup[tour.performer_id]) {
      performersWithTours.add(tour.performer_id);
    }
  });

  // Sort performers by name
  const sortedPerformers = Array.from(performersWithTours)
    .map((id) => ({ id, name: performersLookup[id].name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  sortedPerformers.forEach((performer) => {
    const option = document.createElement("option");
    option.value = performer.id;
    option.textContent = performer.name;
    performerSelect.appendChild(option);
  });
}

function handlePerformerChange() {
  const performerId = document.getElementById("performerSelect").value;
  const tourSelect = document.getElementById("tourSelect");

  // Clear tour dropdown
  tourSelect.innerHTML = '<option value="">Select a tour...</option>';

  if (!performerId) {
    // Optional: Clear the map/content if no performer is selected
    document.getElementById("tourContent").style.display = "none";
    return;
  }

  // Find tours for this performer
  const performerTours = Object.entries(toursLookup)
    .filter(([_, tour]) => tour.performer_id === performerId)
    .map(([id, tour]) => ({ id, name: tour.tour_name || tour.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  performerTours.forEach((tour) => {
    const option = document.createElement("option");
    option.value = tour.id;
    option.textContent = tour.name;
    tourSelect.appendChild(option);
  });

  // If there are tours available, handle the display logic
  if (performerTours.length === 1) {
    // If only one tour, select and display it automatically
    const soleTourId = performerTours[0].id;
    tourSelect.value = soleTourId;
    displayTour(soleTourId);
    updateURL(soleTourId);
  } else if (performerTours.length > 1) {
    // Optional: If there are multiple tours, you might want to clear
    // the previous tour's view until they pick one from the new list
    document.getElementById("tourContent").style.display = "none";
    markers.forEach((marker) => map.removeLayer(marker));
    markers = [];
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

function updateURL(tourId) {
  const tour = toursLookup[tourId];
  if (!tour) return;

  const params = new URLSearchParams();
  params.set("tour", tourId);
  if (tour.performer_id) {
    params.set("performer", tour.performer_id);
  }

  const newURL = `${window.location.pathname}?${params.toString()}`;
  window.history.pushState({ tourId }, "", newURL);
}

function loadTour() {
  const tourId = document.getElementById("tourSelect").value;
  if (!tourId) {
    alert("Please select a tour");
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

  // Store current tour for map filtering
  currentTour = tour;

  // Show tour content
  document.getElementById("tourContent").style.display = "block";

  if (map) {
    map.invalidateSize();
  }

  // Set title and subtitle
  document.getElementById("tourTitle").textContent = tour.name;
  document.getElementById("tourSubtitle").textContent = tour.tour_name || "";

  // Performer websites
  const performer = performersLookup[tour.performer_id];
  const performerIds = new Set();
  if (tour.performer_id) performerIds.add(tour.performer_id);
  if (tour.performer_ids && Array.isArray(tour.performer_ids)) {
    tour.performer_ids.forEach((id) => performerIds.add(id));
  }

  const flyerContainer = document.getElementById("tourFlyerContainer");
  const flyerImage = document.getElementById("tourFlyerImage");

  // Rebuild container children in explicit order: top links → image → bottom links.
  // This avoids positional insertBefore/appendChild drift across repeated displayTour calls.
  flyerContainer.innerHTML = "";

  const topLinks = [];
  const bottomLinks = [];

  performerIds.forEach((id) => {
    const perf = performersLookup[id];
    if (!perf) return;

    // Primary links: performer's own website (unchanged behaviour)
    if (perf.url) {
      const safeUrl = sanitizeUrl(perf.url);
      if (safeUrl) {
        const topLink = document.createElement("a");
        topLink.href = safeUrl;
        topLink.target = "_blank";
        topLink.className = "performer-link site-link-header";
        topLink.textContent = `Visit ${perf.name}'s Website`;
        topLinks.push(topLink);

        const bottomLink = document.createElement("a");
        bottomLink.href = safeUrl;
        bottomLink.target = "_blank";
        bottomLink.className = "performer-link site-link-footer";
        bottomLink.textContent = `Official Website: ${perf.name}`;
        bottomLinks.push(bottomLink);
      }
    }

    // Secondary link: performer profile page (below the website link)
    const perfPageLink = document.createElement("a");
    perfPageLink.href = `new_troubadours_performers.html?performer=${encodeURIComponent(id)}`;
    perfPageLink.className = "performer-link site-link-header";
    perfPageLink.textContent = `${perf.name} — Performer Profile`;
    topLinks.push(perfPageLink);
  });

  topLinks.forEach((l) => flyerContainer.appendChild(l));
  flyerContainer.appendChild(flyerImage); // always re-attach image in the middle
  bottomLinks.forEach((l) => flyerContainer.appendChild(l));

  if (tour.tour_flyer) {
    flyerImage.src = `./storyclub_assets/event_flyers/${sanitizeFlyerPath(tour.tour_flyer)}`;
    flyerImage.alt = `${tour.name} tour flyer`;
    flyerImage.style.display = "block";
    flyerContainer.style.display = "block";
  } else {
    flyerImage.style.display = "none";
    // Show container if there are links, even if image is missing
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

  // Add markers to map
  addTourMarkersToMap(tour);
}

function displayTourDates(tour, status) {
  const datesContainer = document.getElementById("tourDatesList");
  datesContainer.innerHTML = "";

  // Show the hide-past checkbox only for current tours
  const hidePastLabel = document.getElementById("hidePastLabel");
  //const hidePastCheckbox = document.getElementById("hidePastDates");
  //hidePastCheckbox.checked = false;
  hidePastLabel.style.display = status === "current" ? "" : "none";

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

  const sortedDates = [...tour.tour_dates].sort((a, b) => {
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
    flyerImgObserver.observe(img);
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

  // Venue Location with icons — createVenueElement() defined in shared_utils.js
  if (tourDate.venue_id && venuesLookup[tourDate.venue_id]) {
    const venueEl = createVenueElement(venuesLookup[tourDate.venue_id]);
    const venuePageLink = document.createElement("a");
    venuePageLink.href = `new_troubadours_venues.html?venue=${encodeURIComponent(tourDate.venue_id)}`;
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

  // --- Event Flyer Button (Only if it exists for this specific date) ---
  if (tourDate.event_flyer) {
    createTourExpandable(div, "Event Flyer", tourDate.event_flyer, "image");
  }

  return div;
}

// ── Shared lazy-image observer for tour flyers ────────────────────────────────
// Watches for data-src images entering the viewport and loads them on demand.
// Used by both the gallery thumbnails and per-date expandable flyer images.
const flyerImgObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const img = entry.target;
      const src = img.dataset.src;
      if (!src) return;
      img.src = src;
      img.removeAttribute("data-src");
      flyerImgObserver.unobserve(img);
    });
  },
  { rootMargin: "200px 0px" },
);

function renderTourFlyers(tour) {
  const BASE_EVENT = "./storyclub_assets/event_flyers/";

  // Gather all flyers: tour-level + per-date
  const flyers = [];
  if (tour.tour_flyer?.trim()) {
    flyers.push({
      src: BASE_EVENT + sanitizeFlyerPath(tour.tour_flyer),
      label: "Tour flyer",
    });
  }
  (tour.tour_dates || []).forEach((d) => {
    if (!d.event_flyer?.trim()) return;
    const date = parseDateString(d.date);
    const venue = d.venue_id && venuesLookup[d.venue_id];
    const label = date
      ? date.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) +
        (venue ? " · " + venue.name : "")
      : venue
        ? venue.name
        : "Event flyer";
    flyers.push({ src: BASE_EVENT + sanitizeFlyerPath(d.event_flyer), label });
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
  summary.textContent = `\u{1F5BC} Flyers for this tour (${flyers.length})`;
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
        .forEach((img) => flyerImgObserver.observe(img));
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
  const tourId = document.getElementById("tourSelect").value;
  if (tourId && toursLookup[tourId]) {
    const tour = toursLookup[tourId];
    addTourMarkersToMap(tour);
    // Reset to show all dates
    displayTourDates(tour, getTourStatus(tour));
  }
}

function updateMapView() {
  if (!currentTour) return;
  if (!currentTour.tour_dates || currentTour.tour_dates.length === 0) return;

  const bounds = map.getBounds();
  const visibleTourDates = currentTour.tour_dates.filter((tourDate) => {
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
  });

  console.log(
    `Tour dates in map view: ${visibleTourDates.length} of ${currentTour.tour_dates.length}`,
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
  markers.forEach((marker) => map.removeLayer(marker));
  markers = [];

  if (!tour.tour_dates || tour.tour_dates.length === 0) {
    console.warn("No tour dates found for tour:", tour.name || tour);
    return;
  }

  const bounds = [];

  tour.tour_dates.forEach((tourDate) => {
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
  return (tour.tour_dates || [])
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
  const performer = performersLookup[tour.performer_id];

  const card = document.createElement("div");
  card.className = "now-touring-card";
  if (tour.isMusic) card.classList.add("music");

  const showName = document.createElement("div");
  showName.className = "now-touring-show-name";
  showName.textContent = tour.showname || tour.name;
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

  const tours = Object.entries(toursLookup).filter(
    ([_, tour]) => getTourStatus(tour) === status,
  );

  if (tours.length === 0) {
    wrapper.classList.add(hideClass);
    return;
  }

  buildTouringRow(
    tours.filter(([_, t]) => !t.isMusic),
    "📖 Stories & Spoken Word",
    "label-stories",
    container,
    badgeFn,
  );
  buildTouringRow(
    tours.filter(([_, t]) => t.isMusic),
    "🎵 Music",
    "label-music",
    container,
    badgeFn,
  );
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

// Initialize on page load
window.addEventListener("load", async () => {
  console.log("Page loaded, initializing...");

  const urlParams = getTourURLParams();
  console.log("URL params:", urlParams);

  const result = await loadEventsData(urlParams.cacheBuster);

  if (!result) {
    console.error("Failed to load events data");
    return;
  }

  eventsData = result.eventsData;
  toursLookup = result.toursLookup;
  venuesLookup = result.venuesLookup;
  performersLookup = result.performersLookup;

  console.log("Events data loaded successfully");
  console.log("Tours:", Object.keys(toursLookup).length);
  console.log("Performers:", Object.keys(performersLookup).length);
  console.log("Venues:", Object.keys(venuesLookup).length);

  map = initMap("map", updateMapView);
  console.log("Map initialized");

  populatePerformerDropdown();
  console.log("Performer dropdown populated");

  renderNowTouringPanel();
  console.log("Now Touring panel rendered");

  renderUpcomingToursPanel();
  console.log("Upcoming Tours panel rendered");

  renderPastToursPanel();
  console.log("Past Tours panel rendered");

  // If URL has tour/performer params, load them.
  // When only ?tour= is supplied (no performer=), derive the performer from
  // the tour data so both dropdowns are correctly populated.
  if (urlParams.tourId) {
    const tour = toursLookup[urlParams.tourId];
    const performerId =
      urlParams.performerId || (tour && tour.performer_id) || null;

    if (performerId) {
      console.log("Setting performer from URL (or tour lookup):", performerId);
      document.getElementById("performerSelect").value = performerId;
      handlePerformerChange(); // populates tourSelect for this performer
    }

    console.log("Loading tour from URL:", urlParams.tourId);
    document.getElementById("tourSelect").value = urlParams.tourId;
    displayTour(urlParams.tourId);

    // Scroll so the tour content is visible, not stranded below the panels
    setTimeout(() => {
      document
        .getElementById("tourContent")
        .scrollIntoView({ behavior: "smooth", block: "start" });
    }, 300);
  } else if (urlParams.performerId) {
    // performer= present but no tour= — just seed the performer dropdown
    console.log("Setting performer from URL:", urlParams.performerId);
    document.getElementById("performerSelect").value = urlParams.performerId;
    handlePerformerChange();
  }
});
