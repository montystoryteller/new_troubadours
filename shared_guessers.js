// ---------------------------------------------------------------------------
// Shared guessers — heuristics reused by both stats.js (venue-type charts)
// and the event builder (venue_type suggestions, form + enrichment). Load
// this script BEFORE either of those.
//
// classifyVenueType() below was moved here verbatim from stats.js — same
// function body, same regexes, byte-for-byte — so its behaviour on the
// stats page is unchanged. Note: a few of its regex alternatives (e.g. the
// \binstitute\b / \bnewstead\b word-boundary checks) contain what appear to
// be literal control characters rather than the intended `\b` escape, most
// likely from a past copy/paste mangling — meaning those specific
// alternatives silently never match. This was already true before this
// refactor; it's flagged here rather than "fixed" so this move doesn't
// change existing behaviour. Worth a follow-up if it's ever worth chasing.
// ---------------------------------------------------------------------------

function classifyVenueType(name) {
  if (!name) return "Other / unknown";
  const n = name.toLowerCase();
  if (
    /village hall|memorial hall|parish hall|community hall|town hall|assembly room|public hall|welfare hall|memorial institute|parish room|working men|community centre|community center|bowling club|institute|kingsley hall|lowther parish|mcgrigor hall|public rooms|pullens centre|imperial rooms|adastra hall|david hall|alexander centre|three villages hall|mushroom hall|torriano meeting|folk preservation|joinery|malt cross|liskeard|folk of gloucester|old customs house|ventnor british legion|bolton socialist|newstead|scout hut/.test(
      n,
    )
  )
    return "Village / community hall";
  if (
    /church hall|church room|church|st\.\s|saint\s|\bpriory\b|\bchapel\b|quaker|salvation army|buddhist|assumption|our lady|st john|st peter|st mary|st nicholas|st anne|st lawrence|meeting house/.test(
      n,
    )
  )
    return "Church / faith venue";
  if (
    /\btheatre\b|\btheater\b|playhouse|lyric\b|wardrobe|backyard theatre|front room theatre|omnibus|storyhouse|unicorn|dragon|torch|palace theatre|borough theatre|alphabetti|capstone|cygnet|knutsford little|lantern|georgian|\bcube\b|burton taylor|prohibition recording|palladium club/.test(
      n,
    )
  )
    return "Theatre";
  if (
    /arts cent|art cent|arts centr|artcentre|centre for the arts|arts center|llanover|pontardawe|ropetackle|exeter phoenix|chapter arts|quay arts|pound arts|bureau|wycombe|barnoldswick|gregson|moor imagination|riverfront|cambridge junction|john peel centre|ruskin mill|ffwrnes|theatr clwyd|royal welsh college|university|making space|st anne.s arts|rougemont|corn exchange|yellow book|october books|riff factory|spin the black|portico|next door at|\bstudio\b/.test(
      n,
    )
  )
    return "Arts centre / venue";
  if (
    /\bpub\b|tavern|\binn\b|\barms\b|\btap\b|brewery|\bbar\b|\bale house\b|the fleece|brunswick|britons|half moon|station pub|black swan|fountain inn|dove st|locks inn|three swans|stubbing|dairyman|portland arms|porter club|rat and ratchet|duke william|embankment|castle tap|castle inn|bodega|star coffee|temperance|chillingham|the hoops|the grove|the victoria|waverley|hop sun|ropemakers|bear club|hop inn|foxtails|bargeman|alder\b|hearth\b|the fold|the elm tree|katie fitzgerald|chagford inn|ship inn|the acorn|joiners|love shack|\byes\b|department\b|lock 91|cafe|coffee|kitchen garden|merlin|carvel lane|foremans|travellers joy|fat cat|nelly|angels cut|ltb showroom|stables at the bull|snapdragons|avalon|calverts|hotel indigo|swiss cottage|micklethwait|better days|b side|cwrw|\bsocial club\b|crown.*sceptre/.test(
      n,
    )
  )
    return "Pub / bar / café";
  if (
    /museum|library|guildhall|roman villa|darwin house|physic garden|dr johnson|food museum|haslemere museum|story museum|the hold\b/.test(
      n,
    )
  )
    return "Museum / historic";
  if (
    /\bbarn\b|farm|retreat|vineyard|earthhouse|ancient farm|harta|caddaford|circle barn|arty barn|old stables|rectory|plot 9|cranborne|wroot|the big retreat|dart music festival|gibraltar/.test(
      n,
    )
  )
    return "Barn / rural / outdoor";
  if (/online/.test(n)) return "Online";
  return "Other / unknown";
}

// Canonical list of the categories classifyVenueType() can return, for
// anywhere a UI wants to offer them as suggestions/options (e.g. a
// datalist). Kept in the same order stats.js displays them in
// (its own VTYPE_ORDER, in stats.js, is the source of truth for that
// display order — this list mirrors it for convenience elsewhere, but
// isn't read by stats.js itself, so editing one doesn't affect the other).
const VENUE_TYPE_SUGGESTIONS = [
    "Pub / bar / café",
    "Village / community hall",
    "Arts centre / venue",
    "Theatre",
    "Church / faith venue",
    "Museum / historic",
    "Barn / rural / outdoor",
    "Online",
    "Other / unknown",
];

// ---------------------------------------------------------------------------
// Age-rating parser — a best-effort scan of event description text for
// common age-suitability phrasing (e.g. "suitable for ages 8+", "18+",
// "family friendly"), used to SUGGEST an age_rating/min_age, never to set
// them automatically. Always returns the exact sentence it matched, so a
// caller can offer to remove that sentence from the description once its
// content has been captured as a structured field instead.
//
// This is necessarily a rough heuristic over free-form prose, not a
// classifier with any guarantee of coverage — a null return just means
// nothing recognisable was found, not that the event has no age guidance.
// ---------------------------------------------------------------------------
function parseAgeRatingFromText(text) {
    if (!text) return null;
    // Split on sentence-ending punctuation or blank lines, keeping each
    // sentence's original casing/punctuation so it can be matched back
    // against the description verbatim later, for removal.
    const sentences = text.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);
    // Wording that names an adult audience without necessarily giving a
    // number. Doesn't include a bare "18+" — that's a number like any
    // other and is handled by the numeric checks below, not assumed here.
    const ADULT_WORDING = /\badults?[\s-]only\b|\baimed at adults\b|\bfor adults\b|\badult content\b|\bmature (?:content|themes|audiences)\b|\bexplicit content\b/i;

    for (const sentence of sentences) {
        const s = sentence;
        const mentionsAdults = ADULT_WORDING.test(s);

        // Explicit numeric age, in any of several common phrasings.
        let n = null;
        let m = s.match(/\b(?:ages?|aged)\s*(\d{1,2})\s*(?:\+|and (?:over|above|up|older)|or (?:over|above|older))/i);
        if (m) n = parseInt(m[1], 10);
        if (n === null) {
            m = s.match(/\b(?:suitable|recommended|appropriate)\s+for\s+(?:ages?\s*)?(\d{1,2})\s*\+/i);
            if (m) n = parseInt(m[1], 10);
        }
        if (n === null) {
            // A bare "N+" (in a plausible age-rating range) is accepted on
            // its own, as long as there's no currency symbol nearby — "12+"
            // or "18+" written alone overwhelmingly means an age cue in an
            // event listing, so this doesn't need a nearby cue word or a
            // whole standalone sentence to be confident about it.
            m = s.match(/\b(\d{1,2})\s*\+/);
            if (m && !/[£$€]\s*\d/.test(s)) {
                const candidate = parseInt(m[1], 10);
                if (candidate >= 1 && candidate <= 18) n = candidate;
            }
        }

        // A number AND adult wording together in the same sentence (e.g.
        // "aimed at adults, recommended for ages 16 and over") combine into
        // one rating rather than picking just one signal. Only combines
        // within a single sentence — deliberately not across sentences,
        // since the "remove this sentence from the description" action
        // this feeds into only removes one exact sentence, and combining
        // across two would leave it unclear which one to offer removing.
        if (n !== null && mentionsAdults) {
            return { rating: `aimed at adults / ${n}+`, minAge: n, sentence };
        }
        if (n !== null) {
            return { rating: `${n}+`, minAge: n, sentence };
        }
        if (mentionsAdults) {
            // No number given alongside it, so no age is assumed — this
            // used to default to 18, which wasn't necessarily accurate.
            return { rating: "Adults only", minAge: null, sentence };
        }

        // Family friendly / all ages
        if (/\bfamily[\s-]friendly\b|\ball ages\b|\bsuitable for (?:the )?(?:whole )?family\b|\bsuitable for all ages\b/i.test(s)) {
            return { rating: "Family friendly", minAge: null, sentence };
        }

        // Not suitable for children / no children
        if (/\bnot suitable for (?:young )?children\b|\bno children\b|\bnot recommended for children\b/i.test(s)) {
            return { rating: "Not suitable for children", minAge: null, sentence };
        }
    }
    return null;
}

// Canonical suggestions for an age_rating datalist — a mix of the parser's
// own possible outputs and a few other common phrasings, for anywhere a UI
// wants to offer them without requiring free-text entry.
const AGE_RATING_SUGGESTIONS = [
    "Family friendly",
    "Suitable for all ages",
    "8+",
    "12+",
    "14+",
    "16+",
    "18+",
    "Adults only",
    "Not suitable for children",
];

// ---------------------------------------------------------------------------
// Price text <-> structured entries.
//
// renderStructuredPrice() is structured -> text: the exact rendering logic
// used by the event builder's structured price widget, moved here verbatim
// so there's one canonical version rather than a copy that can drift.
//
// parsePriceEntriesFromString() is text -> structured, for a string that's
// ASSUMED to already be about price (e.g. the contents of a Price field
// itself) — for pulling a price mention out of a longer description, use
// parsePriceFromDescription() instead, which finds the relevant sentence
// first (same two-step shape as parseAgeRatingFromText).
//
// getPriceFaceValue() derives a single representative number (plus
// isFree/isPwyw flags) from a set of structured entries, in the same
// {isFree, isPwyw, face} shape stats.js's own parseEventPrice() already
// returns from raw text — so stats.js can prefer structured_price when a
// record has it, and fall back to parsing `price` text only when it
// doesn't, without needing two different result shapes.
//
// All of this is necessarily best-effort over free-form wording, in both
// directions — always a suggestion for a person to review, never applied
// silently.
// ---------------------------------------------------------------------------
const PRICE_TYPE_WORDS = {
    concession: "concessions", advance: "advance", earlybird: "earlybird",
    door: "door", online: "online", member: "members",
};

function formatPriceAmount(n) {
    return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function renderPriceEntry(e) {
    let text;
    if (e.type === "free") {
        text = e.label || "Free";
    } else if (e.type === "donation") {
        text = e.label || "Donation";
        if (e.amount != null) text += ` (suggested £${formatPriceAmount(e.amount)})`;
    } else if (e.type === "pwyw") {
        text = e.label || "Pay what you can";
        if (e.amount != null) text += ` (suggested £${formatPriceAmount(e.amount)})`;
    } else if (e.type === "tier" || (e.label && !PRICE_TYPE_WORDS[e.type])) {
        text = e.amount != null ? `£${formatPriceAmount(e.amount)} ${e.label}` : e.label;
    } else if (PRICE_TYPE_WORDS[e.type]) {
        text = e.amount != null ? `£${formatPriceAmount(e.amount)} ${PRICE_TYPE_WORDS[e.type]}` : PRICE_TYPE_WORDS[e.type];
    } else {
        text = e.amount != null ? `£${formatPriceAmount(e.amount)}` : "";
    }
    if (e.fee != null) text += ` (+ £${formatPriceAmount(e.fee)})`;
    return text;
}

function renderStructuredPrice(entries) {
    if (!entries || !entries.length) return null;
    return entries.map(renderPriceEntry).filter(Boolean).join(" / ");
}

// Finds the first plain amount in a string, accepting £, $, € or a bare
// number (this site is UK-only, so any currency symbol found is treated as
// GBP and discarded — there's no multi-currency support here; a symbol like
// $ appearing in real input just means "a number follows", nothing more).
function extractPriceAmount(text) {
    const m = text.match(/[£$€]?\s*(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : null;
}

// Parses one price "chunk" — either a whole price string in the simple
// single-price case, or one "/"-separated tier of a multi-tier one — into a
// single {type?, amount?, fee?} entry.
function parsePriceChunk(chunk) {
    let c = chunk.trim();

    // Pull a fee out first, in any of this site's common shapes:
    // "+ 1.50", "+£1.50", "(+£1.50)", "(+ £1.50 booking fee)".
    let fee = null;
    const feeMatch = c.match(/[\(]?\+\s*[£$€]?\s*(\d+(?:\.\d+)?)\s*(?:booking fee)?\)?/i);
    if (feeMatch) {
        fee = parseFloat(feeMatch[1]);
        c = c.replace(feeMatch[0], "").trim();
    }

    // Detect a type keyword in what's left, and strip it out so it isn't
    // mistaken for anything else afterwards.
    let type = null;
    const TYPE_PATTERNS = [
        [/\bearly ?bird\b/i, "earlybird"],
        [/\badvance\b|\badv\b/i, "advance"],
        [/\bon the door\b|\botd\b|\bdoor\b/i, "door"],
        [/\bonline\b/i, "online"],
        [/\bconcessions?\b/i, "concession"],
        [/\bmembers?\b/i, "member"],
    ];
    for (const [re, t] of TYPE_PATTERNS) {
        if (re.test(c)) { type = t; c = c.replace(re, "").trim(); break; }
    }

    const amount = extractPriceAmount(c);
    if (amount == null && !type) return null;
    const entry = {};
    if (type) entry.type = type;
    if (amount != null) entry.amount = amount;
    if (fee != null) entry.fee = fee;
    return entry;
}

function parsePriceEntriesFromString(text) {
    if (!text) return null;
    const s = text.trim();
    if (!s) return null;
    const sl = s.toLowerCase();

    // "Free" is checked for anywhere in the string, not just at the start —
    // needed so this also works when called on a full description sentence
    // ("This is a free community event...") rather than just a dedicated
    // Price field ("Free"). Skipped if a currency amount is also present,
    // since a sentence mentioning both ("free parking, £10 entry") almost
    // certainly isn't simply free admission.
    if (/\bfree\b/i.test(sl) && !/[£$€]\s*\d/.test(s)) {
        return [{ type: "free" }];
    }
    if (/pay what you (like|feel|can|decide|want)|pay what|\bpwyw\b/.test(sl)) {
        const amount = extractPriceAmount(s.replace(/pay what you (?:like|feel|can|decide|want)|pay what|pwyw/gi, ""));
        const e = { type: "pwyw" };
        if (amount != null) e.amount = amount;
        return [e];
    }
    if (/\bdonation/.test(sl)) {
        const amount = extractPriceAmount(s.replace(/donations?/gi, ""));
        const e = { type: "donation" };
        if (amount != null) e.amount = amount;
        return [e];
    }

    // One or more tiers. A "/" is this site's own generated separator, so
    // if present it's used as-is. Otherwise, multiple tiers are often
    // comma-separated in prose (e.g. "Tickets are £10, £8 concessions") —
    // only split on comma when there's more than one currency amount to
    // justify it, so a plain single price with an incidental comma ("£10,
    // pay on the door") is left as one chunk rather than needlessly split.
    let chunks;
    if (s.includes("/")) {
        chunks = s.split("/");
    } else {
        const amountCount = (s.match(/[£$€]\s*\d/g) || []).length;
        chunks = (amountCount > 1 && s.includes(",")) ? s.split(",") : [s];
    }
    const entries = chunks.map(c => c.trim()).filter(Boolean).map(parsePriceChunk).filter(Boolean);
    return entries.length ? entries : null;
}

// Scans a longer piece of free text (e.g. an event description) for a
// sentence that looks like it's about price, and parses that sentence —
// rather than assuming the whole text is price-only, which
// parsePriceEntriesFromString() assumes. Requires a currency symbol or an
// explicit price-ish keyword before even attempting a parse, to avoid
// false positives from unrelated numbers (times, running order, etc).
function parsePriceFromDescription(text) {
    if (!text) return null;
    const sentences = text.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);
    const PRICE_CUE = /[£$€]\s*\d|\bfree\b|\bdonation\b|\bpay what\b|\bpwyw\b|\btickets?\b|\bentry\b|\badmission\b|\bcost\b|\bprice\b/i;
    // "Free" on its own is too easily just an ordinary English word ("forever
    // free", "free verse", "reclaims... and is dancing with us still, forever
    // free") rather than a price cue — only trust a "free" result when it
    // sits close to an entry/admission/ticket/event word in the sentence.
    const FREE_PRICE_CONTEXT = /\bfree\b[^.!?]{0,25}\b(?:entry|admission|event|tickets?|to attend)\b|\b(?:entry|admission|tickets?|event)\b[^.!?]{0,25}\bfree\b/i;

    for (const sentence of sentences) {
        if (!PRICE_CUE.test(sentence)) continue;
        const entries = parsePriceEntriesFromString(sentence);
        if (!entries || !entries.length) continue;

        const hasFreeType = entries.some(e => e.type === "free");
        if (hasFreeType && !FREE_PRICE_CONTEXT.test(sentence)) continue;

        // A bare numeric amount with no currency symbol and no recognised
        // type (free/pwyw/donation/advance/etc) is too easily confused with
        // an unrelated number in prose ("10 stories told", a time, a
        // running order) — only accept those when the sentence actually
        // contained a currency symbol somewhere.
        const hasCurrencySymbol = /[£$€]\s*\d/.test(sentence);
        const hasBareAmountOnly = entries.some(e => e.amount != null && !e.type);
        if (hasBareAmountOnly && !hasCurrencySymbol) continue;
        return { entries, sentence };
    }
    return null;
}

// Derives a single representative {isFree, isPwyw, face} from structured
// entries, mirroring the shape stats.js's own text-based parseEventPrice()
// already returns, so a caller can prefer structured_price when present and
// fall back to parsing `price` text only when it isn't, uniformly.
function getPriceFaceValue(entries) {
    if (!entries || !entries.length) return null;
    const paid = entries.filter(e => e.type !== "free");
    if (!paid.length) return { isFree: true, face: null };

    const pwywLike = paid.filter(e => e.type === "pwyw" || e.type === "donation");
    if (pwywLike.length === paid.length) {
        const withAmount = pwywLike.find(e => e.amount != null);
        return { isPwyw: true, face: withAmount ? withAmount.amount : null };
    }

    // Prefer, in order: a plain/untyped entry, then advance, then earlybird,
    // then door/online, then anything that isn't a discount/pwyw/tier
    // entry, then whatever's left — mirrors the old text parser's
    // preference for a headline price over a discounted one, but doesn't
    // need to guess, since the type is already known here.
    const priority = [
        e => !e.type && e.amount != null,
        e => e.type === "advance" && e.amount != null,
        e => e.type === "earlybird" && e.amount != null,
        e => e.type === "door" && e.amount != null,
        e => e.type === "online" && e.amount != null,
        e => !["concession", "member", "pwyw", "donation", "tier"].includes(e.type) && e.amount != null,
        e => e.amount != null,
    ];
    for (const test of priority) {
        const found = paid.find(test);
        if (found) return { face: found.amount };
    }
    return { face: null };
}
