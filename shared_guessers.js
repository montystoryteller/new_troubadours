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
    const AGE_CUE_WORDS = /suitable|recommended|appropriate|age|years|content|audience|rated|certificate/i;

    for (const sentence of sentences) {
        const s = sentence;

        // "18+", adult content, adults only, mature themes — checked first
        // since it's the most specific/unambiguous signal.
        if (/\b18\s*\+|\badults?[\s-]only\b|\badult content\b|\bmature (?:content|themes|audiences)\b|\bexplicit content\b/i.test(s)) {
            return { rating: "Adult content (18+)", minAge: 18, sentence };
        }

        // "ages 8+", "age 8 and over", "aged 12 or above"
        let m = s.match(/\b(?:ages?|aged)\s*(\d{1,2})\s*(?:\+|and (?:over|above|up|older)|or (?:over|above|older))/i);
        if (m) {
            const n = parseInt(m[1], 10);
            return { rating: `${n}+`, minAge: n, sentence };
        }

        // "suitable/recommended/appropriate for (ages) 8+"
        m = s.match(/\b(?:suitable|recommended|appropriate)\s+for\s+(?:ages?\s*)?(\d{1,2})\s*\+/i);
        if (m) {
            const n = parseInt(m[1], 10);
            return { rating: `${n}+`, minAge: n, sentence };
        }

        // A bare "N+" only counts if the sentence also has a suitability cue
        // word, to avoid false positives on prices ("£8+ donations") or
        // other unrelated numbers.
        m = s.match(/\b(\d{1,2})\s*\+/);
        if (m && AGE_CUE_WORDS.test(s) && !/[£$€]\s*\d/.test(s)) {
            const n = parseInt(m[1], 10);
            return { rating: `${n}+`, minAge: n, sentence };
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
    "Adult content (18+)",
    "Not suitable for children",
];
