# `price_breakdown` and `age_guidance` — proposal notes

Companion doc for `events-schema-costings.json`. That file is a copy of
`events-schema.json` with two additive fields available on every record type
that already carries a price today (`tourDate`, `tour`, `showDate`,
`specificEvent`, `musicEvent`, `recurringClubEvent`, `festival`, `folkNight`,
`spokenWordNight`, `workshop`):

- `price_breakdown` — optional structured detail alongside the existing
  free-text `price` (or `cost`, for workshops) string.
- `age_guidance` — optional free-text content rating/guidance.

**Nothing existing changes.** `price`/`cost` stays exactly as it is today —
still a plain string, still the thing every existing page reads. The new
fields are additive and can be populated gradually, or never, per record.

---

## Why not just replace `price` with an object?

Because every page that currently does `event.price` and expects a string
would break at once. Keeping `price` untouched and adding `price_breakdown`
as a sibling means zero migration risk — old code, and any record that never
gets a breakdown filled in, keeps working unchanged.

## Why is a tier's `label` free text, not an enum?

Because the real data doesn't sort into a fixed list. Concession/discount
wording actually in use includes "concessions", "U26", "u21", "students",
"unwaged", "bursary", "pay it forward", "support the artist", "family
ticket" — and that's not exhaustive. Forcing these into an enum would just
create a new place where data doesn't fit and gets shoved into "other".
`label` keeps the source wording; only the two axes that genuinely *are*
small, stable vocabularies — purchase timing (`type`: advance/door) and
attendance mode (`attendance`: in_person/online) — get real enums.

(`type` was chosen over an earlier draft's `channel` — same meaning,
plainer word. It's scoped to the tier object, so it doesn't collide with
`performer.type` or a festival schedule item's `type` elsewhere in this
schema, which mean different things.)

## Why is "free" a tier, not a boolean?

Because real listings do this: **`Cost: Free/£8 suggested donation towards
event expenses`**. It's free *and* there's a suggested amount, at the same
time. A single `free: true` flag can't represent that without either lying
about the suggested donation or contradicting itself. Modelling "free" as
one tier among several removes the contradiction entirely — an event can
have a `{label: "free", amount: 0}` tier and a
`{label: "suggested donation", amount: 8, is_donation: true}` tier in the
same `tiers` array, and both are simply true.

## Worked examples, pulled from the real data

Each of these is an actual `price` string currently in
`events_normalized.json`, with what its `price_breakdown` would look like.

### Multi-tier with a "support the artist" top tier
> `£12, £10 concessions, £15 support the artist (+£1 booking fee)`

```json
{
  "tiers": [
    { "label": "standard",           "amount": 12 },
    { "label": "concessions",        "amount": 10 },
    { "label": "support the artist", "amount": 15 }
  ],
  "booking_fee": { "amount": 1 }
}
```
Note "support the artist" needs no special flag — it's structurally just
another tier with a descriptive label and a higher amount. The same applies
to `£15 (@£12 concessions, £8 bursary, £20 pay it forward)`.

### Pay-what-you-want with a stated minimum
> `Pay what you decide (min. £5)`

```json
{
  "tiers": [
    { "label": "pay what you decide", "is_pay_what_you_want": true, "min_amount": 5 }
  ]
}
```

### Free, with a suggested donation
> `Cost: Free/£8 suggested donation towards event expenses`

```json
{
  "tiers": [
    { "label": "free", "amount": 0 },
    { "label": "suggested donation", "amount": 8, "is_donation": true }
  ]
}
```

### Hybrid / online pricing
> `£8 (£6.50 zoom)`

```json
{
  "tiers": [
    { "label": "in person", "amount": 8,   "attendance": "in_person" },
    { "label": "zoom",      "amount": 6.5, "attendance": "online" }
  ]
}
```

### Advance / door, with a fee tied to one tier only
> `£13.50 (£+1.35) Adv / £16 Doors`

```json
{
  "tiers": [
    { "label": "advance", "amount": 13.50, "type": "advance", "booking_fee_amount": 1.35 },
    { "label": "door",    "amount": 16,    "type": "door" }
  ]
}
```
The fee is only mentioned for the advance tier, so it's set on that tier via
`booking_fee_amount` rather than on the record-level `booking_fee` (which is
for when a fee applies across the board, or isn't clearly tied to one tier).

### Unstructured discount label
> `£10 (£8 u26)`

```json
{
  "tiers": [
    { "label": "standard", "amount": 10 },
    { "label": "u26",      "amount": 8 }
  ]
}
```
`u26` stays exactly as written — no attempt to normalise it into a
"concession" category, since that's exactly the kind of forced
categorisation that loses information.

### Price range
> `£10-15`

```json
{
  "tiers": [
    { "label": "standard", "min_amount": 10, "max_amount": 15 }
  ]
}
```

### When to leave `price_breakdown` out entirely
> `£225 EARLY BIRD PRICE for the weekend including camping (£260 after 15th
> July), £195 EARLY BIRD PRICE for the weekend without camping (£220 after
> 15th July), £100 deposit`

Don't try. This kind of multi-clause, deadline-dependent festival pricing
isn't worth forcing into `tiers` — the field is optional for exactly this
reason. Leave `price_breakdown` absent and let the existing `price` string
carry it, as it does today.

---

## Answering the two questions this was meant to support

**"Do different ticketing companies have different booking fees?"**
Join each tier's (or the record-level) `booking_fee`/`booking_fee_amount`
against whatever field already identifies the ticketing provider (e.g. a
venue or performer's `tickets_url` domain), and group by provider.

**"What kinds of discount tend to be offered for earlybird/concessions?"**
Filter tiers where `is_donation` is false and compare `amount` against the
same record's `standard`-ish tier — anywhere a tier's amount is lower than
the top tier's, and isn't flagged as a donation or PWYW, it's functionally a
discount. `label` gives you the free-text reason (concession, U26, bursary,
earlybird, etc.) without having pre-sorted it into a fixed category.

---

## `age_guidance`

Free text, not an enum, for the same reason as tier labels: real guidance
("15+, strong language and themes of grief", "family friendly, some peril")
doesn't compress into a fixed rating scale, and a storytelling/spoken-word
context isn't well served by film-style certificates anyway.

Note `festival` already has `age_bands` (an array, e.g. `["family",
"adult"]`) — that's about target-audience segments, not content warnings, so
`age_guidance` was added there too as a distinct, complementary field rather
than overloading `age_bands` with a different meaning.
