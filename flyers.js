// ── Constants ─────────────────────────────────────────────────────────────
const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTHS = [
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
const BASE_EVENT = "./storyclub_assets/event_flyers/";
const BASE_CLUB = "./storyclub_assets/club_flyers/";

const CALENDAR = "new_troubadours_event_guide.html";

function escapeHtml(text) {
  if (!text) return "";
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ── Calendar link builder ─────────────────────────────────────────────────
// Constructs a URL back to the events calendar, pre-filtered to the event's
// date window and pre-searched for the show name.
function calendarLink(item) {
  const p = new URLSearchParams();

  if (item.isClubGeneric) {
    // No specific date — just search by club name
    p.set("q", item.name);
    p.set("storyclubs", "1");
    p.set("special", "1");
  } else {
    // Use the event date as both start and end, with a ±3-day window
    const d = new Date(item.date);
    const from = new Date(d);
    from.setDate(from.getDate() - 3);
    const to = new Date(d);
    to.setDate(to.getDate() + 3);
    p.set("start", fmtDate(from));
    p.set("end", fmtDate(to));
    // Search term: show name stripped of [bracketed performer] suffix
    const search = (item.name || "").replace(/\s*\[.*?\]\s*$/, "").trim();
    if (search) p.set("q", search);
    p.set("storyclubs", "1");
    p.set("special", "1");
    if (item.type === "music" || item.isMusic) p.set("music", "1");
    if (item.type === "poetry" || item.isPoetry) p.set("poetry", "1");
    if (item.type === "tour") {
      p.set("special", "1");
    }
  }

  return `${CALENDAR}?${p.toString()}`;
}

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── Context menu ──────────────────────────────────────────────────────────
const ctxMenu = document.getElementById("ctx-menu");
let ctxItem = null; // the flyer item the menu was opened for
let longPressTimer = null;

function openCtxMenu(item, x, y) {
  ctxItem = item;
  ctxMenu.innerHTML = "";

  // Header label
  const lbl = document.createElement("div");
  lbl.className = "ctx-label";
  lbl.textContent =
    item.name.length > 30 ? item.name.slice(0, 28) + "…" : item.name;
  ctxMenu.appendChild(lbl);

  const div1 = document.createElement("div");
  div1.className = "ctx-divider";
  ctxMenu.appendChild(div1);

  // Build menu items based on what links are available
  const dest = resolveLink(item);
  const cal = calendarLink(item);

  function menuItem(icon, label, href) {
    const a = document.createElement("a");
    a.className = "ctx-item";
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.innerHTML = `<span class="ctx-icon">${icon}</span><span>${label}</span>`;
    a.addEventListener("click", () => closeCtxMenu());
    ctxMenu.appendChild(a);
  }

  if (item.ticketUrl?.trim())
    menuItem("🎟", "Buy tickets", item.ticketUrl.trim());
  if (item.performerUrl?.trim())
    menuItem("🎤", "Performer website", item.performerUrl.trim());
  if (item.clubLink?.trim() && item.type !== "story")
    menuItem("🏠", "Club website", item.clubLink.trim());
  if (item.festWebsite?.trim())
    menuItem("🎪", "Festival website", item.festWebsite.trim());

  // Internal pages
  if (item.type === "tour" && item.tourKey) {
    let tourUrl = `new_troubadours_tour_guide.html?tour=${encodeURIComponent(item.tourKey)}`;
    if (item.performerId)
      tourUrl += `&performer=${encodeURIComponent(item.performerId)}`;
    menuItem("🗺", "Tour dates & map", tourUrl);
  }
  if ((item.type === "story" || item.type === "club") && item.clubId) {
    menuItem(
      "ℹ️",
      "Club page",
      `new_troubadours_storyclub.html?club=${encodeURIComponent(item.clubId)}`,
    );
  }

  // Always show calendar link
  const div2 = document.createElement("div");
  div2.className = "ctx-divider";
  ctxMenu.appendChild(div2);
  menuItem("📅", "Find on events calendar", cal);

  // Lightbox
  menuItem("🔍", "View full flyer", "__lightbox__");
  // Fix up the lightbox item — it's not a real URL
  const lbItem = ctxMenu.lastElementChild;
  lbItem.removeAttribute("href");
  lbItem.removeAttribute("target");
  lbItem.addEventListener("click", (e) => {
    e.preventDefault();
    closeCtxMenu();
    // find this item in allItems
    const idx = allItems.filter((i) => activeTypes.has(i.type)).indexOf(item);
    if (idx >= 0)
      openLightbox(
        allItems.filter((i) => activeTypes.has(i.type)),
        idx,
      );
  });

  // Facebook last — only if it's the only option or explicitly present
  if (item.fbEvent?.trim() && !dest)
    menuItem("📘", "Facebook event", item.fbEvent.trim());
  else if (item.fbEvent?.trim())
    menuItem("📘", "Facebook event", item.fbEvent.trim());
  if (item.clubFacebook?.trim() && item.type === "club")
    menuItem("📘", "Club Facebook", item.clubFacebook.trim());

  // Position — keep within viewport
  ctxMenu.classList.add("open");
  const mw = ctxMenu.offsetWidth || 220;
  const mh = ctxMenu.offsetHeight || 200;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  ctxMenu.style.left = Math.min(x, vw - mw - 8) + "px";
  ctxMenu.style.top = Math.min(y, vh - mh - 8) + "px";
}

function closeCtxMenu() {
  ctxMenu.classList.remove("open");
  ctxItem = null;
}

// Close on outside click or Escape
document.addEventListener("click", (e) => {
  if (!ctxMenu.contains(e.target)) closeCtxMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeCtxMenu();
});
document.addEventListener("scroll", () => closeCtxMenu(), { passive: true });

// ── Attach context menu + long-press to a card ────────────────────────────
function attachContextMenu(card, item) {
  // Right-click
  card.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openCtxMenu(item, e.clientX, e.clientY);
  });

  // Long-press (touch)
  card.addEventListener(
    "touchstart",
    (e) => {
      const touch = e.touches[0];
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        openCtxMenu(item, touch.clientX, touch.clientY);
      }, 500);
    },
    { passive: true },
  );

  card.addEventListener("touchend", () => {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  });
  card.addEventListener("touchmove", () => {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  });
}

// Single source of truth for all flyer filter types — add a type here
// (plus its filter button, CSS colors, and classification logic below)
// to introduce a new category without touching every call site.
const FLYER_TYPES = ["story", "club", "tour", "music", "poetry", "festival"];

const activeTypes = new Set(FLYER_TYPES);
let allItems = [];
let videoTrailerItems = [];
let lbItems = [];
let lbIndex = 0;
let activeTourKey = ""; // "" = no filter; set to a tourKey to limit to that tour

// ── URL param sync ────────────────────────────────────────────────────────
function readUrlParams() {
  const p = new URLSearchParams(location.search);
  if (p.has("types")) {
    const requested = p
      .get("types")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    activeTypes.clear();
    requested.forEach((t) => activeTypes.add(t));
  }
  if (p.has("tour")) {
    activeTourKey = p.get("tour").trim();
    // Ensure the 'tour' type is active when filtering to a specific tour
    activeTypes.add("tour");
    activeTypes.add("music"); // music tours use type "tour" with isMusic flag
    activeTypes.add("poetry"); // poetry tours use type "tour" with isPoetry flag
  }
  if (p.has("date")) {
    const raw = p.get("date"); // expects YYYY-MM-DD
    const parsed = new Date(raw + "T00:00:00");
    if (!isNaN(parsed)) {
      _todayOverride = parsed;
      const banner = document.getElementById("date-override-banner");
      const label = document.getElementById("date-override-label");
      label.textContent = `${DAYS[parsed.getDay()]} ${parsed.getDate()} ${MONTHS[parsed.getMonth()]} ${parsed.getFullYear()}`;
      // Preserve other params on the "back to real today" link
      const back = new URLSearchParams(p);
      back.delete("date");
      const backHref = back.toString() ? `?${back}` : "?";
      banner.querySelector("a").href = backHref;
      banner.style.display = "block";
    }
  }
}

function writeUrlParams() {
  const p = new URLSearchParams(location.search);
  p.set("types", [...activeTypes].sort().join(","));
  if (activeTourKey) p.set("tour", activeTourKey);
  else p.delete("tour");
  history.replaceState(null, "", `${location.pathname}?${p}`);
}

// ── Filter controls ───────────────────────────────────────────────────────
function toggleFilter(type) {
  if (activeTypes.has(type)) activeTypes.delete(type);
  else activeTypes.add(type);
  syncFilterButtons();
  writeUrlParams();
  renderAll();
}

function selectAll() {
  FLYER_TYPES.forEach((t) => activeTypes.add(t));
  syncFilterButtons();
  writeUrlParams();
  renderAll();
}

function selectNone() {
  activeTypes.clear();
  syncFilterButtons();
  writeUrlParams();
  renderAll();
}

function syncFilterButtons() {
  document.querySelectorAll(".filter-btn[data-type]").forEach((btn) => {
    btn.classList.toggle("active", activeTypes.has(btn.dataset.type));
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────
function parseDate(s) {
  if (!s) return null;
  // New recurring-schedule object format, e.g.
  // {"type":"fortnightly","day":"monday","start":"25/05/2026"}
  // (Arrays are also typeof "object" in JS but represent multi-date
  // lists, not schedule objects — callers should expand them into
  // individual date strings before calling parseDate. Guard here so
  // an unexpanded array fails loudly instead of being silently
  // misread as a schedule object with no .start.)
  if (Array.isArray(s)) {
    console.warn(
      "parseDate received an array; caller should expand it into individual date strings first:",
      s,
    );
    return null;
  }
  if (typeof s === "object") return parseScheduleObject(s);
  if (typeof s !== "string") return null;
  const parts = s.split("/");
  if (parts.length !== 3) return null;
  const [d, m, y] = parts.map(Number);
  if (!d || !m || !y) return null;
  return new Date(y, m - 1, d);
}

// Resolve a recurring-schedule object down to a single concrete date —
// the next upcoming occurrence on/after today. Used wherever code needs
// one sortable date to represent a recurring club (cutoff checks, sorting,
// isTonight/isTomorrow, etc).
function parseScheduleObject(schedule) {
  if (!schedule || !schedule.start) return null;
  const start = parseDate(schedule.start);
  if (!start) return null;
  const targetDay = DAY_MAP[(schedule.day || "").toLowerCase()];
  const ref = today();

  const type = (schedule.type || "").toLowerCase();

  if (type === "weekly") {
    if (targetDay === undefined) return start;
    const d = new Date(Math.max(start, ref));
    const diff = (targetDay - d.getDay() + 7) % 7;
    d.setDate(d.getDate() + diff);
    return d;
  }

  if (type === "fortnightly") {
    // Step forward in 14-day increments from the anchor "start" date
    // until we reach today or later.
    let d = new Date(start);
    if (d < ref) {
      const daysSince = Math.floor((ref - d) / 86400000);
      const cycles = Math.ceil(daysSince / 14);
      d = new Date(start);
      d.setDate(d.getDate() + cycles * 14);
    }
    return d;
  }

  if (type === "monthly") {
    const occ = OCC_MAP[(schedule.occurrence || "1st").toLowerCase()];
    if (occ === undefined || targetDay === undefined) return start;
    let d = findNthDay(ref.getFullYear(), ref.getMonth(), targetDay, occ);
    if (!d || d < ref) {
      const nextMonth = ref.getMonth() + 1;
      d = findNthDay(
        ref.getFullYear() + Math.floor(nextMonth / 12),
        nextMonth % 12,
        targetDay,
        occ,
      );
    }
    return d;
  }

  // Unknown type — fall back to the anchor date itself.
  return start;
}

// ── Date override (for testing) ───────────────────────────────────────
// Set via ?date=YYYY-MM-DD in the URL.
let _todayOverride = null;

function today() {
  if (_todayOverride) return new Date(_todayOverride);
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatDate(dt) {
  return `${DAYS[dt.getDay()]}, ${dt.getDate()} ${MONTHS[dt.getMonth()]} ${dt.getFullYear()}`;
}

function formatDateShort(dt) {
  return `${dt.getDate()} ${MONTHS[dt.getMonth()]} ${dt.getFullYear()}`;
}

// ── Lazy image loading — see createLazyImageLoader() in shared_utils.js
// for the shared implementation (also used by the tour and performer
// flyer galleries), including URL-keyed caching and error handling.
const imgLoader = createLazyImageLoader({
  rootMargin: "250px 0px",
  wrapSelector: ".flyer-img-wrap",
  errorMessage: "Flyer image<br>not available",
});

// ── Data loading ──────────────────────────────────────────────────────────
// ── Schedule matcher ──────────────────────────────────────────────────────
// Lightweight check: does a recurring schedule string fire on a given date?
// Handles: "Nth dayname", "last dayname", "every dayname", "Nth and Mth dayname",
// "Nth dayname (even|odd months)", pipe-separated alternating patterns.
const DAY_MAP = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};
const OCC_MAP = { "1st": 1, "2nd": 2, "3rd": 3, "4th": 4, last: "last" };

function findNthDay(year, month, targetDay, occurrence) {
  const lastDay = new Date(year, month + 1, 0).getDate();
  if (occurrence === "last") {
    for (let d = lastDay; d >= 1; d--) {
      const t = new Date(year, month, d);
      if (t.getDay() === targetDay) return t;
    }
  } else {
    let count = 0;
    for (let d = 1; d <= lastDay; d++) {
      const t = new Date(year, month, d);
      if (t.getDay() === targetDay && ++count === occurrence) return t;
    }
  }
  return null;
}

function scheduleMatchesDate(schedule, date) {
  if (!schedule || !date) return false;

  // New recurring-schedule object format
  if (typeof schedule === "object") {
    const targetDay = DAY_MAP[(schedule.day || "").toLowerCase()];
    if (targetDay === undefined || date.getDay() !== targetDay) return false;
    const start = parseDate(schedule.start);
    if (!start) return false;
    const type = (schedule.type || "").toLowerCase();
    if (date < start) return false;
    if (type === "weekly") return true;
    if (type === "fortnightly") {
      const daysSince = Math.round((date - start) / 86400000);
      return daysSince % 14 === 0;
    }
    if (type === "monthly") {
      const occ = OCC_MAP[(schedule.occurrence || "1st").toLowerCase()];
      const d = findNthDay(date.getFullYear(), date.getMonth(), targetDay, occ);
      return !!d && d.toDateString() === date.toDateString();
    }
    return false;
  }

  if (typeof schedule !== "string") return false;
  const s = schedule.toLowerCase().trim();
  const y = date.getFullYear(),
    m = date.getMonth();
  const ds = date.toDateString();

  // Specific date DD/MM/YYYY
  if (s.includes("/")) {
    const [d, mo, yr] = s.split("/").map(Number);
    return new Date(yr, mo - 1, d).toDateString() === ds;
  }

  // Pipe-separated alternating: "1st wed (even months) | 1st thu (odd months)"
  if (s.includes("|")) {
    return s.split("|").some((part) => scheduleMatchesDate(part.trim(), date));
  }

  // Strip parenthetical month parity constraint: "1st wednesday (even months)"
  const parityMatch = s.match(/^(.+?)\s*\((even|odd)\s+months\)$/);
  if (parityMatch) {
    const monthNum = m + 1;
    const isEven = monthNum % 2 === 0;
    const condition = parityMatch[2];
    if (condition === "even" && !isEven) return false;
    if (condition === "odd" && isEven) return false;
    return scheduleMatchesDate(parityMatch[1].trim(), date);
  }

  // "every dayname"
  if (s.startsWith("every ")) {
    const dayName = s.replace("every ", "").trim();
    const targetDay = DAY_MAP[dayName];
    return targetDay !== undefined && date.getDay() === targetDay;
  }

  // "Nth and Mth dayname"
  if (s.includes(" and ")) {
    const [occ1str, rest] = s.split(" and ");
    const parts = rest.trim().split(/\s+/);
    const occ2str = parts[0],
      dayName = parts[1];
    const targetDay = DAY_MAP[dayName];
    if (targetDay === undefined) return false;
    const occ1 = OCC_MAP[occ1str.trim()],
      occ2 = OCC_MAP[occ2str.trim()];
    const d1 = findNthDay(y, m, targetDay, occ1);
    const d2 = findNthDay(y, m, targetDay, occ2);
    return (d1 && d1.toDateString() === ds) || (d2 && d2.toDateString() === ds);
  }

  // Standard "Nth dayname" or "last dayname"
  const parts = s.split(/\s+/);
  if (parts.length >= 2) {
    const occ = OCC_MAP[parts[0]],
      targetDay = DAY_MAP[parts[1]];
    if (occ !== undefined && targetDay !== undefined) {
      const d = findNthDay(y, m, targetDay, occ);
      return d && d.toDateString() === ds;
    }
  }

  return false;
}

async function loadFlyers() {
  const result = await loadEventsData();
  if (!result) return;
  const data = result.eventsData;

  // Display when data was last updated
  displayDataLastUpdated(result.lastUpdateTime);
  initNavFeedback();

  const now = today();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - 3);

  const performers = result.performersLookup;
  const venues = result.venuesLookup;
  const items = [];
  const seen = new Set();

  function perf(id) {
    if (!id || !performers[id]) return null;
    const { record } = resolvePerformerDisplay(id, performers);
    return record ? record.name : performers[id].name;
  }
  function perfUrl(id) {
    if (!id || !performers[id]) return "";
    const { record } = resolvePerformerDisplay(id, performers);
    return record ? record.url || "" : performers[id].url || "";
  }
  function ven(id) {
    return venues[id] || {};
  }

  // A filename in a club's flyers[] list that starts with YYYY_MM_DD
  // (e.g. "2026_03_15_special_guest.jpg") is a flyer for that specific
  // club date, not generic artwork — parseDatedClubFlyer()
  // (shared_utils.js) is the single implementation of that detection,
  // shared with the event guide/storyclub/venues pages. Converted here
  // to a DD/MM/YYYY string so it can go through push() like any other
  // dated flyer.
  function datedClubFlyerDateStr(filename) {
    const d = parseDatedClubFlyer(filename);
    if (!d) return null;
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return `${dd}/${mm}/${d.getFullYear()}`;
  }

  function push(
    flyer,
    flyerBase,
    dateStr,
    type,
    name,
    performerId,
    venueId,
    ticketUrl,
    extra,
  ) {
    if (!flyer || !flyer.trim()) return;
    const dt = parseDate(dateStr);
    if (!dt) return;
    const key = `${flyer.trim()}|${dateStr}`;
    if (seen.has(key)) return;
    seen.add(key);
    const v = ven(venueId);
    items.push({
      flyer: flyer.trim(),
      flyerBase,
      date: dt,
      dateStr,
      type,
      name,
      performer: perf(performerId),
      performerId: performerId || "",
      performerUrl: perfUrl(performerId),
      venue: v.name || "",
      city: v.city || "",
      ticketUrl: ticketUrl || "",
      isPast: dt < now,
      isOld: dt < cutoff, // beyond the "Recent past" window — shown in the collapsed/paged Older Flyers section instead
      isTonight: dt.toDateString() === now.toDateString(),
      isTomorrow: dt.toDateString() === tomorrow.toDateString(),
      isCancelled: extra.isCancelled || false,
      isSoldOut: extra.isSoldOut || false,
      ...extra,
    });
  }

  // Find any tonight/tomorrow specific date and resolve its venue
  function resolveSpotlight(d) {
    if (!d) return null;
    const v = ven(d.venue_id);
    return {
      time: d.time || "",
      venue: v.name || "",
      city: v.city || "",
      postcode: v.postcode || "",
      ticketUrl: d.ticket_url || "",
    };
  }

  // Flat one-off event arrays. specificEvents mixes story shows in
  // with any marked isMusic/isPoetry; musicEvents/poetryEvents are
  // always their respective type. Add a tuple here (plus a matching
  // array in the data) to support a new one-off event category.
  const FLAT_EVENT_SOURCES = [
    { dataKey: "specificEvents", defaultType: "story" },
    { dataKey: "musicEvents", defaultType: "music" },
    { dataKey: "poetryEvents", defaultType: "poetry" },
  ];
  // NOTE: .date may be a single "DD/MM/YYYY" string OR an array of
  // such strings (multi-date run). Expand arrays so every date gets
  // its own card instead of being silently dropped by parseDate().
  for (const { dataKey, defaultType } of FLAT_EVENT_SOURCES) {
    for (const e of data[dataKey] || []) {
      const eFlyers = getEventLevelFlyers(e);
      if (eFlyers.length === 0) continue;
      const type = e.isMusic ? "music" : e.isPoetry ? "poetry" : defaultType;
      const clubRec = e.club
        ? (data.events || []).find((c) => c.club === e.club)
        : null;
      const dates = Array.isArray(e.date) ? e.date : [e.date];
      for (const dateStr of dates) {
        for (const f of eFlyers) {
          push(
            f.filename,
            "event",
            dateStr,
            type,
            e.showname || e.name,
            e.performer_id,
            e.venue_id,
            e.ticket_url,
            {
              clubId: e.club || "",
              fbEvent: e.fb_event
                ? `https://www.facebook.com/events/${e.fb_event}`
                : "",
              clubLink: clubRec?.link || "",
              isCancelled: !!e.isCancelled,
              isSoldOut: !!e.isSoldOut,
            },
          );
        }
      }
    }
  }

  // tours — one card per tour keyed on earliest date in window
  for (const [tourKey, tour] of Object.entries(data.tours || {})) {
    const datesInWindow = (tour.tour_dates || [])
      .map((d) => ({ ...d, _dt: parseDate(d.date) }))
      .filter((d) => d._dt && d._dt >= cutoff)
      .sort((a, b) => a._dt - b._dt);
    if (!datesInWindow.length) continue;
    const rep = datesInWindow.find((d) => d._dt >= now) || datesInWindow[0];
    const last = datesInWindow[datesInWindow.length - 1];

    const tonightDate = datesInWindow.find(
      (d) => d._dt.toDateString() === now.toDateString(),
    );
    const tomorrowDate = datesInWindow.find(
      (d) => d._dt.toDateString() === tomorrow.toDateString(),
    );

    const allCancelled = datesInWindow.every((d) => !!d.isCancelled);
    const tourExtra = {
      isMusic: tour.isMusic === true,
      isPoetry: tour.isPoetry === true,
      tourKey: tourKey,
      tourDateRange:
        datesInWindow.length > 1
          ? `${formatDateShort(datesInWindow[0]._dt)} – ${formatDateShort(last._dt)}`
          : null,
      tourDateCount: datesInWindow.length,
      fbEvent: rep.fb_event
        ? `https://www.facebook.com/events/${rep.fb_event}`
        : "",
      tonightSpotlight: resolveSpotlight(tonightDate),
      tomorrowSpotlight: resolveSpotlight(tomorrowDate),
      isCancelled: allCancelled,
      isSoldOut: !!rep.isSoldOut,
    };

    // tour-level flyer(s) — one card per flyer representing the whole
    // tour. getTourLevelFlyers() (shared_utils.js) resolves "tour_flyer",
    // "touring_event_flyer", and the current "touring_event_flyers" list
    // into one ordered, de-duplicated set; each gets its own card here,
    // all keyed to the same representative date/venue for the tour.
    getTourLevelFlyers(tour).forEach((f) => {
      push(
        f.filename,
        "event",
        rep.date,
        "tour",
        tour.tour_name || tour.name,
        tour.performer_id,
        rep.venue_id,
        rep.ticket_url,
        tourExtra,
      );
    });

    // per-date event flyers — one card each for individual dates that have
    // their own flyer(s); getEventLevelFlyers() (shared_utils.js) merges
    // event_flyer/event_flyer2/event_flyers, one card per flyer.
    for (const d of datesInWindow) {
      for (const f of getEventLevelFlyers(d)) {
        push(
          f.filename,
          "event",
          d.date,
          "tour",
          tour.tour_name || tour.name,
          tour.performer_id,
          d.venue_id,
          d.ticket_url,
          {
            ...tourExtra,
            tourDateRange: null, // single-date card — no range label
            tourDateCount: 1,
            fbEvent: d.fb_event
              ? `https://www.facebook.com/events/${d.fb_event}`
              : "",
            tonightSpotlight: resolveSpotlight(
              d._dt.toDateString() === now.toDateString() ? d : null,
            ),
            tomorrowSpotlight: resolveSpotlight(
              d._dt.toDateString() === tomorrow.toDateString() ? d : null,
            ),
            isCancelled: !!d.isCancelled,
            isSoldOut: !!d.isSoldOut,
          },
        );
      }
    }
  }

  // repertoire_shows — show-level flyer (one card for the whole show,
  // keyed on the earliest upcoming date in window) plus per show_date
  // individual flyers
  for (const [, show] of Object.entries(data.repertoire_shows || {})) {
    const showDatesInWindow = (show.show_dates || [])
      .flatMap((sd) =>
        (Array.isArray(sd.date) ? sd.date : [sd.date]).map((dateStr) => ({
          ...sd,
          date: dateStr,
          _dt: parseDate(dateStr),
        })),
      )
      .filter((sd) => sd._dt && sd._dt >= cutoff)
      .sort((a, b) => a._dt - b._dt);

    const showFlyer = show.touring_event_flyer?.trim();
    if (showFlyer && showDatesInWindow.length) {
      const rep =
        showDatesInWindow.find((sd) => sd._dt >= now) || showDatesInWindow[0];
      push(
        showFlyer,
        "event",
        rep.date,
        "story",
        show.showname || show.name,
        show.performer_id,
        rep.venue_id,
        rep.ticket_url,
        {},
      );
    }

    for (const sd of show.show_dates || []) {
      const sdFlyers = getEventLevelFlyers(sd);
      if (sdFlyers.length === 0) continue;
      const dates = Array.isArray(sd.date) ? sd.date : [sd.date];
      for (const dateStr of dates) {
        for (const f of sdFlyers) {
          push(
            f.filename,
            "event",
            dateStr,
            "story",
            show.showname || show.name,
            show.performer_id,
            sd.venue_id,
            sd.ticket_url,
            {},
          );
        }
      }
    }
  }

  // festivals
  for (const [, fest] of Object.entries(data.festivals || {})) {
    for (const f of getEventLevelFlyers(fest)) {
      push(
        f.filename,
        "event",
        fest.start_date,
        "festival",
        fest.name,
        null,
        fest.venue_id,
        fest.ticket_url,
        {
          festEnd: fest.end_date ? parseDate(fest.end_date) : null,
          festWebsite: fest.website || "",
          festFacebook: fest.facebook || "",
        },
      );
    }
  }

  // club generic flyers — shown for clubs that have no upcoming specific event flyers
  const clubsWithUpcomingFlyer = new Set(
    items.filter((i) => !i.isPast && i.clubId).map((i) => i.clubId),
  );
  for (const e of data.events || []) {
    const flyer = e.club_flyer?.trim();
    if (!flyer || !e.club) continue;
    if (clubsWithUpcomingFlyer.has(e.club)) continue;
    const key = `${flyer}|club|${e.club}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const v = ven(e.venue_id);
    const clubTonight = scheduleMatchesDate(e.schedule, now);
    const clubTomorrow = scheduleMatchesDate(e.schedule, tomorrow);
    items.push({
      flyer,
      flyerBase: "club",
      date: now,
      dateStr: null,
      type: "club",
      name: e.name,
      performer: null,
      performerId: "",
      performerUrl: "",
      venue: v.name || "",
      city: v.city || "",
      ticketUrl: e.tickets_url || "",
      clubLink: e.link || "",
      clubFacebook: e.facebook || "",
      isPast: false,
      isClubGeneric: true,
      isTonight: clubTonight,
      isTomorrow: clubTomorrow,
      schedule: e.schedule || "",
      clubId: e.club,
    });
  }

  // club "flyers" list — additional artwork for the club, distinct from
  // club_flyer, sourced from storyclub_assets/event_flyers/ per the
  // schema. A filename prefixed YYYY_MM_DD is a one-off/legacy flyer
  // for that specific date (not a recurring club night), so it's
  // pushed as a "story" card at that date rather than a "club" card —
  // see datedClubFlyerDateStr() above. Anything else is generic club
  // artwork, always shown, same as club_flyer's fallback.
  for (const e of data.events || []) {
    const extraFlyers = Array.isArray(e.flyers) ? e.flyers : [];
    if (!extraFlyers.length || !e.club) continue;
    const v = ven(e.venue_id);
    const clubTonight = scheduleMatchesDate(e.schedule, now);
    const clubTomorrow = scheduleMatchesDate(e.schedule, tomorrow);
    for (const rawFlyer of extraFlyers) {
      const flyer = rawFlyer?.trim();
      if (!flyer) continue;

      const datedStr = datedClubFlyerDateStr(flyer);
      if (datedStr) {
        // One-off/legacy flyer for a specific date, not a regular
        // club-night flyer — file as "story" (same category as
        // other one-off events) rather than "club", so it's not
        // mistaken for a recurring club occurrence.
        push(
          flyer,
          "event",
          datedStr,
          "story",
          e.name,
          null,
          e.venue_id,
          e.tickets_url || "",
          {
            clubId: e.club,
          },
        );
        continue;
      }

      const key = `${flyer}|club-extra|${e.club}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        flyer,
        flyerBase: "event",
        date: now,
        dateStr: null,
        type: "club",
        name: e.name,
        performer: null,
        performerId: "",
        performerUrl: "",
        venue: v.name || "",
        city: v.city || "",
        ticketUrl: e.tickets_url || "",
        clubLink: e.link || "",
        clubFacebook: e.facebook || "",
        isPast: false,
        isClubGeneric: true,
        isTonight: clubTonight,
        isTomorrow: clubTomorrow,
        schedule: e.schedule || "",
        clubId: e.club,
      });
    }
  }

  items.sort((a, b) => a.date - b.date);

  // Video trailers — one card per tour/show that has a video_trailer.
  // getYouTubeEmbedUrl() (shared_utils.js) validates the URL and
  // returns a safe youtube-nocookie.com /embed/ URL or null;
  // anything that isn't a genuine YouTube link is silently skipped.
  videoTrailerItems = [];
  const seenVideoIds = new Set();

  function pushVideoItem(rawUrl, title, performerId, allDatesSorted, extra) {
    const embedUrl = getYouTubeEmbedUrl(rawUrl);
    if (!embedUrl) return;
    const videoId = embedUrl.split("/embed/")[1];
    if (!videoId || seenVideoIds.has(videoId)) return;
    seenVideoIds.add(videoId);

    // Status from the FULL date range (not just the 3-month
    // "in window" cutoff used for flyers): current if today
    // falls between the first and last date inclusive, else
    // upcoming or past.
    let status = "upcoming";
    let rep = null;
    if (allDatesSorted.length) {
      const minD = allDatesSorted[0]._dt;
      const maxD = allDatesSorted[allDatesSorted.length - 1]._dt;
      if (now >= minD && now <= maxD) status = "current";
      else if (maxD < now) status = "past";
      else status = "upcoming";
      rep =
        allDatesSorted.find((d) => d._dt >= now) ||
        allDatesSorted[allDatesSorted.length - 1];
    }

    const v = ven(rep?.venue_id);
    videoTrailerItems.push({
      videoId,
      embedUrl,
      title,
      performer: perf(performerId),
      performerUrl: perfUrl(performerId),
      venue: v.name || "",
      dateStr: rep ? formatDateShort(rep._dt) : "",
      status,
      sortDate: rep
        ? rep._dt
        : status === "past"
          ? allDatesSorted[allDatesSorted.length - 1]?._dt
          : now,
      // type/isMusic/isPoetry/tourKey — same fields flyer cards
      // carry, so isItemTypeVisible()/isItemTourVisible() (used
      // by renderAll) apply identically to video trailers.
      type: extra.type,
      isMusic: !!extra.isMusic,
      isPoetry: !!extra.isPoetry,
      tourKey: extra.tourKey || null,
    });
  }

  function expandAllDates(dateEntries) {
    return (dateEntries || [])
      .flatMap((d) =>
        (Array.isArray(d.date) ? d.date : [d.date]).map((dateStr) => ({
          ...d,
          date: dateStr,
          _dt: parseDate(dateStr),
        })),
      )
      .filter((d) => d._dt)
      .sort((a, b) => a._dt - b._dt);
  }

  for (const [tourKey, tour] of Object.entries(data.tours || {})) {
    pushVideoItem(
      tour.video_trailer,
      tour.tour_name || tour.name,
      tour.performer_id,
      expandAllDates(tour.tour_dates),
      {
        type: "tour",
        isMusic: tour.isMusic === true,
        isPoetry: tour.isPoetry === true,
        tourKey,
      },
    );
  }

  for (const show of Object.values(data.repertoire_shows || {})) {
    pushVideoItem(
      show.video_trailer,
      show.showname || show.name,
      show.performer_id,
      expandAllDates(show.show_dates),
      { type: "story" },
    );
  }

  return items;
}

// ── Video trailers section ───────────────────────────────────────────────
function closeAllVideoCards(exceptCard) {
  document.querySelectorAll(".video-card.open").forEach((card) => {
    if (card === exceptCard) return;
    card.classList.remove("open");
    const frame = card.querySelector("iframe");
    if (frame) frame.src = "";
  });
}

function renderVideoTrailers() {
  const section = document.getElementById("videoTrailersSection");
  const body = document.getElementById("videoTrailersBody");
  const countEl = document.getElementById("videoTrailersCount");

  const visibleVideos = videoTrailerItems
    .filter(isItemTypeVisible)
    .filter(isItemTourVisible);

  if (!visibleVideos.length) {
    section.style.display = "none";
    return;
  }
  section.style.display = "";
  countEl.textContent = `${visibleVideos.length} trailer${visibleVideos.length !== 1 ? "s" : ""}`;
  body.innerHTML = "";

  const groups = [
    {
      status: "current",
      label: "🟢 Now touring / showing",
      className: "current",
    },
    { status: "upcoming", label: "📅 Upcoming", className: "upcoming" },
    { status: "past", label: "🕓 Past", className: "past" },
  ];

  groups.forEach((group) => {
    const groupItems = visibleVideos
      .filter((i) => i.status === group.status)
      .sort((a, b) =>
        group.status === "past"
          ? b.sortDate - a.sortDate
          : a.sortDate - b.sortDate,
      );
    if (!groupItems.length) return;

    const details = document.createElement("details");
    details.className = `video-group video-group-${group.className}`;
    details.open = group.status !== "past";

    const summary = document.createElement("summary");
    summary.className = "video-group-heading";
    summary.innerHTML = `${group.label} <span class="count">${groupItems.length}</span>`;
    details.appendChild(summary);

    const grid = document.createElement("div");
    grid.className = "video-grid";
    groupItems.forEach((item) => grid.appendChild(makeVideoCard(item)));
    details.appendChild(grid);

    body.appendChild(details);
  });
}

function makeVideoCard(item) {
  const card = document.createElement("div");
  card.className = "video-card";

  const thumbBtn = document.createElement("button");
  thumbBtn.className = "video-card-thumb";
  thumbBtn.setAttribute("aria-label", `Play trailer: ${item.title}`);
  thumbBtn.style.backgroundImage = `url(https://img.youtube.com/vi/${item.videoId}/hqdefault.jpg)`;

  const playIcon = document.createElement("span");
  playIcon.className = "video-card-play";
  playIcon.textContent = "▶";
  thumbBtn.appendChild(playIcon);

  const wrapper = document.createElement("div");
  wrapper.className = "video-card-frame-wrap";
  const iframe = document.createElement("iframe");
  iframe.title = `${item.title} trailer`;
  iframe.frameBorder = "0";
  iframe.allow =
    "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
  iframe.referrerPolicy = "strict-origin-when-cross-origin";
  iframe.allowFullscreen = true;
  wrapper.appendChild(iframe);

  thumbBtn.addEventListener("click", () => {
    const isOpen = card.classList.contains("open");
    closeAllVideoCards(card);
    card.classList.toggle("open", !isOpen);
    iframe.src = isOpen ? "" : item.embedUrl;
  });

  const caption = document.createElement("div");
  caption.className = "video-card-caption";
  const titleEl = document.createElement("div");
  titleEl.className = "video-card-title";
  titleEl.textContent = item.title;
  caption.appendChild(titleEl);
  if (item.performer) {
    const perfEl = document.createElement("div");
    perfEl.className = "video-card-performer";
    if (item.performerUrl) {
      const a = document.createElement("a");
      a.href = item.performerUrl;
      a.target = "_blank";
      a.rel = "noopener";
      a.className = "video-card-performer-link";
      a.textContent = item.performer;
      perfEl.appendChild(a);
    } else {
      perfEl.textContent = item.performer;
    }
    caption.appendChild(perfEl);
  }
  if (item.dateStr || item.venue) {
    const metaEl = document.createElement("div");
    metaEl.className = "video-card-meta";
    metaEl.textContent = [item.dateStr, item.venue].filter(Boolean).join(" · ");
    caption.appendChild(metaEl);
  }

  card.appendChild(thumbBtn);
  card.appendChild(wrapper);
  card.appendChild(caption);
  return card;
}

// ── Lightbox ──────────────────────────────────────────────────────────────
function openLightbox(visibleItems, index) {
  lbItems = visibleItems;
  lbIndex = index;
  showLbSlide();
  document.getElementById("lightbox").classList.add("open");
  document.addEventListener("keydown", lbKey);
}

function closeLightbox() {
  document.getElementById("lightbox").classList.remove("open");
  document.removeEventListener("keydown", lbKey);
}

function showLbSlide() {
  const item = lbItems[lbIndex];
  const img = document.getElementById("lightbox-img");
  img.src =
    item.flyerBase === "club"
      ? `${BASE_CLUB}${sanitizeFlyerPath(item.flyer)}`
      : `${BASE_EVENT}${sanitizeFlyerPath(item.flyer)}`;
  img.alt = item.name;

  let dateLine = "";
  if (item.isClubGeneric)
    dateLine = item.schedule
      ? `Meets ${escapeHtml(item.schedule)}`
      : "Regular club";
  else if (item.tourDateRange)
    dateLine = `${escapeHtml(item.tourDateRange)} (${escapeHtml(String(item.tourDateCount))} dates)`;
  else dateLine = formatDate(item.date);

  const dest = resolveLink(item);
  const cal = calendarLink(item);
  const destLabel =
    dest === item.ticketUrl?.trim()
      ? "Tickets →"
      : item.type === "club" && item.clubLink?.trim()
        ? "Club website →"
        : dest === item.performerUrl?.trim()
          ? "Performer website →"
          : dest
            ? "More info →"
            : "";

  document.getElementById("lightbox-caption").innerHTML = `
<div class="lb-title">${escapeHtml(item.name)}</div>
${item.performer ? `<div class="lb-performer">${escapeHtml(item.performer)}</div>` : ""}
${item.venue ? `<div class="lb-meta">${escapeHtml(item.venue)}${item.city ? ", " + escapeHtml(item.city) : ""}</div>` : ""}
<div class="lb-meta">${dateLine}</div>
<div class="lb-actions">
    ${dest ? `<a href="${dest}" target="_blank" rel="noopener noreferrer" class="lb-actions-primary">${destLabel}</a>` : ""}
    <a href="${cal}" target="_blank" rel="noopener noreferrer" class="lb-actions-secondary">📅 Events calendar</a>
</div>
`;
  document.getElementById("lb-prev").disabled = lbIndex <= 0;
  document.getElementById("lb-next").disabled = lbIndex >= lbItems.length - 1;
}

function lbKey(e) {
  if (e.key === "Escape") closeLightbox();
  if (e.key === "ArrowLeft" && lbIndex > 0) {
    lbIndex--;
    showLbSlide();
  }
  if (e.key === "ArrowRight" && lbIndex < lbItems.length - 1) {
    lbIndex++;
    showLbSlide();
  }
}

document.getElementById("lightbox-close").onclick = closeLightbox;
document.getElementById("lightbox").addEventListener("click", (e) => {
  if (e.target === document.getElementById("lightbox")) closeLightbox();
});
document.getElementById("lb-prev").onclick = () => {
  if (lbIndex > 0) {
    lbIndex--;
    showLbSlide();
  }
};
document.getElementById("lb-next").onclick = () => {
  if (lbIndex < lbItems.length - 1) {
    lbIndex++;
    showLbSlide();
  }
};

// ── Link resolution — priority order by type ─────────────────────────────
// story/music/poetry: ticket → performer site → club site → fb event
// tour:        ticket → performer site → fb event
// club:        club site → performer site → club facebook
// festival:    ticket → festival website → festival facebook
function resolveLink(item) {
  const t = item.ticketUrl?.trim();
  const p = item.performerUrl?.trim();
  const c = item.clubLink?.trim();
  const fb = item.fbEvent?.trim();
  const cf = item.clubFacebook?.trim();
  const fw = item.festWebsite?.trim();
  const ff = item.festFacebook?.trim();

  if (
    item.type === "story" ||
    item.type === "music" ||
    item.type === "poetry"
  ) {
    return t || p || c || fb || "";
  }
  if (item.type === "tour") {
    // For a tour-level flyer (multiple dates), the performer site is the
    // best primary link; tickets belong to individual dates, not the tour.
    // For a single-date tour card, ticket is fine as primary.
    if (item.tourDateCount > 1) {
      return p || fw || t || fb || "";
    }
    return t || p || fb || "";
  }
  if (item.type === "club") {
    return c || p || cf || "";
  }
  if (item.type === "festival") {
    return t || fw || ff || "";
  }
  return t || p || "";
}

const TYPE_LABELS = {
  story: "Story show",
  club: "Club",
  tour: "Tour",
  music: "Music",
  poetry: "Poetry",
  festival: "Festival",
};

function makeCard(item, visibleItems, indexInVisible, highlightSoldOut = true) {
  const card = document.createElement("div");
  let cls = "flyer-card";
  if (item.isPast && !item.isClubGeneric) cls += " past";
  if (item.isTonight) cls += " tonight";
  if (item.isTomorrow) cls += " tomorrow";
  if (item.isCancelled) cls += " cancelled";
  card.className = cls;
  card.dataset.type = item.type;

  // Image wrapper with lazy image
  const wrap = document.createElement("div");
  wrap.className = "flyer-img-wrap";

  const img = document.createElement("img");
  img.dataset.src =
    item.flyerBase === "club"
      ? `${BASE_CLUB}${sanitizeFlyerPath(item.flyer)}`
      : `${BASE_EVENT}${sanitizeFlyerPath(item.flyer)}`;
  img.alt = item.name;
  imgLoader.observe(img);
  wrap.appendChild(img);

  if (item.isCancelled) {
    const b = document.createElement("span");
    b.className = "status-banner cancelled-banner";
    b.textContent = "Cancelled";
    wrap.appendChild(b);
  } else if (item.isSoldOut && highlightSoldOut) {
    const b = document.createElement("span");
    b.className = "status-banner sold-out-banner";
    b.textContent = "Sold out";
    wrap.appendChild(b);
  }

  const badge = document.createElement("span");
  badge.className = "type-badge";
  badge.textContent = TYPE_LABELS[item.type] || item.type;
  wrap.appendChild(badge);

  card.appendChild(wrap);

  // Caption
  const cap = document.createElement("div");
  cap.className = "flyer-caption";

  if (item.isCancelled) {
    const s = document.createElement("div");
    s.className = "caption-status cancelled";
    s.textContent = "❌ Cancelled";
    cap.appendChild(s);
  } else if (item.isSoldOut && highlightSoldOut) {
    const s = document.createElement("div");
    s.className = "caption-status sold-out";
    s.textContent = "🔴 Sold out";
    cap.appendChild(s);
  }

  const dateEl = document.createElement("div");
  dateEl.className = "flyer-date";
  if (item.isTonight || item.isTomorrow) {
    const urgency = document.createElement("div");
    urgency.className = "urgency-label";
    urgency.textContent = item.isTonight ? "🔴 Tonight!" : "🟠 Tomorrow";
    dateEl.appendChild(urgency);

    // For tour flyers add the specific date's venue + time;
    // for club generics the card venue is already the right one
    const spotlight = item.isTonight
      ? item.tonightSpotlight
      : item.tomorrowSpotlight;
    if (item.type === "tour" && spotlight) {
      const detail = document.createElement("div");
      detail.className = "urgency-detail";
      const parts = [spotlight.venue, spotlight.city]
        .filter(Boolean)
        .join(", ");
      detail.textContent =
        parts + (spotlight.time ? " · " + spotlight.time : "");
      dateEl.appendChild(detail);
    } else if (item.type === "club" && (item.venue || item.city)) {
      const detail = document.createElement("div");
      detail.className = "urgency-detail";
      detail.textContent =
        [item.venue, item.city].filter(Boolean).join(", ") +
        (item.schedule ? " · " + item.schedule : "");
      dateEl.appendChild(detail);
    }
  }
  const dateText = document.createElement("span");
  if (item.isClubGeneric)
    dateText.textContent = item.schedule
      ? `Meets ${item.schedule}`
      : "Regular club";
  else if (item.tourDateRange)
    dateText.textContent = `${item.tourDateRange} · ${item.tourDateCount} dates`;
  else dateText.textContent = formatDate(item.date);
  dateEl.appendChild(dateText);
  cap.appendChild(dateEl);

  const title = document.createElement("div");
  title.className = "flyer-title";
  title.textContent = item.name;
  cap.appendChild(title);

  if (item.performer) {
    const p = document.createElement("div");
    p.className = "flyer-performer";
    p.textContent = item.performer;
    cap.appendChild(p);
  }

  if (item.venue) {
    const v = document.createElement("div");
    v.className = "flyer-venue";
    v.textContent = item.venue + (item.city ? `, ${item.city}` : "");
    cap.appendChild(v);
  }

  const cardDest = resolveLink(item);
  if (cardDest) {
    const actions = document.createElement("div");
    actions.className = "flyer-actions";
    const a = document.createElement("a");
    a.href = cardDest;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent =
      cardDest === item.ticketUrl?.trim()
        ? "Tickets →"
        : item.type === "club" && item.clubLink?.trim()
          ? "Club website →"
          : cardDest === item.performerUrl?.trim()
            ? "Performer →"
            : "More info →";
    a.addEventListener("click", (e) => e.stopPropagation());
    actions.appendChild(a);
    cap.appendChild(actions);
  }

  card.appendChild(cap);

  // Image click → best link, or calendar as fallback, lightbox only if truly nothing
  const cal = calendarLink(item);
  wrap.style.cursor = "pointer";
  wrap.addEventListener("click", (e) => {
    e.stopPropagation();
    window.open(cardDest || cal, "_blank", "noopener,noreferrer");
  });

  // Caption / title area always opens lightbox for full flyer view
  cap.style.cursor = "zoom-in";
  cap.addEventListener("click", (e) => {
    e.stopPropagation();
    openLightbox(visibleItems, indexInVisible);
  });

  attachContextMenu(card, item);
  return card;
}

// ── Tour filter ───────────────────────────────────────────────────────────
function populateTourDropdown() {
  const sel = document.getElementById("tourFilterSelect");
  // Collect tours that actually have flyers in allItems
  const tourItems = allItems.filter((i) => i.type === "tour" && i.tourKey);
  if (!tourItems.length) return;

  // Build map: tourKey → "Artist — Tour name"
  const tourMap = new Map();
  tourItems.forEach((i) => {
    if (!tourMap.has(i.tourKey)) {
      const label = i.performer ? `${i.performer} — ${i.name}` : i.name;
      tourMap.set(i.tourKey, label);
    }
  });

  // Sort by display label
  const sorted = [...tourMap.entries()].sort((a, b) =>
    a[1].localeCompare(b[1]),
  );
  sorted.forEach(([key, name]) => {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = name;
    sel.appendChild(opt);
  });

  // Show the tour filter bar and pre-select if URL had ?tour=
  document.getElementById("tourFilterBar").style.display = "";
  if (activeTourKey) {
    sel.value = activeTourKey;
    syncTourFilterUI();
  }
}

function handleTourFilterChange() {
  activeTourKey = document.getElementById("tourFilterSelect").value;
  syncTourFilterUI();
  writeUrlParams();
  renderAll();
}

function clearTourFilter() {
  activeTourKey = "";
  document.getElementById("tourFilterSelect").value = "";
  syncTourFilterUI();
  writeUrlParams();
  renderAll();
}

function syncTourFilterUI() {
  const sel = document.getElementById("tourFilterSelect");
  const clearBtn = document.getElementById("tourFilterClear");
  sel.classList.toggle("active", !!activeTourKey);
  clearBtn.classList.toggle("visible", !!activeTourKey);
}

// ── Render ────────────────────────────────────────────────────────────────
// Shared by both flyer cards (renderAll) and video trailers
// (renderVideoTrailers) so a type/tour filter change is reflected
// identically everywhere on the page.
function isItemTypeVisible(item) {
  return (
    activeTypes.has(item.type) ||
    (item.type === "tour" && item.isMusic && activeTypes.has("music")) ||
    (item.type === "tour" && item.isPoetry && activeTypes.has("poetry"))
  );
}
function isItemTourVisible(item) {
  return !activeTourKey || item.tourKey === activeTourKey;
}

function renderAll() {
  const root = document.getElementById("page-content");
  const hideCancelled =
    document.getElementById("hideCancelled")?.checked ?? true;
  const highlightSoldOut =
    document.getElementById("highlightSoldOut")?.checked ?? true;

  let visible = allItems.filter(isItemTypeVisible);

  if (hideCancelled) visible = visible.filter((i) => !i.isCancelled);

  // Apply tour key filter — only show flyers belonging to the selected tour
  if (activeTourKey) {
    visible = visible.filter(isItemTourVisible);
  }

  renderVideoTrailers();

  root.innerHTML = "";

  if (!visible.length) {
    root.innerHTML = `<p class="no-flyers">${
      activeTypes.size === 0
        ? "No types selected — use the filters above."
        : "No flyers to show for the selected types."
    }</p>`;
    return;
  }

  const upcoming = visible.filter((i) => !i.isPast || i.isClubGeneric);
  const recentPast = visible
    .filter((i) => i.isPast && !i.isClubGeneric && !i.isOld)
    .reverse();
  const olderPast = visible
    .filter((i) => i.isPast && !i.isClubGeneric && i.isOld)
    .reverse();

  function section(heading, items, isPast) {
    if (!items.length) return;
    const h = document.createElement("h2");
    h.className = "section-heading" + (isPast ? " past" : "");
    h.innerHTML = `${heading} <span class="count">${items.length} flyer${items.length !== 1 ? "s" : ""}</span>`;
    root.appendChild(h);
    const grid = document.createElement("div");
    grid.className = "flyer-grid";
    items.forEach((item) => {
      grid.appendChild(
        makeCard(item, visible, visible.indexOf(item), highlightSoldOut),
      );
    });
    root.appendChild(grid);
  }

  section("Upcoming", upcoming, false);
  section("Recent past", recentPast, true);

  // Older flyers (beyond the ~3 month "recent" window) — collapsed by
  // default and revealed a page at a time on open/click, rather than
  // silently discarded, so the archive is still reachable without
  // dumping potentially hundreds of cards into the DOM up front.
  if (olderPast.length > 0) {
    const details = document.createElement("details");
    details.className = "older-flyers-details";

    const summary = document.createElement("summary");
    summary.className = "older-flyers-summary";
    summary.innerHTML = `📜 Older Flyers <span class="count">${olderPast.length} flyer${olderPast.length !== 1 ? "s" : ""}</span>`;
    details.appendChild(summary);

    const body = document.createElement("div");
    body.className = "older-flyers-body";
    details.appendChild(body);

    const PAGE_SIZE = 24;
    let shown = 0;
    let grid = null;
    let loadMoreBtn = null;

    function renderNextPage() {
      if (!grid) {
        grid = document.createElement("div");
        grid.className = "flyer-grid";
        body.appendChild(grid);
      }
      const batch = olderPast.slice(shown, shown + PAGE_SIZE);
      batch.forEach((item) => {
        grid.appendChild(
          makeCard(item, visible, visible.indexOf(item), highlightSoldOut),
        );
      });
      shown += batch.length;

      if (loadMoreBtn) loadMoreBtn.remove();
      if (shown < olderPast.length) {
        loadMoreBtn = document.createElement("button");
        loadMoreBtn.type = "button";
        loadMoreBtn.className = "load-more-flyers-btn";
        const remaining = olderPast.length - shown;
        loadMoreBtn.textContent = `Load ${Math.min(PAGE_SIZE, remaining)} more (${remaining} remaining)`;
        loadMoreBtn.addEventListener("click", renderNextPage);
        body.appendChild(loadMoreBtn);
      }
    }

    // Render the first page lazily, only once the section is
    // actually opened, so we don't build cards no one asked to see.
    details.addEventListener("toggle", () => {
      if (details.open && shown === 0) renderNextPage();
    });

    root.appendChild(details);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────
(async () => {
  readUrlParams();
  syncFilterButtons();

  // Show spinner only if no cache exists
  if (!getSchedulesCache()) {
    document.getElementById("page-content").innerHTML =
      '<p class="status-message status-message--loading">⏳ Loading flyers…</p>';
  }

  try {
    allItems = await loadFlyers();
  } catch (e) {
    console.error("flyers.html boot error:", e);
    document.getElementById("page-content").innerHTML =
      `<p class="status-message status-message--error">Could not load events data.<br><small>${e.message}</small></p>`;
    return;
  }

  // Defer heavy rendering to allow browser to paint loading state first
  setTimeout(() => {
    populateTourDropdown();
    renderAll(); // also renders/filters video trailers — see isItemTypeVisible/isItemTourVisible
    // Mark as cached — valid until date/month boundary crosses
    setSchedulesCache({ computed: true });
  }, 0);
})();
