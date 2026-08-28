// ---------------------------------------------------------------------------
// Data + state
// ---------------------------------------------------------------------------

let eventsData = null;
let venuesLookup = {};
let performersLookup = {};
let toursLookup = {};
let venueId = null;
let venue = null;
let map = null;
let leafletPromise = null;

const LEAFLET_JS_URL =
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js";
const LEAFLET_CSS_URL =
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css";

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

function preloadLeafletWhenIdle() {
  const preload = () =>
    loadLeaflet().catch((error) =>
      console.warn("Leaflet preload failed:", error),
    );
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(preload, { timeout: 2000 });
  } else {
    setTimeout(preload, 1500);
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

// Performance-type classification (what kinds of events happen at a
// venue — distinct from classifyVenueType()/VTYPE_* in shared_utils.js,
// which classify the *building* itself from its name). Story/Music/
// Poetry mirror the same three buckets used on the performers listing
// page; folk nights and Irish sessions are treated as "music" here
// since they're live-music events, even though they're their own
// event types internally.
const PTYPE_DEFS = [
  { key: "story", label: "📖 Story", colour: "#2e7d32" },
  { key: "music", label: "🎵 Music", colour: "#443cd7" },
  { key: "poetry", label: "✒️ Poetry", colour: "#d6006e" },
];
const PTYPE_COLOUR = Object.fromEntries(
  PTYPE_DEFS.map((p) => [p.key, p.colour]),
);

function classifyVenuePerformanceTypes(venueId) {
  const types = new Set();

  (eventsData.events || []).forEach((e) => {
    if (e.venue_id === venueId) types.add("story");
  });
  (eventsData.folkNights || []).forEach((e) => {
    if (e.venue_id === venueId) types.add("music");
  });
  (eventsData.irishSessions || []).forEach((e) => {
    if (e.venue_id === venueId) types.add("music");
  });

  [
    ...(eventsData.specificEvents || []),
    ...(eventsData.musicEvents || []),
    ...(eventsData.poetryEvents || []),
  ].forEach((e) => {
    if (e.venue_id !== venueId) return;
    types.add(classifyPerformanceType(e));
  });

  Object.values(toursLookup).forEach((tour) => {
    (tour.tour_dates || []).forEach((td) => {
      if (td.venue_id !== venueId) return;
      types.add(classifyPerformanceType(tour));
    });
  });

  Object.values(eventsData.repertoire_shows || {}).forEach((ts) => {
    (ts.show_dates || []).forEach((sd) => {
      if (sd.venue_id === venueId) types.add("story");
    });
  });

  return types;
}

function renderAllVenues() {
  const root = document.getElementById("venueContent");
  root.innerHTML = "";

  const h1 = document.createElement("h1");
  h1.textContent = "Venues";
  root.appendChild(h1);

  // Build sorted venue list (only venues with a name)
  const venueList = Object.entries(venuesLookup)
    .filter(([, v]) => v.name)
    .sort((a, b) => a[1].name.localeCompare(b[1].name));

  // Collect unique cities for filter
  const cities = [
    ...new Set(venueList.map(([, v]) => v.city).filter(Boolean)),
  ].sort();

  // Build search index — pre-classify venue type so it's available for
  // both the listing cards and the shared type filter.
  const venueIndex = venueList.map(([vid, v]) => ({
    vid,
    v,
    vtype: classifyVenueType(v.name),
    ptypes: classifyVenuePerformanceTypes(vid),
    searchText: [v.name, v.city, v.full_address, v.postcode]
      .filter(Boolean)
      .join(" ")
      .toLowerCase(),
  }));

  // Collect the types that actually appear (in canonical order).
  const presentTypes = VTYPE_ORDER.filter((t) =>
    venueIndex.some((e) => e.vtype === t),
  );

  // ── Filter state ─────────────────────────────────────────────────────
  let activeCity = null;
  let searchTerm = "";
  let activeVenueType = null; // null = show all types
  let mapBounds = null; // null = no bounds filter (map closed / never panned)
  // Performance-type filter: which of story/music/poetry are
  // selected, and whether a venue must match ANY (union) or ALL
  // (intersection) of them. All three selected + union == no
  // restriction (the default).
  const activePTypes = new Set(PTYPE_DEFS.map((p) => p.key));
  let ptypeMode = "union"; // 'union' | 'intersection'

  // vid → marker, so city filter can show/hide individual markers
  const markerByVid = {};

  function performanceTypeVisible(entry) {
    if (activePTypes.size === 0) return false; // nothing selected → show nothing
    if (ptypeMode === "intersection") {
      // Always compute the real intersection — selecting all
      // three types should narrow to venues hosting all three,
      // not fall back to "show everything".
      return [...activePTypes].every((t) => entry.ptypes.has(t));
    }
    // Union: selecting every type is equivalent to no restriction
    if (activePTypes.size === PTYPE_DEFS.length) return true;
    return [...entry.ptypes].some((t) => activePTypes.has(t));
  }

  function isVisible(entry) {
    if (activeVenueType && entry.vtype !== activeVenueType) return false;
    if (!performanceTypeVisible(entry)) return false;
    if (activeCity && entry.v.city !== activeCity) return false;
    if (searchTerm && !entry.searchText.includes(searchTerm.toLowerCase()))
      return false;
    if (mapBounds && entry.v.latlon) {
      if (!mapBounds.contains(entry.v.latlon)) return false;
    }
    return true;
  }

  // Marker visibility mirrors isVisible() but (matching prior
  // behaviour) ignores free-text search and map-bounds panning —
  // only the toggle-style filters (venue type / performance type /
  // city) show or hide markers directly.
  function markerVisible(entry) {
    if (activeVenueType !== null && entry.vtype !== activeVenueType)
      return false;
    if (!performanceTypeVisible(entry)) return false;
    if (activeCity !== null && entry.v.city !== activeCity) return false;
    return true;
  }

  function syncMarkerVisibility() {
    if (!mapHandle.map) return;
    venueIndex.forEach((entry) => {
      const marker = markerByVid[entry.vid];
      if (!marker) return;
      if (markerVisible(entry)) {
        marker.addTo(mapHandle.map);
      } else {
        marker.remove();
      }
    });
  }

  // ── Marker registry (populated lazily when the map first opens) ──────
  const markersByType = {};

  // ── Controls: search + venue-type filter + city filter ───────────────
  const controls = document.createElement("div");
  controls.className = "dir-controls";

  createSearchBox(controls, {
    placeholder: "Search venues by name, city or postcode\u2026",
    search: (term) =>
      venueIndex.filter((e) => e.searchText.includes(term)).slice(0, 8),
    renderItem: ({ v }) => {
      const item = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = v.name;
      item.appendChild(strong);
      if (v.city) {
        const city = document.createElement("span");
        city.className = "dir-search-item-meta";
        city.textContent = v.city;
        item.appendChild(city);
      }
      return item;
    },
    onSelect: ({ vid, v }, searchInput, clearBtn, dropdown) => {
      searchInput.value = v.name;
      searchTerm = v.name;
      clearBtn.style.display = "block";
      dropdown.style.display = "none";
      renderList();
      setTimeout(() => {
        const el = document.getElementById("venue-row-" + vid);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 80);
    },
    onChange: (term) => {
      searchTerm = term;
      renderList();
    },
  });

  // ── Venue-type filter buttons ────────────────────────────────────────
  {
    const typeLabel = document.createElement("div");
    typeLabel.className = "dir-filter-label";
    typeLabel.textContent = "Filter by venue type";
    controls.appendChild(typeLabel);

    const typeBtnsWrap = document.createElement("div");
    typeBtnsWrap.className = "dir-filter-btns";

    const allTypeBtn = document.createElement("button");
    allTypeBtn.textContent = "All";
    allTypeBtn.className = "dir-filter-btn active-teal";
    typeBtnsWrap.appendChild(allTypeBtn);

    const typeBtnEls = [{ btn: allTypeBtn, vtype: null }];

    presentTypes.forEach((vtype) => {
      const colour = VTYPE_COLOURS[vtype] || "#999";
      const btn = document.createElement("button");
      btn.className = "dir-filter-btn";
      btn.style.borderLeftColor = colour;
      btn.style.borderLeftWidth = "4px";

      const swatch = document.createElement("span");
      swatch.style.cssText = `display:inline-block;width:10px;height:10px;border-radius:50%;background:${colour};margin-right:5px;vertical-align:middle;flex-shrink:0;`;
      btn.appendChild(swatch);
      btn.appendChild(document.createTextNode(vtype));

      typeBtnEls.push({ btn, vtype });
      typeBtnsWrap.appendChild(btn);
    });

    function applyTypeFilter(selected) {
      activeVenueType = selected;

      // Update button active states
      typeBtnEls.forEach(({ btn, vtype }) => {
        btn.classList.toggle("active-teal", selected === vtype);
      });

      // Re-render listing
      renderList();

      // If the map is already open, update marker visibility respecting all filters
      syncMarkerVisibility();
    }

    allTypeBtn.addEventListener("click", () => applyTypeFilter(null));
    typeBtnEls.slice(1).forEach(({ btn, vtype }) => {
      btn.addEventListener("click", () => {
        applyTypeFilter(activeVenueType === vtype ? null : vtype);
      });
    });

    controls.appendChild(typeBtnsWrap);
  }

  // ── Performance-type filter — story/music/poetry, with a
  // union/intersection mode toggle ────────────────────────────────────
  {
    const ptypeLabel = document.createElement("div");
    ptypeLabel.className = "dir-filter-label";
    ptypeLabel.textContent = "Filter by performance type";
    controls.appendChild(ptypeLabel);

    const ptypeBtnsWrap = document.createElement("div");
    ptypeBtnsWrap.className = "dir-filter-btns";

    const allPtypeBtn = document.createElement("button");
    allPtypeBtn.textContent = "All";
    allPtypeBtn.className = "dir-filter-btn active-teal";
    allPtypeBtn.addEventListener("click", () => {
      PTYPE_DEFS.forEach(({ key }) => activePTypes.add(key));
      ptypeMode = "union";
      refreshPtypeBtns();
      renderList();
      syncMarkerVisibility();
    });
    ptypeBtnsWrap.appendChild(allPtypeBtn);

    const ptypeBtnEls = [];
    PTYPE_DEFS.forEach(({ key, label }) => {
      const btn = document.createElement("button");
      btn.className = "type-filter-btn active";
      btn.dataset.ptype = key;
      btn.textContent = label;
      btn.addEventListener("click", () => {
        if (activePTypes.has(key)) activePTypes.delete(key);
        else activePTypes.add(key);
        refreshPtypeBtns();
        renderList();
        syncMarkerVisibility();
      });
      ptypeBtnEls.push(btn);
      ptypeBtnsWrap.appendChild(btn);
    });

    function refreshPtypeBtns() {
      ptypeBtnEls.forEach((btn) =>
        btn.classList.toggle("active", activePTypes.has(btn.dataset.ptype)),
      );
      // "All" reads as active only when every type is selected in union mode —
      // i.e. genuinely "no restriction", matching the venue-type All button's meaning.
      allPtypeBtn.classList.toggle(
        "active-teal",
        activePTypes.size === PTYPE_DEFS.length && ptypeMode === "union",
      );
    }

    controls.appendChild(ptypeBtnsWrap);

    // Mode toggle — only meaningful once 2+ types are selected,
    // but always visible so its state is clear.
    const modeWrap = document.createElement("div");
    modeWrap.style.cssText =
      "display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px;color:#777;";

    const modeLabel = document.createElement("span");
    modeLabel.textContent = "Show venues matching:";
    modeWrap.appendChild(modeLabel);

    const unionBtn = document.createElement("button");
    unionBtn.className = "dir-filter-btn active-teal";
    unionBtn.textContent = "Any selected (union)";

    const intersectionBtn = document.createElement("button");
    intersectionBtn.className = "dir-filter-btn";
    intersectionBtn.textContent = "All selected (intersection)";

    function applyPtypeMode(mode) {
      ptypeMode = mode;
      unionBtn.classList.toggle("active-teal", mode === "union");
      intersectionBtn.classList.toggle("active-teal", mode === "intersection");
      refreshPtypeBtns();
      renderList();
      syncMarkerVisibility();
    }
    unionBtn.addEventListener("click", () => applyPtypeMode("union"));
    intersectionBtn.addEventListener("click", () =>
      applyPtypeMode("intersection"),
    );

    modeWrap.appendChild(unionBtn);
    modeWrap.appendChild(intersectionBtn);
    controls.appendChild(modeWrap);
  }

  // ── City filter — collapsible <details> with buttons ──────────────────
  if (cities.length > 0) {
    const cityDetails = document.createElement("details");
    cityDetails.className = "dir-card";
    cityDetails.style.cssText = "margin-top:6px;";

    const citySummary = document.createElement("summary");
    citySummary.className = "dir-map-summary";
    citySummary.style.cssText =
      "font-size:13px;padding:7px 12px;cursor:pointer;";

    function updateCitySummary() {
      citySummary.textContent = activeCity
        ? `📍 City: ${activeCity}`
        : "📍 Filter by city";
    }
    updateCitySummary();
    cityDetails.appendChild(citySummary);

    const cityBtnsWrap = document.createElement("div");
    cityBtnsWrap.style.cssText =
      "padding:8px 12px 10px;display:flex;flex-wrap:wrap;gap:5px;";

    let cityBtnEls = [];
    function refreshCityBtns() {
      cityBtnEls.forEach((btn, i) => {
        const val = i === 0 ? null : cities[i - 1];
        btn.classList.toggle("active-teal", activeCity === val);
      });
      updateCitySummary();
    }

    function applyCityFilter(city) {
      activeCity = city;
      refreshCityBtns();
      renderList();

      // Sync map markers — hide any that don't match the active filters
      syncMarkerVisibility();

      // Close the panel once a selection is made (except "All")
      if (city !== null) cityDetails.open = false;
    }

    const allCityBtn = document.createElement("button");
    allCityBtn.textContent = "All";
    allCityBtn.className = "dir-filter-btn active-teal";
    allCityBtn.addEventListener("click", () => applyCityFilter(null));
    cityBtnsWrap.appendChild(allCityBtn);
    cityBtnEls.push(allCityBtn);

    cities.forEach((city) => {
      const btn = document.createElement("button");
      btn.textContent = city;
      btn.className = "dir-filter-btn";
      btn.addEventListener("click", () => {
        applyCityFilter(activeCity === city ? null : city);
      });
      cityBtnsWrap.appendChild(btn);
      cityBtnEls.push(btn);
    });

    cityDetails.appendChild(cityBtnsWrap);
    controls.appendChild(cityDetails);
  }

  root.appendChild(controls);

  // ── Collapsible map ───────────────────────────────────────────────────
  const mapHandle = createCollapsibleMap(
    root,
    "venues-dir-map",
    "Show map of all venues",
    400,
    (map) => {
      venueIndex.forEach(({ vid, v, vtype, ptypes }) => {
        if (!v.latlon || v.latlon.length === 0) return;
        const colour = VTYPE_COLOURS[vtype] || "#999";
        const ptypeLine =
          ptypes.size > 0
            ? `<br>${[...ptypes].map((t) => PTYPE_DEFS.find((p) => p.key === t)?.label || t).join(" · ")}`
            : "";
        const popup = `<strong>${escapeHtml(v.name)}</strong>${v.city ? "<br>" + escapeHtml(v.city) : ""}<br><em style="color:${colour}">${vtype}</em>${ptypeLine}`;
        const marker = L.circle(v.latlon, {
          radius: 3000,
          fillColor: colour,
          color: colour,
          weight: 2,
          fillOpacity: 0.8,
        })
          .addTo(map)
          .bindPopup(popup)
          .on("click", () => {
            location.href = `new_troubadours_venues.html?venue=${encodeURIComponent(vid)}`;
          });
        if (!markersByType[vtype]) markersByType[vtype] = [];
        markersByType[vtype].push(marker);
        markerByVid[vid] = marker;
      });

      // Apply any filters already active before the map was opened
      const ptypeFilterActive =
        activePTypes.size !== PTYPE_DEFS.length || ptypeMode !== "union";
      if (
        activeVenueType !== null ||
        activeCity !== null ||
        ptypeFilterActive
      ) {
        venueIndex.forEach((entry) => {
          const marker = markerByVid[entry.vid];
          if (!marker) return;
          if (markerVisible(entry)) {
            marker.addTo(map);
          } else {
            marker.remove();
          }
        });
      }

      // ── Bounds filter on zoom/pan (mirrors events page behaviour) ───
      function updateFromMapBounds() {
        mapBounds = map.getBounds();
        renderList();
      }
      map.on("moveend", updateFromMapBounds);

      // Clear bounds filter when the map panel is collapsed
      mapHandle.details.addEventListener("toggle", () => {
        if (!mapHandle.details.open) {
          mapBounds = null;
          renderList();
        }
      });
    },
    loadLeaflet,
  );

  // ── Count line ───────────────────────────────────────────────────────
  const countLine = document.createElement("p");
  countLine.className = "venue-list-count";
  root.appendChild(countLine);

  // ── List container ───────────────────────────────────────────────────
  const listWrap = document.createElement("div");
  listWrap.className = "venue-list-grid";
  root.appendChild(listWrap);

  // ── Render function ──────────────────────────────────────────────────
  function renderList() {
    listWrap.innerHTML = "";
    const visible = venueIndex.filter(isVisible);
    const total = venueIndex.length;
    countLine.textContent =
      visible.length === total
        ? `${total} venues`
        : `${visible.length} of ${total} venues`;

    if (visible.length === 0) {
      const p = document.createElement("p");
      p.className = "venue-list-empty";
      p.textContent = "No venues match the current filters.";
      listWrap.appendChild(p);
      return;
    }

    visible.forEach(({ vid, v, vtype, ptypes }) => {
      const colour = VTYPE_COLOURS[vtype] || "#999";

      const row = document.createElement("div");
      row.id = "venue-row-" + vid;
      row.className = "venue-list-card";
      row.style.borderLeftColor = colour;
      row.onclick = () => {
        location.href = `new_troubadours_venues.html?venue=${encodeURIComponent(vid)}`;
      };

      const nameEl = document.createElement("div");
      nameEl.className = "venue-list-name";
      nameEl.textContent = v.name;
      row.appendChild(nameEl);

      if (v.city || v.postcode) {
        const locEl = document.createElement("div");
        locEl.className = "venue-list-loc";
        locEl.textContent = [v.city, v.postcode].filter(Boolean).join(" · ");
        row.appendChild(locEl);
      }

      // Venue-type badge (building type)
      const typeBadge = document.createElement("span");
      typeBadge.className = "venue-type-badge";
      typeBadge.style.cssText = `background:${colour}22;color:${colour};border:1px solid ${colour}55;`;
      typeBadge.textContent = vtype;
      row.appendChild(typeBadge);

      // Performance-type badges (story/music/poetry) — the
      // "highlighting" for what kinds of events happen here
      [...ptypes].forEach((pt) => {
        const def = PTYPE_DEFS.find((p) => p.key === pt);
        if (!def) return;
        const pill = document.createElement("span");
        pill.className = "venue-ptype-badge";
        pill.style.cssText = `background:${def.colour}22;color:${def.colour};border:1px solid ${def.colour}55;`;
        pill.textContent = def.label;
        row.appendChild(pill);
      });

      if (v.url) {
        const a = document.createElement("a");
        a.href = sanitizeUrl(v.url) || "#";
        a.target = "_blank";
        a.className = "venue-list-website-link";
        a.textContent = "website";
        a.onclick = (e) => e.stopPropagation();
        row.appendChild(a);
      }

      listWrap.appendChild(row);
    });
  }

  renderList();
}

// Initialize immediately (don't wait for DOMContentLoaded) so data starts loading early
(async () => {
  const params = new URLSearchParams(window.location.search);
  venueId = params.get("venue");

  if (!venueId) {
    const loaded = await loadEventsData();
    if (!loaded) return showNotFound();
    eventsData = loaded.eventsData;
    venuesLookup = loaded.venuesLookup;
    performersLookup = loaded.performersLookup;
    toursLookup = loaded.toursLookup;
    displayDataLastUpdated(loaded.lastUpdateTime);
    initNavFeedback();
    // Defer heavy rendering to background to allow loading state to display
    setTimeout(() => {
      renderAllVenues();
      document.getElementById("loadingState").style.display = "none";
      document.getElementById("venueContent").style.display = "";
      preloadLeafletWhenIdle();
    }, 0);
    return;
  }

  const loaded = await loadEventsData();
  if (!loaded) {
    showNotFound();
    return;
  }

  eventsData = loaded.eventsData;
  venuesLookup = loaded.venuesLookup;
  performersLookup = loaded.performersLookup;
  displayDataLastUpdated(loaded.lastUpdateTime);
  initNavFeedback();
  toursLookup = loaded.toursLookup;

  venue = venuesLookup[venueId];
  if (!venue) {
    showNotFound();
    return;
  }

  // Defer heavy rendering to background to allow loading state to display
  setTimeout(() => {
    renderVenue();
    document.getElementById("loadingState").style.display = "none";
    document.getElementById("venueContent").style.display = "";
    if (venue.latlon) {
      loadLeaflet()
        .then(() => {
          initVenueMap();
          setTimeout(() => map.invalidateSize(), 0);
        })
        .catch((error) => {
          console.error("Failed to load venue map:", error);
          document.getElementById("map-container").style.display = "none";
        });
    }
  }, 0);
})();

// ---------------------------------------------------------------------------
// Main render
// ---------------------------------------------------------------------------

function renderVenue() {
  document.title = `${venue.name} — New Troubadours`;

  document.getElementById("venueName").textContent = venue.name;

  // Address
  if (venue.full_address) {
    const addr = document.getElementById("venueAddress");
    addr.textContent = venue.full_address;
  }

  // External links
  const linksDiv = document.getElementById("venueLinks");
  if (venue.url) {
    const a = document.createElement("a");
    a.href = sanitizeUrl(venue.url) || "#";
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "Website";
    linksDiv.appendChild(a);
  }
  if (venue.email) {
    if (linksDiv.children.length > 0)
      linksDiv.appendChild(document.createTextNode(" · "));
    const a = document.createElement("a");
    a.href = `mailto:${escapeHtml(venue.email)}`;
    a.textContent = "Email";
    linksDiv.appendChild(a);
  }
  if (venue.facebook) {
    if (linksDiv.children.length > 0)
      linksDiv.appendChild(document.createTextNode(" · "));
    const a = document.createElement("a");
    a.href = normaliseFacebookUrl(venue.facebook);
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "Facebook";
    linksDiv.appendChild(a);
  }
  if (venue.instagram) {
    if (linksDiv.children.length > 0)
      linksDiv.appendChild(document.createTextNode(" · "));
    const a = document.createElement("a");
    const igUrl = /^https?:\/\//i.test(venue.instagram)
      ? venue.instagram
      : `https://www.instagram.com/${venue.instagram.replace(/^@/, "")}`;
    a.href = sanitizeUrl(igUrl) || "#";
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "Instagram";
    linksDiv.appendChild(a);
  }
  // Google Maps link
  if (venue.latlon) {
    if (linksDiv.children.length > 0)
      linksDiv.appendChild(document.createTextNode(" · "));
    const a = document.createElement("a");
    const q = encodeURIComponent(venue.full_address || venue.name);
    a.href = `https://www.google.com/maps/search/?api=1&query=${q}`;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "Google Maps";
    linksDiv.appendChild(a);
  }

  // Description
  if (venue.description) {
    const descDiv = document.getElementById("venueDescription");
    descDiv.style.display = "";
    appendParagraphs(descDiv, venue.description);
  }

  // Info table
  renderInfoTable();

  // Map
  if (!venue.latlon) {
    document.getElementById("map-container").style.display = "none";
  }

  // Gather all events at this venue
  const regularClubs = (eventsData.events || []).filter(
    (e) => e.venue_id === venueId,
  );
  const folkNights = (eventsData.folkNights || []).filter(
    (e) => e.venue_id === venueId,
  );
  const irishSessions = (eventsData.irishSessions || []).filter(
    (e) => e.venue_id === venueId,
  );
  const specificEvents = (eventsData.specificEvents || []).filter(
    (e) => e.venue_id === venueId,
  );
  const musicEvents = (eventsData.musicEvents || []).filter(
    (e) => e.venue_id === venueId,
  );
  const poetryEvents = (eventsData.poetryEvents || []).filter(
    (e) => e.venue_id === venueId,
  );

  // Tour dates at this venue
  const tourDatesHere = [];
  Object.entries(toursLookup).forEach(([tourId, tour]) => {
    (tour.tour_dates || []).forEach((td) => {
      if (td.venue_id === venueId) {
        tourDatesHere.push({ tour, tourId, tourDate: td });
      }
    });
  });

  // Touring show dates at this venue
  const showDatesHere = [];
  Object.entries(eventsData.repertoire_shows || {}).forEach(([tsId, ts]) => {
    (ts.show_dates || []).forEach((sd) => {
      if (sd.venue_id === venueId) {
        showDatesHere.push({ ts, tsId, showDate: sd });
      }
    });
  });

  // Festival at this venue
  const festivalsHere = Object.entries(eventsData.festivals || {}).filter(
    ([, f]) => f.venue_id === venueId,
  );

  // Regular clubs
  if (regularClubs.length > 0) {
    document.getElementById("regularClubsSection").style.display = "";
    regularClubs.forEach((e) =>
      renderRegularClub(
        document.getElementById("regularClubsList"),
        e,
        "storyclub",
      ),
    );
  }

  if (folkNights.length > 0) {
    document.getElementById("folkNightsSection").style.display = "";
    folkNights.forEach((e) =>
      renderRegularClub(document.getElementById("folkNightsList"), e, "folk"),
    );
  }

  if (irishSessions.length > 0) {
    document.getElementById("irishSessionsSection").style.display = "";
    irishSessions.forEach((e) =>
      renderRegularClub(
        document.getElementById("irishSessionsList"),
        e,
        "session",
      ),
    );
  }

  // Sort specific + music + tour dates by date
  const today = getTodayMidnight();
  const allDated = [
    ...specificEvents.map((e) => ({
      type: "specific",
      date: parseDateString(e.date),
      data: e,
    })),
    ...musicEvents.map((e) => ({
      type: "music",
      date: parseDateString(e.date),
      data: e,
    })),
    ...poetryEvents.map((e) => ({
      type: "poetry",
      date: parseDateString(e.date),
      data: e,
    })),
    ...tourDatesHere.map((t) => ({
      type: "tour",
      date: parseDateString(t.tourDate.date),
      data: t,
    })),
    ...showDatesHere.map((s) => ({
      type: "show",
      date: parseDateString(s.showDate.date),
      data: s,
    })),
    ...festivalsHere.map(([fid, f]) => ({
      type: "festival",
      date: parseDateString(f.start_date),
      data: { fid, festival: f },
    })),
  ]
    .filter((e) => e.date)
    .sort((a, b) => a.date - b.date);

  const upcoming = allDated.filter((e) => e.date >= today);
  const past = allDated.filter((e) => e.date < today);

  if (upcoming.length > 0) {
    document.getElementById("upcomingSection").style.display = "";
    upcoming.forEach((e) =>
      renderEventRow(document.getElementById("upcomingList"), e, false),
    );
  }

  if (past.length > 0) {
    document.getElementById("pastSection").style.display = "";
    // Show most recent first for past
    [...past]
      .reverse()
      .forEach((e) =>
        renderEventRow(document.getElementById("pastList"), e, true),
      );
  }

  // Flyers gallery — current/upcoming in full colour, past greyed out
  renderVenueFlyers(regularClubs, allDated, today);

  // Nearby venues
  renderNearbyVenues();
}

// ---------------------------------------------------------------------------
// Info table
// ---------------------------------------------------------------------------

function renderInfoTable() {
  const table = document.getElementById("venueInfoTable");

  const rows = [
    venue.city && ["City", venue.city],
    venue.postcode && ["Postcode", venue.postcode],
  ].filter(Boolean);

  if (rows.length === 0) return;

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
// Map
// ---------------------------------------------------------------------------

function initVenueMap() {
  const [lat, lon] = venue.latlon;
  map = L.map("map", { minZoom: 5, maxZoom: 18 }).setView([lat, lon], 14);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors",
  }).addTo(map);

  const marker = L.marker([lat, lon]).addTo(map);
  marker
    .bindPopup(
      `<strong>${escapeHtml(venue.name)}</strong><br>${escapeHtml(venue.city || "")}`,
    )
    .openPopup();
}

// ---------------------------------------------------------------------------
// Regular club card
// ---------------------------------------------------------------------------

function renderRegularClub(container, event, type) {
  const typeClass =
    { storyclub: "club-story", folk: "club-folk", session: "club-session" }[
      type
    ] || "";
  const card = document.createElement("div");
  card.className = `regular-club-card ${typeClass}`;

  const nameRow = document.createElement("div");
  nameRow.className = "regular-club-name";
  nameRow.textContent = event.name;
  card.appendChild(nameRow);

  const metaRow = document.createElement("div");
  metaRow.className = "regular-club-meta";
  if (event.schedule) {
    const sched = document.createElement("span");
    sched.className = "regular-club-schedule";
    sched.textContent = capitalise(event.schedule);
    metaRow.appendChild(sched);
  }
  if (event.time) {
    metaRow.appendChild(
      document.createTextNode(event.schedule ? " · " + event.time : event.time),
    );
  }
  if (event.price) {
    metaRow.appendChild(document.createTextNode(" · " + event.price));
  }
  if (metaRow.childNodes.length > 0) card.appendChild(metaRow);

  if (event.description) {
    const desc = document.createElement("div");
    desc.className = "regular-club-desc";
    desc.textContent = event.description;
    card.appendChild(desc);
  }

  // Links row
  const links = document.createElement("div");
  links.className = "regular-club-links";
  const linkSrc = event.link || event.url;
  if (linkSrc) {
    const a = document.createElement("a");
    a.href = sanitizeUrl(linkSrc) || "#";
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "Website";
    links.appendChild(a);
  }
  if (event.facebook) {
    if (links.children.length > 0)
      links.appendChild(document.createTextNode(" · "));
    const a = document.createElement("a");
    a.href = normaliseFacebookUrl(event.facebook);
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "Facebook";
    links.appendChild(a);
  }
  if (event.email) {
    if (links.children.length > 0)
      links.appendChild(document.createTextNode(" · "));
    const a = document.createElement("a");
    a.href = `mailto:${escapeHtml(event.email)}`;
    a.textContent = "Email";
    links.appendChild(a);
  }
  if (links.children.length > 0) card.appendChild(links);

  // Exceptions / notes
  if (Array.isArray(event.exceptions) && event.exceptions.length > 0) {
    const exc = document.createElement("div");
    exc.className = "regular-club-exceptions";
    exc.textContent = `Note: not on ${event.exceptions.join(", ")}`;
    card.appendChild(exc);
  }
  if (event.storiesWelcome) {
    const sw = document.createElement("span");
    sw.className = "badge badge-stories-welcome";
    sw.textContent = "Stories welcome";
    card.appendChild(sw);
  }
  if (event.byInvitation) {
    const bi = document.createElement("span");
    bi.className = "badge badge-by-invite";
    bi.textContent = "By invitation";
    card.appendChild(bi);
  }

  container.appendChild(card);
}

// ---------------------------------------------------------------------------
// Dated event row (specific, music, tour date, festival)
// ---------------------------------------------------------------------------

function renderEventRow(container, entry, isPast) {
  const row = document.createElement("div");
  row.className = `event-row${isPast ? " event-row-past" : ""}`;

  const dateCol = document.createElement("div");
  dateCol.className = "event-row-date";
  dateCol.textContent = entry.date ? formatMediumDate(entry.date) : "TBC";
  row.appendChild(dateCol);

  const detail = document.createElement("div");
  detail.className = "event-row-detail";

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
      a.href = `new_troubadours_performers.html?performer=${encodeURIComponent(e.performer_id)}`;
      a.textContent = perf.name;
      p.appendChild(a);
      detail.appendChild(p);
    }

    const badges = document.createElement("div");
    badges.className = "badge-row";
    if (e.isMusic) {
      const b = document.createElement("span");
      b.className = "badge badge-music";
      b.textContent = "Music";
      badges.appendChild(b);
    } else if (e.isPoetry) {
      const b = document.createElement("span");
      b.className = "badge badge-poetry";
      b.textContent = "Poetry";
      badges.appendChild(b);
    } else {
      const b = document.createElement("span");
      b.className = "badge badge-special";
      b.textContent = "Story show";
      badges.appendChild(b);
    }
    if (e.price) {
      const b = document.createElement("span");
      b.className = "badge badge-price";
      b.textContent = e.price;
      badges.appendChild(b);
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
      a.href = `new_troubadours_performers.html?performer=${encodeURIComponent(tour.performer_id)}`;
      a.textContent = perf.name;
      p.appendChild(a);
      detail.appendChild(p);
    }

    const badges = document.createElement("div");
    badges.className = "badge-row";
    const b = document.createElement("span");
    b.className = "badge badge-special";
    b.textContent = "Tour date";
    badges.appendChild(b);
    if (tourDate.price) {
      const bp = document.createElement("span");
      bp.className = "badge badge-price";
      bp.textContent = tourDate.price;
      badges.appendChild(bp);
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
    viewLink.href = `new_troubadours_tour_guide.html?tour=${encodeURIComponent(tourId)}`;
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
      a.href = `new_troubadours_performers.html?performer=${encodeURIComponent(ts.performer_id)}`;
      a.textContent = perf.name;
      p.appendChild(a);
      detail.appendChild(p);
    }

    const badges = document.createElement("div");
    badges.className = "badge-row";
    const b = document.createElement("span");
    b.className = "badge badge-special";
    b.textContent = "Touring show";
    badges.appendChild(b);
    if (showDate.ticket_url && !isPast) {
      const a = document.createElement("a");
      a.href = sanitizeUrl(showDate.ticket_url) || "#";
      a.target = "_blank";
      a.className = "ticket-link";
      a.textContent = "Tickets";
      badges.appendChild(a);
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
    const b = document.createElement("span");
    b.className = "badge badge-special";
    b.textContent = "Festival";
    badges.appendChild(b);
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
}

// ---------------------------------------------------------------------------
// Flyers gallery
// ---------------------------------------------------------------------------

// A filename in a club's flyers[] list prefixed YYYY_MM_DD (e.g.
// "2026_07_26_loveshack-birds.jpg") is a flyer for that specific date;
// anything else is generic club artwork treated as always-current.
// parseDatedClubFlyer() (shared_utils.js) is the single implementation
// of that detection, shared with the event guide/flyers/storyclub pages.

// Pull the flyer filename(s) relevant to one of the dated entries
// already assembled into allDated (specific/music/poetry/tour/show/festival).
function extractFlyersForEntry(entry) {
  const EVENT_BASE = "./storyclub_assets/event_flyers/";
  const out = [];
  const add = (filename) => {
    const clean = filename?.trim();
    if (clean) out.push({ filename: clean, basePath: EVENT_BASE });
  };

  if (
    entry.type === "specific" ||
    entry.type === "music" ||
    entry.type === "poetry"
  ) {
    const e = entry.data;
    add(e.event_flyer);
    add(e.event_flyer2);
    add(e.tour_flyer);
  } else if (entry.type === "tour") {
    const { tour, tourDate } = entry.data;
    if (tourDate.event_flyer?.trim()) {
      add(tourDate.event_flyer);
    } else {
      getTourLevelFlyers(tour).forEach((f) => add(f.filename));
    }
  } else if (entry.type === "show") {
    const { ts, showDate } = entry.data;
    if (showDate.event_flyer?.trim()) {
      add(showDate.event_flyer);
    } else {
      add(ts.touring_event_flyer);
    }
  } else if (entry.type === "festival") {
    add(entry.data.festival.event_flyer);
  }
  return out;
}

// Build the venue's flyer gallery from: regular club nights (club_flyer
// + flyers[], generic ones always "current", YYYY_MM_DD-prefixed ones
// dated) plus every dated event happening at this venue. Deduplicated
// by file so a flyer reused across several dates (e.g. a tour headline
// flyer) only appears once, coloured by its most relevant occurrence.
function renderVenueFlyers(regularClubs, allDated, today) {
  const flyerMap = new Map();

  function addFlyer(filename, basePath, date) {
    const key = `${basePath}${filename}`;
    const isPast = date ? date < today : false;
    const existing = flyerMap.get(key);
    if (!existing) {
      flyerMap.set(key, { filename, basePath, date, isPast });
      return;
    }
    // Prefer a current/upcoming occurrence over a past one, and the
    // earliest upcoming date over a later one.
    if (
      !isPast &&
      (existing.isPast || (date && existing.date && date < existing.date))
    ) {
      existing.date = date;
      existing.isPast = isPast;
    }
  }

  regularClubs.forEach((club) => {
    if (club.club_flyer?.trim()) {
      addFlyer(club.club_flyer.trim(), "./storyclub_assets/club_flyers/", null);
    }
    (Array.isArray(club.flyers) ? club.flyers : []).forEach((raw) => {
      const clean = raw?.trim();
      if (!clean) return;
      const date = parseDatedClubFlyer(clean);
      addFlyer(clean, "./storyclub_assets/event_flyers/", date);
    });
  });

  allDated.forEach((entry) => {
    extractFlyersForEntry(entry).forEach((f) =>
      addFlyer(f.filename, f.basePath, entry.date),
    );
  });

  if (flyerMap.size === 0) return;

  const items = [...flyerMap.values()];
  const current = items
    .filter((i) => !i.isPast)
    .sort((a, b) => (a.date || today) - (b.date || today));
  const past = items.filter((i) => i.isPast).sort((a, b) => b.date - a.date);

  document.getElementById("venueFlyersSection").style.display = "";
  const list = document.getElementById("venueFlyersList");

  [...current, ...past].forEach((item) => {
    const src = `${item.basePath}${sanitizeFlyerPath(item.filename)}`;
    const a = document.createElement("a");
    a.href = src;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.className = `venue-flyer-thumb${item.isPast ? " venue-flyer-thumb-past" : ""}`;
    const img = document.createElement("img");
    img.src = src;
    img.alt = "";
    img.loading = "lazy";
    a.appendChild(img);
    list.appendChild(a);
  });
}

// ---------------------------------------------------------------------------
// Nearby venues
// ---------------------------------------------------------------------------

function renderNearbyVenues() {
  if (!venue.latlon) return;
  const [lat, lon] = venue.latlon;
  const RADIUS_KM = 20;

  const nearby = Object.entries(venuesLookup)
    .filter(([vid, v]) => vid !== venueId && v.latlon)
    .map(([vid, v]) => {
      const dist = haversineKm(lat, lon, v.latlon[0], v.latlon[1]);
      return { vid, v, dist };
    })
    .filter((x) => x.dist <= RADIUS_KM)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 8);

  if (nearby.length === 0) return;

  document.getElementById("nearbySection").style.display = "";
  const list = document.getElementById("nearbyList");

  nearby.forEach(({ vid, v, dist }) => {
    const row = document.createElement("div");
    row.className = "nearby-row";

    const a = document.createElement("a");
    a.href = `new_troubadours_venues.html?venue=${encodeURIComponent(vid)}`;
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

// ---------------------------------------------------------------------------
// Date formatting helpers
// ---------------------------------------------------------------------------

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
const DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatShortDate(d) {
  return d ? `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}` : "";
}

function formatMediumDate(d) {
  return d
    ? `${DAYS_SHORT[d.getDay()]} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`
    : "";
}
