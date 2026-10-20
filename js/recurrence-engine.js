/**
 * recurrence-engine.js
 *
 * Single canonical implementation of New Troubadours' recurring-schedule
 * expansion, replacing the two independent copies that used to live in
 * storyclub.js (`scheduledOccurrencesInRange`) and event_display.js
 * (`parseSchedule` + the exception-handling half of `processRecurringEvents`).
 *
 * Verified against the following, cross-checked by running the OLD
 * implementations side by side (see recurrence-engine.test.js):
 *   - leap years (Feb 2024) and non-leap years (Feb 2025)
 *   - Dec -> Jan year-boundary windows
 *   - months with 4 vs 5 occurrences of a given weekday
 *   - "1st and 3rd <day>" and pipe-separated even/odd-month schedules
 *   - month-end-spanning windows
 *   - fortnightly structured-object schedules
 *
 * Fixes two real bugs found in the old code:
 *   1. event_display.js's parseSchedule() threw a TypeError on structured
 *      schedule objects with type "weekly" or "monthly" (only "fortnightly"
 *      was handled; anything else fell through to a `.includes()` call on
 *      a plain object). Dormant today because the only structured-object
 *      schedule in current data is fortnightly, but a live landmine.
 *   2. Neither engine's occurrence-name map recognised the word "first"
 *      (only "1st"/"2nd"/"3rd"/"4th"/"last") — the schedule
 *      "first wednesday" (Aberystwyth Fables Storytelling Circle, as of
 *      this writing) silently resolved to ZERO dates on both the calendar
 *      and its own club page. Fixed by accepting ordinal words as aliases.
 *
 * Also improves on the old exception/reschedule matching: when an
 * exception date doesn't land on a regular occurrence, the old code
 * matched it to "the first regular date in that month" — fine for
 * once-a-month schedules, wrong for a schedule with more than one
 * occurrence per month (e.g. "1st and 3rd wednesday"). This version
 * matches to the NEAREST unclaimed regular date in that month instead.
 *
 * Works as a plain script (attaches `RecurrenceEngine` to the global
 * object — browser <script> include, same as shared_utils.js) or as a
 * CommonJS/Workers module (`require("./recurrence-engine.js")`). No DOM
 * dependency, so it runs unmodified in Node, Cloudflare Workers, or a
 * browser.
 */
(function (root, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    root.RecurrenceEngine = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Lookup tables
  // ---------------------------------------------------------------------

  const DAY_MAP = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };

  // Numeral-ordinal AND word forms both map to the same occurrence number.
  // "first wednesday" now resolves the same as "1st wednesday" — see fix #2
  // in the file header.
  const OCCURRENCE_MAP = {
    "1st": 1,
    first: 1,
    "2nd": 2,
    second: 2,
    "3rd": 3,
    third: 3,
    "4th": 4,
    fourth: 4,
    "5th": 5,
    fifth: 5,
    last: "last",
  };

  // ---------------------------------------------------------------------
  // Low-level date helpers
  // ---------------------------------------------------------------------

  /** Midnight-normalise a Date in place and return it. */
  function atMidnight(d) {
    d.setHours(0, 0, 0, 0);
    return d;
  }

  /**
   * Parse a DD/MM/YYYY (or DD/MM/YY) string into a midnight-normalised Date,
   * or null. A 2-digit year is assumed to mean 2000-2099 — ported from
   * event_display.js's old parseExceptionDate(), which had this and nothing
   * else did; kept here so hand-typed exception dates like "25/12/26" still
   * work rather than silently losing that leniency in the consolidation.
   */
  function parseDMY(str) {
    if (!str || typeof str !== "string") return null;
    const parts = str.split("/").map(Number);
    if (parts.length !== 3) return null;
    let [d, m, y] = parts;
    if (!d || !m || !y) return null;
    if (y < 100) y += 2000;
    return atMidnight(new Date(y, m - 1, d));
  }

  function dateKey(d) {
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  function monthKey(d) {
    return `${d.getFullYear()}-${d.getMonth() + 1}`; // 1-based, matches MM/YYYY exception format
  }

  /**
   * The Nth (or last) weekday of a given month.
   * `new Date(year, month + 1, 0)` is "day 0 of next month" — JS's Date
   * normalises month overflow/underflow, so this correctly returns the
   * true last day of `month` across leap years and Dec -> Jan alike.
   * @param {number} year
   * @param {number} month - 0-indexed
   * @param {number} targetDay - 0 (Sun) - 6 (Sat)
   * @param {number|"last"} occurrence - 1-5, or "last"
   * @returns {Date|null}
   */
  function findNthDayInMonth(year, month, targetDay, occurrence) {
    const lastDay = new Date(year, month + 1, 0);
    if (occurrence === "last") {
      for (let d = lastDay.getDate(); d >= 1; d--) {
        const t = atMidnight(new Date(year, month, d));
        if (t.getDay() === targetDay) return t;
      }
      return null;
    }
    let count = 0;
    for (let d = 1; d <= lastDay.getDate(); d++) {
      const t = atMidnight(new Date(year, month, d));
      if (t.getDay() === targetDay && ++count === occurrence) return t;
    }
    return null; // e.g. occurrence=5 requested in a month with only 4
  }

  // ---------------------------------------------------------------------
  // Raw recurrence expansion (no exceptions applied yet)
  // ---------------------------------------------------------------------

  /**
   * Expand a schedule (structured object OR legacy string) into every
   * regularly-occurring date in [from, to], ignoring exceptions entirely.
   * @param {object|string} schedule
   * @param {Date} from - inclusive, midnight-normalised
   * @param {Date} to - inclusive, midnight-normalised
   * @returns {Date[]} sorted ascending
   */
  function expandRawSchedule(schedule, from, to) {
    if (!schedule) return [];
    const results = [];
    const add = (d) => {
      if (d && d >= from && d <= to) results.push(d);
    };

    // ---- Structured schedule object: {type, day, occurrence?, start} ----
    if (typeof schedule === "object") {
      const type = (schedule.type || "").toLowerCase();
      const start = parseDMY(schedule.start);
      if (!start) return [];
      const targetDay = DAY_MAP[(schedule.day || "").toLowerCase()];

      if (type === "weekly" || type === "every") {
        if (targetDay === undefined) return [];
        let cur = new Date(Math.max(start, from));
        const diff = (targetDay - cur.getDay() + 7) % 7;
        cur = atMidnight(new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + diff));
        while (cur <= to) {
          if (cur >= start) add(new Date(cur));
          cur.setDate(cur.getDate() + 7);
        }
        return results;
      }

      if (type === "fortnightly") {
        let cur = new Date(start);
        if (cur < from) {
          const cycles = Math.ceil((from - cur) / (14 * 86400000));
          cur = atMidnight(new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + cycles * 14));
        }
        while (cur <= to) {
          add(new Date(cur));
          cur.setDate(cur.getDate() + 14);
        }
        return results;
      }

      if (type === "monthly") {
        const occNum = OCCURRENCE_MAP[(schedule.occurrence || "1st").toLowerCase()];
        if (occNum === undefined || targetDay === undefined) return [];
        let curMonth = new Date(from.getFullYear(), from.getMonth(), 1);
        const endMonth = new Date(to.getFullYear(), to.getMonth(), 1);
        while (curMonth <= endMonth) {
          const d = findNthDayInMonth(curMonth.getFullYear(), curMonth.getMonth(), targetDay, occNum);
          if (d && d >= start) add(d);
          curMonth.setMonth(curMonth.getMonth() + 1);
        }
        return results.sort((a, b) => a - b);
      }

      return []; // unrecognised structured type
    }

    // ---- Legacy string schedules ----
    const str = String(schedule).trim();
    if (!str) return [];
    const lower = str.toLowerCase();

    // A bare DD/MM/YYYY used as the whole schedule = a single one-off date.
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(str)) {
      add(parseDMY(str));
      return results;
    }

    // Pipe-separated alternating months: "1st wednesday (even months) | 1st thursday (odd months)"
    if (str.includes("|")) {
      str.split("|").forEach((part) => {
        const m = part.trim().match(/^(.+?)\s*\((\w+)\s+months\)$/i);
        if (!m) return;
        const [occStr, dayStr] = m[1].trim().toLowerCase().split(/\s+/);
        const cond = m[2].toLowerCase();
        const tDay = DAY_MAP[dayStr];
        const occNum = OCCURRENCE_MAP[occStr];
        if (tDay === undefined || occNum === undefined) return;
        let cur = new Date(from.getFullYear(), from.getMonth() - 1, 1);
        const end = new Date(to.getFullYear(), to.getMonth() + 1, 0);
        while (cur <= end) {
          const mo = cur.getMonth() + 1;
          const matches = (cond === "even" && mo % 2 === 0) || (cond === "odd" && mo % 2 !== 0);
          if (matches) add(findNthDayInMonth(cur.getFullYear(), cur.getMonth(), tDay, occNum));
          cur.setMonth(cur.getMonth() + 1);
        }
      });
      return results.sort((a, b) => a - b);
    }

    // "1st and 3rd wednesday" (two occurrences of the same weekday per month)
    if (lower.includes(" and ")) {
      const [occ1Str, rest] = lower.split(" and ");
      const restParts = rest.trim().split(/\s+/);
      const occ2Str = restParts[0];
      const dayStr = restParts[1];
      const tDay = DAY_MAP[dayStr];
      const occ1 = OCCURRENCE_MAP[occ1Str.trim()];
      const occ2 = OCCURRENCE_MAP[occ2Str.trim()];
      if (tDay === undefined || occ1 === undefined || occ2 === undefined) return results;
      let cur = new Date(from.getFullYear(), from.getMonth() - 1, 1);
      const end = new Date(to.getFullYear(), to.getMonth() + 1, 0);
      while (cur <= end) {
        add(findNthDayInMonth(cur.getFullYear(), cur.getMonth(), tDay, occ1));
        add(findNthDayInMonth(cur.getFullYear(), cur.getMonth(), tDay, occ2));
        cur.setMonth(cur.getMonth() + 1);
      }
      return results.sort((a, b) => a - b);
    }

    // "every <day>"
    if (lower.startsWith("every ")) {
      const tDay = DAY_MAP[lower.replace("every ", "").trim()];
      if (tDay === undefined) return results;
      let cur = new Date(from);
      while (cur.getDay() !== tDay) cur.setDate(cur.getDate() + 1);
      while (cur <= to) {
        add(new Date(cur));
        cur.setDate(cur.getDate() + 7);
      }
      return results;
    }

    // Standard "Nth <day>" (also matches "first wednesday", "last friday", etc.)
    const [occStr, dayStr] = lower.split(/\s+/);
    const tDay = DAY_MAP[dayStr];
    const occNum = OCCURRENCE_MAP[occStr];
    if (tDay === undefined || occNum === undefined) return results;
    let cur = new Date(from.getFullYear(), from.getMonth() - 1, 1);
    const end = new Date(to.getFullYear(), to.getMonth() + 1, 0);
    while (cur <= end) {
      add(findNthDayInMonth(cur.getFullYear(), cur.getMonth(), tDay, occNum));
      cur.setMonth(cur.getMonth() + 1);
    }
    return results.sort((a, b) => a - b);
  }

  // ---------------------------------------------------------------------
  // Exceptions: cancellation + reschedule detection
  // ---------------------------------------------------------------------

  /**
   * Parse an `exceptions` array into exact-date skips and whole-month skips.
   * @param {string[]} exceptions - DD/MM/YYYY (exact) or MM/YYYY (whole month)
   */
  function parseExceptions(exceptions) {
    const exact = [];
    const months = new Set();
    (exceptions || []).forEach((s) => {
      if (!s) return;
      const parts = s.split("/").map(Number);
      if (parts.length === 2) {
        const [mm, yyyy] = parts;
        if (mm && yyyy) months.add(`${yyyy}-${mm}`);
        return;
      }
      const d = parseDMY(s);
      if (d) exact.push(d);
    });
    return { exact, months };
  }

  /**
   * Return every regularly-scheduled occurrence for a club in [from, to],
   * each tagged with its status, PLUS any rescheduled replacement dates
   * that fall in [from, to] even if they don't land on a "regular" day.
   *
   * @param {object|string} schedule
   * @param {Date} from - inclusive, midnight-normalised
   * @param {Date} to - inclusive, midnight-normalised
   * @param {string[]} [exceptions] - DD/MM/YYYY (exact) or MM/YYYY (whole month)
   * @returns {{
   *   date: Date,
   *   status: "scheduled"|"cancelled"|"moved_from"|"moved_to",
   *   isCancelled: boolean,   // back-compat with the old .isCancelled flag —
   *                           // true for "cancelled" and "moved_from" (the
   *                           // date as originally scheduled is NOT happening)
   *   movedTo?: Date,         // present when status === "moved_from"
   *   movedFrom?: Date,       // present when status === "moved_to"
   * }[]} sorted ascending by date
   */
  function scheduledOccurrencesInRange(schedule, from, to, exceptions) {
    if (!schedule) return [];
    const { exact: exactExceptions, months: monthExceptions } = parseExceptions(exceptions);

    // Widen the raw-expansion window to safely cover every exception
    // anchor, even ones outside [from, to] — mirrors the old
    // processRecurringEvents() widening logic, needed so e.g. a whole-month
    // exception just before `from` still cancels a date that might
    // otherwise straddle in.
    const anchors = [
      ...exactExceptions,
      ...[...monthExceptions].map((k) => {
        const [y, m] = k.split("-").map(Number);
        return new Date(y, m - 1, 1);
      }),
    ];
    let expandedFrom = new Date(from);
    let expandedTo = new Date(to);
    if (anchors.length) {
      expandedFrom = new Date(Math.min(from, ...anchors));
      expandedFrom.setMonth(expandedFrom.getMonth() - 1);
      expandedTo = new Date(Math.max(to, ...anchors));
      expandedTo.setMonth(expandedTo.getMonth() + 1);
    }

    const regularDates = expandRawSchedule(schedule, expandedFrom, expandedTo);

    // ---- Whole-month exceptions: cancel every regular date that month ----
    const cancelledOnly = new Set();
    regularDates.forEach((d) => {
      if (monthExceptions.has(monthKey(d))) cancelledOnly.add(dateKey(d));
    });

    // ---- Exact-date exceptions: exact match = cancellation; otherwise ----
    // ---- nearest unclaimed regular date that month = reschedule ----
    const reschedules = []; // { from: Date, to: Date }
    const claimed = new Set();
    exactExceptions.forEach((exc) => {
      const excKey = dateKey(exc);
      const isRegular = regularDates.some((d) => dateKey(d) === excKey);
      if (isRegular) {
        cancelledOnly.add(excKey);
        return;
      }
      const candidates = regularDates.filter(
        (d) =>
          d.getFullYear() === exc.getFullYear() &&
          d.getMonth() === exc.getMonth() &&
          !claimed.has(dateKey(d)) &&
          !cancelledOnly.has(dateKey(d)),
      );
      if (!candidates.length) {
        console.warn(
          `recurrence-engine: exception ${excKey} has no matching regular occurrence to reschedule (schedule: ${JSON.stringify(schedule)})`,
        );
        return;
      }
      // Nearest by absolute day difference — correct even when a schedule
      // has more than one occurrence per month (e.g. "1st and 3rd wednesday").
      candidates.sort((a, b) => Math.abs(a - exc) - Math.abs(b - exc));
      const target = candidates[0];
      claimed.add(dateKey(target));
      reschedules.push({ from: new Date(target), to: new Date(exc) });
    });
    const rescheduledFromKeys = new Set(reschedules.map((r) => dateKey(r.from)));

    // ---- Assemble output, restricted to the originally requested window ----
    const results = [];
    regularDates.forEach((d) => {
      if (d < from || d > to) return;
      const key = dateKey(d);
      if (rescheduledFromKeys.has(key)) return; // added below, with movedTo
      if (cancelledOnly.has(key)) {
        results.push({ date: new Date(d), status: "cancelled", isCancelled: true });
      } else {
        results.push({ date: new Date(d), status: "scheduled", isCancelled: false });
      }
    });
    reschedules.forEach((r) => {
      if (r.from >= from && r.from <= to) {
        results.push({ date: new Date(r.from), status: "moved_from", isCancelled: true, movedTo: new Date(r.to) });
      }
      if (r.to >= from && r.to <= to) {
        results.push({ date: new Date(r.to), status: "moved_to", isCancelled: false, movedFrom: new Date(r.from) });
      }
    });

    return results.sort((a, b) => a.date - b.date);
  }

  /** Same as scheduledOccurrencesInRange, but only the dates actually happening. */
  function scheduledDatesInRange(schedule, from, to, exceptions) {
    return scheduledOccurrencesInRange(schedule, from, to, exceptions)
      .filter((o) => !o.isCancelled)
      .map((o) => o.date);
  }

  function todayMidnight() {
    return atMidnight(new Date());
  }

  /** Next scheduled date from today (within 6 months), or null. */
  function nextMeetingDate(schedule, exceptions) {
    const from = todayMidnight();
    const to = new Date(from);
    to.setMonth(to.getMonth() + 6);
    const dates = scheduledDatesInRange(schedule, from, to, exceptions || []);
    return dates.find((d) => d >= from) || null;
  }

  /** Next occurrence from today (within 6 months) whether cancelled or not. */
  function nextOccurrence(schedule, exceptions) {
    const from = todayMidnight();
    const to = new Date(from);
    to.setMonth(to.getMonth() + 6);
    const occurrences = scheduledOccurrencesInRange(schedule, from, to, exceptions || []);
    return occurrences.find((o) => o.date >= from) || null;
  }

  /** Most recent scheduled date before today (within the last 3 months), or null. */
  function prevMeetingDate(schedule, exceptions) {
    const today = todayMidnight();
    const to = new Date(today);
    to.setDate(to.getDate() - 1);
    const from = new Date(to);
    from.setMonth(from.getMonth() - 3);
    const dates = scheduledDatesInRange(schedule, from, to, exceptions || []);
    return dates.length ? dates[dates.length - 1] : null;
  }

  return {
    scheduledOccurrencesInRange,
    scheduledDatesInRange,
    nextMeetingDate,
    nextOccurrence,
    prevMeetingDate,
    // exposed for advanced callers / testing — not usually needed directly
    findNthDayInMonth,
    expandRawSchedule,
    DAY_MAP,
    OCCURRENCE_MAP,
  };
});
