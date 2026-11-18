/* event_collect.js — every event in a date window, as plain records.
 *
 * Pure and additive: it reads the events data and returns records; it touches no page or planner state.
 * It mirrors what gig_planner.js's gCollect gathers (recurring clubs / folk nights / Irish sessions,
 * dated story / music / poetry events, tour dates, one record per night of a multi-night run, and the
 * same de-duplication) so any page can ask "what is on, and where, between these dates?".
 * The gig planner does not use it yet; the tour planner's clash finder does.
 *
 * Needs these globals (all loaded on the planner pages): EventHelpers (event_helpers.js),
 * RecurrenceEngine, parseDateString and, optionally, resolveClubVenueId / clubIsActiveOn (shared_utils.js).
 *
 *   EventCollect.collect(data, from, to, { venueOk })  -> records, soonest first
 *     record: { id, list, chip, cat, kind, title, bill, performerList, date, time, venue_id, club,
 *               price, soldOut, source: { list, rec, tour } }
 *       list  where it came from: clubs | folkNights | irishSessions | specificEvents | musicEvents | poetryEvents | tours
 *       chip  the kind it counts as when watching for clashes: story | music | poetry | folk | sessions
 *       cat   story | music | poetry | folk (as the gig planner groups them)
 *       kind  "recurring" (a regular night) or "event" (dated)
 *     venueOk(venue_id) lets a caller drop events at venues it can't use.
 */
const EventCollect = (() => {
  const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const same = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

  function collect(ed, from, to, opts) {
    const venueOk = (opts && opts.venueOk) || (() => true);
    const performers = (ed && ed.performers) || {};
    const out = [];
    const push = (ev) => { if (ev.venue_id && venueOk(ev.venue_id)) out.push(ev); };
    const bill = (e) => EventHelpers.buildBill(e, performers);

    // regular nights
    [["clubs", "story", "story"], ["folkNights", "folk", "folk"], ["irishSessions", "folk", "sessions"]].forEach(([list, cat, chip]) =>
      ((ed && ed[list]) || []).forEach((rec) => {
        if (!rec.schedule) return;
        RecurrenceEngine.scheduledOccurrencesInRange(rec.schedule, from, to, rec.exceptions || []).forEach((o) => {
          if (o.status === "cancelled" || o.status === "moved_from") return;
          if (typeof clubIsActiveOn === "function" && list === "clubs" && !clubIsActiveOn(rec, o.date)) return;
          push({
            id: `rec:${list}:${rec.club || rec.folk_id || rec.name}:${key(o.date)}`, list, chip, cat, kind: "recurring",
            title: rec.name, bill: null, performerList: [], date: o.date, time: rec.time || "",
            venue_id: list === "clubs" && typeof resolveClubVenueId === "function" ? resolveClubVenueId(rec, o.date) : rec.venue_id,
            club: list === "clubs" ? rec.club || null : null, price: rec.price || "", soldOut: false,
            source: { list, rec, tour: null },
          });
        });
      }));

    // dated events: one record per night of a multi-night run
    [["specificEvents", "story"], ["musicEvents", "music"], ["poetryEvents", "poetry"]].forEach(([list, cat0]) =>
      ((ed && ed[list]) || []).forEach((e) => {
        if (e.online || e.cancelled || e.isCancelled) return;
        const all = EventHelpers.eventDates(e, parseDateString), multi = all.length > 1;
        const cat = e.isMusic ? "music" : e.isPoetry ? "poetry" : cat0;
        all.filter((d) => d >= from && d <= to).forEach((d) => {
          const b = bill(e);
          push({
            id: `ev:${e.eventId ? e.eventId + (multi ? ":" + key(d) : "") : e.name + key(d)}`, list, chip: cat, cat, kind: "event",
            title: e.showname || e.name, bill: b, performerList: b.all, date: d, time: e.time || "", venue_id: e.venue_id,
            club: e.club || null, price: e.price || "", soldOut: !!e.isSoldOut, source: { list, rec: e, tour: null },
          });
        });
      }));

    // tour dates
    Object.values((ed && ed.tours) || {}).forEach((t) => (t.tour_dates || []).forEach((td) => {
      if (td.cancelled || td.isCancelled) return;
      const all = EventHelpers.eventDates(td, parseDateString), multi = all.length > 1;
      const cat = t.isMusic ? "music" : t.isPoetry ? "poetry" : "story";
      all.filter((d) => d >= from && d <= to).forEach((d) => {
        const b = bill({ ...t, ...td });
        push({
          id: `ev:${td.eventId ? td.eventId + (multi ? ":" + key(d) : "") : (t.tour_name || t.name) + key(d) + td.venue_id}`,
          list: "tours", chip: cat, cat, kind: "event", title: t.tour_name || t.name, bill: b, performerList: b.all, date: d,
          time: td.time || t.time || "", venue_id: td.venue_id, club: null, price: td.price || t.price || "", soldOut: !!td.isSoldOut,
          source: { list: "tours", rec: td, tour: t },
        });
      });
    }));

    // De-duplicate: the same gig can be a tour date AND a specific event, or a one-off on top of a club's
    // regular night. Keep the richer (dated) record and merge the bills.
    const seen = new Map();
    out.sort((a, b) => (a.kind === "event" ? 0 : 1) - (b.kind === "event" ? 0 : 1));
    const keep = [];
    out.forEach((ev) => {
      const k1 = ev.id;
      const k2 = `${ev.venue_id}|${key(ev.date)}`;
      if (seen.has(k1)) { EventHelpers.mergeBill(seen.get(k1), ev); return; }
      const prior = seen.get(k2);
      if (prior && (ev.kind === "recurring" || same(prior.title, ev.title))) { EventHelpers.mergeBill(prior, ev); return; }
      seen.set(k1, ev); seen.set(k2, ev);
      keep.push(ev);
    });
    return keep.sort((a, b) => a.date - b.date || a.title.localeCompare(b.title));
  }

  return { collect };
})();
