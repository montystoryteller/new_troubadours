// ---------------------------------------------------------------------------
// Flyer helpers (used by render functions below)
// ---------------------------------------------------------------------------

const BASE_FLYER = "./storyclub_assets/event_flyers/";

function sanitizeFlyerName(name) {
  if (!name) return "";
  return name.replace(/[^a-zA-Z0-9._\-]/g, "");
}

// ---------------------------------------------------------------------------
// Data + state
// ---------------------------------------------------------------------------

let eventsData = null;
let venuesLookup = {};
let performersLookup = {};
let toursLookup = {};
let podcastsLookup = {};
let performerId = null;
let performer = null;
let compoundIdsForMe = new Set();
let pfImgLoader = null;

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// "Featured on a named series" / "has media" — used to badge performers on
// both the directory listing and their own page.
//
// featuredSeriesFor() is the stronger signal: an actual guest credit on one
// of the site's recognised industry-standard interview/telling series
// (currently World Storytelling Cafe and Taking the Tradition On), pulled
// from the podcasts registry — see events-schema.json → $defs.podcast.
//
// hasAnyMedia() is deliberately coarse: true if this performer has *any*
// video, own podcast feed, or podcast-guest appearance, without saying
// which. The directory listing only has room for one icon per signal, and
// spelling out video-vs-podcast-vs-appearance there would be more clutter
// than it's worth — a performer's own page already breaks these out
// properly (Videos / Podcasts / Podcast Appearances sections).
// ---------------------------------------------------------------------------

const FEATURED_SERIES = [
  { podcastId: "world-storytelling-cafe", shortLabel: "WSC" },
  { podcastId: "taking-the-tradition-on-podcast", shortLabel: "TTTO" },
];

function podcastCreditIncludesAny(podcast, ids) {
  return (podcast?.items || []).some((item) => {
    const itemIds = Array.isArray(item.performer_ids)
      ? item.performer_ids
      : item.performer_id
        ? [item.performer_id]
        : [];
    return itemIds.some((id) => ids.has(id));
  });
}

function featuredSeriesFor(ids) {
  return FEATURED_SERIES.filter(({ podcastId }) =>
    podcastCreditIncludesAny(podcastsLookup[podcastId], ids),
  ).map(({ podcastId, shortLabel }) => ({
    podcastId,
    shortLabel,
    fullName: podcastsLookup[podcastId]?.series_title || shortLabel,
  }));
}

function hasAnyMedia(performer, ids) {
  if (
    Array.isArray(performer.youtube_videos) &&
    performer.youtube_videos.length > 0
  )
    return true;
  if (
    performer.podcast &&
    (typeof performer.podcast === "string" || performer.podcast.length > 0)
  )
    return true;
  if (
    Array.isArray(performer.podcast_appearances) &&
    performer.podcast_appearances.length > 0
  )
    return true;
  return Object.values(podcastsLookup).some((podcast) =>
    podcastCreditIncludesAny(podcast, ids),
  );
}

function renderAllPerformers() {
  const container = document.getElementById("performerContent");
  container.innerHTML = "";

  // ── Build search index ─────────────────────────────────────────────
  // Each entry covers performer name + bio + tour/show/event names
  // so you can find "Cinderella" and land on the performer who does it.
  const perfIndex = Object.entries(performersLookup)
    .filter(([, p]) => !isTroupeConfig(p))
    .sort((a, b) => a[1].name.localeCompare(b[1].name))
    .map(([pid, p]) => {
      const aliasIds = new Set([pid, ...(p.aliases || [])]);
      const showNames = [];
      // What kinds of appearances this performer has — a
      // performer can be more than one type (e.g. a musician
      // who also does spoken word), so this is a Set, not a
      // single category.
      const types = new Set();
      if (p.poet === true) types.add("poetry");

      // Tours
      Object.values(toursLookup).forEach((t) => {
        if (aliasIds.has(t.performer_id)) {
          const n = t.tour_name || t.name;
          if (n) showNames.push(n);
          types.add(classifyPerformanceType(t));
        }
      });
      // Touring shows — always story
      Object.values(eventsData.repertoire_shows || {}).forEach((ts) => {
        if (aliasIds.has(ts.performer_id)) {
          const n = ts.showname || ts.name;
          if (n) showNames.push(n);
          types.add("story");
        }
      });
      // Specific / music / poetry events
      [
        ...(eventsData.specificEvents || []),
        ...(eventsData.musicEvents || []),
        ...(eventsData.poetryEvents || []),
      ].forEach((e) => {
        if (aliasIds.has(e.performer_id)) {
          const n = e.showname || e.name;
          if (n && !showNames.includes(n)) showNames.push(n);
          types.add(classifyPerformanceType(e));
        }
      });

      // "Story Troupe" — a combined-billing entry (its own
      // record links to several individual performer_ids,
      // e.g. two storytellers touring under one joint id)
      // whose appearances include story shows. Scoped to
      // story specifically, not music/poetry duos.
      const isMultiPerformer =
        Array.isArray(p.performer_ids) && p.performer_ids.length > 0;
      if (isMultiPerformer && types.has("story")) types.add("troupe");

      // Performers with no tours/shows/events listed yet
      // (e.g. a newly-added entry) default to "story" — the
      // most likely bucket on a storytelling-first site —
      // rather than being left type-less. A type-less entry
      // would otherwise never match any filter combination,
      // including the "everything selected" default, and
      // silently vanish from the directory.
      if (types.size === 0) types.add("story");

      return {
        pid,
        name: p.name,
        nameLower: p.name.toLowerCase(),
        bioLower: (p.bio || "").toLowerCase(),
        showNamesLower: showNames.map((s) => s.toLowerCase()),
        showNames,
        href: `new_troubadours_performers.html?performer=${encodeURIComponent(pid)}`,
        isTroupe: isTroupe(p),
        types,
        hasMedia: hasAnyMedia(p, aliasIds),
        featuredSeries: featuredSeriesFor(aliasIds),
      };
    });

  // ── Type filters ──────────────────────────────────────────────────
  const TYPE_DEFS = [
    { key: "story", label: "📖 Storytellers" },
    { key: "music", label: "🎵 Musicians" },
    { key: "poetry", label: "✒️ Poets" },
    { key: "troupe", label: "🎭 Story Troupes" },
  ];
  const activeTypes = new Set(TYPE_DEFS.map((t) => t.key));
  let currentSearchTerm = "";

  const typeFilterWrap = document.createElement("div");
  typeFilterWrap.className = "perf-type-filters";

  const allTypeBtn = document.createElement("button");
  allTypeBtn.className = "dir-filter-btn active-teal";
  allTypeBtn.textContent = "All";
  allTypeBtn.onclick = () => {
    TYPE_DEFS.forEach(({ key }) => activeTypes.add(key));
    refreshTypeBtns();
    applyFilters();
  };
  typeFilterWrap.appendChild(allTypeBtn);

  const noneTypeBtn = document.createElement("button");
  noneTypeBtn.className = "dir-filter-btn";
  noneTypeBtn.textContent = "None";
  noneTypeBtn.onclick = () => {
    activeTypes.clear();
    refreshTypeBtns();
    applyFilters();
  };
  typeFilterWrap.appendChild(noneTypeBtn);

  const typeBtnEls = [];
  TYPE_DEFS.forEach(({ key, label }) => {
    const btn = document.createElement("button");
    btn.className = "type-filter-btn active";
    btn.dataset.ptype = key;
    btn.textContent = label;
    btn.onclick = () => {
      if (activeTypes.has(key)) activeTypes.delete(key);
      else activeTypes.add(key);
      refreshTypeBtns();
      applyFilters();
    };
    typeBtnEls.push(btn);
    typeFilterWrap.appendChild(btn);
  });

  function refreshTypeBtns() {
    typeBtnEls.forEach((btn) =>
      btn.classList.toggle("active", activeTypes.has(btn.dataset.ptype)),
    );
    allTypeBtn.classList.toggle(
      "active-teal",
      activeTypes.size === TYPE_DEFS.length,
    );
    // Highlighted only when every type button is off — i.e. the actual
    // "nothing selected" state — not merely "not all selected" (that's
    // just the normal look of any partial selection).
    noneTypeBtn.classList.toggle("active-teal", activeTypes.size === 0);
  }

  container.appendChild(typeFilterWrap);

  // ── Search box ────────────────────────────────────────────────────
  const searchWrap = document.createElement("div");
  searchWrap.className = "perf-search-wrap";

  createSearchBox(searchWrap, {
    placeholder: "Search performers, shows or tours…",
    search: (term) => {
      const t = term.toLowerCase();
      return perfIndex
        .map((entry) => {
          if (entry.nameLower.includes(t)) return { entry, matchType: "name" };
          if (entry.bioLower.includes(t)) return { entry, matchType: "bio" };
          const showMatch = entry.showNames.find((s, i) =>
            entry.showNamesLower[i].includes(t),
          );
          if (showMatch) return { entry, matchType: showMatch };
          return null;
        })
        .filter(Boolean)
        .slice(0, 10);
    },
    renderItem: ({ entry, matchType }) => {
      const div = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = entry.name;
      div.appendChild(strong);
      if (matchType !== "name" && matchType !== "bio") {
        // matchType is the show name that matched
        const meta = document.createElement("span");
        meta.className = "dir-search-item-meta";
        meta.textContent = matchType;
        div.appendChild(meta);
      } else if (matchType === "bio") {
        const meta = document.createElement("span");
        meta.className = "dir-search-item-meta";
        meta.textContent = "bio";
        div.appendChild(meta);
      }
      if (entry.isTroupe) {
        const tag = document.createElement("span");
        tag.className = "dir-search-item-meta";
        tag.textContent = "troupe";
        div.appendChild(tag);
      }
      return div;
    },
    onSelect: ({ entry }, searchInput, clearBtn, dropdown) => {
      // Navigate directly to the performer page
      location.href = entry.href;
    },
    onChange: (term) => {
      currentSearchTerm = term.toLowerCase();
      applyFilters();
    },
  });

  container.appendChild(searchWrap);

  // ── Collapsible list ──────────────────────────────────────────────
  const details = document.createElement("details");
  details.className = "all-performers-details";

  const summary = document.createElement("summary");
  summary.className = "all-performers-summary";

  const summaryLabel = document.createElement("span");
  summaryLabel.className = "all-performers-label";
  summaryLabel.textContent = `All performers (${perfIndex.length})`;
  summary.appendChild(summaryLabel);

  const summaryHint = document.createElement("span");
  summaryHint.className = "all-performers-hint";
  summaryHint.textContent = "click to expand";
  summary.appendChild(summaryHint);

  details.appendChild(summary);

  const listBody = document.createElement("div");
  listBody.className = "all-performers-body";

  // Build list rows manually so we can tag each with data-pid for filtering
  const TYPE_TAG_LABELS = {
    music: "Music",
    poetry: "Poetry",
    troupe: "Troupe",
  };
  const list = document.createElement("div");
  list.className = "simple-list";
  perfIndex.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "simple-list-row";
    row.dataset.pid = entry.pid;
    row.dataset.types = [...entry.types].join(" ");
    const a = document.createElement("a");
    a.href = entry.href;
    a.textContent = entry.name;
    row.appendChild(a);
    // Small type tags (story is the baseline look, so only
    // tag music/poetry to keep the common case uncluttered).
    // Grouped in one wrapper so 2+ tags cluster together as a
    // single flex item instead of being spread apart by the
    // row's justify-content: space-between.
    const tagGroup = document.createElement("span");
    tagGroup.className = "simple-list-row-tags";
    entry.types.forEach((ty) => {
      if (!TYPE_TAG_LABELS[ty]) return;
      const tag = document.createElement("span");
      tag.className = `simple-list-row-type-tag type-${ty}`;
      tag.textContent = TYPE_TAG_LABELS[ty];
      tagGroup.appendChild(tag);
    });
    // Media icon — see hasAnyMedia(); deliberately one combined icon
    // rather than separate video/podcast/appearance icons (their own
    // page breaks those out properly).
    if (entry.hasMedia) {
      const mediaIcon = document.createElement("span");
      mediaIcon.className = "simple-list-row-media-icon";
      mediaIcon.textContent = "🎬";
      mediaIcon.title = "Has video and/or podcast content";
      tagGroup.appendChild(mediaIcon);
    }
    // Featured-series badge(s) — a guest credit on a recognised
    // industry-standard series (see FEATURED_SERIES), separate from the
    // generic media icon above since it's a stronger credential. Links to
    // that series' scoped view on the Watch & Listen page (media.js
    // reads ?series=<podcast_id> — see also the same link built in
    // renderPerformer() for the header badge).
    entry.featuredSeries.forEach(({ podcastId, shortLabel, fullName }) => {
      const seriesBadge = document.createElement("a");
      seriesBadge.href = `new_troubadours_media.html?series=${encodeURIComponent(podcastId)}`;
      seriesBadge.className = "simple-list-row-series-tag";
      seriesBadge.textContent = shortLabel;
      seriesBadge.title = `Featured on ${fullName} — view all episodes`;
      seriesBadge.onclick = (e) => e.stopPropagation();
      tagGroup.appendChild(seriesBadge);
    });
    if (tagGroup.children.length > 0) row.appendChild(tagGroup);
    list.appendChild(row);
  });
  listBody.appendChild(list);
  details.appendChild(listBody);

  container.appendChild(details);

  // ── Combined search + type filtering ────────────────────────────────
  function applyFilters() {
    const t = currentSearchTerm;
    const matchedPids = new Set(
      t
        ? perfIndex
            .filter(
              (e) =>
                e.nameLower.includes(t) ||
                e.bioLower.includes(t) ||
                e.showNamesLower.some((s) => s.includes(t)),
            )
            .map((e) => e.pid)
        : perfIndex.map((e) => e.pid), // empty → show all
    );

    let visibleCount = 0;
    listBody.querySelectorAll(".simple-list-row").forEach((row) => {
      const pid = row.dataset.pid;
      const rowTypes = row.dataset.types.split(" ").filter(Boolean);
      const typeVisible = rowTypes.some((ty) => activeTypes.has(ty));
      const searchVisible = !t || matchedPids.has(pid);
      const visible = typeVisible && searchVisible;
      row.style.display = visible ? "" : "none";
      if (visible) visibleCount++;
    });

    const filterActive = !!t || activeTypes.size < TYPE_DEFS.length;
    summaryLabel.textContent = filterActive
      ? `All performers — ${visibleCount} match${visibleCount !== 1 ? "es" : ""}`
      : `All performers (${perfIndex.length})`;

    // Auto-expand when filtering, restore default when cleared
    if (filterActive) details.open = true;
  }
}

// Initialize immediately (don't wait for DOMContentLoaded) so data starts loading early
(async () => {
  const params = new URLSearchParams(window.location.search);
  performerId = params.get("performer");

  // Lazy-image loader for performer-page flyer thumbnails — see
  // createLazyImageLoader() in shared_utils.js for the shared
  // implementation (also used by the flyers page and tour flyer
  // gallery). Declared here so it's available to all functions.
  // Matches both flyer-strip and gallery-card wrap contexts.
  pfImgLoader = createLazyImageLoader({
    rootMargin: "300px 0px",
    srcAttribute: "pfSrc",
    revealedClass: "pf-loaded",
    wrapSelector: ".perf-flyer-thumb, .perf-gallery-img-wrap",
    errorMessage: "Flyer image<br>not available",
  });

  if (!performerId) {
    const loaded = await loadEventsData();
    if (!loaded) return showNotFound();
    eventsData = loaded.eventsData;
    toursLookup = loaded.toursLookup;
    performersLookup = loaded.performersLookup;
    displayDataLastUpdated(loaded.lastUpdateTime);
    initNavFeedback();

    // Defer heavy rendering to background to allow loading state to display
    setTimeout(() => {
      renderAllPerformers();
      document.getElementById("loadingState").style.display = "none";
      document.getElementById("performerContent").style.display = "";
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
  toursLookup = loaded.toursLookup;
  podcastsLookup = loaded.podcastsLookup;
  displayDataLastUpdated(loaded.lastUpdateTime);
  initNavFeedback();

  performer = performersLookup[performerId];
  if (!performer) {
    showNotFound();
    return;
  }

  // Defer heavy rendering to background to allow loading state to display
  setTimeout(() => {
    renderPerformer();
    document.getElementById("loadingState").style.display = "none";
    document.getElementById("performerContent").style.display = "";
  }, 0);

  // ── Jump-to-performer search in the page header ────────────────
  const jumpWrap = document.getElementById("perfJumpWrap");
  if (jumpWrap) {
    jumpWrap.style.display = "";

    // Build a lightweight index: name + show/tour names
    const jumpIndex = Object.entries(performersLookup)
      .filter(([, p]) => !isTroupeConfig(p) && p)
      .sort((a, b) => a[1].name.localeCompare(b[1].name))
      .map(([pid, p]) => {
        const aliasIds = new Set([pid, ...(p.aliases || [])]);
        const showNames = [];
        Object.values(toursLookup).forEach((t) => {
          if (aliasIds.has(t.performer_id)) {
            const n = t.tour_name || t.name;
            if (n) showNames.push(n);
          }
        });
        Object.values(eventsData.repertoire_shows || {}).forEach((ts) => {
          if (ts.performer_id === pid) {
            const n = ts.showname || ts.name;
            if (n) showNames.push(n);
          }
        });
        return {
          pid,
          name: p.name,
          nameLower: p.name.toLowerCase(),
          showNamesLower: showNames.map((s) => s.toLowerCase()),
          showNames,
          href: `new_troubadours_performers.html?performer=${encodeURIComponent(pid)}`,
        };
      });

    createSearchBox(jumpWrap, {
      placeholder: "Jump to performer…",
      search: (term) => {
        const t = term.toLowerCase();
        return jumpIndex
          .filter((e) => e.pid !== performerId) // exclude current
          .map((e) => {
            if (e.nameLower.includes(t)) return { e, hint: null };
            const sm = e.showNames.find((s, i) =>
              e.showNamesLower[i].includes(t),
            );
            if (sm) return { e, hint: sm };
            return null;
          })
          .filter(Boolean)
          .slice(0, 8);
      },
      renderItem: ({ e, hint }) => {
        const div = document.createElement("div");
        const strong = document.createElement("strong");
        strong.textContent = e.name;
        div.appendChild(strong);
        if (hint) {
          const meta = document.createElement("span");
          meta.className = "dir-search-item-meta";
          meta.textContent = hint;
          div.appendChild(meta);
        }
        return div;
      },
      onSelect: ({ e }) => {
        location.href = e.href;
      },
      onChange: () => {},
    });
  }
})();

// ---------------------------------------------------------------------------
// Main render
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// "Agenda" ordering for the top-level Tours/Repertoire/Other
// appearances/Festivals listings — soonest-upcoming first, then most
// recently completed first below that, rather than a flat oldest-to-
// newest list that would bury anything upcoming under years of history
// (or, for tours/touring shows/festivals, no date-based order at all).
// ---------------------------------------------------------------------------

/**
 * Given a list of Date objects for one tour/show/festival, picks the one
 * date "representing" it for sorting purposes: the soonest upcoming date
 * if it has any, otherwise its most recent past date.
 * @param {(Date|null)[]} dates
 * @returns {Date|null}
 */
function representativeDate(dates) {
  const valid = dates.filter(Boolean);
  if (valid.length === 0) return null;
  const today = getTodayMidnight();
  const future = valid.filter((d) => d >= today).sort((a, b) => a - b);
  if (future.length > 0) return future[0];
  return valid.sort((a, b) => b - a)[0];
}

/**
 * Comparator factory: sorts so every item with an upcoming representative
 * date comes first (soonest first), then every item whose representative
 * date is in the past comes after (most recent first), then anything with
 * no date at all sinks to the very bottom.
 * @param {(item: any) => Date|null} getDate
 */
function upcomingFirstThenRecent(getDate) {
  const today = getTodayMidnight();
  return (a, b) => {
    const da = getDate(a);
    const db = getDate(b);
    if (!da && !db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    const aFuture = da >= today;
    const bFuture = db >= today;
    if (aFuture && bFuture) return da - db; // soonest upcoming first
    if (!aFuture && !bFuture) return db - da; // most recent past first
    return aFuture ? -1 : 1; // any upcoming beats any past
  };
}

function representativeTourDate(tour) {
  return representativeDate(
    (tour.tour_dates || []).map((td) => parseDateString(td.date)),
  );
}

function representativeShowDate(show) {
  return representativeDate(
    (show.show_dates || []).map((sd) => parseDateString(sd.date)),
  );
}

function renderPerformer() {
  document.title = `${performer.name} — New Troubadours`;

  // Avatar initials
  const initials = performer.name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase())
    .slice(0, 2)
    .join("");
  document.getElementById("performerAvatar").textContent = initials;

  // For compound performers, render each member name as a link to their individual page.
  // Members may be declared via performer_ids/ids, or inferred from the compound ID
  // by splitting on known separators (e.g. "daniel-morden-hugh-lupton-sarah-lianne-lewis").
  const nameEl = document.getElementById("performerName");
  const members =
    performer.performer_ids ||
    performer.ids ||
    (() => {
      // Fallback: infer members by finding individual performer IDs that appear
      // as substrings of the compound performer ID (longest matches first).
      const candidateIds = Object.keys(performersLookup)
        .filter(
          (id) =>
            id !== performerId &&
            performersLookup[id] &&
            !(performersLookup[id].performer_ids || performersLookup[id].ids),
        )
        .sort((a, b) => b.length - a.length); // longest first to avoid partial matches
      const remaining = [performerId];
      const found = [];
      let slug = performerId;
      for (const id of candidateIds) {
        if (slug.includes(id)) {
          found.push(id);
          slug = slug
            .replace(id, "")
            .replace(/^-+|-+$/g, "")
            .replace(/-{2,}/g, "-");
        }
        if (!slug) break;
      }
      return found.length > 1 ? found : [];
    })();
  if (members.length > 1) {
    // Tokenise the display name by common separators, preserving them as delimiters.
    // e.g. "Daniel Morden | Hugh Lupton & Sarah Lianne Lewis" → parts + separators.
    const separatorRe = /(\s*[\|&\/]\s*|\s+and\s+|\s+feat\.\s*)/i;
    const rawParts = performer.name.split(separatorRe);
    // rawParts alternates: [name, sep, name, sep, name, …]
    rawParts.forEach((part, i) => {
      if (i % 2 === 1) {
        // Separator token — keep it as plain text
        nameEl.appendChild(document.createTextNode(part));
      } else {
        const trimmed = part.trim();
        if (!trimmed) return;
        // Try to find the matching individual performer record by name.
        const matchId = members.find((id) => {
          const p = performersLookup[id];
          return p && p.name.toLowerCase() === trimmed.toLowerCase();
        });
        if (matchId) {
          const a = document.createElement("a");
          a.href = `new_troubadours_performers.html?performer=${encodeURIComponent(matchId)}`;
          a.textContent = trimmed;
          a.className = "performer-member-link";
          nameEl.appendChild(a);
        } else {
          nameEl.appendChild(document.createTextNode(trimmed));
        }
      }
    });
  } else if (members.length === 1) {
    // Single declared member — link it
    const a = document.createElement("a");
    a.href = `new_troubadours_performers.html?performer=${encodeURIComponent(members[0])}`;
    a.textContent = performer.name;
    a.className = "performer-member-link";
    nameEl.appendChild(a);
  } else {
    nameEl.textContent = performer.name;
  }

  // Also render member chips beneath the name when performer_ids are declared
  if (members.length > 1) {
    const chipsDiv = document.createElement("div");
    chipsDiv.className = "performer-member-chips";
    members.forEach((id) => {
      const p = performersLookup[id];
      if (!p) return;
      const chip = document.createElement("a");
      chip.href = `new_troubadours_performers.html?performer=${encodeURIComponent(id)}`;
      chip.className = "performer-member-chip";
      // Avatar initials
      const initials = p.name
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => w[0].toUpperCase())
        .slice(0, 2)
        .join("");
      const av = document.createElement("span");
      av.className = "chip-avatar";
      av.textContent = initials;
      chip.appendChild(av);
      chip.appendChild(document.createTextNode(p.name));
      chipsDiv.appendChild(chip);
    });
    // Insert after the h1
    nameEl.parentNode.insertBefore(chipsDiv, nameEl.nextSibling);
  }

  // Musician / Poet badges — shown if this performer record (or,
  // for a combined billing like "Jess Silk & Joe Solo", any of its
  // declared members) is tagged musician: true / poet: true.
  const isMusicianPerformer =
    performer.musician === true ||
    members.some((id) => performersLookup[id]?.musician === true);
  const isPoetPerformer =
    performer.poet === true ||
    members.some((id) => performersLookup[id]?.poet === true);
  const badgesDiv = document.getElementById("performerBadges");
  if (isMusicianPerformer) {
    const badge = document.createElement("span");
    badge.className = "performer-badge performer-badge-musician";
    badge.textContent = "🎵 Musician";
    badgesDiv.appendChild(badge);
  }
  if (isPoetPerformer) {
    const badge = document.createElement("span");
    badge.className = "performer-badge performer-badge-poet";
    badge.textContent = "✒️ Poet";
    badgesDiv.appendChild(badge);
  }

  // Featured-series badge(s) — see featuredSeriesFor(); same credit check
  // used on the directory listing. performer.aliases mirrors the aliasIds
  // set built there (pid + declared aliases), matching the direct-id
  // credit-matching convention already used by collectPerformerVideoAppearances()/
  // collectPerformerAppearances() rather than expanding through compound
  // performer_ids (podcast items tag individuals directly in practice).
  // Links to that series' scoped view on the Watch & Listen page
  // (media.js reads ?series=<podcast_id>).
  featuredSeriesFor(
    new Set([performerId, ...(performer.aliases || [])]),
  ).forEach(({ podcastId, shortLabel, fullName }) => {
    const badge = document.createElement("a");
    badge.href = `new_troubadours_media.html?series=${encodeURIComponent(podcastId)}`;
    badge.className = "performer-badge performer-badge-series";
    badge.textContent = `🌍 ${shortLabel}`;
    badge.title = `Featured on ${fullName} — view all episodes`;
    badgesDiv.appendChild(badge);
  });

  // External links: website, Facebook, Facebook page/group, Instagram, Podcast
  const websiteDiv = document.getElementById("performerWebsite");

  function addPerformerLink(url, label, kind) {
    if (!url) return;
    let href;
    if (kind === "facebook") {
      href = normaliseFacebookUrl(url);
    } else if (kind === "instagram") {
      const igUrl = /^https?:\/\//i.test(url)
        ? url
        : `https://www.instagram.com/${url.replace(/^@/, "")}`;
      href = sanitizeUrl(igUrl) || "#";
    } else {
      href = sanitizeUrl(url);
      if (!href) return;
    }
    if (websiteDiv.children.length > 0)
      websiteDiv.appendChild(document.createTextNode(" · "));
    const a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = label;
    websiteDiv.appendChild(a);
  }

  addPerformerLink(
    performer.url,
    performer.url
      ? performer.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")
      : "",
    "website",
  );
  addPerformerLink(performer.facebook, "Facebook", "facebook");
  addPerformerLink(performer.facebook_group, "Facebook Page", "facebook");
  addPerformerLink(performer.instagram, "Instagram", "instagram");
  // Podcast(s) get their own collapsible section further down the page
  // (see renderPodcastSection) rather than a link here, since performer.podcast
  // may be a single URL or a whole list of them.

  // Bio
  if (performer.bio) {
    const bioDiv = document.getElementById("performerBio");
    appendParagraphs(bioDiv, performer.bio);
  }

  // Podcasts
  renderPodcastSection(performer);
  renderPodcastAppearancesSection(performer);
  renderVideosSection(performer);

  // Build a set of all compound performer IDs that include this performer.
  // Checks both performer_ids and the legacy ids field on performer records.
  // e.g. if performerId = "sarah-liisa-wilkinson", this set will contain
  // "lucy-lill-sarah-liisa-wilkinson" so events with that performer_id are found.
  compoundIdsForMe = new Set();
  Object.entries(performersLookup).forEach(([pid, p]) => {
    const members = p.performer_ids || p.ids || [];
    if (Array.isArray(members) && members.includes(performerId)) {
      compoundIdsForMe.add(pid);
    }
  });

  // If viewing a troupe, also treat all its alias configs as "me"
  if (isTroupe(performer)) {
    (performer.aliases || []).forEach((aid) => compoundIdsForMe.add(aid));
  }
  // If viewing a troupe config, treat the parent troupe as "me" too
  if (isTroupeConfig(performer) && performer.troupe) {
    compoundIdsForMe.add(performer.troupe);
    // ...and the sibling configs
    const parent = performersLookup[performer.troupe];
    (parent?.aliases || []).forEach((aid) => {
      if (aid !== performerId) compoundIdsForMe.add(aid);
    });
  }

  // Helper: returns true if an event/tour/show belongs to this performer.
  // Checks: direct performer_id match, performer_ids array on the event itself
  // (used on tours like Haggarty/Brittain), and compound performer records
  // whose ids/performer_ids include this performer (used on specificEvents
  // like Queen of Between which carry a compound performer_id).
  function performerMatches(obj) {
    if (obj.performer_id === performerId) return true;
    if (
      Array.isArray(obj.performer_ids) &&
      obj.performer_ids.includes(performerId)
    )
      return true;
    if (obj.performer_id && compoundIdsForMe.has(obj.performer_id)) return true;
    return false;
  }

  // Gather all data for this performer
  const myTours = Object.entries(toursLookup)
    .filter(([, t]) => performerMatches(t))
    .sort(upcomingFirstThenRecent(([, t]) => representativeTourDate(t)));
  const myTouringShows = Object.entries(eventsData.repertoire_shows || {})
    .filter(([, ts]) => performerMatches(ts))
    .sort(upcomingFirstThenRecent(([, ts]) => representativeShowDate(ts)));  // Expand any multi-night `date` arrays (dateOrDates) into one entry per date,
  // same convention as tour_dates — see expandTourDates() in shared_utils.js.
  const mySpecific = expandTourDates(
    (eventsData.specificEvents || []).filter((e) => performerMatches(e)),
  );
  const myMusic = expandTourDates(
    (eventsData.musicEvents || []).filter((e) => performerMatches(e)),
  );
  const myPoetry = expandTourDates(
    (eventsData.poetryEvents || []).filter((e) => performerMatches(e)),
  );
  const myFestivals = Object.entries(eventsData.festivals || {})
    .filter(([, f]) => (f.performers || []).some((p) => p.performer_id === performerId))
    .sort(upcomingFirstThenRecent(([, f]) => parseDateString(f.start_date)));

  // Collaborators — note myFestivals is deliberately excluded here: sharing
  // a festival bill isn't performing together (see collectCollaborators()).
  renderCollaboratorsSection(
    collectCollaborators([
      ...myTours.map(([, t]) => ({ record: t, displayName: t.tour_name || t.name })),
      ...myTouringShows.map(([, ts]) => ({
        record: ts,
        displayName: ts.showname || ts.name,
      })),
      ...mySpecific.map((e) => ({ record: e, displayName: e.showname || e.name })),
      ...myMusic.map((e) => ({ record: e, displayName: e.showname || e.name })),
      ...myPoetry.map((e) => ({ record: e, displayName: e.showname || e.name })),
    ]),
  );

  // Count all tour dates
  const totalTourDates = myTours.reduce(
    (sum, [, t]) => sum + (t.tour_dates || []).length,
    0,
  );
  const totalTouringDates = myTouringShows.reduce(
    (sum, [, ts]) => sum + (ts.show_dates || []).length,
    0,
  );

  // Count unique venues across all events
  const venueIds = new Set();
  myTours.forEach(([, t]) =>
    (t.tour_dates || []).forEach(
      (td) => td.venue_id && venueIds.add(td.venue_id),
    ),
  );
  myTouringShows.forEach(([, ts]) =>
    (ts.show_dates || []).forEach(
      (sd) => sd.venue_id && venueIds.add(sd.venue_id),
    ),
  );
  [...mySpecific, ...myMusic, ...myPoetry].forEach(
    (e) => e.venue_id && venueIds.add(e.venue_id),
  );

  // Stats row
  const hasToursOrShows = myTours.length > 0 || myTouringShows.length > 0;
  const otherEventsCount = mySpecific.length + myMusic.length + myPoetry.length;
  const otherEventsLabel = hasToursOrShows
    ? "Other events"
    : otherEventsCount === 1
      ? "Event"
      : "Events";
  const stats = [
    { n: myTours.length, label: myTours.length === 1 ? "Tour" : "Tours" },
    { n: totalTourDates + totalTouringDates, label: "Tour dates" },
    { n: otherEventsCount, label: otherEventsLabel },
    { n: venueIds.size, label: "Venues" },
  ];
  const statsRow = document.getElementById("statsRow");
  stats.forEach((s) => {
    if (s.n === 0) return;
    const card = document.createElement("div");
    card.className = "stat-card";
    card.innerHTML = `<div class="stat-n">${s.n}</div><div class="stat-l">${escapeHtml(s.label)}</div>`;
    statsRow.appendChild(card);
  });

  // Tours
  if (myTours.length > 0) {
    document.getElementById("toursSection").style.display = "";
    const list = document.getElementById("toursList");
    myTours.forEach(([tourId, tour]) => renderTourCard(list, tourId, tour));
  }

  // Touring shows
  if (myTouringShows.length > 0) {
    document.getElementById("touringShowsSection").style.display = "";
    const list = document.getElementById("touringShowsList");
    myTouringShows.forEach(([tsId, ts]) =>
      renderTouringShowCard(list, tsId, ts),
    );
  }

  // Specific + music + poetry events
  const allOther = [...mySpecific, ...myMusic, ...myPoetry].sort(
    upcomingFirstThenRecent((e) => parseDateString(e.date)),
  );
  if (allOther.length > 0) {
    document.getElementById("eventsSection").style.display = "";
    // Heading: "Appearances" when sole content, "Other appearances" when alongside tours/shows
    document.getElementById("eventsSectionHeading").textContent =
      hasToursOrShows ? "Other appearances" : "Appearances";
    // Annotate the stat card if all events are TBC
    const tbcCount = allOther.filter(
      (e) =>
        !parseDateString(e.date) &&
        !(Array.isArray(e.datetimes) && e.datetimes.length > 0),
    ).length;
    if (tbcCount === allOther.length && tbcCount > 0) {
      // All are TBC — add a small note to the stat card label
      const statCards = document
        .getElementById("statsRow")
        .querySelectorAll(".stat-card");
      statCards.forEach((card) => {
        const label = card.querySelector(".stat-l");
        if (
          label &&
          (label.textContent === "Event" ||
            label.textContent === "Events" ||
            label.textContent === "Other events")
        ) {
          label.textContent += " (date TBC)";
        }
      });
    } else if (tbcCount > 0) {
      // Some are TBC — note how many
      const statCards = document
        .getElementById("statsRow")
        .querySelectorAll(".stat-card");
      statCards.forEach((card) => {
        const label = card.querySelector(".stat-l");
        if (
          label &&
          (label.textContent === "Event" ||
            label.textContent === "Events" ||
            label.textContent === "Other events")
        ) {
          label.textContent += ` (${tbcCount} TBC)`;
        }
      });
    }
    const list = document.getElementById("eventsList");
    allOther.forEach((e) => renderEventRow(list, e));
  }

  // Festivals
  if (myFestivals.length > 0) {
    document.getElementById("festivalsSection").style.display = "";
    const list = document.getElementById("festivalsList");
    myFestivals.forEach(([fid, f]) => renderFestivalRow(list, fid, f));
  }

  // Flyer gallery — collects all flyers across tours, shows and events
  renderFlyerGallery(myTours, myTouringShows, allOther);

  // If this is a troupe, render each alias config as a collapsible sub-section
  if (isTroupe(performer)) {
    renderTroupeConfigs(performer);
  }
}

// ---------------------------------------------------------------------------
// Flyer gallery
// Collects all flyers for this performer (tour-level, per-date, event, show)
// and renders a horizontally-scrolling strip of thumbnails.
// ---------------------------------------------------------------------------

// Shared list that the lightbox navigates — populated by renderFlyerGallery
let perfGalleryItems = [];

// ── Performer-page flyer lightbox (state + functions) ───────────────────
// Defined here (in the same script block as renderPerformer/
// renderTourCard) rather than in the later <script> tag near the
// lightbox markup, so makePerfFlyerThumb & co. are guaranteed to exist
// before renderPerformer ever calls them — the wiring of the lightbox's
// own buttons (which needs that markup to exist first) stays in the
// later <script> tag, further down the page.
let _pfItems = [];
let _pfIdx = 0;

function openPerfFlyer(items, idx) {
  _pfItems = items;
  _pfIdx = idx;
  showPfSlide();
  document.getElementById("perfFlyerLightbox").classList.add("pf-open");
  document.addEventListener("keydown", pfLbKey);
}

function closePerfFlyer() {
  document.getElementById("perfFlyerLightbox").classList.remove("pf-open");
  document.removeEventListener("keydown", pfLbKey);
}

function showPfSlide() {
  const item = _pfItems[_pfIdx];
  document.getElementById("pfImg").src = item.src;
  document.getElementById("pfImg").alt = item.label || "";
  document.getElementById("pfCaption").textContent = item.label || "";
  document.getElementById("pfPrev").disabled = _pfIdx <= 0;
  document.getElementById("pfNext").disabled = _pfIdx >= _pfItems.length - 1;
}

function pfLbKey(e) {
  if (e.key === "Escape") closePerfFlyer();
  if (e.key === "ArrowLeft" && _pfIdx > 0) {
    _pfIdx--;
    showPfSlide();
  }
  if (e.key === "ArrowRight" && _pfIdx < _pfItems.length - 1) {
    _pfIdx++;
    showPfSlide();
  }
}

// Helper used by renderTourCard / renderTouringShowCard / renderEventRow
function makePerfFlyerThumb(flyerName, label, extraClass) {
  const src = BASE_FLYER + sanitizeFlyerName(flyerName.trim());
  const wrap = document.createElement("div");
  wrap.className = "perf-flyer-thumb" + (extraClass ? " " + extraClass : "");
  wrap.title = "View flyer";
  const img = document.createElement("img");
  img.dataset.pfSrc = src;
  img.alt = label || "Flyer";
  pfImgLoader.observe(img);
  wrap.appendChild(img);
  wrap.addEventListener("click", (e) => {
    e.stopPropagation();
    // Open in the full gallery list if available, so prev/next works
    const galleryIdx = perfGalleryItems.findIndex((i) => i.src === src);
    if (galleryIdx >= 0) {
      openPerfFlyer(perfGalleryItems, galleryIdx);
    } else {
      openPerfFlyer([{ src, label: label || "" }], 0);
    }
  });
  return wrap;
}

function renderFlyerGallery(myTours, myTouringShows, allOther) {
  const items = [];
  const seen = new Set();

  function add(flyerName, label, dateStr, isMusic, isPast, isPoetry) {
    if (!flyerName?.trim()) return;
    const key = flyerName.trim() + "|" + (dateStr || "");
    if (seen.has(key)) return;
    seen.add(key);
    items.push({
      src: BASE_FLYER + sanitizeFlyerName(flyerName.trim()),
      label: label || "",
      dateStr: dateStr || "",
      isMusic: !!isMusic,
      isPoetry: !!isPoetry,
      isPast: !!isPast,
    });
  }

  const today = getTodayMidnight();

  // Tours — tour-level flyer(s) first, then per-date flyer(s).
  // getTourLevelFlyers()/getEventLevelFlyers() (shared_utils.js) each
  // resolve to a de-duplicated list; add() itself also dedupes by
  // flyerName+dateStr, so looping every flyer here is safe even if the
  // same filename somehow appears in both places.
  myTours.forEach(([, tour]) => {
    const dates = tour.tour_dates || [];
    const first = dates[0] ? parseDateString(dates[0].date) : null;
    const last = dates[dates.length - 1]
      ? parseDateString(dates[dates.length - 1].date)
      : null;
    const range =
      first && last && first.getTime() !== last.getTime()
        ? `${formatShortDate(first)} – ${formatShortDate(last)}`
        : first
          ? formatShortDate(first)
          : "";
    const allPast = last && last < today;
    getTourLevelFlyers(tour).forEach((f) => {
      add(
        f.filename,
        tour.tour_name || tour.name,
        range,
        tour.isMusic,
        allPast,
        tour.isPoetry,
      );
    });
    (tour.tour_dates || []).forEach((td) => {
      const d = parseDateString(td.date);
      getEventLevelFlyers(td).forEach((f) => {
        add(
          f.filename,
          tour.tour_name || tour.name,
          d ? formatShortDate(d) : td.date || "",
          tour.isMusic,
          d && d < today,
          tour.isPoetry,
        );
      });
    });
  });

  // Touring shows — show-level flyer, then per-date
  myTouringShows.forEach(([, ts]) => {
    const tsFlyer = ts.touring_event_flyer || ts.event_flyer;
    if (tsFlyer?.trim()) {
      add(tsFlyer, ts.showname || ts.name, "", false, false, false);
    }
    (ts.show_dates || []).forEach((sd) => {
      const d = parseDateString(sd.date);
      getEventLevelFlyers(sd).forEach((f) => {
        add(
          f.filename,
          ts.showname || ts.name,
          d ? formatShortDate(d) : sd.date || "",
          false,
          d && d < today,
          false,
        );
      });
    });
  });

  // Specific + music + poetry events
  allOther.forEach((e) => {
    const d = parseDateString(e.date);
    getEventLevelFlyers(e).forEach((f) => {
      add(
        f.filename,
        e.showname || e.name,
        d ? formatShortDate(d) : e.date || "",
        !!e.isMusic,
        d && d < today,
        !!e.isPoetry,
      );
    });
  });

  if (items.length === 0) return;

  // Store globally so lightbox can navigate
  perfGalleryItems = items;

  // Show the section
  const section = document.getElementById("perfGallerySection");
  section.style.display = "";
  document.getElementById("perfGalleryHint").textContent =
    `${items.length} flyer${items.length !== 1 ? "s" : ""} — click to expand`;

  // Build thumbnail cards
  const strip = document.getElementById("perfGalleryStrip");
  strip.innerHTML = "";

  items.forEach((item, idx) => {
    const card = document.createElement("div");
    card.className =
      "perf-gallery-card" +
      (item.isMusic ? " gc-music" : "") +
      (item.isPoetry ? " gc-poetry" : "") +
      (item.isPast ? " gc-past" : "");
    card.title = item.label + (item.dateStr ? " · " + item.dateStr : "");
    card.addEventListener("click", () => openPerfFlyer(perfGalleryItems, idx));

    const wrap = document.createElement("div");
    wrap.className = "perf-gallery-img-wrap";

    const img = document.createElement("img");
    img.dataset.pfSrc = item.src;
    img.alt = item.label;
    pfImgLoader.observe(img);
    wrap.appendChild(img);

    const badge = document.createElement("span");
    badge.className = "perf-gallery-type-badge";
    badge.textContent = item.isMusic
      ? "Music"
      : item.isPoetry
        ? "Poetry"
        : "Show";
    wrap.appendChild(badge);

    card.appendChild(wrap);

    const cap = document.createElement("div");
    cap.className = "perf-gallery-caption";

    const capTitle = document.createElement("div");
    capTitle.className = "perf-gallery-caption-title";
    capTitle.textContent = item.label;
    cap.appendChild(capTitle);

    const capDate = document.createElement("div");
    capDate.className = "perf-gallery-caption-date";
    capDate.textContent = item.dateStr || (item.isPast ? "Past" : "Upcoming");
    cap.appendChild(capDate);

    card.appendChild(cap);
    strip.appendChild(card);
  });

  // Lazy-load images when <details> is opened
  let observed = false;
  section.addEventListener("toggle", () => {
    if (section.open && !observed) {
      observed = true;
      strip
        .querySelectorAll("img[data-pf-src]")
        .forEach((img) => pfImgLoader.observe(img));
    }
  });
}

// ---------------------------------------------------------------------------
// Podcast section
// performer.podcast may be a single URL string or an array of URL strings
// (see events-schema.json → $defs.podcastUrls) — normalise to an array first,
// same as the .date / dateOrDates convention used elsewhere in this file.
//
// Each URL is treated as a podcast feed (or a podcast website to
// autodiscover a feed on) and actually fetched, so the section shows a
// real episode list rather than just a link — using the same
// fetch/autodiscover/parse machinery as the episode list in
// podcast-feed-curator.html (see podcast_utils.js). Each feed's
// episode list sits behind its own nested "Episodes" collapsible and
// is only fetched the first time that particular feed is expanded —
// opening the outer "Podcasts" section alone triggers no network
// calls, and a feed the user never expands is never fetched. Long
// episode/feed lists are paged behind "+N more" rather than dumped in
// all at once.
// ---------------------------------------------------------------------------

const PERF_PODCAST_FEEDS_VISIBLE = 4;
const PERF_PODCAST_EPISODES_VISIBLE = 5;
// Recognise a handful of common podcast-hosting domains so a feed card
// can show a friendly platform name before (or if) the real feed title
// loads. Anything else falls back to the bare hostname.
const PODCAST_PLATFORM_LABELS = {
  "open.spotify.com": "Spotify",
  "spotify.com": "Spotify",
  "podcasts.apple.com": "Apple Podcasts",
  "music.amazon.co.uk": "Amazon Music",
  "music.amazon.com": "Amazon Music",
  "soundcloud.com": "SoundCloud",
  "youtube.com": "YouTube",
  "youtu.be": "YouTube",
  "anchor.fm": "Anchor",
  "buzzsprout.com": "Buzzsprout",
  "podbean.com": "Podbean",
  "libsyn.com": "Libsyn",
  "audioboom.com": "Audioboom",
  "acast.com": "Acast",
  "podomatic.com": "Podomatic",
  "captivate.fm": "Captivate",
  "transistor.fm": "Transistor",
};

function normalisePodcastUrls(podcast) {
  const raw = Array.isArray(podcast) ? podcast : podcast ? [podcast] : [];
  const seen = new Set();
  const out = [];
  raw.forEach((u) => {
    if (typeof u !== "string") return;
    const trimmed = u.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  });
  return out;
}

function podcastLinkLabel(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (PODCAST_PLATFORM_LABELS[host]) return PODCAST_PLATFORM_LABELS[host];
    const knownSuffix = Object.keys(PODCAST_PLATFORM_LABELS).find((h) =>
      host.endsWith("." + h),
    );
    return knownSuffix ? PODCAST_PLATFORM_LABELS[knownSuffix] : host;
  } catch (e) {
    return "Podcast";
  }
}

// Toggle an inline audio preview for one episode/appearance row. Mirrors
// the "▶ Preview" behaviour in podcast-feed-curator.html, including the
// CORS-proxy retry, and closes any other open preview first so only one
// plays at a time. The audio's `src` is only ever set here — nothing
// fetches or preloads it until the user actually clicks play.
function togglePodcastAudioPreview(
  row,
  audioUrl,
  btn,
  labelPlaying = "▶ Preview",
) {
  const existing = row.querySelector(".perf-podcast-episode-audio");
  if (existing) {
    existing.remove();
    btn.textContent = labelPlaying;
    return;
  }
  document
    .querySelectorAll(".perf-podcast-episode-audio")
    .forEach((h) => h.remove());
  document
    .querySelectorAll(".perf-podcast-episode-preview-btn")
    .forEach((b) => {
      b.textContent = b.dataset.playLabel || "▶ Preview";
    });

  const holder = document.createElement("div");
  holder.className = "perf-podcast-episode-audio";
  const audio = document.createElement("audio");
  audio.controls = true;
  audio.autoplay = true;
  audio.src = audioUrl;
  audio.addEventListener("error", () => {
    if (audio.dataset.retried) return;
    audio.dataset.retried = "1";
    audio.src = proxiedPodcastUrl(audioUrl);
  });
  holder.appendChild(audio);
  row.appendChild(holder);
  btn.textContent = "■ Close";
}

// Build one feed card: header (icon/artwork + title + "Open ↗" link)
// plus a nested, collapsed-by-default "Episodes" panel. Returns
// {el, load} — load() fetches the feed (populating the real title/
// artwork and pre-building the episode list) and is called by
// renderPodcastSection as soon as the outer "Podcasts" section is
// opened, so a visitor sees real feed info without an extra click.
// The nested Episodes panel itself is just a plain CSS-collapsed
// <details> at that point — opening it doesn't trigger any further
// fetch, since the data's already in hand.
function createPodcastFeedCard(url) {
  const card = document.createElement("div");
  card.className = "perf-podcast-feed";

  const header = document.createElement("div");
  header.className = "perf-podcast-feed-header";

  const icon = document.createElement("div");
  icon.className = "perf-podcast-feed-icon";
  icon.textContent = "🎙";
  header.appendChild(icon);

  const headerBody = document.createElement("div");
  headerBody.className = "perf-podcast-feed-header-body";

  const title = document.createElement("div");
  title.className = "perf-podcast-feed-title";
  title.textContent = podcastLinkLabel(url);
  headerBody.appendChild(title);

  const sub = document.createElement("div");
  sub.className = "perf-podcast-feed-sub";
  sub.textContent = "Loading feed…";
  headerBody.appendChild(sub);

  header.appendChild(headerBody);

  const openLink = createExternalLink(url, "Open ↗", {
    className: "perf-podcast-feed-open",
  });
  if (openLink) header.appendChild(openLink);

  card.appendChild(header);

  // Nested "Episodes" panel — collapsed by default, populated
  // eagerly by load() below, but only actually revealed when the
  // visitor clicks it open.
  const episodesDetails = document.createElement("details");
  episodesDetails.className = "perf-podcast-episodes-details";

  const episodesSummary = document.createElement("summary");
  episodesSummary.className = "perf-podcast-episodes-summary";

  const episodesLabel = document.createElement("span");
  episodesLabel.textContent = "Episodes";
  episodesSummary.appendChild(episodesLabel);

  const episodesHint = document.createElement("span");
  episodesHint.className = "perf-podcast-episodes-hint";
  episodesHint.textContent = "loading…";
  episodesSummary.appendChild(episodesHint);

  episodesDetails.appendChild(episodesSummary);

  const episodesBody = document.createElement("div");
  episodesBody.className = "perf-podcast-episodes-body";
  episodesDetails.appendChild(episodesBody);

  card.appendChild(episodesDetails);

  function addEpisode(episodeList, episode) {
    const row = document.createElement("div");
    row.className = "perf-podcast-episode";

    const top = document.createElement("div");
    top.className = "perf-podcast-episode-row";

    const epBody = document.createElement("div");
    epBody.className = "perf-podcast-episode-body";

    const epTitle = document.createElement("div");
    epTitle.className = "perf-podcast-episode-title";
    epTitle.textContent = episode.title;
    epBody.appendChild(epTitle);

    const metaParts = [];
    if (episode.pubDate) metaParts.push(formatPodcastDate(episode.pubDate));
    if (episode.duration)
      metaParts.push(formatPodcastDuration(episode.duration));
    if (metaParts.length > 0) {
      const epMeta = document.createElement("div");
      epMeta.className = "perf-podcast-episode-meta";
      epMeta.textContent = metaParts.join(" · ");
      epBody.appendChild(epMeta);
    }

    top.appendChild(epBody);

    if (episode.enclosureUrl) {
      const previewBtn = document.createElement("button");
      previewBtn.type = "button";
      previewBtn.className = "perf-podcast-episode-preview-btn";
      previewBtn.textContent = "▶ Preview";
      previewBtn.addEventListener("click", () =>
        togglePodcastAudioPreview(row, episode.enclosureUrl, previewBtn),
      );
      top.appendChild(previewBtn);
    }

    row.appendChild(top);
    episodeList.appendChild(row);
  }

  async function load() {
    let result;
    try {
      result = await loadPodcastFeed(url);
    } catch (e) {
      sub.textContent = "Couldn't load this feed — try the link above.";
      sub.classList.add("is-error");
      episodesHint.textContent = "unavailable";
      return;
    }
    const { feed, items } = result;

    if (feed.title) title.textContent = feed.title;
    if (feed.image) {
      const img = document.createElement("img");
      img.className = "perf-podcast-feed-thumb";
      img.src = feed.image;
      img.alt = "";
      icon.replaceWith(img);
    }
    sub.textContent = `${items.length} episode${items.length !== 1 ? "s" : ""}`;

    if (items.length === 0) {
      episodesHint.textContent = "no episodes";
      const empty = document.createElement("div");
      empty.className = "perf-podcast-feed-status";
      empty.textContent = "No episodes listed in this feed.";
      episodesBody.appendChild(empty);
      return;
    }

    episodesHint.textContent = `${items.length} episode${items.length !== 1 ? "s" : ""}`;

    const episodeList = document.createElement("div");
    episodeList.className = "perf-podcast-episode-list";
    episodesBody.appendChild(episodeList);

    const visible = items.slice(0, PERF_PODCAST_EPISODES_VISIBLE);
    const rest = items.slice(PERF_PODCAST_EPISODES_VISIBLE);
    visible.forEach((ep) => addEpisode(episodeList, ep));

    if (rest.length > 0) {
      const moreBtn = document.createElement("button");
      moreBtn.type = "button";
      moreBtn.className = "perf-podcast-more";
      moreBtn.textContent = `+${rest.length} more episode${rest.length !== 1 ? "s" : ""}`;
      moreBtn.addEventListener("click", () => {
        rest.forEach((ep) => addEpisode(episodeList, ep));
        moreBtn.remove();
      });
      episodesBody.appendChild(moreBtn);
    }
  }

  return { el: card, load };
}

function renderPodcastSection(performer) {
  const urls = normalisePodcastUrls(performer.podcast);
  const section = document.getElementById("perfPodcastSection");
  if (urls.length === 0) {
    section.style.display = "none";
    return;
  }

  section.style.display = "";
  document.getElementById("perfPodcastHint").textContent =
    `${urls.length} podcast${urls.length !== 1 ? "s" : ""} — click to expand`;

  const list = document.getElementById("perfPodcastList");
  list.innerHTML = "";

  // Feed data (title, artwork, episode list) is fetched as soon as
  // the outer "Podcasts" section is opened — not before, so nothing
  // loads for a performer whose podcast section a visitor never
  // opens — but without waiting for a further click per feed, so
  // the card shows real info rather than just a bare URL.
  let opened = false;
  const pendingLoads = [];

  function addFeed(url) {
    const { el, load } = createPodcastFeedCard(url);
    list.appendChild(el);
    if (opened) load();
    else pendingLoads.push(load);
  }

  const visible = urls.slice(0, PERF_PODCAST_FEEDS_VISIBLE);
  const rest = urls.slice(PERF_PODCAST_FEEDS_VISIBLE);
  visible.forEach(addFeed);

  if (rest.length > 0) {
    const moreBtn = document.createElement("button");
    moreBtn.type = "button";
    moreBtn.className = "perf-podcast-more";
    moreBtn.textContent = `+${rest.length} more podcast${rest.length !== 1 ? "s" : ""}`;
    moreBtn.addEventListener("click", () => {
      rest.forEach(addFeed);
      moreBtn.remove();
    });
    list.appendChild(moreBtn);
  }

  section.addEventListener("toggle", () => {
    if (section.open && !opened) {
      opened = true;
      pendingLoads.forEach((load) => load());
      pendingLoads.length = 0;
    }
  });
}

// ---------------------------------------------------------------------------
// Podcast Appearances section
// performer.podcast_appearances (see events-schema.json →
// $defs.podcastAppearance) lists one-off guest spots on OTHER
// people's podcasts — as opposed to performer.podcast, which is a
// podcast the performer runs themself. Each entry either references
// a series in the top-level `podcasts` registry via podcast_id, or
// gives the podcast name/url inline. Unlike the feed section above,
// no fetching or autodiscovery is needed for the list itself (the
// episode name + audio link are already in the data) — the only
// network request possible here is the episode audio itself, and
// that's only requested if/when the visitor presses ▶ Preview.
// ---------------------------------------------------------------------------

// resolvePodcastAppearanceMeta(), collectPerformerAppearances(), and
// extractYoutubeId()/collectPerformerVideoAppearances() are defined in
// shared_utils.js (also used by media.js) — see that file's "Podcast/video
// appearance resolution" section.

function renderPodcastAppearancesSection(performer) {
  const appearances = collectPerformerAppearances(
    performer,
    performerId,
    podcastsLookup,
  );
  const section = document.getElementById("perfPodcastAppearancesSection");
  if (appearances.length === 0) {
    section.style.display = "none";
    return;
  }

  section.style.display = "";
  document.getElementById("perfPodcastAppearancesHint").textContent =
    `${appearances.length} appearance${appearances.length !== 1 ? "s" : ""} — click to expand`;

  const list = document.getElementById("perfPodcastAppearancesList");
  list.innerHTML = "";

  // Reuse the same card chrome as a podcast feed card, just without
  // its header, so appearances visually match the feeds above.
  const card = document.createElement("div");
  card.className = "perf-podcast-feed";
  const episodeList = document.createElement("div");
  episodeList.className = "perf-podcast-episode-list";
  card.appendChild(episodeList);
  list.appendChild(card);

  function addAppearance(appearance) {
    const row = document.createElement("div");
    row.className = "perf-podcast-episode";

    const top = document.createElement("div");
    top.className = "perf-podcast-episode-row";

    const body = document.createElement("div");
    body.className = "perf-podcast-episode-body";

    const title = document.createElement("div");
    title.className = "perf-podcast-episode-title";
    title.textContent = appearance.episode_name;
    body.appendChild(title);

    const meta = resolvePodcastAppearanceMeta(appearance, podcastsLookup);
    if (meta.name) {
      const metaLine = document.createElement("div");
      metaLine.className = "perf-podcast-episode-meta";
      const metaLink = meta.url
        ? createExternalLink(meta.url, meta.name, {})
        : null;
      metaLine.appendChild(metaLink || document.createTextNode(meta.name));
      body.appendChild(metaLine);
    }
    // Format badge (e.g. "interview", "telling") — same badge style used
    // in the Videos section, kept separate from the name/link above so
    // the link stays a clean click target.
    if (meta.format) {
      const badges = document.createElement("div");
      badges.className = "perf-video-badges";
      const formatBadge = document.createElement("span");
      formatBadge.className = "perf-video-format-badge";
      formatBadge.textContent = meta.format;
      badges.appendChild(formatBadge);
      body.appendChild(badges);
    }

    top.appendChild(body);

    if (appearance.audio_url) {
      const previewBtn = document.createElement("button");
      previewBtn.type = "button";
      previewBtn.className = "perf-podcast-episode-preview-btn";
      previewBtn.textContent = "▶ Play";
      previewBtn.dataset.playLabel = "▶ Play";
      previewBtn.addEventListener("click", () =>
        togglePodcastAudioPreview(
          row,
          appearance.audio_url,
          previewBtn,
          "▶ Play",
        ),
      );
      top.appendChild(previewBtn);
    }

    row.appendChild(top);
    episodeList.appendChild(row);
  }

  const visible = appearances.slice(0, PERF_PODCAST_EPISODES_VISIBLE);
  const rest = appearances.slice(PERF_PODCAST_EPISODES_VISIBLE);
  visible.forEach(addAppearance);

  if (rest.length > 0) {
    const moreBtn = document.createElement("button");
    moreBtn.type = "button";
    moreBtn.className = "perf-podcast-more";
    moreBtn.textContent = `+${rest.length} more`;
    moreBtn.addEventListener("click", () => {
      rest.forEach(addAppearance);
      moreBtn.remove();
    });
    card.appendChild(moreBtn);
  }
}

// ---------------------------------------------------------------------------
// Videos section
// Two sources are merged here:
//   1. Registry-sourced — episode items (in the top-level `podcasts`
//      registry, see events-schema.json → $defs.podcast / $defs.podcastEpisode)
//      tagged with this performer's id via performer_id/performer_ids,
//      whose item carries a yt_url. This is the preferred home for a
//      video going forward (e.g. World Storytelling Cafe, Taking the
//      Tradition On), since it also captures the series name/presenter
//      and lets one series' videos be reused across every performer
//      it features.
//   2. Legacy inline — performer.youtube_videos (see events-schema.json
//      → $defs.youtubeVideo), each labelled with a story/piece name
//      rather than necessarily the video's own YouTube title. Kept for
//      performers not yet migrated into the podcasts registry.
// Each video gets its own nested collapsible (not just a play button,
// per the brief) — its embed is only created the first time THAT
// video's collapsible is opened, and is torn down again (stopping
// playback) if it's closed, so nothing ever loads for a video a
// visitor never expands.
// ---------------------------------------------------------------------------

// extractYoutubeId() and collectPerformerVideoAppearances() are defined in
// shared_utils.js (also used by media.js).

// ---------------------------------------------------------------------------
// Collaborators
// Other performers who shared an actual performance with this one — the
// same tour_dates/show_dates/specific-event entry, not just the same
// festival lineup (a festival bill lists several unrelated acts on the
// same day, which isn't "performing together" in the sense meant here —
// see renderPerformer(), which deliberately doesn't feed myFestivals into
// this). A shared credit shows up either as an explicit performer_ids[]
// array on the record (e.g. a tour billed as "Daniel Morden & Hugh
// Lupton"), or as a compound/troupe performer_id that includes this
// performer among its declared members (e.g. viewing Gillian Brownson's
// page, whose tour is billed under the joint id
// "gillian-brownson-dragon-storytellers"). Deliberately excludes the case
// where record.performer_id === performerId itself: that's just this
// performer's (or, when viewing a troupe's own page, the troupe's own)
// ordinary billing, already shown in the page header/member chips above —
// not a collaboration with someone else.
// ---------------------------------------------------------------------------

function collectCollaborators(records) {
  const map = new Map(); // collaboratorId -> Set of shared show/tour names

  records.forEach(({ record, displayName }) => {
    const castIds = new Set();

    if (
      Array.isArray(record.performer_ids) &&
      record.performer_ids.includes(performerId)
    ) {
      record.performer_ids.forEach((id) => castIds.add(id));
    }

    if (
      record.performer_id &&
      record.performer_id !== performerId &&
      compoundIdsForMe.has(record.performer_id)
    ) {
      const compound = performersLookup[record.performer_id];
      const compoundMembers = compound?.performer_ids || compound?.ids || [];
      compoundMembers.forEach((id) => castIds.add(id));
    }

    castIds.forEach((id) => {
      if (id === performerId) return;
      if (!map.has(id)) map.set(id, new Set());
      if (displayName) map.get(id).add(displayName);
    });
  });

  return map;
}

/**
 * @param {Map<string, Set<string>>} collaborators - id -> shared show/tour names
 */
function renderCollaboratorsSection(collaborators) {
  const section = document.getElementById("perfCollaboratorsSection");
  const ids = [...collaborators.keys()]
    .filter((id) => performersLookup[id])
    .sort((a, b) =>
      (performersLookup[a]?.name || a).localeCompare(
        performersLookup[b]?.name || b,
      ),
    );

  if (ids.length === 0) {
    section.style.display = "none";
    return;
  }

  section.style.display = "";
  document.getElementById("perfCollaboratorsHint").textContent =
    `${ids.length} collaborator${ids.length !== 1 ? "s" : ""} — click to expand`;

  const list = document.getElementById("perfCollaboratorsList");
  list.innerHTML = "";

  ids.forEach((id) => {
    const p = performersLookup[id];
    const showNames = [...(collaborators.get(id) || [])].filter(Boolean);

    const row = document.createElement("div");
    row.className = "perf-collaborator-row";

    const nameLine = document.createElement("div");
    nameLine.className = "perf-collaborator-name-line";

    const a = document.createElement("a");
    a.href = `new_troubadours_performers.html?performer=${encodeURIComponent(id)}`;
    a.className = "perf-collaborator-name";
    a.textContent = p.name;
    nameLine.appendChild(a);

    // Musician/Poet badges — same convention as the page-header badges
    // (see renderPerformer()), checking declared members too in case the
    // collaborator is itself a compound/troupe entry.
    const members = p.performer_ids || p.ids || [];
    const isMusicianCollab =
      p.musician === true ||
      members.some((mid) => performersLookup[mid]?.musician === true);
    const isPoetCollab =
      p.poet === true ||
      members.some((mid) => performersLookup[mid]?.poet === true);
    if (isMusicianCollab) {
      const badge = document.createElement("span");
      badge.className = "performer-badge performer-badge-musician";
      badge.textContent = "🎵 Musician";
      nameLine.appendChild(badge);
    }
    if (isPoetCollab) {
      const badge = document.createElement("span");
      badge.className = "performer-badge performer-badge-poet";
      badge.textContent = "✒️ Poet";
      nameLine.appendChild(badge);
    }
    row.appendChild(nameLine);

    if (showNames.length > 0) {
      const meta = document.createElement("div");
      meta.className = "perf-collaborator-meta";
      meta.textContent = showNames.join(", ");
      row.appendChild(meta);
    }

    list.appendChild(row);
  });
}

function renderVideosSection(performer) {

  const videos = collectPerformerVideoAppearances(
    performer,
    performerId,
    podcastsLookup,
  );
  const section = document.getElementById("perfVideosSection");
  if (videos.length === 0) {
    section.style.display = "none";
    return;
  }

  section.style.display = "";
  document.getElementById("perfVideosHint").textContent =
    `${videos.length} video${videos.length !== 1 ? "s" : ""} — click to expand`;

  const list = document.getElementById("perfVideosList");
  list.innerHTML = "";

  // Reuse the same card chrome as a podcast feed card, just without
  // its header, so this list visually matches the sections above.
  const card = document.createElement("div");
  card.className = "perf-podcast-feed";
  list.appendChild(card);

  videos.forEach((video) => {
    const videoId = extractYoutubeId(video.yt_url);

    const details = document.createElement("details");
    details.className = "perf-podcast-episodes-details";

    const summary = document.createElement("summary");
    summary.className = "perf-podcast-episodes-summary";

    // Reuse .perf-podcast-episode-body's flex:1/min-width:0 so the title
    // (and, for registry-sourced videos, a series subtitle beneath it)
    // takes the available space, pushing the hint to the right edge —
    // matching the appearances list's title+meta layout.
    const textCol = document.createElement("div");
    textCol.className = "perf-podcast-episode-body";

    const label = document.createElement("div");
    label.textContent = video.story_name || "Untitled video";
    textCol.appendChild(label);

    if (video.source || video.format) {
      const badges = document.createElement("div");
      badges.className = "perf-video-badges";
      if (video.source) {
        const sourceBadge = document.createElement("span");
        sourceBadge.className = "perf-video-source-badge";
        sourceBadge.textContent = video.source;
        badges.appendChild(sourceBadge);
      }
      if (video.format) {
        const formatBadge = document.createElement("span");
        formatBadge.className = "perf-video-format-badge";
        formatBadge.textContent = video.format;
        badges.appendChild(formatBadge);
      }
      textCol.appendChild(badges);
    }

    summary.appendChild(textCol);

    const hint = document.createElement("span");
    hint.className = "perf-podcast-episodes-hint";
    hint.textContent = "▶ click to play";
    summary.appendChild(hint);

    details.appendChild(summary);

    const body = document.createElement("div");
    body.className = "perf-podcast-episodes-body";
    details.appendChild(body);

    details.addEventListener("toggle", () => {
      if (details.open) {
        hint.textContent = "playing";
        const frame = document.createElement("div");
        frame.className = "perf-video-frame";
        const iframe = document.createElement("iframe");
        // `origin` matters here, not just as good practice — without it,
        // the postMessage handshake YouTube's embed uses to sync its UI
        // can fail, which is what leaves the pause/play icon stuck in the
        // centre of the view even though the video is actually playing.
        const embedOrigin = encodeURIComponent(window.location.origin);
        iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?autoplay=1&playsinline=1&rel=0&enablejsapi=1&origin=${embedOrigin}`;
        iframe.title = video.story_name || "YouTube video";
        iframe.allow =
          "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture";
        iframe.allowFullscreen = true;
        iframe.loading = "lazy";
        frame.appendChild(iframe);
        body.appendChild(frame);
      } else {
        hint.textContent = "▶ click to play";
        body.innerHTML = ""; // tears down the iframe, stopping playback
      }
    });

    card.appendChild(details);
  });
}

// ---------------------------------------------------------------------------
// Troupe config sub-sections
// Shown at the bottom of a troupe's performer page.
// Each alias (e.g. tis-tales-hsf) gets its own collapsible block listing
// its events, so that the specific lineup is visible without cluttering
// the main performer listing.
// ---------------------------------------------------------------------------

function renderTroupeConfigs(troupe) {
  const aliases = troupe.aliases || [];
  if (aliases.length === 0) return;

  const configs = aliases
    .map((aid) => [aid, performersLookup[aid]])
    .filter(([, p]) => p); // only render configs that exist in data

  if (configs.length === 0) return;

  // Wrapper section
  const section = document.createElement("div");
  section.className = "content-section";
  section.style.marginTop = "20px";

  const heading = document.createElement("h3");
  heading.className = "section-heading";
  heading.textContent = "Lineup configurations";
  section.appendChild(heading);

  configs.forEach(([configId, config]) => {
    // Gather events for this specific config ID
    const configTours = Object.entries(toursLookup).filter(
      ([, t]) =>
        t.performer_id === configId ||
        (Array.isArray(t.performer_ids) && t.performer_ids.includes(configId)),
    );
    const configShows = Object.entries(
      eventsData.repertoire_shows || {},
    ).filter(([, ts]) => ts.performer_id === configId);
    const configSpecific = (eventsData.specificEvents || []).filter(
      (e) => e.performer_id === configId,
    );
    const configMusic = (eventsData.musicEvents || []).filter(
      (e) => e.performer_id === configId,
    );
    const configPoetry = (eventsData.poetryEvents || []).filter(
      (e) => e.performer_id === configId,
    );

    const totalDates =
      configTours.reduce((s, [, t]) => s + (t.tour_dates || []).length, 0) +
      configShows.reduce((s, [, ts]) => s + (ts.show_dates || []).length, 0) +
      configSpecific.length +
      configMusic.length +
      configPoetry.length;

    // Collapsible card for this config
    const details = document.createElement("details");
    details.className = "troupe-config-details";

    const summary = document.createElement("summary");
    summary.className = "troupe-config-summary";

    const summaryLabel = document.createElement("span");
    summaryLabel.className = "troupe-config-label";
    summaryLabel.textContent = config.name;
    summary.appendChild(summaryLabel);

    if (totalDates > 0) {
      const badge = document.createElement("span");
      badge.className = "troupe-config-badge";
      badge.textContent = `${totalDates} date${totalDates !== 1 ? "s" : ""}`;
      summary.appendChild(badge);
    }

    details.appendChild(summary);

    const body = document.createElement("div");
    body.className = "troupe-config-body";

    // Member chips for this lineup
    const configMembers = config.performer_ids || config.ids || [];
    if (configMembers.length > 0) {
      const chipsDiv = document.createElement("div");
      chipsDiv.className = "performer-member-chips troupe-config-chips";
      configMembers.forEach((mid) => {
        const m = performersLookup[mid];
        if (!m) return;
        const chip = document.createElement("a");
        chip.href = `new_troubadours_performers.html?performer=${encodeURIComponent(mid)}`;
        chip.className = "performer-member-chip";
        const initials = m.name
          .split(/\s+/)
          .filter(Boolean)
          .map((w) => w[0].toUpperCase())
          .slice(0, 2)
          .join("");
        const av = document.createElement("span");
        av.className = "chip-avatar";
        av.textContent = initials;
        chip.appendChild(av);
        chip.appendChild(document.createTextNode(m.name));
        chipsDiv.appendChild(chip);
      });
      body.appendChild(chipsDiv);
    }

    if (totalDates === 0) {
      const none = document.createElement("p");
      none.style.cssText =
        "font-size:13px;color:#999;font-style:italic;margin-top:10px";
      none.textContent = "No events listed for this lineup.";
      body.appendChild(none);
    } else {
      // Tours
      configTours.forEach(([tid, tour]) => renderTourCard(body, tid, tour));
      // Touring shows
      configShows.forEach(([tsId, ts]) =>
        renderTouringShowCard(body, tsId, ts),
      );
      // Other events
      const otherEvents = [
        ...configSpecific,
        ...configMusic,
        ...configPoetry,
      ].sort((a, b) => {
        const da = parseDateString(a.date),
          db = parseDateString(b.date);
        if (!da && !db) return 0;
        if (!da) return 1;
        if (!db) return -1;
        return da - db;
      });
      if (otherEvents.length > 0) {
        const evtList = document.createElement("div");
        otherEvents.forEach((e) => renderEventRow(evtList, e));
        body.appendChild(evtList);
      }
    }

    details.appendChild(body);
    section.appendChild(details);
  });

  document.getElementById("performerContent").appendChild(section);
}

// ---------------------------------------------------------------------------
// Tour/repertoire "history" — full past-date detail
// The stats badges only ever gave a *count* of past dates, with no way to
// see which venues/when — everything actually visible elsewhere on the
// page (the Other Appearances list) shows real detail even for past
// events. These two helpers flatten one tour_dates/show_dates entry into
// the same flat-event shape renderEventRow() expects (a lighter version of
// what buildTourMergedEvent()/buildShowMergedEvent() do for the calendar
// in event_display.js, which isn't loaded on this page), so the past-dates
// collapsible added in renderTourCard()/renderTouringShowCard() below can
// reuse that renderer — and its date/venue/badge/flyer handling — as-is.
// ---------------------------------------------------------------------------

function tourDateToEventRow(tour, td) {
  return {
    name: tour.tour_name || tour.name,
    showname: tour.name,
    date: td.date,
    time: td.time || tour.time || null,
    venue_id: td.venue_id,
    performer_id: tour.performer_id,
    isMusic: tour.isMusic,
    isPoetry: tour.isPoetry,
    isSpecial: tour.isSpecial,
    ticket_url: td.ticket_url,
    // First of this date's own flyer(s), falling back to the tour's —
    // getEventLevelFlyers()/getTourLevelFlyers() (shared_utils.js) apply
    // the full event_flyer/event_flyer2/event_flyers and
    // tour_flyer/touring_event_flyer/touring_event_flyers precedence;
    // renderEventRow() only shows one flyer button per row, so just the
    // first is used here.
    event_flyer:
      getEventLevelFlyers(td)[0]?.filename ||
      getTourLevelFlyers(tour)[0]?.filename ||
      null,
  };
}

function showDateToEventRow(show, sd) {
  return {
    name: show.name,
    showname: show.showname || show.name,
    date: sd.date,
    time: sd.time || null,
    venue_id: sd.venue_id,
    performer_id: show.performer_id,
    isSpecial: show.isSpecial,
    ticket_url: sd.ticket_url,
    event_flyer:
      getEventLevelFlyers(sd)[0]?.filename ||
      show.touring_event_flyer ||
      null,
  };
}

function sortByDate(a, b) {
  const da = parseDateString(a.date),
    db = parseDateString(b.date);
  if (!da && !db) return 0;
  if (!da) return 1;
  if (!db) return -1;
  return da - db;
}

/**
 * Appends a "Past dates (N)" collapsible to `card`, listing every entry in
 * `pastDates` (oldest first) via renderEventRow(), using `toEventRow` to
 * flatten each date entry first. No-op if there are no past dates.
 * @param {HTMLElement} card
 * @param {object[]} pastDates
 * @param {(dateEntry: object) => object} toEventRow
 */
/**
 * Appends a "{titlePrefix} (N)" collapsible to `card`, listing every entry
 * in `dateEntries` (chronological order) via renderEventRow(), using
 * `toEventRow` to flatten each date entry first. No-op if there are no
 * entries. Used for both the Upcoming dates (open by default, so nothing
 * currently visible becomes an extra click) and Past dates (closed by
 * default) sections on tour/repertoire cards — previously Upcoming was a
 * row of button-styled pips while Past was a dropdown; this makes both
 * behave the same way.
 * @param {HTMLElement} card
 * @param {object[]} dateEntries
 * @param {(dateEntry: object) => object} toEventRow
 * @param {{ titlePrefix: string, defaultOpen?: boolean }} options
 */
function renderDateCollapsible(
  card,
  dateEntries,
  toEventRow,
  { titlePrefix, defaultOpen = false, sortDescending = false },
) {
  if (dateEntries.length === 0) return;

  const details = document.createElement("details");
  details.className = "tour-history-details";
  if (defaultOpen) details.open = true;

  const summary = document.createElement("summary");
  summary.className = "tour-history-summary";
  summary.textContent = `${titlePrefix} (${dateEntries.length})`;
  const hint = document.createElement("span");
  hint.className = "tour-history-hint";
  hint.textContent = defaultOpen ? "click to collapse" : "click to expand";
  summary.appendChild(hint);
  details.appendChild(summary);

  const list = document.createElement("div");
  list.className = "tour-history-list";
  // Upcoming dates read soonest-first (ascending); past dates read most-
  // recent-first (descending) — reverse chronological, so the thing that
  // just happened is at the top rather than buried below years-old dates.
  [...dateEntries]
    .sort(sortDescending ? (a, b) => sortByDate(b, a) : sortByDate)
    .forEach((d) => renderEventRow(list, toEventRow(d)));
  details.appendChild(list);

  card.appendChild(details);
}

// ---------------------------------------------------------------------------
// Tour card
// ---------------------------------------------------------------------------

// How much of the first paragraph to show before collapsing behind a
// "more…" toggle — see the Description block in renderTourCard().
const TOUR_CARD_DESC_PREVIEW_LENGTH = 200;

function renderTourCard(container, tourId, tour) {
  const today = getTodayMidnight();
  const dates = tour.tour_dates || [];

  const futureDates = dates.filter((d) => {
    const parsed = parseDateString(d.date);
    return parsed && parsed >= today;
  });
  const pastDates = dates.filter((d) => {
    const parsed = parseDateString(d.date);
    return parsed && parsed < today;
  });

  const firstDate = dates[0] ? parseDateString(dates[0].date) : null;
  const lastDate = dates[dates.length - 1]
    ? parseDateString(dates[dates.length - 1].date)
    : null;

  const isMusic = tour.isMusic;
  const isPoetry = tour.isPoetry;
  const card = document.createElement("div");
  card.className = `tour-card${isMusic ? " tour-card-music" : ""}${isPoetry ? " tour-card-poetry" : ""}`;

  // Flyer thumbnail (floated right) — first of the tour's flyers, via
  // getTourLevelFlyers() (shared_utils.js), which covers
  // tour_flyer/touring_event_flyer/touring_event_flyers.
  const tourCardFlyer = getTourLevelFlyers(tour)[0]?.filename;
  if (tourCardFlyer) {
    card.appendChild(
      makePerfFlyerThumb(tourCardFlyer, tour.tour_name || tour.name),
    );
  }

  // Header row
  const header = document.createElement("div");
  header.className = "tour-card-header";

  const nameEl = document.createElement("div");
  nameEl.className = "tour-card-name";
  nameEl.textContent = tour.tour_name || tour.name;
  header.appendChild(nameEl);

  // Badge: remaining dates
  if (futureDates.length > 0) {
    const badge = document.createElement("span");
    badge.className = "tour-remaining-badge";
    badge.textContent = `${futureDates.length} date${futureDates.length !== 1 ? "s" : ""} remaining`;
    header.appendChild(badge);
  } else {
    const badge = document.createElement("span");
    badge.className = "tour-completed-badge";
    badge.textContent =
      pastDates.length > 0
        ? `Completed (${pastDates.length} date${pastDates.length !== 1 ? "s" : ""})`
        : "Completed";
    header.appendChild(badge);
  }

  card.appendChild(header);

  // Co-performers line — shown when this tour has multiple performers
  // and we are viewing it from one of their individual pages
  if (Array.isArray(tour.performer_ids) && tour.performer_ids.length > 1) {
    const coPerformers = tour.performer_ids
      .filter((id) => id !== performerId)
      .map((id) => {
        const p = performersLookup[id];
        if (!p) return null;
        const a = document.createElement("a");
        a.href = `new_troubadours_performers.html?performer=${encodeURIComponent(id)}`;
        a.textContent = p.name;
        a.className = "tour-view-link";
        a.onclick = (e) => e.stopPropagation();
        return a;
      })
      .filter(Boolean);
    if (coPerformers.length > 0) {
      const coDiv = document.createElement("div");
      coDiv.className = "tour-card-meta";
      coDiv.appendChild(document.createTextNode("with "));
      coPerformers.forEach((a, i) => {
        if (i > 0) coDiv.appendChild(document.createTextNode(" & "));
        coDiv.appendChild(a);
      });
      card.appendChild(coDiv);
    }
  }

  // Description — collapsed by default (first paragraph, capped at
  // TOUR_CARD_DESC_PREVIEW_LENGTH chars), with a "more…" toggle that swaps
  // in the complete, multi-paragraph description in place. Unlike the
  // Repertoire cards below (which always show everything, since the show
  // is the primary thing there and there's no separate detail page to
  // link out to), a tour card is a preview linking to the full tour page
  // — but tour_description text inherited from a repertoire show (see
  // applyRepertoireInheritance() in shared_utils.js) can run much longer
  // than the old hand-written tour blurbs, so it's worth letting people
  // read the whole thing here too without having to leave the page.
  if (tour.tour_description) {
    const paras = tour.tour_description
      .split("\n\n\n\n")
      .map((p) => p.replace(/\n\n/g, " ").trim())
      .filter(Boolean);
    const firstPara = paras[0] || "";
    const isTruncated = firstPara.length > TOUR_CARD_DESC_PREVIEW_LENGTH;
    const hasMore = isTruncated || paras.length > 1;

    const desc = document.createElement("div");
    desc.className = "tour-card-desc";

    const previewP = document.createElement("p");
    previewP.textContent = isTruncated
      ? firstPara.slice(0, TOUR_CARD_DESC_PREVIEW_LENGTH - 1).trimEnd() + "…"
      : firstPara;
    desc.appendChild(previewP);

    if (hasMore) {
      const fullWrap = document.createElement("div");
      fullWrap.className = "tour-card-desc-full";
      fullWrap.style.display = "none";
      paras.forEach((p) => {
        const el = document.createElement("p");
        el.textContent = p;
        fullWrap.appendChild(el);
      });
      desc.appendChild(fullWrap);

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "tour-card-desc-toggle";
      toggle.textContent = "more…";
      toggle.onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        const isOpen = fullWrap.style.display !== "none";
        fullWrap.style.display = isOpen ? "none" : "block";
        previewP.style.display = isOpen ? "" : "none";
        toggle.textContent = isOpen ? "more…" : "less";
      };
      desc.appendChild(toggle);
    }

    card.appendChild(desc);
  }

  // Date range + count
  if (firstDate && lastDate) {
    const meta = document.createElement("div");
    meta.className = "tour-card-meta";
    meta.textContent = `${formatShortDate(firstDate)} – ${formatShortDate(lastDate)} · ${dates.length} date${dates.length !== 1 ? "s" : ""}`;
    card.appendChild(meta);
  }

  // Upcoming and past dates — both as collapsibles (upcoming open by
  // default so nothing currently visible needs an extra click; past
  // closed by default). See renderDateCollapsible().
  const toEventRow = (td) => tourDateToEventRow(tour, td);
  renderDateCollapsible(card, futureDates, toEventRow, {
    titlePrefix: "Upcoming dates",
    defaultOpen: true,
  });
  renderDateCollapsible(card, pastDates, toEventRow, {
    titlePrefix: "Past dates",
    sortDescending: true,
  });

  // View tour link
  const footer = document.createElement("div");
  footer.className = "tour-card-footer";
  const viewLink = document.createElement("a");
  viewLink.href = `new_troubadours_tour_guide.html?tour=${encodeURIComponent(tourId)}`;
  viewLink.className = "tour-view-link";
  viewLink.textContent = "View full tour →";
  footer.appendChild(viewLink);
  card.appendChild(footer);

  container.appendChild(card);
}

// ---------------------------------------------------------------------------
// Repertoire show card
// The show itself is the primary thing; dates are secondary context.
// ---------------------------------------------------------------------------

function renderTouringShowCard(container, tsId, ts) {
  const today = getTodayMidnight();
  const dates = ts.show_dates || [];
  const futureDates = dates.filter((d) => {
    const p = parseDateString(d.date);
    return p && p >= today;
  });
  const pastDates = dates.filter((d) => {
    const p = parseDateString(d.date);
    return p && p < today;
  });

  const card = document.createElement("div");
  card.className = "tour-card repertoire-card";

  // Flyer thumbnail from touring_event_flyer, or the first date's own
  // flyer(s) via getEventLevelFlyers() (shared_utils.js).
  const tsFlyer =
    ts.touring_event_flyer ||
    ts.event_flyer ||
    (dates.length > 0 && getEventLevelFlyers(dates[0])[0]?.filename) ||
    null;
  if (tsFlyer?.trim()) {
    card.appendChild(makePerfFlyerThumb(tsFlyer, ts.showname || ts.name));
  }

  // Header: show name + badge
  const header = document.createElement("div");
  header.className = "tour-card-header";

  const nameEl = document.createElement("div");
  nameEl.className = "tour-card-name";
  nameEl.textContent = ts.showname || ts.name;
  header.appendChild(nameEl);

  const badge = document.createElement("span");
  badge.className =
    futureDates.length > 0 ? "tour-remaining-badge" : "tour-completed-badge";
  badge.textContent =
    futureDates.length > 0
      ? `${futureDates.length} upcoming date${futureDates.length !== 1 ? "s" : ""}`
      : pastDates.length > 0
        ? `${pastDates.length} past date${pastDates.length !== 1 ? "s" : ""}`
        : "No dates listed";
  header.appendChild(badge);
  card.appendChild(header);

  // Full description — the show is the thing, so give it room
  if (ts.description) {
    const desc = document.createElement("div");
    desc.className = "tour-card-desc repertoire-desc";
    const paras = ts.description
      .split("\n\n\n\n")
      .map((p) => p.replace(/\n\n/g, " ").trim())
      .filter(Boolean);
    paras.forEach((p) => {
      const el = document.createElement("p");
      el.textContent = p;
      desc.appendChild(el);
    });
    card.appendChild(desc);
  }

  // Upcoming and past dates — both as collapsibles (upcoming open by
  // default so nothing currently visible needs an extra click; past
  // closed by default). See renderDateCollapsible().
  const toEventRow = (sd) => showDateToEventRow(ts, sd);
  renderDateCollapsible(card, futureDates, toEventRow, {
    titlePrefix: "Upcoming dates",
    defaultOpen: true,
  });
  renderDateCollapsible(card, pastDates, toEventRow, {
    titlePrefix: "Past dates",
    sortDescending: true,
  });

  container.appendChild(card);
}

// ---------------------------------------------------------------------------
// Other event row
// ---------------------------------------------------------------------------

function renderEventRow(container, event) {
  // If the event has no single date but has a datetimes array, use the first entry's date.
  // datetimes entries look like "01/04/2026 : 7.30pm"
  let dateStr = event.date;
  let timeStr = event.time;
  const hasDatesArray =
    Array.isArray(event.datetimes) && event.datetimes.length > 0;
  if (!dateStr && hasDatesArray) {
    const firstDt = event.datetimes[0];
    const parts = firstDt.split(/\s*:\s*/);
    dateStr = parts[0] ? parts[0].trim() : "";
    if (!timeStr && parts[1]) timeStr = parts[1].trim();
  }
  const date = parseDateString(dateStr);
  // isPast: for multi-date events use the *last* datetime to decide
  let isPast = false;
  if (hasDatesArray) {
    const lastDt = event.datetimes[event.datetimes.length - 1];
    const lastDateStr = lastDt.split(/\s*:\s*/)[0].trim();
    const lastDate = parseDateString(lastDateStr);
    isPast = lastDate && lastDate < getTodayMidnight();
  } else {
    isPast = date && date < getTodayMidnight();
  }
  const venue = event.venue_id ? venuesLookup[event.venue_id] : null;

  const row = document.createElement("div");
  row.className = `event-row${isPast ? " event-row-past" : ""}`;

  const dateCol = document.createElement("div");
  dateCol.className = "event-row-date";
  if (date) {
    dateCol.textContent =
      hasDatesArray && event.datetimes.length > 1
        ? `${formatMediumDate(date)} +${event.datetimes.length - 1} more`
        : formatMediumDate(date);
  } else {
    dateCol.textContent = "Date TBC";
  }
  if (isPast) dateCol.classList.add("muted");
  row.appendChild(dateCol);

  const detail = document.createElement("div");
  detail.className = "event-row-detail";

  const title = document.createElement("div");
  title.className = "event-row-title";
  title.textContent = event.showname || event.name;
  detail.appendChild(title);

  if (timeStr) {
    const t = document.createElement("span");
    t.className = "event-row-time";
    t.textContent = timeStr;
    detail.appendChild(t);
  }

  // Co-performer credit for joint shows (e.g. "with Lucy Lill")
  if (event.performer_id && compoundIdsForMe.has(event.performer_id)) {
    const compound = performersLookup[event.performer_id];
    const members = compound && (compound.performer_ids || compound.ids || []);
    const coPerformers = (members || []).filter((id) => id !== performerId);
    if (coPerformers.length > 0) {
      const coDiv = document.createElement("div");
      coDiv.className = "event-row-time";
      coDiv.appendChild(document.createTextNode("with "));
      coPerformers.forEach((id, i) => {
        if (i > 0) coDiv.appendChild(document.createTextNode(" & "));
        const p = performersLookup[id];
        if (p) {
          const a = document.createElement("a");
          a.href = `new_troubadours_performers.html?performer=${encodeURIComponent(id)}`;
          a.textContent = p.name;
          a.onclick = (e) => e.stopPropagation();
          coDiv.appendChild(a);
        } else {
          coDiv.appendChild(document.createTextNode(id));
        }
      });
      detail.appendChild(coDiv);
    }
  }

  if (venue) {
    const v = document.createElement("div");
    v.className = "event-row-venue";
    if (venue.url) {
      const a = document.createElement("a");
      a.href = sanitizeUrl(venue.url) || "#";
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = venue.name;
      v.appendChild(a);
      if (venue.city) v.appendChild(document.createTextNode(`, ${venue.city}`));
    } else {
      v.textContent = venue.name + (venue.city ? `, ${venue.city}` : "");
    }
    detail.appendChild(v);
  }

  const badges = document.createElement("div");
  badges.className = "badge-row";
  if (event.isMusic) {
    const b = document.createElement("span");
    b.className = "badge badge-music";
    b.textContent = "Music";
    badges.appendChild(b);
  }
  if (event.isPoetry) {
    const b = document.createElement("span");
    b.className = "badge badge-poetry";
    b.textContent = "Poetry";
    badges.appendChild(b);
  }
  if (event.isSpecial && !event.isMusic && !event.isPoetry) {
    const b = document.createElement("span");
    b.className = "badge badge-special";
    b.textContent = "Story show";
    badges.appendChild(b);
  }
  if (isPast) {
    const b = document.createElement("span");
    b.className = "badge badge-past";
    b.textContent = "Past";
    badges.appendChild(b);
  }
  if (event.ticket_url && !isPast) {
    const a = document.createElement("a");
    a.href = sanitizeUrl(event.ticket_url) || "#";
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.className = "ticket-link";
    a.textContent = "Tickets";
    badges.appendChild(a);
  }
  detail.appendChild(badges);

  // Flyer expand-button (if available)
  if (event.event_flyer?.trim()) {
    const flyerSrc = BASE_FLYER + sanitizeFlyerName(event.event_flyer.trim());
    const btn = document.createElement("span");
    btn.className = "event-row-flyer-btn";
    btn.textContent = "🖼 View flyer";
    const expandable = document.createElement("div");
    expandable.className = "event-row-flyer-expandable";
    const fimg = document.createElement("img");
    fimg.alt = event.showname || event.name || "Flyer";
    let flyerLoaded = false;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpen = expandable.style.display === "block";
      if (isOpen) {
        expandable.style.display = "none";
        btn.textContent = "🖼 View flyer";
      } else {
        if (!flyerLoaded) {
          fimg.src = flyerSrc;
          flyerLoaded = true;
        }
        expandable.style.display = "block";
        btn.textContent = "🖼 Hide flyer";
      }
    });
    fimg.addEventListener("click", (e) => {
      e.stopPropagation();
      const galleryIdx = perfGalleryItems.findIndex((i) => i.src === flyerSrc);
      if (galleryIdx >= 0) {
        openPerfFlyer(perfGalleryItems, galleryIdx);
      } else {
        openPerfFlyer(
          [{ src: flyerSrc, label: event.showname || event.name || "" }],
          0,
        );
      }
    });
    expandable.appendChild(fimg);
    detail.appendChild(btn);
    detail.appendChild(expandable);
  }

  row.appendChild(detail);
  container.appendChild(row);
}

// ---------------------------------------------------------------------------
// Festival row
// ---------------------------------------------------------------------------

function renderFestivalRow(container, fid, festival) {
  const start = parseDateString(festival.start_date);
  const end = parseDateString(festival.end_date);
  const isPast = end && end < getTodayMidnight();

  const row = document.createElement("div");
  row.className = `event-row${isPast ? " event-row-past" : ""}`;

  const dateCol = document.createElement("div");
  dateCol.className = "event-row-date";
  if (start && end) {
    dateCol.textContent =
      start.toDateString() === end.toDateString()
        ? formatMediumDate(start)
        : `${formatShortDate(start)} – ${formatShortDate(end)}`;
  }
  row.appendChild(dateCol);

  const detail = document.createElement("div");
  detail.className = "event-row-detail";

  const title = document.createElement("div");
  title.className = "event-row-title";
  title.textContent = festival.name;
  detail.appendChild(title);

  const role = (festival.performers || []).find(
    (p) => p.performer_id === performerId,
  );
  if (role && role.role) {
    const r = document.createElement("span");
    r.className = "event-row-time";
    r.textContent = role.role;
    detail.appendChild(r);
  }

  const venue = festival.venue_id ? venuesLookup[festival.venue_id] : null;
  if (venue) {
    const v = document.createElement("div");
    v.className = "event-row-venue";
    v.textContent = venue.name + (venue.city ? `, ${venue.city}` : "");
    detail.appendChild(v);
  }

  const badges = document.createElement("div");
  badges.className = "badge-row";
  const b = document.createElement("span");
  b.className = "badge badge-special";
  b.textContent = "Festival";
  badges.appendChild(b);
  if (isPast) {
    const bp = document.createElement("span");
    bp.className = "badge badge-past";
    bp.textContent = "Past";
    badges.appendChild(bp);
  }
  if (festival.ticket_url && !isPast) {
    const a = document.createElement("a");
    a.href = sanitizeUrl(festival.ticket_url) || "#";
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.className = "ticket-link";
    a.textContent = "Tickets";
    badges.appendChild(a);
  }
  detail.appendChild(badges);

  row.appendChild(detail);
  container.appendChild(row);
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
const DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatShortDate(d) {
  if (!d) return "";
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}

function formatMediumDate(d) {
  if (!d) return "";
  return `${DAYS_SHORT[d.getDay()]} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

// ── Performer-page flyer lightbox wiring ────────────────────────────────
// State + functions (openPerfFlyer, closePerfFlyer, showPfSlide, pfLbKey,
// makePerfFlyerThumb) now live in the main script block above, alongside
// renderPerformer, so they're guaranteed to exist before it needs them.
// Only the bits that require the lightbox markup above to already exist
// in the DOM stay here.

document.getElementById("pfClose").onclick = closePerfFlyer;
document.getElementById("pfPrev").onclick = () => { if (_pfIdx > 0) { _pfIdx--; showPfSlide(); } };
document.getElementById("pfNext").onclick = () => { if (_pfIdx < _pfItems.length - 1) { _pfIdx++; showPfSlide(); } };
document.getElementById("perfFlyerLightbox").addEventListener("click", e => {
    if (e.target === document.getElementById("perfFlyerLightbox")) closePerfFlyer();
});