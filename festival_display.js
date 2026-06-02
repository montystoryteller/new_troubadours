// festival_display.js
// Drives new_troubadours_festival.html
// Depends on shared_utils.js being loaded first.

let map;
let markers = [];
let eventsData = null;
let venuesLookup = {};
let performersLookup = {};
let currentFestival = null; // { key, record }

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

function getFestivalURLParams() {
  const p = new URLSearchParams(window.location.search);
  return { festivalId: p.get("festival"), cacheBuster: p.get("v") };
}

function updateURL(festivalId) {
  const p = new URLSearchParams({ festival: festivalId });
  window.history.pushState({ festivalId }, "", `${window.location.pathname}?${p}`);
}

function shareFestivalLink() {
  if (!currentFestival?.key) { alert("No festival selected"); return; }
  const url = `${location.origin}${location.pathname}?festival=${encodeURIComponent(currentFestival.key)}`;
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.querySelector("button[onclick='shareFestivalLink()']");
    const orig = btn.innerHTML;
    btn.innerHTML = "✅ Link Copied!";
    setTimeout(() => { btn.innerHTML = orig; }, 2000);
  }).catch(console.error);
}

function handleFestivalSelectChange() {
  const id = document.getElementById("festivalSelect").value;
  if (id) { displayFestival(id); updateURL(id); }
}

function loadSelectedFestival() {
  const id = document.getElementById("festivalSelect").value;
  if (!id) { alert("Please select a festival"); return; }
  displayFestival(id);
  updateURL(id);
}

// ---------------------------------------------------------------------------
// Festival status
// ---------------------------------------------------------------------------

function getFestivalStatus(fest) {
  const today = getTodayMidnight();
  const start = parseDateString(fest.start_date);
  const end   = parseDateString(fest.end_date);
  if (!start || !end) return "unknown";
  if (end   < today)  return "past";
  if (start > today)  return "future";
  return "current";
}

// ---------------------------------------------------------------------------
// Collect linked events from specificEvents + tour_dates
// Returns a sorted array of items, each with a normalised shape.
// ---------------------------------------------------------------------------

function collectLinkedEvents(festivalKey) {
  const linked = [];

  for (const ev of eventsData.specificEvents || []) {
    if (ev.wider_event !== festivalKey) continue;
    const dates = Array.isArray(ev.date) ? ev.date : [ev.date];
    for (const ds of dates) {
      const parsed = parseDateString(ds);
      if (parsed) linked.push({ source: "specific", date: parsed, dateStr: ds, event: ev });
    }
  }

  for (const [tourKey, tour] of Object.entries(eventsData.tours || {})) {
    for (const td of tour.tour_dates || []) {
      if (td.wider_event !== festivalKey) continue;
      const dates = Array.isArray(td.date) ? td.date : [td.date];
      for (const ds of dates) {
        const parsed = parseDateString(ds);
        if (parsed) linked.push({ source: "tour", date: parsed, dateStr: ds, tourDate: td, tour, tourKey });
      }
    }
  }

  linked.sort((a, b) => {
    const diff = a.date - b.date;
    if (diff !== 0) return diff;
    const at = a.source === "specific" ? (a.event.time || "") : (a.tourDate.time || "");
    const bt = b.source === "specific" ? (b.event.time || "") : (b.tourDate.time || "");
    return at.localeCompare(bt);
  });

  return linked;
}

// ---------------------------------------------------------------------------
// Build the unified programme: schedule[] items + linked events, merged.
// Each entry has: { date, dateStr, startMinutes, endMinutes, stage,
//                   title, performer, time, type, ticketUrl, description,
//                   linkedItem }   (linkedItem present for wider_event matches)
// ---------------------------------------------------------------------------

/**
 * Parse a time string like "7.30pm", "19:30", "3-4pm", "3.30-4.30pm"
 * Returns minutes-since-midnight for start (and end if range), or null.
 */
function parseTimeToMinutes(timeStr) {
  if (!timeStr) return null;
  const s = timeStr.trim().toLowerCase();

  // Try range like "3-4pm", "7.30-9pm", "3.30-4.30pm"
  const rangeMatch = s.match(/^(\d+(?:[.:]\d+)?)\s*[-–]\s*(\d+(?:[.:]\d+)?)\s*(am|pm)?$/);
  if (rangeMatch) {
    const suffix = rangeMatch[3] || "";
    const startMin = parseOnePart(rangeMatch[1], suffix, false);
    const endMin   = parseOnePart(rangeMatch[2], suffix, true);
    return { start: startMin, end: endMin };
  }

  // Single time "7.30pm", "19:00", "3pm"
  const singleMatch = s.match(/^(\d+(?:[.:]\d+)?)\s*(am|pm)?$/);
  if (singleMatch) {
    const m = parseOnePart(singleMatch[1], singleMatch[2] || "", false);
    return { start: m, end: m + 60 }; // assume 1 hour if no end given
  }

  // "7-8pm" already caught above; try "3pm-4pm"
  const rangeMatch2 = s.match(/^(\d+(?:[.:]\d+)?)\s*(am|pm)\s*[-–]\s*(\d+(?:[.:]\d+)?)\s*(am|pm)$/);
  if (rangeMatch2) {
    const startMin = parseOnePart(rangeMatch2[1], rangeMatch2[2], false);
    const endMin   = parseOnePart(rangeMatch2[3], rangeMatch2[4], false);
    return { start: startMin, end: endMin };
  }

  return null;
}

function parseOnePart(part, suffix, preferPM) {
  const [hStr, mStr] = part.split(/[.:]/);
  let h = parseInt(hStr, 10);
  const m = mStr ? parseInt(mStr, 10) : 0;
  if (suffix === "pm" && h < 12) h += 12;
  if (suffix === "am" && h === 12) h = 0;
  if (!suffix && preferPM && h < 12) h += 12; // range end: "3-4pm" → 4pm
  if (!suffix && !preferPM && h < 8) h += 12; // no suffix, small hour → pm
  return h * 60 + m;
}

function buildProgramme(fest) {
  const programme = [];
  const linked = collectLinkedEvents(currentFestival.key);

  // 1. Schedule items from the festival record
  for (const item of fest.schedule || []) {
    const date = parseDateString(item.date);
    if (!date) continue;
    const times = parseTimeToMinutes(item.time);
    const performer = item.performer_id
      ? (performersLookup[item.performer_id]?.name || item.performer_id)
      : (item.performer || "");
    programme.push({
      date,
      dateStr: item.date,
      startMinutes: times?.start ?? null,
      endMinutes:   times?.end   ?? null,
      stage: item.stage || "Main Stage",
      title: item.showname || item.name || "",
      performer,
      time: item.time || "",
      type: item.type || "schedule",
      ticketUrl: item.ticket_url || "",
      description: item.description || "",
      linkedItem: null,
    });
  }

  // 2. Linked events (wider_event)
  for (const item of linked) {
    const ev     = item.source === "specific" ? item.event : item.tourDate;
    const tour   = item.source === "tour" ? item.tour : null;
    const rawTime = ev.time || "";
    const times  = parseTimeToMinutes(rawTime);
    const perfId = item.source === "specific" ? ev.performer_id : tour?.performer_id;
    const performer = perfId
      ? (performersLookup[perfId]?.name || perfId)
      : "";
    const title = ev.showname
      || (item.source === "specific" ? ev.name : tour?.name)
      || "";
    // Stage: use ev.stage if present, else try venue short name, else "Festival"
    const venueId = item.source === "specific" ? ev.venue_id : ev.venue_id;
    const venue   = venuesLookup[venueId] || {};
    const stage   = ev.stage || venue.short_name || venue.name || "Festival";

    programme.push({
      date: item.date,
      dateStr: item.dateStr,
      startMinutes: times?.start ?? null,
      endMinutes:   times?.end   ?? null,
      stage,
      title,
      performer,
      time: rawTime,
      type: item.source === "tour" && tour?.isMusic ? "music" : "special",
      ticketUrl: ev.ticket_url || "",
      description: ev.description || "",
      linkedItem: item,
    });
  }

  // Sort by date then start time
  programme.sort((a, b) => {
    const dd = a.date - b.date;
    if (dd !== 0) return dd;
    if (a.startMinutes !== null && b.startMinutes !== null) return a.startMinutes - b.startMinutes;
    if (a.startMinutes !== null) return -1;
    if (b.startMinutes !== null) return  1;
    return a.title.localeCompare(b.title);
  });

  return programme;
}

// ---------------------------------------------------------------------------
// Clashfinder renderer
// ---------------------------------------------------------------------------

const PX_PER_MINUTE = 1.4; // height scaling
const SLOT_MINUTES  = 30;  // time-axis granularity
const MIN_BLOCK_PX  = 28;  // minimum block height

function renderClashfinder() {
  const fest = currentFestival?.record;
  if (!fest) return;

  const section   = document.getElementById("festivalScheduleSection");
  const container = document.getElementById("clashfinderContainer");
  const daySelect = document.getElementById("cfDaySelect");

  const programme = buildProgramme(fest);

  if (programme.length === 0) {
    section.style.display = "none";
    return;
  }

  section.style.display = "";
  container.innerHTML = "";

  // Get unique days
  const dayKeys = [...new Set(programme.map(p => p.dateStr))];

  // Populate day selector (only on first call or after festival change)
  const existingOptions = [...daySelect.options].map(o => o.value);
  const needsRefresh = !dayKeys.every(k => existingOptions.includes(k));
  if (needsRefresh) {
    daySelect.innerHTML = '<option value="all">All days</option>';
    dayKeys.forEach(ds => {
      const d = parseDateString(ds);
      const label = d ? d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) : ds;
      const opt = document.createElement("option");
      opt.value = ds;
      opt.textContent = label;
      daySelect.appendChild(opt);
    });
  }

  const selectedDay = daySelect.value;
  const daysToShow = selectedDay === "all" ? dayKeys : [selectedDay];

  daysToShow.forEach(dayKey => {
    const dayItems = programme.filter(p => p.dateStr === dayKey);
    if (dayItems.length === 0) return;
    const dayDate = parseDateString(dayKey);
    const dayLabel = dayDate
      ? dayDate.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })
      : dayKey;
    container.appendChild(buildDayGrid(dayLabel, dayItems));
  });
}

function buildDayGrid(dayLabel, items) {
  const today = getTodayMidnight();

  // Determine stages (preserve insertion order)
  const stages = [...new Set(items.map(i => i.stage))];

  // Items with time info → use clashfinder grid
  // Items without time → show as a simple list below the grid
  const timed   = items.filter(i => i.startMinutes !== null);
  const untimed = items.filter(i => i.startMinutes === null);

  // Time bounds
  let minTime = timed.length ? Math.min(...timed.map(i => i.startMinutes)) : 0;
  let maxTime = timed.length ? Math.max(...timed.map(i => i.endMinutes ?? i.startMinutes + 60)) : 0;
  // Round to slot boundaries
  minTime = Math.floor(minTime / SLOT_MINUTES) * SLOT_MINUTES;
  maxTime = Math.ceil(maxTime  / SLOT_MINUTES) * SLOT_MINUTES;
  if (maxTime <= minTime) maxTime = minTime + 60;

  const totalMinutes = maxTime - minTime;
  const timeSlots = [];
  for (let t = minTime; t <= maxTime; t += SLOT_MINUTES) timeSlots.push(t);

  // Wrapper
  const wrapper = document.createElement("div");
  wrapper.className = "clashfinder-day-wrapper";

  // Day label banner
  const banner = document.createElement("div");
  banner.className = "cf-day-banner";
  banner.textContent = dayLabel;
  wrapper.appendChild(banner);

  if (timed.length === 0 && untimed.length === 0) return wrapper;

  // CSS grid: col 1 = time axis, then one col per stage
  const totalCols = stages.length + 1;
  const gridStyle = `grid-template-columns: 56px repeat(${stages.length}, 1fr)`;

  if (timed.length > 0) {
    const grid = document.createElement("div");
    grid.className = "clashfinder-grid";
    grid.setAttribute("style", gridStyle);

    // Header row
    const corner = document.createElement("div");
    corner.className = "cf-corner";
    corner.textContent = "Time";
    grid.appendChild(corner);

    stages.forEach(stage => {
      const cell = document.createElement("div");
      cell.className = "cf-stage-header";
      cell.textContent = stage;
      grid.appendChild(cell);
    });

    // Time rows
    timeSlots.forEach(t => {
      const timeCell = document.createElement("div");
      timeCell.className = "cf-time-cell";
      const h = Math.floor(t / 60);
      const m = t % 60;
      timeCell.textContent = `${h}:${String(m).padStart(2, "0")}`;
      grid.appendChild(timeCell);

      stages.forEach(() => {
        const slot = document.createElement("div");
        slot.className = "cf-slot-cell";
        grid.appendChild(slot);
      });
    });

    // Now overlay event blocks. We use a separate flex container per stage
    // column so positioning is relative to that column.
    // We rebuild the grid with explicit stage columns as positioned containers.

    // Actually: replace the slot-cell approach with absolutely-positioned
    // columns on top of the time grid. Simpler: build stage columns separately.

    // Clear and rebuild with a different approach:
    grid.innerHTML = "";

    // Corner
    const cornerEl = document.createElement("div");
    cornerEl.className = "cf-corner";
    cornerEl.textContent = "Time";
    grid.appendChild(cornerEl);

    // Stage headers
    stages.forEach(stage => {
      const h = document.createElement("div");
      h.className = "cf-stage-header";
      h.textContent = stage;
      grid.appendChild(h);
    });

    // Time axis + stage columns (one row per slot)
    const gridHeight = totalMinutes * PX_PER_MINUTE;

    // Time column cells
    timeSlots.forEach(t => {
      const tc = document.createElement("div");
      tc.className = "cf-time-cell";
      const h = Math.floor(t / 60);
      const m = t % 60;
      tc.textContent = `${h}:${String(m).padStart(2, "0")}`;
      tc.style.height = `${SLOT_MINUTES * PX_PER_MINUTE}px`;
      tc.style.boxSizing = "border-box";
      grid.appendChild(tc);

      stages.forEach(() => {
        const sc = document.createElement("div");
        sc.className = "cf-slot-cell";
        sc.style.height = `${SLOT_MINUTES * PX_PER_MINUTE}px`;
        sc.style.boxSizing = "border-box";
        grid.appendChild(sc);
      });
    });

    // Overlay: for each stage, create a relatively-positioned column overlay
    // We do this by wrapping the whole grid in a container and placing
    // absolute-positioned stage column overlays.

    // Simpler: wrap grid in a position:relative shell, add one overlay per stage.
    const gridWrap = document.createElement("div");
    gridWrap.style.position = "relative";
    gridWrap.appendChild(grid);

    // The header row height
    const HEADER_H = 36; // px, matches cf-stage-header padding

    stages.forEach((stage, stageIdx) => {
      // Create a transparent overlay div positioned over this stage's column
      const overlay = document.createElement("div");
      overlay.style.position = "absolute";
      overlay.style.top = `${HEADER_H}px`;
      overlay.style.height = `${gridHeight}px`;
      overlay.style.pointerEvents = "none"; // let grid scrolling work

      // We'll set left/width after the grid is in the DOM; use a data attr
      overlay.dataset.stageIdx = stageIdx;
      overlay.classList.add("cf-stage-overlay");
      gridWrap.appendChild(overlay);

      const stageItems = timed.filter(i => i.stage === stage);
      stageItems.forEach(item => {
        const block = buildEventBlock(item, minTime, today);
        overlay.appendChild(block);
        overlay.style.pointerEvents = "auto";
      });
    });

    wrapper.appendChild(gridWrap);

    // After render, position the overlays by reading grid column widths
    requestAnimationFrame(() => positionOverlays(grid, gridWrap, HEADER_H));
  }

  // Untimed items — simple card list
  if (untimed.length > 0) {
    const untimedSection = document.createElement("div");
    untimedSection.className = "cf-untimed-section";
    const label = document.createElement("div");
    label.className = "cf-untimed-label";
    label.textContent = "Events (time TBC)";
    untimedSection.appendChild(label);
    untimed.forEach(item => {
      untimedSection.appendChild(buildUntimedCard(item, today));
    });
    wrapper.appendChild(untimedSection);
  }

  return wrapper;
}

function positionOverlays(grid, gridWrap, headerH) {
  // Read the actual rendered column widths from the grid
  // Grid columns: col 0 = time axis, col 1..N = stages
  const overlays = gridWrap.querySelectorAll(".cf-stage-overlay");
  if (!overlays.length) return;

  // Get grid bounding rect and time-cell width
  const gridRect = grid.getBoundingClientRect();
  const wrapRect = gridWrap.getBoundingClientRect();

  // Find the first stage header to get column positions
  const stageHeaders = grid.querySelectorAll(".cf-stage-header");
  overlays.forEach(overlay => {
    const idx = parseInt(overlay.dataset.stageIdx, 10);
    const header = stageHeaders[idx];
    if (!header) return;
    const hRect = header.getBoundingClientRect();
    const left = hRect.left - wrapRect.left;
    const width = hRect.width;
    overlay.style.left  = `${left}px`;
    overlay.style.width = `${width}px`;
  });
}

function buildEventBlock(item, minTime, today) {
  const past = item.date < today;
  const topPx    = (item.startMinutes - minTime) * PX_PER_MINUTE;
  const durationMin = (item.endMinutes ?? item.startMinutes + 60) - item.startMinutes;
  const heightPx = Math.max(durationMin * PX_PER_MINUTE, MIN_BLOCK_PX);

  const block = document.createElement("div");
  block.className = `cf-event cf-event-${item.type}`;
  if (past) block.classList.add("cf-event-past");
  block.style.top    = `${topPx}px`;
  block.style.height = `${heightPx}px`;

  const titleEl = document.createElement("div");
  titleEl.className = "cf-event-title";
  titleEl.textContent = item.title;
  block.appendChild(titleEl);

  if (item.performer && heightPx > 42) {
    const perfEl = document.createElement("div");
    perfEl.className = "cf-event-performer";
    perfEl.textContent = item.performer;
    block.appendChild(perfEl);
  }

  if (item.time && heightPx > 56) {
    const timeEl = document.createElement("div");
    timeEl.className = "cf-event-time";
    timeEl.textContent = item.time;
    block.appendChild(timeEl);
  }

  // Tooltip on click
  block.addEventListener("click", e => {
    e.stopPropagation();
    showCfTooltip(item, block);
  });

  return block;
}

let _activeCfTooltip = null;

function showCfTooltip(item, anchor) {
  if (_activeCfTooltip) { _activeCfTooltip.remove(); _activeCfTooltip = null; }

  const tip = document.createElement("div");
  tip.className = "cf-tooltip";

  const title = document.createElement("div");
  title.className = "cf-tooltip-title";
  title.textContent = item.title;
  tip.appendChild(title);

  if (item.performer) {
    const p = document.createElement("div");
    p.className = "cf-tooltip-perf";
    p.textContent = item.performer;
    tip.appendChild(p);
  }

  if (item.time) {
    const t = document.createElement("div");
    t.className = "cf-tooltip-time";
    t.textContent = item.time;
    tip.appendChild(t);
  }

  const stageEl = document.createElement("div");
  stageEl.className = "cf-tooltip-stage";
  stageEl.textContent = item.stage;
  tip.appendChild(stageEl);

  if (item.ticketUrl) {
    const safeUrl = sanitizeUrl(item.ticketUrl);
    if (safeUrl) {
      const a = document.createElement("a");
      a.href = safeUrl; a.target = "_blank"; a.rel = "noopener noreferrer";
      a.className = "cf-tooltip-link";
      a.textContent = "🎟 Tickets";
      tip.appendChild(a);
    }
  }

  // Position relative to the clashfinder container
  const container = document.getElementById("clashfinderContainer");
  container.style.position = "relative";
  container.appendChild(tip);

  const aRect = anchor.getBoundingClientRect();
  const cRect = container.getBoundingClientRect();
  tip.style.position = "absolute";
  tip.style.top  = `${aRect.bottom - cRect.top + 6}px`;
  tip.style.left = `${Math.max(0, aRect.left - cRect.left)}px`;
  tip.style.pointerEvents = "auto";

  _activeCfTooltip = tip;

  // Dismiss on outside click
  setTimeout(() => {
    document.addEventListener("click", () => {
      if (_activeCfTooltip) { _activeCfTooltip.remove(); _activeCfTooltip = null; }
    }, { once: true });
  }, 50);
}

function buildUntimedCard(item, today) {
  const past = item.date < today;
  const div = document.createElement("div");
  div.className = `cf-untimed-card cf-event-${item.type}`;
  if (past) div.classList.add("cf-event-past");

  const title = document.createElement("span");
  title.className = "cf-untimed-title";
  title.textContent = item.title;
  div.appendChild(title);

  if (item.performer) {
    const p = document.createElement("span");
    p.className = "cf-untimed-perf";
    p.textContent = ` — ${item.performer}`;
    div.appendChild(p);
  }

  const stage = document.createElement("span");
  stage.className = "cf-untimed-stage";
  stage.textContent = item.stage;
  div.appendChild(stage);

  return div;
}

// ---------------------------------------------------------------------------
// Display the full festival detail
// ---------------------------------------------------------------------------

function displayFestival(festivalId) {
  const fest = (eventsData.festivals || {})[festivalId];
  if (!fest) {
    document.getElementById("festivalContent").style.display = "none";
    document.getElementById("festivalNotFound").style.display = "block";
    return;
  }

  currentFestival = { key: festivalId, record: fest };
  document.getElementById("festivalNotFound").style.display = "none";
  document.getElementById("festivalContent").style.display = "block";
  document.title = `${fest.name} — New Troubadours`;

  if (map) map.invalidateSize();

  // Reset day selector for new festival
  const daySelect = document.getElementById("cfDaySelect");
  daySelect.innerHTML = '<option value="all">All days</option>';

  // Header
  document.getElementById("festivalTitle").textContent = fest.name;
  document.getElementById("festivalSubtitle").textContent = fest.short_name || "";

  // Date range
  const start = parseDateString(fest.start_date);
  const end   = parseDateString(fest.end_date);
  const longFmt = { weekday: "long", day: "numeric", month: "long", year: "numeric" };
  const rangeEl = document.getElementById("festivalDateRange");
  if (start && end) {
    rangeEl.textContent = start.toDateString() === end.toDateString()
      ? start.toLocaleDateString("en-GB", longFmt)
      : `${start.toLocaleDateString("en-GB", longFmt)} — ${end.toLocaleDateString("en-GB", longFmt)}`;
  }

  // Status banner
  const status = getFestivalStatus(fest);
  const statusEl = document.getElementById("festivalStatusBanner");
  const STATUS = {
    past:    { cls: "festival-banner-past",    text: "📅 This festival has ended." },
    future:  { cls: "festival-banner-future",  text: "🗓 Upcoming — dates still to come." },
    current: { cls: "festival-banner-current", text: "🎪 Festival in progress!" },
    unknown: { cls: "", text: "" },
  };
  statusEl.className = `festival-status-banner ${STATUS[status].cls}`;
  statusEl.textContent = STATUS[status].text;
  statusEl.style.display = STATUS[status].text ? "" : "none";

  // Venue
  const venue = venuesLookup[fest.venue_id] || {};
  const venueEl = document.getElementById("festivalVenue");
  venueEl.innerHTML = "";
  if (venue.name) {
    const loc = document.createElement("div");
    loc.className = "festival-venue-line";
    loc.textContent = `📍 ${venue.name}`;
    if (venue.full_address && venue.full_address !== venue.name) {
      loc.textContent += `, ${venue.full_address}`;
    }
    if (fest.venue_id) {
      const vl = document.createElement("a");
      vl.href = `new_troubadours_venues.html?venue=${encodeURIComponent(fest.venue_id)}`;
      vl.className = "venue-page-link";
      vl.textContent = "i";
      venueEl.appendChild(vl);
    }
    venueEl.appendChild(loc);
  }

  // External links
  const linksEl = document.getElementById("festivalLinks");
  linksEl.innerHTML = "";
  [
    { url: fest.website,    label: "🌐 Festival Website", cls: "" },
    { url: fest.ticket_url, label: "🎟 Tickets",          cls: "festival-ticket-link" },
    { url: fest.facebook,   label: "📘 Facebook",         cls: "" },
  ].forEach(({ url, label, cls }) => {
    if (!url) return;
    const safe = sanitizeUrl(url);
    if (!safe) return;
    const a = document.createElement("a");
    a.href = safe; a.target = "_blank"; a.rel = "noopener noreferrer";
    a.className = `festival-ext-link ${cls}`.trim();
    a.textContent = label;
    linksEl.appendChild(a);
  });

  // Description
  const descEl = document.getElementById("festivalDescription");
  descEl.innerHTML = "";
  if (fest.description) {
    appendParagraphs(descEl, fest.description);
    descEl.style.display = "block";
  } else {
    descEl.style.display = "none";
  }

  // Performers
  renderFestivalPerformers(fest);

  // Flyer
  const flyerEl = document.getElementById("festivalFlyer");
  flyerEl.innerHTML = "";
  if (fest.event_flyer) {
    const img = document.createElement("img");
    img.src = `./storyclub_assets/event_flyers/${sanitizeFlyerPath(fest.event_flyer)}`;
    img.alt = `${fest.name} flyer`;
    img.className = "festival-flyer-img";
    flyerEl.appendChild(img);
    flyerEl.style.display = "block";
  } else {
    flyerEl.style.display = "none";
  }

  // Clashfinder (schedule + linked events merged)
  renderClashfinder();

  // Listed events sidebar
  renderLinkedEvents(festivalId);

  // Map
  addFestivalMarkersToMap(festivalId, fest);
}

// ---------------------------------------------------------------------------
// Performers section
// ---------------------------------------------------------------------------

/**
 * Build a merged, deduped performer list for a festival.
 *
 * Sources (in priority order):
 *   1. fest.performers[] — explicit entries; may carry a role (e.g. "headliner")
 *   2. wider_event-tagged specificEvents and tour_dates — derived automatically
 *
 * Returns an array of { id, name, role, explicit } objects, sorted
 * explicit-first then alphabetically by name within each group.
 */
function collectFestivalPerformers(festId, fest) {
  // 1. Explicit performers (with role)
  const seen = new Map(); // performer_id → entry
  for (const p of fest.performers || []) {
    const rec = performersLookup[p.performer_id];
    if (rec && !seen.has(p.performer_id)) {
      seen.set(p.performer_id, { id: p.performer_id, name: rec.name, role: p.role || "", explicit: true });
    }
  }

  // 2. Derived from linked events
  const linked = collectLinkedEvents(festId);
  for (const item of linked) {
    const ids = [];
    if (item.source === "specific") {
      if (item.event.performer_id) ids.push(item.event.performer_id);
      if (Array.isArray(item.event.performer_ids)) ids.push(...item.event.performer_ids);
    } else {
      if (item.tour.performer_id) ids.push(item.tour.performer_id);
      if (Array.isArray(item.tour.performer_ids)) ids.push(...item.tour.performer_ids);
    }
    for (const id of ids) {
      if (seen.has(id)) continue; // already listed (explicit takes priority)
      const rec = performersLookup[id];
      if (rec) seen.set(id, { id, name: rec.name, role: "", explicit: false });
    }
  }

  const all = [...seen.values()];
  // Explicit first, then alpha by name
  all.sort((a, b) => {
    if (a.explicit !== b.explicit) return a.explicit ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return all;
}

function renderFestivalPerformers(fest) {
  const perfEl = document.getElementById("festivalPerformers");
  perfEl.innerHTML = "";

  const performers = collectFestivalPerformers(currentFestival.key, fest);

  if (!performers.length && !fest.performers_tbc) {
    perfEl.style.display = "none";
    return;
  }

  const h = document.createElement("h3");
  h.className = "festival-section-heading";
  h.textContent = "Performers";
  perfEl.appendChild(h);

  const list = document.createElement("div");
  list.className = "festival-performer-list";

  performers.forEach(p => {
    const row = document.createElement("div");
    row.className = "festival-performer-row";
    const a = document.createElement("a");
    a.href = `new_troubadours_performers.html?performer=${encodeURIComponent(p.id)}`;
    a.textContent = p.name;
    a.className = "festival-performer-link";
    row.appendChild(a);
    if (p.role) {
      const r = document.createElement("span");
      r.className = "festival-performer-role";
      r.textContent = p.role;
      row.appendChild(r);
    }
    list.appendChild(row);
  });

  if (fest.performers_tbc) {
    const tbc = document.createElement("div");
    tbc.className = "festival-performers-tbc";
    tbc.textContent = "+ more to be announced";
    list.appendChild(tbc);
  }

  perfEl.appendChild(list);
  perfEl.style.display = "block";
}

// ---------------------------------------------------------------------------
// Listed events panel (right-hand sidebar)
// ---------------------------------------------------------------------------

function renderLinkedEvents(festivalId) {
  const container = document.getElementById("festivalEventsList");
  const heading   = document.getElementById("festivalEventsHeading");
  container.innerHTML = "";

  const linked = collectLinkedEvents(festivalId);

  if (linked.length === 0) {
    heading.textContent = "Listed Events";
    container.innerHTML = "<p class='festival-no-events'>No individual events listed yet.</p>";
    return;
  }

  heading.textContent = `Listed Events (${linked.length})`;
  linked.forEach(item => {
    container.appendChild(
      item.source === "specific"
        ? buildSpecificEventCard(item)
        : buildTourDateCard(item)
    );
  });
}

function buildSpecificEventCard(item) {
  const { date, event } = item;
  const today = getTodayMidnight();
  const past = date < today;

  const div = document.createElement("div");
  div.className = "event special festival-linked-event";
  if (past) div.classList.add("date-past");

  const nameDiv = document.createElement("div");
  nameDiv.className = "event-name";
  const dateText = date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  nameDiv.textContent = event.time ? `${dateText} • ${event.time}` : dateText;
  div.appendChild(nameDiv);

  const showDiv = document.createElement("div");
  showDiv.className = "festival-event-showname";
  showDiv.textContent = event.showname || event.name;
  div.appendChild(showDiv);

  if (event.performer_id && performersLookup[event.performer_id]) {
    const p = performersLookup[event.performer_id];
    const perfDiv = document.createElement("div");
    perfDiv.className = "event-performer";
    const a = document.createElement("a");
    a.href = `new_troubadours_performers.html?performer=${encodeURIComponent(event.performer_id)}`;
    a.className = "event-performer-link";
    a.textContent = p.name;
    perfDiv.appendChild(a);
    div.appendChild(perfDiv);
  }

  const venue = venuesLookup[event.venue_id] || {};
  if (venue.name) {
    const venueEl = createVenueElement(venue);
    if (event.venue_id) {
      const vl = document.createElement("a");
      vl.href = `new_troubadours_venues.html?venue=${encodeURIComponent(event.venue_id)}`;
      vl.className = "venue-page-link";
      vl.textContent = "i";
      vl.onclick = e => e.stopPropagation();
      venueEl.appendChild(vl);
    }
    div.appendChild(venueEl);
  }

  if (event.price) {
    const pr = document.createElement("div");
    pr.className = "event-price";
    pr.textContent = event.price;
    div.appendChild(pr);
  }

  const tickets = createTicketsElement(event, past);
  if (tickets) div.appendChild(tickets);

  if (event.description) {
    const { toggle, content } = createFestivalExpandable("More Info", event.description);
    div.appendChild(toggle);
    div.appendChild(content);
  }

  if (venue.latlon) {
    div.style.cursor = "pointer";
    div.addEventListener("click", () => {
      map.flyTo(venue.latlon, 14);
      markers.forEach(m => { if (m.venue_id === event.venue_id) m.openPopup(); });
    });
  }

  return div;
}

function buildTourDateCard(item) {
  const { date, tourDate, tour, tourKey } = item;
  const today = getTodayMidnight();
  const past = date < today;

  const div = document.createElement("div");
  div.className = `event festival-linked-event ${tour.isMusic ? "music" : "special"}`;
  if (past) div.classList.add("date-past");

  const nameDiv = document.createElement("div");
  nameDiv.className = "event-name";
  const dateText = date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  nameDiv.textContent = tourDate.time ? `${dateText} • ${tourDate.time}` : dateText;
  div.appendChild(nameDiv);

  const showDiv = document.createElement("div");
  showDiv.className = "festival-event-showname";
  showDiv.textContent = tour.name;
  div.appendChild(showDiv);

  const badge = document.createElement("a");
  badge.href = `new_troubadours_tour_guide.html?tour=${encodeURIComponent(tourKey)}`;
  badge.className = "touring-badge festival-tour-badge";
  badge.textContent = "🎭 Tour date";
  badge.onclick = e => e.stopPropagation();
  div.appendChild(badge);

  if (tour.performer_id && performersLookup[tour.performer_id]) {
    const p = performersLookup[tour.performer_id];
    const perfDiv = document.createElement("div");
    perfDiv.className = "event-performer";
    const a = document.createElement("a");
    a.href = `new_troubadours_performers.html?performer=${encodeURIComponent(tour.performer_id)}`;
    a.className = "event-performer-link";
    a.textContent = p.name;
    perfDiv.appendChild(a);
    div.appendChild(perfDiv);
  }

  const venue = venuesLookup[tourDate.venue_id] || {};
  if (venue.name) {
    const venueEl = createVenueElement(venue);
    if (tourDate.venue_id) {
      const vl = document.createElement("a");
      vl.href = `new_troubadours_venues.html?venue=${encodeURIComponent(tourDate.venue_id)}`;
      vl.className = "venue-page-link";
      vl.textContent = "i";
      vl.onclick = e => e.stopPropagation();
      venueEl.appendChild(vl);
    }
    div.appendChild(venueEl);
  }

  const tickets = createTicketsElement(tourDate, past);
  if (tickets) div.appendChild(tickets);

  if (tourDate.description) {
    const { toggle, content } = createFestivalExpandable("More Info", tourDate.description);
    div.appendChild(toggle);
    div.appendChild(content);
  }

  if (venue.latlon) {
    div.style.cursor = "pointer";
    div.addEventListener("click", () => {
      map.flyTo(venue.latlon, 14);
      markers.forEach(m => { if (m.venue_id === tourDate.venue_id) m.openPopup(); });
    });
  }

  return div;
}

function createFestivalExpandable(label, content) {
  const toggle = document.createElement("div");
  toggle.className = "event-expand-btn expand-btn-spaced";
  toggle.textContent = label;

  const contentEl = document.createElement("div");
  contentEl.className = "event-expandable";
  contentEl.style.display = "none";
  appendParagraphs(contentEl, content);

  toggle.onclick = e => {
    e.stopPropagation();
    const hidden = contentEl.style.display === "none";
    contentEl.style.display = hidden ? "block" : "none";
    toggle.textContent = hidden ? "Close" : label;
  };

  return { toggle, content: contentEl };
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

function addFestivalMarkersToMap(festivalId, fest) {
  markers = clearMarkers(map, markers);
  const bounds = [];

  const festVenue = venuesLookup[fest.venue_id] || {};
  if (festVenue.latlon) {
    const [lat, lon] = festVenue.latlon;
    const m = L.circleMarker([lat, lon], {
      radius: 12, fillColor: "#1b5e20", color: "#fff",
      weight: 2, opacity: 1, fillOpacity: 0.9,
    }).addTo(map);
    m.venue_id = fest.venue_id;
    m.bindPopup(`<div class="popup-content"><h3>${escapeHtml(fest.name)}</h3><p>${escapeHtml(festVenue.name || "")}</p></div>`);
    markers.push(m);
    bounds.push([lat, lon]);
  }

  const linked = collectLinkedEvents(festivalId);
  const today  = getTodayMidnight();

  linked.forEach(item => {
    const venueId = item.source === "specific" ? item.event.venue_id : item.tourDate.venue_id;
    const venue   = venuesLookup[venueId] || {};
    if (!venue.latlon) return;
    const [lat, lon] = venue.latlon;
    const past    = item.date < today;
    const isMusic = item.source === "tour" && item.tour.isMusic;
    const m = L.circleMarker([lat, lon], {
      radius: past ? 6 : 8,
      fillColor: past ? "#aaa" : isMusic ? "#443cd7" : "#4CAF50",
      color: past ? "#999" : "#fff",
      weight: 2, opacity: 1, fillOpacity: past ? 0.5 : 0.85,
    }).addTo(map);
    m.venue_id = venueId;

    const ds = item.date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
    const evName = item.source === "specific"
      ? (item.event.showname || item.event.name)
      : item.tour.name;
    const time = item.source === "specific" ? item.event.time : item.tourDate.time;

    m.bindPopup(`<div class="popup-content">
      <h3>${escapeHtml(venue.name)}</h3>
      <p><strong>${escapeHtml(ds)}${time ? " • " + escapeHtml(time) : ""}</strong></p>
      <p>${escapeHtml(evName)}</p>
      <p>${escapeHtml(venue.full_address || "")}</p>
    </div>`);
    markers.push(m);
    bounds.push([lat, lon]);
  });

  if (bounds.length === 1)       map.setView(bounds[0], 13);
  else if (bounds.length > 1)    map.fitBounds(L.latLngBounds(bounds), { padding: [50, 50] });
}

function resetFestivalMap() {
  if (currentFestival) addFestivalMarkersToMap(currentFestival.key, currentFestival.record);
}

// ---------------------------------------------------------------------------
// Overview panels
// ---------------------------------------------------------------------------

function renderFestivalPanels() {
  const festivals = Object.entries(eventsData.festivals || {});
  if (!festivals.length) return;

  const groups = { current: [], future: [], past: [] };
  festivals.forEach(([id, f]) => {
    const s = getFestivalStatus(f);
    (groups[s] || groups.future).push([id, f]);
  });

  renderFestivalPanel("currentFestivalsBody",  "currentFestivalsPanel",  groups.current, "no-current");
  renderFestivalPanel("upcomingFestivalsBody", "upcomingFestivalsPanel", groups.future,  "no-upcoming");
  renderFestivalPanel("pastFestivalsBody",     "pastFestivalsPanel",     groups.past,    "no-past");
}

function renderFestivalPanel(bodyId, wrapperId, entries, hideClass) {
  const body    = document.getElementById(bodyId);
  const wrapper = document.getElementById(wrapperId);
  if (!body || !wrapper) return;
  if (!entries.length) { wrapper.classList.add(hideClass); return; }

  const grid = document.createElement("div");
  grid.className = "festival-cards-grid";
  entries.forEach(([id, f]) => grid.appendChild(buildFestivalCard(id, f)));
  body.appendChild(grid);
}

function buildFestivalCard(festId, fest) {
  const card = document.createElement("div");
  card.className = "festival-overview-card";
  card.style.cursor = "pointer";

  const start = parseDateString(fest.start_date);
  const end   = parseDateString(fest.end_date);

  const name = document.createElement("div");
  name.className = "festival-card-name";
  name.textContent = fest.name;
  card.appendChild(name);

  if (fest.short_name) {
    const sh = document.createElement("div");
    sh.className = "festival-card-short";
    sh.textContent = fest.short_name;
    card.appendChild(sh);
  }

  if (start && end) {
    const dates = document.createElement("div");
    dates.className = "festival-card-dates";
    dates.textContent = start.toDateString() === end.toDateString()
      ? start.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
      : `${start.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – ${end.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;
    card.appendChild(dates);
  }

  const venue = venuesLookup[fest.venue_id] || {};
  if (venue.name) {
    const loc = document.createElement("div");
    loc.className = "festival-card-location";
    loc.textContent = `📍 ${venue.name}`;
    card.appendChild(loc);
  }

  const linked = collectLinkedEvents(festId);
  const scheduleCount = (fest.schedule || []).length;
  const total = linked.length + scheduleCount;
  if (total > 0) {
    const badge = document.createElement("div");
    badge.className = "festival-card-event-count";
    const parts = [];
    if (scheduleCount) parts.push(`${scheduleCount} programme item${scheduleCount !== 1 ? "s" : ""}`);
    if (linked.length) parts.push(`${linked.length} listed event${linked.length !== 1 ? "s" : ""}`);
    badge.textContent = parts.join(" · ");
    card.appendChild(badge);
  }

  // Derived performer names (compact)
  const performers = collectFestivalPerformers(festId, fest);
  if (performers.length) {
    const perfEl = document.createElement("div");
    perfEl.className = "festival-card-performers";
    perfEl.textContent = performers.map(p => p.name).join(", ");
    card.appendChild(perfEl);
  }

  card.addEventListener("click", () => {
    document.getElementById("festivalSelect").value = festId;
    displayFestival(festId);
    updateURL(festId);
    document.getElementById("festivalContent").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  return card;
}

// ---------------------------------------------------------------------------
// Dropdown
// ---------------------------------------------------------------------------

function populateFestivalDropdown() {
  const sel = document.getElementById("festivalSelect");
  Object.entries(eventsData.festivals || {})
    .map(([id, f]) => ({ id, name: f.name, start: parseDateString(f.start_date) }))
    .sort((a, b) => (a.start || 0) - (b.start || 0))
    .forEach(({ id, name }) => {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = name;
      sel.appendChild(opt);
    });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

window.addEventListener("load", async () => {
  const { festivalId, cacheBuster } = getFestivalURLParams();

  const result = await loadEventsData(cacheBuster);
  if (!result) { console.error("Failed to load events data"); return; }

  eventsData       = result.eventsData;
  venuesLookup     = result.venuesLookup;
  performersLookup = result.performersLookup;

  map = initMap("map", () => {});

  populateFestivalDropdown();
  renderFestivalPanels();

  if (festivalId) {
    document.getElementById("festivalSelect").value = festivalId;
    displayFestival(festivalId);
    setTimeout(() => {
      document.getElementById("festivalContent").scrollIntoView({ behavior: "smooth", block: "start" });
    }, 300);
  }
});
