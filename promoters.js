// promoters.js
// Drives promoters.html
// Depends on shared_utils.js being loaded first.

let eventsData = null;
let promotersLookup = {};
let festivalsLookup = {};
let venuesLookup = {};
let performersLookup = {};
let toursLookup = {}; // needed by renderEventRow()/tour handling in shared_utils.js
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
// Promoter registry (promoters + story clubs)
//
// A promoter and a story club can be the same organisation:
//   - promoters[id].isClub  === true, with id also a clubs[].club id, and/or
//   - clubs[].isPromoter    === true (no promoters[] record required).
// Either side is enough. The result is one effective record per promoter id:
// the promoter's own fields win, the club fills any gaps (name, description,
// website / facebook / tickets / email), and the club's venue, its
// feature_slots performers, plus the venue/performers of any specific, tour
// or repertoire events tagged with the club, are merged into the promoter's
// venue and artist lists. `_club` holds the club record for club promoters.
// ---------------------------------------------------------------------------

function normaliseFacebookUrl(fb) {
  if (!fb) return null;
  return /^https?:/i.test(fb) ? fb : `https://facebook.com/${fb}`;
}

function idsOf(obj) {
  if (!obj) return [];
  if (Array.isArray(obj.performer_ids) && obj.performer_ids.length)
    return obj.performer_ids;
  return obj.performer_id ? [obj.performer_id] : [];
}

// Venue and performer ids of every one-off event tagged with a club:
// specificEvents[].club, tours[].tour_dates[].club (legacy alias club_event) and
// repertoire_shows[].show_dates[].club (same rules as storyclub.js).
function collectClubEventRefs(data, clubId) {
  const venues = new Set();
  const performers = new Set();
  (data.specificEvents || [])
    .filter((e) => e.club === clubId)
    .forEach((e) => {
      if (e.venue_id) venues.add(e.venue_id);
      idsOf(e).forEach((id) => performers.add(id));
    });
  Object.values(data.tours || {}).forEach((tour) => {
    expandTourDates(tour.tour_dates)
      .filter((td) => (td.club || td.club_event) === clubId)
      .forEach((td) => {
        if (td.venue_id) venues.add(td.venue_id);
        idsOf(tour).forEach((id) => performers.add(id));
      });
  });
  Object.values(data.repertoire_shows || {}).forEach((show) => {
    expandTourDates(show.show_dates)
      .filter((sd) => sd.club === clubId)
      .forEach((sd) => {
        if (sd.venue_id) venues.add(sd.venue_id);
        idsOf(show).forEach((id) => performers.add(id));
      });
  });
  return { venues: [...venues], performers: [...performers] };
}

function uniq(...lists) {
  return [...new Set(lists.flat().filter(Boolean))];
}

function buildPromoterRegistry(data) {
  const clubs = Array.isArray(data.clubs) ? data.clubs : [];
  const clubsById = {};
  clubs.forEach((c) => {
    if (c?.club) clubsById[c.club] = c;
  });

  const base = { ...(data.promoters || {}) };
  // Clubs that declare themselves promoters get an entry even with no record.
  clubs.forEach((c) => {
    if (c?.club && c.isPromoter && !base[c.club]) base[c.club] = {};
  });

  const registry = {};
  Object.entries(base).forEach(([id, rec]) => {
    const club = rec.isClub || clubsById[id]?.isPromoter ? clubsById[id] : null;
    if (!club) {
      registry[id] = rec;
      return;
    }
    const refs = collectClubEventRefs(data, id);
    const featured = (club.feature_slots || [])
      .map((slot) => (Array.isArray(slot) ? slot[1] : null))
      .filter((v) => typeof v === "string");
    registry[id] = {
      ...rec,
      name: rec.name || club.name,
      description: rec.description || club.description,
      promoter_link: rec.promoter_link || rec.url || club.link,
      facebook: rec.facebook || normaliseFacebookUrl(club.facebook),
      email: rec.email || club.email,
      ticketing_url:
        rec.ticketing_url || club.ticketing_url || club.tickets_url,
      promoter_venues: uniq(
        rec.promoter_venues || [],
        [club.venue_id],
        refs.venues,
      ),
      promoter_artists: uniq(rec.promoter_artists || [], featured, refs.performers),
      _club: club,
    };
  });
  return registry;
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

  if (counts.length || promoter._club) {
    const badges = document.createElement("div");
    badges.className = "promoter-card-counts";
    if (promoter._club) {
      const b = document.createElement("span");
      b.className = "promoter-card-badge";
      b.textContent = "📖 story club";
      badges.appendChild(b);
    }
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

// ---------------------------------------------------------------------------
// Events
//
// One-off dated events (specific / music / poetry events, tour dates, touring
// show / story walk dates) belong to a promoter when the record carries its
// promoter_id — or, for a club promoter, is tagged with the club (`club`, or
// the legacy tour-date `club_event`). A club promoter also gets the upcoming
// occurrences of the club's recurring schedule. Festivals keep their own
// section. Rows are built by renderEventRow() (shared_utils.js), the same
// renderer the venue page uses.
// ---------------------------------------------------------------------------

const PROMOTER_RECURRING_MONTHS_AHEAD = 6;

function collectPromoterEvents(promoterId, promoter) {
  const clubId = promoter._club ? promoter._club.club : null;
  const mine = (r) =>
    r.promoter_id === promoterId ||
    r.promoter === promoterId ||
    (clubId && r.club === clubId);
  const withVenue = (entry, venueId) => {
    entry.venueId = venueId || null;
    entry.venue = venueId ? venuesLookup[venueId] || null : null;
    return entry;
  };
  const out = [];

  [
    ["specificEvents", "specific", "story"],
    ["musicEvents", "music", "music"],
    ["poetryEvents", "poetry", "poetry"],
  ].forEach(([bucket, type, category]) => {
    expandDateOrDates((eventsData[bucket] || []).filter(mine)).forEach((e) => {
      const date = parseDateString(e.date);
      if (date) out.push(withVenue({ type, date, data: e, category }, e.venue_id));
    });
  });

  Object.entries(toursLookup).forEach(([tourId, tour]) => {
    expandDateOrDates(tour.tour_dates).forEach((td) => {
      const tagged = clubId && (td.club || td.club_event) === clubId;
      if (!tagged && td.promoter_id !== promoterId) return;
      const date = parseDateString(td.date);
      if (!date) return;
      out.push(
        withVenue(
          {
            type: "tour",
            date,
            data: { tour, tourId, tourDate: td },
            category:
              tour.isMusic || td.isMusic
                ? "music"
                : tour.isPoetry
                  ? "poetry"
                  : "story",
          },
          td.venue_id,
        ),
      );
    });
  });

  Object.entries(eventsData.repertoire_shows || {}).forEach(([tsId, ts]) => {
    expandDateOrDates(ts.show_dates).forEach((sd) => {
      if (!mine(sd)) return;
      const date = parseDateString(sd.date);
      if (!date) return;
      out.push(
        withVenue(
          {
            type: "show",
            date,
            data: { ts, tsId, showDate: sd },
            category: classifyPerformanceType(ts),
          },
          sd.venue_id,
        ),
      );
    });
  });

  // Upcoming nights of the club's recurring schedule (past nights of a
  // recurring schedule have no natural start, so only the future is listed).
  const from = getTodayMidnight();
  const to = new Date(from);
  to.setMonth(to.getMonth() + PROMOTER_RECURRING_MONTHS_AHEAD);
  (eventsData.clubs || [])
    .filter((c) => c.schedule && (c.promoter_id === promoterId || (clubId && c.club === clubId)))
    .forEach((rec) => {
      RecurrenceEngine.scheduledOccurrencesInRange(
        rec.schedule,
        from,
        to,
        rec.exceptions || [],
      ).forEach((occ) => {
        if (occ.status === "cancelled" || occ.status === "moved_from") return;
        out.push(
          withVenue(
            { type: "club", date: occ.date, data: { club: rec }, category: "story" },
            resolveClubVenueId(rec, occ.date),
          ),
        );
      });
    });

  return out;
}

function renderPromoterEvents(promoterId, promoter) {
  const section = document.getElementById("promoterEventsSection");
  const upcomingEl = document.getElementById("promoterUpcomingEvents");
  const pastDetails = document.getElementById("promoterPastEventsDetails");
  const pastEl = document.getElementById("promoterPastEvents");
  upcomingEl.innerHTML = "";
  pastEl.innerHTML = "";

  const today = getTodayMidnight();
  const all = collectPromoterEvents(promoterId, promoter);
  const upcoming = all.filter((e) => e.date >= today).sort((a, b) => a.date - b.date);
  const past = all.filter((e) => e.date < today).sort((a, b) => b.date - a.date);

  section.style.display = all.length ? "" : "none";
  if (!all.length) return;

  if (upcoming.length) {
    upcoming.forEach((e) => renderEventRow(upcomingEl, e, false, { showVenue: true }));
  } else {
    const note = document.createElement("p");
    note.className = "promoter-empty-note";
    note.textContent = "No upcoming events listed.";
    upcomingEl.appendChild(note);
  }

  pastDetails.style.display = past.length ? "" : "none";
  if (past.length) {
    document.getElementById("promoterPastEventsSummary").textContent =
      `Past events (${past.length})`;
    past.forEach((e) => renderEventRow(pastEl, e, true, { showVenue: true }));
  }
}

function renderPromoterClub(promoterId, promoter) {
  const container = document.getElementById("promoterClubList");
  container.innerHTML = "";
  const club = promoter._club;
  setSectionVisible(container, !!club);
  if (!club) return;

  const row = document.createElement("a");
  row.className = "promoter-list-item";
  row.href = `storyclub.html?club=${encodeURIComponent(club.club)}`;

  const name = document.createElement("div");
  name.className = "promoter-list-item-name";
  name.textContent = club.name || promoterId;
  row.appendChild(name);

  const when = [
    typeof club.schedule === "string" ? club.schedule : null,
    typeof club.time === "string" ? club.time : null,
  ].filter(Boolean);
  const metas = [
    when.join(" · "),
    typeof club.price === "string" ? club.price : "",
    venuesLookup[club.venue_id]?.name || "",
  ].filter(Boolean);
  metas.forEach((text) => {
    const m = document.createElement("div");
    m.className = "promoter-list-item-meta";
    m.textContent = text;
    row.appendChild(m);
  });
  container.appendChild(row);
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
  document.getElementById("promoterControls").style.display = "";
  document.getElementById("promoterBackLink").style.display = "none";
}

function applyPromoterMode() {
  demoteHeadingToH2(document.getElementById("pageHeading"));
  const sub = document.getElementById("pageSubheading");
  if (sub) sub.style.display = "none";
  promoteHeadingToH1(document.getElementById("promoterTitle"));
  document.getElementById("allPromotersPanel").style.display = "none";
  document.getElementById("promoterControls").style.display = "none";
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
    renderShareBadge("promoter", null);
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
      url: promoter.facebook,
      label: "📘 Facebook",
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

  renderShareBadge("promoter", promoterId);
  renderPromoterClub(promoterId, promoter);
  renderPromoterEvents(promoterId, promoter);
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
  promotersLookup = buildPromoterRegistry(eventsData);
  festivalsLookup = eventsData.festivals || {};
  venuesLookup = eventsData.locations || {};
  performersLookup = eventsData.performers || {};
  stagesLookup = eventsData.independent_stages || {};
  toursLookup = result.toursLookup || {};

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
