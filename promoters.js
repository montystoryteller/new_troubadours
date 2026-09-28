// promoters.js
// Drives promoters.html
// Depends on shared_utils.js being loaded first.

let eventsData = null;
let promotersLookup = {};
let festivalsLookup = {};
let venuesLookup = {};
let performersLookup = {};
let stagesLookup = {};

let currentPromoter = null; // { key, record }

// ---------------------------------------------------------------------------
// Display-name / date helpers
// ---------------------------------------------------------------------------

/**
 * A handful of promoter records (e.g. "trowbridge_pump") don't have a name
 * field yet. Fall back to a human-readable version of the id rather than
 * showing the raw slug.
 */
function getPromoterDisplayName(id, promoter) {
  if (promoter?.name) return promoter.name;
  return id
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Minimal, self-contained date resolution for festivals linked from a
// promoter's page — mirrors getFestivalDates()/pickFestivalRunning() in
// small_festivals_display.js. Duplicated (rather than shared) since this
// page doesn't load that script; kept intentionally small.
//
// Pull raw start/end date strings out of a festival or running record.
// The source data isn't consistent about shape, so this checks, in order:
//   - a nested dates{} object, using either start/end or start_date/end_date
//   - flat start_date (+ optional end_date)
//   - a bare single date (single-day event, e.g. ragged-bear-2026,
//     or a single-day running like wigan-diggers-2026)
function extractDates(obj) {
  if (!obj) return { start: null, end: null };
  const nested = obj.dates;
  if (nested) {
    const start = nested.start || nested.start_date || null;
    if (start) {
      return { start, end: nested.end || nested.end_date || start };
    }
  }
  if (obj.start_date) {
    return { start: obj.start_date, end: obj.end_date || obj.start_date };
  }
  if (obj.date) {
    return { start: obj.date, end: obj.date };
  }
  return { start: null, end: null };
}

function pickFestivalRunning(fest) {
  const runnings = fest?.runnings;
  if (!runnings || typeof runnings !== "object") return null;
  const today = getTodayMidnight();
  const candidates = Object.entries(runnings)
    .map(([key, r]) => {
      const { start: startStr, end: endStr } = extractDates(r);
      return {
        key,
        r,
        start: parseDateString(startStr),
        end: parseDateString(endStr) || parseDateString(startStr),
      };
    })
    .filter((c) => c.start);
  if (!candidates.length) return null;
  const current = candidates.find((c) => c.start <= today && c.end >= today);
  if (current) return current;
  const future = candidates
    .filter((c) => c.start > today)
    .sort((a, b) => a.start - b.start);
  if (future.length) return future[0];
  return candidates.sort((a, b) => b.start - a.start)[0];
}

function getFestivalDates(fest) {
  const direct = extractDates(fest);
  if (direct.start) return direct;
  const running = pickFestivalRunning(fest);
  if (running) {
    return extractDates(running.r);
  }
  return { start: null, end: null };
}

/**
 * Expand a festival into one entry per relevant running (see the identical
 * helper in small_festivals_display.js). A promoter's linked festival can be
 * a recurring one with both a past and an upcoming running (e.g. a
 * promoter's own weekender series) — showing only one row for it via
 * getFestivalDates()/pickFestivalRunning() would silently drop the others.
 * Festivals with no runnings still just produce a single entry.
 * @returns {Array<{runningKey: string|null, running: object|null, dates: {start,end}}>}
 */
function expandFestivalRunnings(fest) {
  const direct = extractDates(fest);
  if (direct.start) {
    return [{ runningKey: null, running: null, dates: direct }];
  }
  const runnings = fest.runnings;
  if (
    runnings &&
    typeof runnings === "object" &&
    Object.keys(runnings).length
  ) {
    return Object.entries(runnings)
      .map(([runningKey, running]) => ({
        runningKey,
        running,
        dates: extractDates(running),
      }))
      .filter((entry) => entry.dates.start);
  }
  return [];
}

function formatDateRange(dates) {
  const start = parseDateString(dates.start);
  const end = parseDateString(dates.end);
  if (!start) return "";
  const fmt = { day: "numeric", month: "short", year: "numeric" };
  if (!end || start.toDateString() === end.toDateString()) {
    return start.toLocaleDateString("en-GB", fmt);
  }
  return `${start.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – ${end.toLocaleDateString("en-GB", fmt)}`;
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

function getPromoterURLParams() {
  const p = new URLSearchParams(window.location.search);
  return { promoterId: p.get("promoter"), cacheBuster: p.get("v") };
}

function promoterPageURL(promoterId) {
  return `${window.location.pathname}?promoter=${encodeURIComponent(promoterId)}`;
}

function sharePromoterLink() {
  if (!currentPromoter?.key) {
    alert("No promoter selected");
    return;
  }
  const url = `${location.origin}${location.pathname}?promoter=${encodeURIComponent(currentPromoter.key)}`;
  navigator.clipboard
    .writeText(url)
    .then(() => {
      const btn = document.querySelector(
        "button[onclick='sharePromoterLink()']",
      );
      showCopyFeedback(btn);
    })
    .catch(console.error);
}

// Each promoter has its own canonical page (?promoter=id), so choosing one
// is a full navigation rather than an in-page swap.
function handlePromoterSelectChange() {
  const id = document.getElementById("promoterSelect").value;
  if (id) window.location.href = promoterPageURL(id);
}

function loadSelectedPromoter() {
  const id = document.getElementById("promoterSelect").value;
  if (!id) {
    alert("Please select a promoter");
    return;
  }
  window.location.href = promoterPageURL(id);
}

// ---------------------------------------------------------------------------
// Overview cards
// ---------------------------------------------------------------------------

function buildPromoterCard(id, promoter) {
  const card = document.createElement("a");
  card.className = "promoter-overview-card";
  card.href = promoterPageURL(id);

  const name = document.createElement("div");
  name.className = "promoter-card-name";
  name.textContent = getPromoterDisplayName(id, promoter);
  card.appendChild(name);

  if (promoter.description) {
    const desc = document.createElement("div");
    desc.className = "promoter-card-desc";
    const MAX = 120;
    desc.textContent =
      promoter.description.length > MAX
        ? promoter.description.slice(0, MAX).trim() + "…"
        : promoter.description;
    card.appendChild(desc);
  }

  const counts = [
    ["🎪", (promoter.promoter_festivals || []).length, "festival"],
    ["🏕️", (promoter.promoter_stages || []).length, "stage"],
    ["📍", (promoter.promoter_venues || []).length, "venue"],
    ["🎤", (promoter.promoter_artists || []).length, "artist"],
  ].filter(([, n]) => n > 0);

  if (counts.length) {
    const badges = document.createElement("div");
    badges.className = "promoter-card-counts";
    counts.forEach(([icon, n, label]) => {
      const badge = document.createElement("span");
      badge.className = "promoter-card-badge";
      badge.textContent = `${icon} ${n} ${label}${n !== 1 ? "s" : ""}`;
      badges.appendChild(badge);
    });
    card.appendChild(badges);
  }

  return card;
}

function renderPromotersOverview() {
  const body = document.getElementById("allPromotersBody");
  const entries = Object.entries(promotersLookup);
  body.innerHTML = "";

  if (!entries.length) {
    body.innerHTML =
      '<p class="promoter-panel-placeholder">No promoters listed yet.</p>';
    return;
  }

  entries.sort(([idA, a], [idB, b]) =>
    getPromoterDisplayName(idA, a).localeCompare(
      getPromoterDisplayName(idB, b),
    ),
  );

  const grid = document.createElement("div");
  grid.className = "promoter-cards-grid";
  entries.forEach(([id, promoter]) =>
    grid.appendChild(buildPromoterCard(id, promoter)),
  );
  body.appendChild(grid);
}

function populatePromoterDropdown() {
  const sel = document.getElementById("promoterSelect");
  Object.entries(promotersLookup)
    .map(([id, p]) => ({ id, name: getPromoterDisplayName(id, p) }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach(({ id, name }) => {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = name;
      sel.appendChild(opt);
    });
}

// ---------------------------------------------------------------------------
// Linked-list section builders (festivals / stages / venues / artists)
// ---------------------------------------------------------------------------

function setSectionVisible(container, visible) {
  const section = container.closest(".promoter-section");
  if (section) section.style.display = visible ? "" : "none";
}

function renderPromoterFestivals(promoter) {
  const container = document.getElementById("promoterFestivalsList");
  container.innerHTML = "";
  const ids = promoter.promoter_festivals || [];

  // No entries for this promoter: hide the whole section.
  setSectionVisible(container, ids.length > 0);
  if (!ids.length) return;

  // One row per festival occurrence, not per festival — a recurring
  // festival (e.g. a promoter's own weekender series) can have a past and
  // an upcoming running at once, and both should show up here.
  const rows = [];
  ids.forEach((festId) => {
    const fest = festivalsLookup[festId];
    if (!fest) {
      rows.push({ festId, fest: null, running: null, dates: null });
      return;
    }
    const occurrences = expandFestivalRunnings(fest);
    if (!occurrences.length) {
      rows.push({ festId, fest, running: null, dates: null });
    } else {
      occurrences.forEach((occ) =>
        rows.push({ festId, fest, running: occ.running, dates: occ.dates }),
      );
    }
  });

  rows.forEach(({ festId, fest, running, dates }) => {
    const row = document.createElement("a");
    row.className = "promoter-list-item";
    row.href = `small_festivals.html?festival=${encodeURIComponent(festId)}`;

    const name = document.createElement("div");
    name.className = "promoter-list-item-name";
    name.textContent = running?.name || (fest ? fest.name : festId);
    row.appendChild(name);

    if (fest) {
      const dateRange = dates ? formatDateRange(dates) : "";
      if (dateRange) {
        const meta = document.createElement("div");
        meta.className = "promoter-list-item-meta";
        meta.textContent = dateRange;
        row.appendChild(meta);
      }
    } else {
      row.classList.add("promoter-list-item-unresolved");
    }

    container.appendChild(row);
  });
}

function renderPromoterStages(promoter) {
  const container = document.getElementById("promoterStagesList");
  container.innerHTML = "";
  const ids = promoter.promoter_stages || [];

  // No entries for this promoter: hide the whole section.
  setSectionVisible(container, ids.length > 0);
  if (!ids.length) return;

  ids.forEach((stageId) => {
    const stage = stagesLookup[stageId];
    const row = document.createElement("div");
    row.className = "promoter-list-item";

    const name = document.createElement("div");
    name.className = "promoter-list-item-name";
    // A few stage records (e.g. "knockerdown-inn") don't have a name field
    // yet — stage.name would be undefined there, not just falsy-and-empty,
    // so fall back to a humanized id rather than showing "undefined".
    name.textContent = stage ? stage.name || getPromoterDisplayName(stageId, stage) : stageId;
    row.appendChild(name);

    if (stage) {
      const types = Array.isArray(stage.type)
        ? stage.type
        : stage.type
          ? [stage.type]
          : [];
      if (types.length) {
        const meta = document.createElement("div");
        meta.className = "promoter-list-item-meta";
        meta.textContent = types.join(" · ");
        row.appendChild(meta);
      }
      if (Array.isArray(stage.festivals) && stage.festivals.length) {
        const at = document.createElement("div");
        at.className = "promoter-list-item-meta";
        at.textContent = `At: ${stage.festivals
          .map((fid) => festivalsLookup[fid]?.name || fid)
          .join(", ")}`;
        row.appendChild(at);
      }
      const link = sanitizeUrl(stage.url || stage.facebook);
      if (link) {
        const a = document.createElement("a");
        a.href = link;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.className = "promoter-list-item-link";
        a.textContent = "🌐 Website";
        a.onclick = (e) => e.stopPropagation();
        row.appendChild(a);
      }
    } else {
      row.classList.add("promoter-list-item-unresolved");
    }

    container.appendChild(row);
  });
}

function renderPromoterVenues(promoter) {
  const container = document.getElementById("promoterVenuesList");
  container.innerHTML = "";
  const ids = promoter.promoter_venues || [];

  // No entries for this promoter: hide the whole section.
  setSectionVisible(container, ids.length > 0);
  if (!ids.length) return;

  ids.forEach((venueId) => {
    const venue = venuesLookup[venueId];
    const row = document.createElement("div");
    row.className = "promoter-list-item";

    const name = document.createElement("div");
    name.className = "promoter-list-item-name";
    name.textContent = venue ? venue.name : venueId;
    row.appendChild(name);

    if (venue) {
      if (venue.full_address && venue.full_address !== venue.name) {
        const meta = document.createElement("div");
        meta.className = "promoter-list-item-meta";
        meta.textContent = venue.full_address;
        row.appendChild(meta);
      }
    } else {
      row.classList.add("promoter-list-item-unresolved");
    }

    container.appendChild(row);
  });
}

function renderPromoterArtists(promoter) {
  const container = document.getElementById("promoterArtistsList");
  container.innerHTML = "";
  const ids = promoter.promoter_artists || [];

  // No entries for this promoter: hide the whole section.
  setSectionVisible(container, ids.length > 0);
  if (!ids.length) return;

  ids.forEach((performerId) => {
    const performer = performersLookup[performerId];
    const row = document.createElement("a");
    row.className = "promoter-list-item";
    row.href = `performers.html?performer=${encodeURIComponent(performerId)}`;

    const name = document.createElement("div");
    name.className = "promoter-list-item-name";
    name.textContent = performer ? performer.name : performerId;
    row.appendChild(name);

    if (!performer) row.classList.add("promoter-list-item-unresolved");

    container.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Directory vs single-promoter mode
//
// Same pattern as performers.js: no ?promoter= arg shows the directory
// (overview panel + selector); with the arg, the page is that promoter's own
// canonical page, with a link back to the plain directory page. Switching
// between them is a full navigation. On a promoter page the promoter's name
// becomes the H1 and the directory heading is demoted to H2 (its
// directory-only subheading is hidden).
// ---------------------------------------------------------------------------

function promoteHeadingToH1(el) {
  if (!el || el.tagName === "H1") return el;
  const h1 = document.createElement("h1");
  h1.id = el.id;
  h1.className = el.className;
  h1.innerHTML = el.innerHTML;
  el.replaceWith(h1);
  return h1;
}

function demoteHeadingToH2(el) {
  if (!el || el.tagName === "H2") return el;
  const h2 = document.createElement("h2");
  h2.id = el.id;
  h2.className = el.className;
  h2.innerHTML = el.innerHTML;
  el.replaceWith(h2);
  return h2;
}

function applyDirectoryMode() {
  promoteHeadingToH1(document.getElementById("pageHeading"));
  const sub = document.getElementById("pageSubheading");
  if (sub) sub.style.display = "";
  demoteHeadingToH2(document.getElementById("promoterTitle"));
  document.getElementById("allPromotersPanel").style.display = "";
  document.getElementById("promoterSelectorRow").style.display = "";
  document.getElementById("shareLinkBtn").style.display = "none";
  document.getElementById("promoterBackLink").style.display = "none";
}

function applyPromoterMode() {
  demoteHeadingToH2(document.getElementById("pageHeading"));
  const sub = document.getElementById("pageSubheading");
  if (sub) sub.style.display = "none";
  promoteHeadingToH1(document.getElementById("promoterTitle"));
  document.getElementById("allPromotersPanel").style.display = "none";
  document.getElementById("promoterSelectorRow").style.display = "none";
  document.getElementById("shareLinkBtn").style.display = "";
  document.getElementById("promoterBackLink").style.display = "";
}

// bfcache restores: re-assert the correct mode for this document.
window.addEventListener("pageshow", () => {
  if (getPromoterURLParams().promoterId) applyPromoterMode();
  else applyDirectoryMode();
});

// ---------------------------------------------------------------------------
// Promoter detail
// ---------------------------------------------------------------------------

function displayPromoter(promoterId) {
  const promoter = promotersLookup[promoterId];
  if (!promoter) {
    document.getElementById("promoterContent").style.display = "none";
    document.getElementById("promoterNotFound").style.display = "block";
    return;
  }

  currentPromoter = { key: promoterId, record: promoter };
  document.getElementById("promoterNotFound").style.display = "none";
  document.getElementById("promoterContent").style.display = "block";

  const displayName = getPromoterDisplayName(promoterId, promoter);
  document.title = `${displayName} — Grass Roots Scene`;
  updateMeta("description", displayName, " — ");
  updateMeta("keywords", displayName, ", ");

  const titleEl = document.getElementById("promoterTitle");
  titleEl.textContent = displayName;

  // Subtitle only shown when the record has no proper name, as a hint
  // that the display name is a fallback derived from its id.
  const subtitleEl = document.getElementById("promoterSubtitle");
  if (!promoter.name) {
    subtitleEl.textContent = `(id: ${promoterId})`;
    subtitleEl.style.display = "block";
  } else {
    subtitleEl.style.display = "none";
  }

  // Links
  const linksEl = document.getElementById("promoterLinks");
  linksEl.innerHTML = "";
  [
    {
      url: promoter.promoter_link || promoter.url,
      label: "🌐 Website",
      cls: "",
    },
    {
      url: promoter.ticketing_url,
      label: "🎟 Ticketing",
      cls: "promoter-ticket-link",
    },
    {
      url: promoter.application_url,
      label: "📝 Apply to Play",
      cls: "promoter-apply-link",
    },
  ].forEach(({ url, label, cls }) => {
    if (!url) return;
    const safe = sanitizeUrl(url);
    if (!safe) return;
    const a = document.createElement("a");
    a.href = safe;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.className = `promoter-ext-link ${cls}`.trim();
    a.textContent = label;
    linksEl.appendChild(a);
  });

  // Description
  const descEl = document.getElementById("promoterDescription");
  descEl.innerHTML = "";
  if (promoter.description) {
    appendParagraphs(descEl, promoter.description);
    descEl.style.display = "block";
  } else {
    descEl.style.display = "none";
  }

  renderPromoterFestivals(promoter);
  renderPromoterStages(promoter);
  renderPromoterVenues(promoter);
  renderPromoterArtists(promoter);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/**
 * Forces a genuinely fresh copy of grass_roots_normalized.json (bypassing the
 * normal auto-rolling cache window defined in shared_utils.js) and
 * re-renders the page with it. Wired up to the "Refresh data" button.
 */
function refreshDirectoryData() {
  const btn = document.getElementById("refreshDataBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Refreshing…";
  }
  sessionStorage.setItem("forceFreshEventsData", "1");
  window.location.reload();
}

// Initialize.
// Runs as soon as this script executes rather than waiting for the "load"
// event, so the JSON fetch starts as early as possible.
setCanonical("promoter");

(async () => {
  const forcedRefresh = sessionStorage.getItem("forceFreshEventsData");
  if (forcedRefresh) sessionStorage.removeItem("forceFreshEventsData");

  const { promoterId, cacheBuster } = getPromoterURLParams();

  // Set the page mode straight away so the wrong layout never flashes.
  if (promoterId) applyPromoterMode();
  else applyDirectoryMode();

  if (!promoterId) {
    document.getElementById("allPromotersBody").innerHTML =
      '<p class="promoter-panel-placeholder">Loading promoters…</p>';
  }

  const result = await loadEventsData(
    cacheBuster || (forcedRefresh ? Date.now() : null),
  );
  if (!result) {
    console.error("Failed to load events data");
    const msg =
      '<p class="not-found">Could not load directory data. Please try refreshing the page.</p>';
    if (promoterId) {
      const nf = document.getElementById("promoterNotFound");
      nf.innerHTML = msg;
      nf.style.display = "block";
    } else {
      document.getElementById("allPromotersBody").innerHTML = msg;
    }
    return;
  }

  eventsData = result.eventsData;
  promotersLookup = eventsData.promoters || {};
  festivalsLookup = eventsData.festivals || {};
  venuesLookup = eventsData.locations || {};
  performersLookup = eventsData.performers || {};
  stagesLookup = eventsData.independent_stages || {};

  displayDataLastUpdated(result.lastUpdateTime);
  initNavFeedback();

  setTimeout(() => {
    if (promoterId) {
      displayPromoter(promoterId);
    } else {
      populatePromoterDropdown();
      renderPromotersOverview();
    }
  }, 0);
})();
