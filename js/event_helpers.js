/**
 * event_helpers.js — small PURE helpers for reading records from events_normalized.json.
 *
 * No DOM, no globals, no storage, no side effects: everything a function needs is passed in.
 * gig_planner.js uses it. tour_planner.js does NOT load this file, so it is unaffected; it
 * could adopt these later (bill roles, troupe handling, multi-date records) without any
 * change here.
 */
const EventHelpers = (() => {
  const asArray = (x) => (Array.isArray(x) ? x : typeof x === "string" && x ? [x] : []);

  /**
   * Who is on the bill, by role.
   *   head    – performer_id + performer_ids (co-headline), plus other_performer_ids
   *             when the record is flagged isDoubleHeadline
   *   support – support_performer_ids (a lesser billing than the headliner)
   *   also    – other_performer_ids (no billing relationship assumed)
   * A performer appears once, in the highest role they hold. A troupe's members are not
   * repeated beside the troupe itself (they stay in `all`, so searching by a member's name
   * still works). Pass a merged record for a tour date ({ ...tour, ...tourDate }) so a
   * date's own support_performer_ids overrides the tour's, as the schema says.
   * `performers` is the performers lookup (id -> { name, performer_ids? }).
   * Returns { head, support, also, all } as display names, plus { ids } with the performer
   * ids per role (the hook for "played with" relationships).
   */
  function buildBill(e, performers) {
    const P = performers || {};
    const nameOf = (id) => (P[id] && P[id].name) || null;
    const members = (id) => (P[id] && Array.isArray(P[id].performer_ids) ? P[id].performer_ids : []);
    const co = !!e.isDoubleHeadline;
    const seen = new Set();
    const take = (list) => list.filter((id) => id && !seen.has(id) && seen.add(id));
    const ids = {
      head: take([e.performer_id, ...asArray(e.performer_ids), ...(co ? asArray(e.other_performer_ids) : [])]),
      support: take(asArray(e.support_performer_ids)),
      also: take(co ? [] : asArray(e.other_performer_ids)),
    };
    const hidden = new Set(); // troupe members shown via their troupe's own name
    ids.head.forEach((id) => members(id).forEach((m) => { if (m !== id && ids.head.includes(m)) hidden.add(m); }));
    const names = (list, skip) => [...new Set(list.filter((id) => !(skip && skip.has(id))).map(nameOf).filter(Boolean))];
    const bill = {
      head: names(ids.head, hidden), support: names(ids.support), also: names(ids.also),
      all: names([...ids.head, ...ids.support, ...ids.also]), ids,
    };
    if (!bill.all.length && typeof e.performer === "string" && e.performer) { bill.head = [e.performer]; bill.all = [e.performer]; }
    return bill;
  }

  /** One line for plain-text uses (plan text, calendar, export): "A, B, support: C".
   *  `ev` is { performer: "A, B", bill: { support: [...] } }. */
  function billText(ev) {
    const sup = ev.bill && ev.bill.support.length ? "support: " + ev.bill.support.join(", ") : "";
    return [ev.performer, sup].filter(Boolean).join(", ");
  }

  /** Fold a duplicate record's bill into the one being kept, so no act is lost. */
  function mergeBill(keep, other) {
    if (!keep.bill || !other.bill) return;
    ["head", "support", "also"].forEach((r) => other.bill[r].forEach((n) => {
      if (!keep.bill.all.includes(n)) { keep.bill[r].push(n); keep.bill.all.push(n); keep.performerList = keep.bill.all; }
    }));
    keep.performer = [...keep.bill.head, ...keep.bill.also].join(", ");
  }

  /** Every date a record runs on. `e.date` is one "dd/mm/yyyy" string, or an array of them for a
   *  multi-night run; `parse` turns one string into a Date (e.g. parseDateString). Bad dates are dropped. */
  function eventDates(e, parse) {
    return asArray(e && e.date).map((s) => parse(s)).filter(Boolean);
  }

  return { asArray, buildBill, billText, mergeBill, eventDates };
})();
