#!/usr/bin/env python3
"""
ticket_sync.py - turn ticketing-site listings into events_normalized.json-style records,
reconciled to the ids, venues, performers and promoters already in the feed.
(Supersedes eventbrite_sync.py: Eventbrite is now one adapter among several.)

    # a promoter/organiser page, or individual event pages, from any supported site - mix freely
    python ticket_sync.py events_normalized.json \
        https://wegottickets.com/TravelingwordsProductions \
        https://www.eventbrite.co.uk/o/72555678233 \
        https://www.eventbrite.co.uk/e/some-show-tickets-1234567890123 \
        https://www.tickettailor.com/events/matlockstorytellingcafe/2370161
    # -> new_event_data.json (newVenues / specificEvents / updatedEvents) + a review printed to the console

Adapters
    eventbrite    schema.org JSON-LD on event pages; organiser pages (/o/...) for discovery
    wegottickets  page-text parser (title, lineup, "Presented by", venue block, door/start time,
                  ticket price + booking fee, age, sold out); promoter pages for discovery;
                  /event/<id> and /f/<id> URLs are both understood (they are different id spaces)
    anything else generic schema.org JSON-LD (Ticket Tailor, TicketSource, See Tickets, Skiddle, Dice...
                  - best effort: it works only where the page publishes Event JSON-LD)
    To add a site: write one `parse_<site>(page, url) -> dict` returning the Listing shape (see
    `listing_template`) and register it in PARSERS; add its URL patterns to `ticket_keys`.

Output: ONE file, new_event_data.json (-o to change), in the same shape the event builder downloads:
    newVenues {id: record}, specificEvents [records], updatedEvents {"specificEvents#<index>": full record}
so it merges the same way as a builder export. If the file already exists, a new run is ADDED to it, never
overwritten (use --overwrite to start the file afresh): new venues and new events are appended (anything
already in the file is left exactly as it is, so edits you made to it survive), field updates for the same
feed record are combined, and any other keys in the file are kept. Venues already in the file are used when
matching, so a second run does not create the same venue again. The review notes (why each venue matched, conflicts,
collisions, things to check) are printed to the console; --report FILE also saves them as JSON.
The input feed is never modified. Curated fields (description, flyer, name, age_rating, eventId) on
existing records are never overwritten. Online-only events are skipped unless --include-online.

Matching and ids are ports of the event builder's own logic (event_builder.html / shared_*.js):
extractPostcodeOrEircode, parseTownPostcodeFromAddress, coreNameSimilarity + the 150 m / same-postcode
rule from "Possible duplicate venues", parseAgeRatingFromText, renderStructuredPrice, slugify/uniqueId,
buildStructuredEventId (yyyymmdd-performerId-venueId, with its unknown-performer / unknown-venue fallbacks).

Listing pages that render client-side may return no links; save the loaded page from your browser
and pass it with --listing-html (and single event pages with --event-html).
Use --debug-text to dump the text each parser saw (invaluable when a site changes its layout).
Optional: pip install curl_cffi   (browser-like TLS fingerprint)
"""
from __future__ import annotations

import argparse
import datetime as dt
import difflib
import hashlib
import html
import json
import math
import re
import sys
import time
import unicodedata
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

try:
    from zoneinfo import ZoneInfo
    UK = ZoneInfo("Europe/London")
except Exception:  # pragma: no cover
    UK = dt.timezone.utc

EB_HOST = "https://www.eventbrite.co.uk"
CURRENCY = {"GBP": "£", "EUR": "€", "USD": "$"}
LD_RE = re.compile(r"<script[^>]+type=[\"']application/ld\+json[\"'][^>]*>(.*?)</script>", re.S | re.I)
UK_PC = r"[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}"
MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}


# ============================================================================ generic helpers
def slugify(s: str) -> str:
    """Port of the builder's slugify(): NFKD, strip diacritics, drop apostrophes, non-alnum -> '-'."""
    s = unicodedata.normalize("NFKD", (s or "").lower())
    s = re.sub(r"[\u0300-\u036f]", "", s)
    s = re.sub(r"['\u2018\u2019\u02BC`\u00B4]", "", s)
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def unique_id(slug: str, exists) -> str:
    """Port of the builder's uniqueId()."""
    i, n = slug or "untitled", 2
    while exists(i):
        i, n = f"{slug}-{n}", n + 1
    return i


def norm_pc(s: str | None) -> str:
    return re.sub(r"\s+", "", (s or "").upper())


def norm_name(s: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9 ]+", " ", unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()).split())


def haversine(a, b):
    if not a or not b:
        return None
    (la1, lo1), (la2, lo2) = a, b
    p1, p2 = math.radians(la1), math.radians(la2)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lo2 - lo1) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


def venue_tokens(name: str, city: str = "") -> list[str]:
    n = re.sub(r"[^a-z0-9 ]+", " ", unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower())
    drop = {"the", "a", "of"} | set(re.sub(r"[^a-z0-9 ]+", " ", city.lower()).split())
    return [t for t in n.split() if t not in drop]


def name_scores(a: str, b: str, city: str = "") -> tuple[float, float]:
    ta, tb = venue_tokens(a, city), venue_tokens(b, city)
    seq = difflib.SequenceMatcher(None, " ".join(ta), " ".join(tb)).ratio()
    contain = len(set(ta) & set(tb)) / min(len(set(ta)), len(set(tb))) if ta and tb else 0.0
    return seq, contain


def parse_dmy(s: str) -> dt.date | None:
    try:
        d, m, y = (int(x) for x in s.strip().split("/"))
        return dt.date(y, m, d)
    except Exception:
        return None


def fmt_dmy(d: dt.date) -> str:
    return d.strftime("%d/%m/%Y")


def money(v: float) -> str:
    return f"{int(v)}" if float(v).is_integer() else f"{v:.2f}"


def clean_text(s: str | None) -> str:
    if not s:
        return ""
    s = re.sub(r"(?i)<br\s*/?>|</p>", "\n\n", s)
    s = html.unescape(re.sub(r"<[^>]+>", "", s)).replace("\r", "")
    paras = [re.sub(r"[ \t]+", " ", p).strip() for p in re.split(r"\n\s*\n", s)]
    return "\n\n\n\n".join(p for p in paras if p)  # the feed separates paragraphs with 4 newlines


# ============================================================================ ports of the event builder's logic
def extract_uk_postcode(text: str | None) -> str | None:
    m = re.search(r"\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b", text or "", re.I)
    return f"{m.group(1).upper()} {m.group(2).upper()}" if m else None


def extract_postcode_or_eircode(text: str | None) -> str | None:
    uk = extract_uk_postcode(text)
    if uk or not text:
        return uk
    m = re.search(r"\b([ACDEFHKNPRTVWXY]\d{2}|D6W)\s*([0-9ACDEFHKNPRTVWXY]{4})\b", text, re.I)
    return f"{m.group(1).upper()} {m.group(2).upper()}" if m else None


ADDRESS_REGION_WORDS = ["wales", "isle of wight"]


def parse_town_postcode_from_address(address: str | None) -> dict | None:
    """Port of parseTownPostcodeFromAddress(): last comma-segment must be just a postcode."""
    if not address:
        return None
    parts = [p.strip() for p in address.split(",") if p.strip()]
    if len(parts) < 2:
        return None
    pc = extract_postcode_or_eircode(parts[-1])
    if not pc or re.sub(r"\s+", "", parts[-1].upper()) != pc.replace(" ", ""):
        return None
    town = parts[-2]
    if town.lower() in ADDRESS_REGION_WORDS and len(parts) >= 3:
        town = f"{parts[-3]}, {town}"
    return {"town": town, "postcode": pc}


GENERIC_VENUE_PHRASES = ["village hall", "town hall", "church hall", "memorial hall", "parish hall", "assembly rooms",
                         "community centre", "community center", "arts centre", "arts center", "social club",
                         "working mens club", "royal british legion", "scout hut", "scout hall", "village institute"]
GENERIC_VENUE_WORDS = ["hall", "theatre", "theater", "centre", "center", "club", "hut", "church", "institute", "the"]


def core_venue_name(s: str) -> str:
    n = re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()
    for p in GENERIC_VENUE_PHRASES:
        n = re.sub(r"\b" + p.replace(" ", r"\s+") + r"\b", " ", n)
    for w in GENERIC_VENUE_WORDS:
        n = re.sub(r"\b" + w + r"\b", " ", n)
    return re.sub(r"\s+", " ", n).strip()


def levenshtein(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(prev[j - 1] if ca == cb else 1 + min(prev[j], cur[j - 1], prev[j - 1]))
        prev = cur
    return prev[-1]


def core_name_similarity(a: str, b: str) -> float:
    """Port of coreNameSimilarity(): 0 when either name is nothing but generic wording."""
    ca, cb = core_venue_name(a), core_venue_name(b)
    if not ca or not cb:
        return 0.0
    return 1 - levenshtein(ca, cb) / max(len(ca), len(cb))


def find_nearby_by_latlon(lat, lon, venues: dict, radius_km: float = 20, limit: int = 8) -> list[tuple[str, dict, float]]:
    """Port of findNearbyByLatLon() (shared_utils.js) over a {id: record} dict."""
    out = [(vid, v, haversine([lat, lon], v["latlon"]) / 1000) for vid, v in venues.items()
           if isinstance(v.get("latlon"), list) and len(v["latlon"]) == 2]
    return sorted((x for x in out if x[2] <= radius_km), key=lambda x: x[2])[:limit]


ADULT_WORDING = re.compile(r"\badults?[\s-]only\b|\baimed at adults\b|\bfor adults\b|\badult content\b|"
                           r"\bmature (?:content|themes|audiences)\b|\bexplicit content\b", re.I)


def parse_age_rating_from_text(text: str | None) -> dict | None:
    """Port of parseAgeRatingFromText() (shared_guessers.js)."""
    if not text:
        return None
    for s in (x.strip() for x in re.split(r"(?<=[.!?])\s+|\n+", text) if x.strip()):
        adults = bool(ADULT_WORDING.search(s))
        n = None
        m = re.search(r"\b(?:ages?|aged)\s*(\d{1,2})\s*(?:\+|and (?:over|above|up|older)|or (?:over|above|older))", s, re.I)
        if m:
            n = int(m.group(1))
        if n is None:
            m = re.search(r"\b(?:suitable|recommended|appropriate)\s+for\s+(?:ages?\s*)?(\d{1,2})\s*\+", s, re.I)
            if m:
                n = int(m.group(1))
        if n is None:
            m = re.search(r"\b(\d{1,2})\s*\+", s)
            if m and not re.search(r"[£$€]\s*\d", s) and 1 <= int(m.group(1)) <= 18:
                n = int(m.group(1))
        if n is not None and adults:
            return {"rating": f"aimed at adults / {n}+", "minAge": n, "sentence": s}
        if n is not None:
            return {"rating": f"{n}+", "minAge": n, "sentence": s}
        if adults:
            return {"rating": "Adults only", "minAge": None, "sentence": s}
        if re.search(r"\bfamily[\s-]friendly\b|\ball ages\b|\bsuitable for (?:the )?(?:whole )?family\b|\bsuitable for all ages\b", s, re.I):
            return {"rating": "Family friendly", "minAge": None, "sentence": s}
        if re.search(r"\bnot suitable for (?:young )?children\b|\bno children\b|\bnot recommended for children\b", s, re.I):
            return {"rating": "Not suitable for children", "minAge": None, "sentence": s}
    return None


PRICE_TYPE_WORDS = {"concession": "concessions", "advance": "advance", "earlybird": "earlybird", "door": "door",
                    "online": "online", "member": "members"}


def fmt_price_amount(n: float) -> str:
    return str(int(n)) if float(n).is_integer() else f"{n:.2f}"


def render_price_entry(e: dict) -> str:
    t, label, amt = e.get("type"), e.get("label"), e.get("amount")
    if t == "free":
        text = label or "Free"
    elif t in ("donation", "pwyw"):
        text = label or ("Donation" if t == "donation" else "Pay what you can")
        if amt is not None:
            text += f" (suggested £{fmt_price_amount(amt)})"
    elif t == "tier" or (label and t not in PRICE_TYPE_WORDS):
        text = f"£{fmt_price_amount(amt)} {label}" if amt is not None else label
    elif t in PRICE_TYPE_WORDS:
        text = f"£{fmt_price_amount(amt)} {PRICE_TYPE_WORDS[t]}" if amt is not None else PRICE_TYPE_WORDS[t]
    else:
        text = f"£{fmt_price_amount(amt)}" if amt is not None else ""
    if e.get("fee") is not None:
        text += f" (+ £{fmt_price_amount(e['fee'])})"
    return text


def render_structured_price(entries: list[dict]) -> str:
    return " / ".join(x for x in (render_price_entry(e) for e in entries) if x)


def encode_paragraph_breaks(text: str | None) -> str:
    """Port of encodeParagraphBreaks(): a blank line between paragraphs is stored as four newlines."""
    t = "\n".join(re.sub(r"[ \t]+$", "", l) for l in (text or "").replace("\r\n", "\n").split("\n"))
    return "\n\n\n\n".join(p.strip() for p in re.split(r"\n{2,}", t) if p.strip())


def build_structured_event_id(rec: dict, date: dt.date) -> str:
    """Port of buildStructuredEventId(): yyyymmdd-performerId-venueId, with the same fallbacks."""
    performer = rec.get("performer_id") or (rec.get("performer_ids") or [""])[0] or "unknown-performer"
    return f"{date:%Y%m%d}-{performer}-{rec.get('venue_id') or 'unknown-venue'}"


_last_geocode = [0.0]


def geocode_venue(name: str, full_address: str, postcode: str, city: str) -> tuple[list[float], str] | None:
    """The builder's geocoder (Nominatim, candidates most-to-least specific, >=1.1 s apart).
    The builder only calls it from a button, per Nominatim's policy on bulk use - so this is opt-in
    (--geocode) and only ever called for NEW venues, i.e. a handful of requests."""
    from urllib.parse import quote
    country = "UK" if (not postcode or extract_uk_postcode(postcode)) else "Ireland"
    primary = full_address or ", ".join(x for x in (name, city, postcode) if x)
    cands = [primary] if primary else []
    if postcode and postcode != primary:
        cands.append(postcode)
    nc = ", ".join(x for x in (name, city) if x)
    if nc and nc != primary:
        cands.append(nc)
    for q in dict.fromkeys(f"{c}, {country}" for c in cands):
        time.sleep(max(0.0, 1.1 - (time.time() - _last_geocode[0])))
        _last_geocode[0] = time.time()
        try:
            req = urllib.request.Request("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=" + quote(q),
                                         headers={"User-Agent": "ticket_sync/2.0 (event listing maintenance)"})
            with urllib.request.urlopen(req, timeout=15) as r:
                res = json.load(r)
            if res:
                return [round(float(res[0]["lat"]), 5), round(float(res[0]["lon"]), 5)], q
        except Exception:
            continue
    return None


# ============================================================================ URL knowledge
def ticket_keys(url: str) -> list[str]:
    """Stable identifiers inside a ticket URL, used to recognise the same event across URL variants."""
    if not url or not url.startswith("http"):
        return []
    u = urlsplit(url)
    host, path = u.netloc.lower().removeprefix("www."), u.path
    ks: list[str] = []
    if "eventbrite." in host:
        m = re.search(r"-tickets-(\d{9,})", path)
        ks += [f"eb:{m.group(1)}"] if m else []
    elif host.endswith("wegottickets.com"):
        m = re.search(r"/(event|f)/(\d+)", path)
        ks += [f"wgt-{m.group(1)}:{m.group(2)}"] if m else []
    elif host.endswith("tickettailor.com"):
        m = re.search(r"/events/([^/]+)/(\d+)", path)
        ks += [f"tt:{m.group(1).lower()}/{m.group(2)}"] if m else []
    elif "ticketsource." in host:
        m = (re.search(r"/[et]-([a-z0-9]+)/?$", path, re.I) or re.search(r"/[et]-([a-z0-9]+)", path, re.I)
             or re.search(r"/booking/init/([A-Za-z0-9]+)", path))
        ks += [f"ts:{m.group(1).lower()}"] if m else []
    elif host.endswith("seetickets.com"):
        m = re.search(r"/(\d{5,})/?$", path)
        ks += [f"see:{m.group(1)}"] if m else []
    elif host.endswith("dice.fm"):
        m = re.search(r"/event/([a-z0-9]+)-", path)
        ks += [f"dice:{m.group(1)}"] if m else []
    elif host.endswith("skiddle.com"):
        m = re.search(r"/(\d{6,})/?$", path)
        ks += [f"skiddle:{m.group(1)}"] if m else []
    return ks


def site_of(url: str) -> str:
    host = urlsplit(url).netloc.lower()
    if "eventbrite." in host:
        return "eventbrite"
    if host.endswith("wegottickets.com"):
        return "wegottickets"
    if host.endswith("ticketsource.co.uk") or host.endswith("ticketsource.com"):
        return "ticketsource"
    if host.endswith("tickettailor.com"):
        return "tickettailor"
    return "generic"


def is_event_url(url: str) -> bool:
    """Event page vs listing/organiser page."""
    site, path = site_of(url), urlsplit(url).path
    if site == "eventbrite":
        return "/e/" in path
    if site == "wegottickets":
        return bool(re.search(r"/(event|f)/\d+", path))
    if site == "ticketsource":
        return bool(re.search(r"/e-[a-z0-9]+|/booking/init/", path, re.I))
    if site == "tickettailor":
        return bool(re.search(r"/events/[^/]+/\d+", path))
    return True  # unknown hosts are treated as single event pages


def extract_links(text: str) -> dict[str, str]:
    """Event links from any listing HTML/JSON (key -> canonical URL). Both supported sites at once."""
    t = text.replace("\\/", "/").replace("\\u002F", "/").replace("&#x2F;", "/")
    out: dict[str, str] = {}
    for m in re.finditer(r"/e/([A-Za-z0-9%_.\-]*?-tickets-(\d{9,}))", t):
        out.setdefault(f"eb:{m.group(2)}", f"{EB_HOST}/e/{m.group(1)}")
    for m in re.finditer(r"(?:wegottickets\.com)?/(?:af/\d+/)?(event|f)/(\d{3,})(?![\d])", t):
        out.setdefault(f"wgt-{m.group(1)}:{m.group(2)}", f"https://wegottickets.com/{m.group(1)}/{m.group(2)}")
    # TicketSource event pages: /<promoter>/<event-slug>/e-<id>
    for m in re.finditer(r"""href=["'](?:https?://(?:www\.)?ticketsource\.co(?:m|\.uk))?(/[A-Za-z0-9_\-%.]+/[A-Za-z0-9_\-%.]+/e-([A-Za-z0-9]+))["']""", t):
        out.setdefault(f"ts:{m.group(2).lower()}", f"https://www.ticketsource.com{m.group(1)}")
    # Ticket Tailor event pages: /events/<box-office>/<id>
    for m in re.finditer(r"""href=["'](?:https?://(?:www\.)?tickettailor\.com)?(/events/([A-Za-z0-9_\-]+)/(\d+))[/"'?#]""", t):
        out.setdefault(f"tt:{m.group(2).lower()}/{m.group(3)}", f"https://www.tickettailor.com{m.group(1)}")
    return out


def listing_id(url: str) -> str | None:
    """Identity of an organiser/promoter page, for resolving to performer/promoter/club in the feed."""
    u = urlsplit(url)
    if site_of(url) == "eventbrite":
        m = re.search(r"/o/(?:[^/?#]*?-)?(\d{9,})", u.path)
        return f"eb-org:{m.group(1)}" if m else None
    if site_of(url) == "wegottickets":
        seg = u.path.strip("/")
        return f"wgt:{seg.lower()}" if seg and not re.match(r"(event|f|af)/", seg) else None
    if site_of(url) == "tickettailor":
        m = re.fullmatch(r"/events/([A-Za-z0-9_\-]+)/?", u.path)
        return f"tt:{m.group(1).lower()}" if m else None
    if site_of(url) == "ticketsource":
        seg = u.path.strip("/")
        # a promoter's page is a single path segment (/storytelling); /whats-on/..., /booking/... and event pages are not
        return f"ts:{seg.lower()}" if seg and "/" not in seg and seg.lower() not in ("whats-on", "booking") else None
    return None


# ============================================================================ fetching
def http_get(url: str, retries: int = 3) -> str:
    headers = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                             "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
               "Accept": "text/html,application/xhtml+xml", "Accept-Language": "en-GB,en;q=0.9"}
    last = None
    for attempt in range(retries):
        try:
            try:
                from curl_cffi import requests as cr  # type: ignore
                r = cr.get(url, headers=headers, impersonate="chrome", timeout=30)
            except ImportError:
                import requests  # type: ignore
                r = requests.get(url, headers=headers, timeout=30)
            if r.status_code == 200:
                return r.text
            last = f"HTTP {r.status_code}"
            if r.status_code in (401, 403):
                raise RuntimeError(f"{last} (blocked). Try `pip install curl_cffi`, or save the page from your "
                                   "browser and use --listing-html / --event-html.")
        except RuntimeError:
            raise
        except Exception as e:
            last = repr(e)
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"GET {url} failed: {last}")


def get_page(url: str, cache: Path | None, refresh: bool, delay: float) -> str:
    path = cache / (hashlib.sha1(url.encode()).hexdigest()[:16] + ".html") if cache else None
    if path and path.exists() and not refresh:
        return path.read_text(encoding="utf-8")
    text = http_get(url)
    time.sleep(delay)
    if path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    return text



# ============================================================================ listing shape + time/price formatting
def listing_template(site: str, url: str) -> dict:
    return {"site": site, "url": url, "keys": ticket_keys(url), "title": "", "description": "", "start": None,
            "end": None, "time_text": "", "structured_time": None, "price_text": "", "structured_price": None,
            "price_ok": set(), "sold_out": False, "cancelled": False, "online": False, "hybrid": False,
            "location": {"name": "", "street": "", "city": "", "postcode": "", "latlon": None},
            "organiser_id": None, "promoter_name": "", "lineup": "", "age_text": "", "category": "",
            "past": False, "notes": []}


def norm_clock(s: str) -> str:
    """'7:30pm' -> '7.30pm', '7:00 PM' -> '7pm'."""
    m = re.search(r"(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?m\.?", s or "", re.I)
    if not m:
        return ""
    h, mi, mer = int(m.group(1)), int(m.group(2) or 0), m.group(3).lower() + "m"
    return f"{h}{mer}" if mi == 0 else f"{h}.{mi:02d}{mer}"


def clock_to_hm(s: str) -> tuple[int, int] | None:
    m = re.search(r"(\d{1,2})(?:[:.](\d{2}))?\s*([ap])m", s or "", re.I)
    if not m:
        return None
    h, mi, pm = int(m.group(1)) % 12, int(m.group(2) or 0), m.group(3).lower() == "p"
    return h + (12 if pm else 0), mi


def fmt_clock(t: dt.datetime) -> str:
    h = t.hour % 12 or 12
    return f"{h}" if t.minute == 0 else f"{h}.{t.minute:02d}"


def fmt_time(start, end) -> str:
    if not start:
        return ""
    sm = "am" if start.hour < 12 else "pm"
    if not end or end <= start or (end - start) > dt.timedelta(hours=14):
        return f"{fmt_clock(start)}{sm}"
    em = "am" if end.hour < 12 else "pm"
    return f"{fmt_clock(start)}-{fmt_clock(end)}{em}" if sm == em else f"{fmt_clock(start)}{sm}-{fmt_clock(end)}{em}"


def parse_dt(s):
    if not s:
        return None
    try:
        d = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return d.replace(tzinfo=UK) if d.tzinfo is None else d.astimezone(UK)


# ============================================================================ adapter: JSON-LD (Eventbrite + generic)
def _ld_items(node):
    if isinstance(node, list):
        for x in node:
            yield from _ld_items(x)
    elif isinstance(node, dict):
        if "@graph" in node:
            yield from _ld_items(node["@graph"])
        yield node


def jsonld_events(page: str) -> list[dict]:
    out = []
    for m in LD_RE.finditer(page):
        raw, data = m.group(1).strip(), None
        for cand in (raw, html.unescape(raw)):
            try:
                data = json.loads(cand)
                break
            except Exception:
                continue
        for it in _ld_items(data) if data is not None else []:
            t = it.get("@type")
            if any(isinstance(x, str) and x.endswith("Event") for x in (t if isinstance(t, list) else [t])):
                out.append(it)
    return out


def ld_location(ev: dict) -> dict:
    loc = ev.get("location")
    place, virtual = None, False
    for l in (loc if isinstance(loc, list) else [loc]):
        if isinstance(l, dict):
            if "VirtualLocation" in str(l.get("@type")):
                virtual = True
            else:
                place = place or l
    mode = str(ev.get("eventAttendanceMode", ""))
    out = {"online": "OnlineEventAttendanceMode" in mode or (virtual and not place),
           "hybrid": "MixedEventAttendanceMode" in mode, "name": "", "street": "", "city": "", "postcode": "",
           "latlon": None}
    if place:
        addr = place.get("address") or {}
        addr = {"streetAddress": addr} if isinstance(addr, str) else addr
        geo = place.get("geo") or {}
        out.update(name=(place.get("name") or "").strip(), street=addr.get("streetAddress", ""),
                   city=addr.get("addressLocality", ""), postcode=addr.get("postalCode", ""))
        try:
            out["latlon"] = [round(float(geo["latitude"]), 5), round(float(geo["longitude"]), 5)]
        except (KeyError, TypeError, ValueError):
            pass
        if not out["postcode"]:
            out["postcode"] = extract_postcode_or_eircode(" ".join([out["street"], out["city"]])) or ""
    return out


def ld_price(offers) -> tuple[str, bool, set]:
    offs = offers if isinstance(offers, list) else ([offers] if offers else [])
    vals, cur, sold = [], "GBP", []
    for o in offs:
        if not isinstance(o, dict):
            continue
        cur = o.get("priceCurrency") or cur
        for k in ("price", "lowPrice", "highPrice"):
            try:
                vals.append(float(o[k]))
            except (KeyError, TypeError, ValueError):
                pass
        if o.get("availability"):
            sold.append(str(o["availability"]).endswith("SoldOut"))
    sold_out = bool(sold) and all(sold)
    if not vals:
        return "", sold_out, set()
    lo, hi = min(vals), max(vals)
    if hi == 0:
        return "Free", sold_out, {0.0}
    sym = CURRENCY.get(cur, cur + " ")
    return (f"{sym}{money(lo)}" if lo == hi else f"From {sym}{money(lo)}"), sold_out, {lo}


def organiser_id_of(ev: dict) -> str | None:
    org = ev.get("organizer")
    for o in (org if isinstance(org, list) else [org]):
        if isinstance(o, dict):
            lid = listing_id(o.get("url", ""))
            if lid:
                return lid
    return None


def parse_jsonld(page: str, url: str) -> dict | str:
    """Return a Listing, or a string explaining why not."""
    evs = jsonld_events(page)
    keys = ticket_keys(url)
    ev = next((e for e in evs if any(k in ticket_keys(str(e.get("url", ""))) for k in keys)), evs[0] if evs else None)
    if not ev:
        return "no schema.org Event JSON-LD found on page"
    L = listing_template(site_of(url), url)
    m = re.search(r"/e/([A-Za-z0-9%_.\-]*?-tickets-\d{9,})", str(ev.get("url") or url))
    L["url"] = f"{EB_HOST}/e/{m.group(1)}" if L["site"] == "eventbrite" and m else (str(ev.get("url") or url))
    L["keys"] = ticket_keys(L["url"]) or keys
    L["start"], L["end"] = parse_dt(ev.get("startDate")), parse_dt(ev.get("endDate"))
    if not L["start"]:
        return "no startDate"
    L["title"] = clean_text(ev.get("name")).replace("\n", " ").strip()
    L["description"] = clean_text(ev.get("description"))
    L["price_text"], L["sold_out"], L["price_ok"] = ld_price(ev.get("offers"))
    L["cancelled"] = str(ev.get("eventStatus", "")).endswith("EventCancelled")
    if str(ev.get("eventStatus", "")).endswith(("EventPostponed", "EventRescheduled")):
        L["notes"].append(f"status on site: {ev.get('eventStatus')}")
    L["location"] = ld_location(ev)
    L["online"], L["hybrid"] = L["location"]["online"], L["location"]["hybrid"]
    L["organiser_id"] = organiser_id_of(ev)
    org = ev.get("organizer")
    org = org[0] if isinstance(org, list) and org else org
    L["promoter_name"] = (org.get("name") if isinstance(org, dict) else "") or ""
    multi = bool(L["end"] and (L["end"].date() - L["start"].date()).days >= 1)
    if multi:
        L["notes"].append(f"runs {fmt_dmy(L['start'].date())}-{fmt_dmy(L['end'].date())}; only start date recorded")
    L["time_text"] = fmt_time(L["start"], None if multi else L["end"])
    return L


# ============================================================================ adapter: WeGotTickets (page text)
def html_to_lines(page: str) -> list[str]:
    t = re.sub(r"(?is)<(script|style|noscript|svg)\b.*?</\1>", "", page)
    t = re.sub(r"(?is)<!--.*?-->", "", t)
    t = re.sub(r"(?i)<\s*(?:br|/?(?:p|div|li|h[1-6]|tr|section|article|ul|ol|table|form|button|header|footer|nav))\b[^>]*>", "\n", t)
    t = html.unescape(re.sub(r"<[^>]+>", "", t)).replace("\xa0", " ")
    t = re.sub(r"[\ue000-\uf8ff]", "", t)  # icon-font glyphs
    return [l for l in (re.sub(r"[ \t]+", " ", x).strip() for x in t.split("\n")) if l]


def page_title(page: str, lines: list[str]) -> str:
    for pat in (r"(?is)<h1[^>]*>(.*?)</h1>", r'(?is)<meta[^>]+property=["\']og:title["\'][^>]+content=["\'](.*?)["\']',
                r"(?is)<title[^>]*>(.*?)</title>"):
        m = re.search(pat, page)
        if m:
            t = html.unescape(re.sub(r"<[^>]+>", "", m.group(1))).strip()
            t = re.sub(r"\s*[|\-–—]\s*(?:WeGotTickets.*|Tickets?\b.*)$", "", t, flags=re.I).strip()
            if t:
                return re.sub(r"\s+", " ", t)
    return lines[0] if lines else ""


SECTION_END = re.compile(r"^(Tickets|Venue information|Simple, honest ticketing\.?|In the sometimes murky world.*|Access\b.*|Share this.*|Terms.*)$", re.I)
DATE_RE = re.compile(r"(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\s+(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s+(\d{4})")
VENUE_LINE = re.compile(r"^0?\s*([A-Z][A-Z0-9 .'&/\-]{1,40}):\s+(.+?)\s*(?:\(info\))?$")


def looks_like_lineup(line: str) -> bool:
    if len(line) > 160 or re.search(r"[.!?]\s*$", line) or line.lower().startswith(("tickets", "presented by", "past event", "this event")):
        return False
    parts = [p.strip() for p in re.split(r",|\band\b|&", line) if p.strip()]
    return bool(parts) and all(1 <= len(p.split()) <= 5 and p[0].isupper() for p in parts)


def parse_wgt(page: str, url: str) -> dict | str:
    lines = html_to_lines(page)
    L = listing_template("wegottickets", url)
    L["title"] = page_title(page, lines)
    L["past"] = any(re.match(r"past event!?", l, re.I) for l in lines)

    # --- date / venue line / times
    di = next((i for i, l in enumerate(lines) if DATE_RE.search(l)), None)
    if di is None:
        return "no date line found (page layout not recognised - run with --debug-text and compare)"
    dm = DATE_RE.search(lines[di])
    day, mon, year = int(dm.group(1)), MONTHS.get(dm.group(2)[:3].lower()), int(dm.group(3))
    if not mon:
        return f"unrecognised month {dm.group(2)!r}"
    vi, vm = next(((i, VENUE_LINE.match(lines[i])) for i in range(di, max(di - 5, -1), -1) if VENUE_LINE.match(lines[i])),
                  (None, None))
    window = " ".join(lines[di:di + 4])
    doors = re.search(r"door(?:s)?(?: time)?:?\s*(\d{1,2}(?:[:.]\d{2})?\s*[ap]m)", window, re.I)
    start = re.search(r"(?:start|show)(?: time)?:?\s*(\d{1,2}(?:[:.]\d{2})?\s*[ap]m)", window, re.I)
    plain = re.search(r"(?:^|\s)N?\s*(\d{1,2}[:.]\d{2}\s*[ap]m)\s*$", " ".join(lines[di + 1:di + 2]), re.I) \
        or re.search(r"\bN\s*(\d{1,2}[:.]\d{2}\s*[ap]m)", window, re.I)
    start_s = norm_clock(start.group(1)) if start else (norm_clock(plain.group(1)) if plain else "")
    doors_s = norm_clock(doors.group(1)) if doors else ""
    hm = clock_to_hm(start_s) or clock_to_hm(doors_s)
    L["start"] = dt.datetime(year, mon, day, *(hm or (0, 0)), tzinfo=UK)
    if doors_s and start_s:
        L["time_text"] = f"Doors {doors_s}, Start {start_s}"
        L["structured_time"] = [{"type": "doors", "time": doors_s}, {"type": "start", "time": start_s}]
    else:
        L["time_text"] = start_s or doors_s
    if not hm:
        L["notes"].append("no time found on page")

    # --- presenter + lineup (lines between the last title occurrence and the venue line)
    pres = next((l for l in lines if l.lower().startswith("presented by")), "")
    L["promoter_name"] = re.sub(r"(?i)^presented by:?\s*", "", pres).strip(" ,")
    t_idx = max((i for i, l in enumerate(lines[: (vi if vi is not None else di)]) if norm_name(l) == norm_name(L["title"])), default=-1)
    blurbs = []
    for l in lines[t_idx + 1:(vi if vi is not None else di)]:
        if l.lower().startswith(("tickets", "presented by", "past event")):
            continue
        if looks_like_lineup(l) and not L["lineup"]:
            L["lineup"] = l.strip(" ,")
        elif len(l) > 30:
            blurbs.append(l)

    # --- venue
    loc = L["location"]
    if vm:
        loc["city"], loc["name"] = vm.group(1).strip().title(), vm.group(2).strip()
    vinfo = next((i for i, l in enumerate(lines) if l.lower() == "venue information"), None)
    if vinfo is not None:
        block = []
        for l in lines[vinfo + 1:vinfo + 9]:
            if SECTION_END.match(l):
                break
            block.append(l)
        pcs = [i for i, l in enumerate(block) if extract_postcode_or_eircode(l)
               and re.sub(r"\s+", "", l.upper()) == extract_postcode_or_eircode(l).replace(" ", "")]
        if pcs:
            loc["postcode"] = extract_postcode_or_eircode(block[pcs[-1]])
            addr = [re.sub(r"^0\s?(?=\d)", "", l) for l in block[1:pcs[-1]]]
            if addr:
                loc["street"] = addr[0]
                loc["city"] = addr[-1] if len(addr) > 1 else loc["city"]
        if not loc["name"] and block:
            m = VENUE_LINE.match(block[0])
            if m:
                loc["city"], loc["name"] = m.group(1).title(), m.group(2)
    if not loc["name"]:
        L["notes"].append("venue not found on page")

    # --- age / category
    for l in lines[di:di + 8]:
        m = re.match(r"^[.\s]*((?:\d{1,2}\s*\+|\d{1,2}\s+and\s+over|all ages))(?!\w)(.*)$", l, re.I)
        if m:
            L["age_text"] = re.sub(r"^(\d{1,2})\s+and\s+over$", r"\1+", m.group(1).strip(), flags=re.I)
            if m.group(2).strip():
                L["notes"].append(f"age note on site: {m.group(1)}{m.group(2)}")
            break
    cm = next((re.match(r"^C\s*(.+)$", l) for l in lines[di:di + 8] if re.match(r"^C\s*[A-Z][A-Za-z &/-]+$", l)), None)
    L["category"] = cm.group(1) if cm else ""

    # --- description
    ei = next((i for i, l in enumerate(lines) if l.lower() == "event information"), None)
    body = []
    if ei is not None:
        for l in lines[ei + 1:]:
            if SECTION_END.match(l):
                break
            body.append(l)
    L["description"] = "\n\n\n\n".join(blurbs + body)

    # --- tickets / price
    ti = next((i for i, l in enumerate(lines) if l.lower() == "tickets" and i > di), None)
    seg = lines[ti:vinfo if vinfo and vinfo > (ti or 0) else None] if ti is not None else lines[di:]
    entries, label = [], ""
    for l in seg:
        m = re.search(r"Ticket price:\s*£\s*([\d.]+)(?:,?\s*Booking fee:\s*£\s*([\d.]+))?", l, re.I)
        if m:
            entries.append((label, float(m.group(1)), float(m.group(2)) if m.group(2) else 0.0))
        elif not re.match(r"(?i)(tickets are|total price|sold out|tickets$|not on sale|on sale)", l):
            label = l
    if entries:
        def etype(lbl: str) -> str:
            lbl = lbl.lower()
            for kw, t in (("concession", "concession"), ("student", "concession"), ("senior", "concession"),
                          ("child", "concession"), ("early", "earlybird"), ("advance", "advance"), ("member", "member")):
                if kw in lbl:
                    return t
            return "standard"
        sp, texts = [], []
        for lbl, amt, fee in entries:
            e = {"type": etype(lbl), "amount": amt}
            if len(entries) > 1 and e["type"] == "standard" and lbl:
                e["label"] = lbl
            if fee:
                e["fee"] = fee
            sp.append(e)
            texts.append("Free" if amt == 0 else f"£{money(amt)}" + (f" (+ £{fee:.2f})" if fee else ""))
            L["price_ok"] |= {amt, round(amt + fee, 2)}
        if all(e["amount"] == 0 for e in sp):
            L["price_text"], L["structured_price"] = "Free", [{"type": "free"}]
        else:
            L["price_text"], L["structured_price"] = " / ".join(texts), sp
    else:
        tp = re.search(r"Total price:\s*£\s*([\d.]+)", " ".join(seg), re.I)
        if tp:
            L["price_text"] = "Free" if float(tp.group(1)) == 0 else f"£{money(float(tp.group(1)))}"
            L["price_ok"] = {float(tp.group(1))}
    seg_text = " ".join(seg)
    L["sold_out"] = bool(re.search(r"\bsold out\b", seg_text, re.I)) and "tickets are available" not in seg_text.lower()
    if re.search(r"\bcancel+ed\b", " ".join(lines[:12]), re.I):
        L["cancelled"] = True
    if L["sold_out"] or L["cancelled"]:
        L["notes"].append("sold-out/cancelled status is detected from page text - check")
    L["_lines"] = lines
    return L


# ============================================================================ adapter: TicketSource
def _ts_text(x: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", x or ""))).strip()


def ticketsource_rows(page: str) -> dict[str, dict]:
    """The schema.org-microdata event rows on a TicketSource promoter page (or an event page), keyed like ticket_keys.
    A listing row has title, venue, town, start (and usually end) time and availability, but no price or description."""
    rows: dict[str, dict] = {}
    chunks = re.split(r'(?=itemtype=["\']https?://schema\.org/Event["\'])', page)[1:]
    for ch in chunks:
        href = re.search(r"""href=["'](?:https?://(?:www\.)?ticketsource\.co(?:m|\.uk))?(/[^"'\s?#]+/e-([A-Za-z0-9]+))["']""", ch)
        if not href:
            continue
        name = re.search(r'itemprop=["\']name["\'][^>]*>(.*?)</', ch, re.S)
        venue_blk = re.search(r'itemtype=["\']https?://schema\.org/EventVenue["\'](.*?)(?=itemprop=["\']startDate|$)', ch, re.S)
        vblk = venue_blk.group(1) if venue_blk else ""
        vname = re.search(r'itemprop=["\']name["\'][^>]*>(.*?)</', vblk, re.S)
        town = re.search(r'itemprop=["\']addressLocality["\'][^>]*>(.*?)</', vblk, re.S)
        start = re.search(r'itemprop=["\']startDate["\'][^>]*content=["\']([^"\']+)', ch) or \
            re.search(r'content=["\']([^"\']+)["\'][^>]*itemprop=["\']startDate', ch)
        tm = re.search(r"<time[^>]*>(.*?)</time>", ch, re.S)
        book = re.search(r"/booking/init/([A-Za-z0-9]+)", ch)
        avail = re.search(r'class=["\'][^"\']*availability[^"\']*["\'][^>]*>(.*?)</div>', ch, re.S)
        rows[f"ts:{href.group(2).lower()}"] = {
            "site": "ticketsource", "path": href.group(1), "title": _ts_text(name.group(1)) if name else "", "venue": _ts_text(vname.group(1)) if vname else "",
            "town": _ts_text(town.group(1)) if town else "", "start": start.group(1) if start else "",
            "time_text": _ts_text(tm.group(1)) if tm else "", "booking": book.group(1).lower() if book else "",
            "availability": _ts_text(avail.group(1)) if avail else "", "sold_out_text": bool(re.search(r"sold\s*out", ch, re.I)),
        }
    return rows


def ts_row_to_listing(row: dict) -> dict | str:
    url = f"https://www.ticketsource.com{row['path']}"
    L = listing_template("ticketsource", url)
    if row.get("booking"):
        L["keys"] = L["keys"] + [f"ts:{row['booking']}"]
    L["start"] = parse_dt(row.get("start"))
    if not L["start"]:
        return "no start date in the listing row"
    times = re.findall(r"\d{1,2}(?::\d{2})?\s*[AP]M", row.get("time_text", ""), re.I)
    if len(times) >= 2:
        hm = clock_to_hm(times[-1])
        if hm:
            end = L["start"].replace(hour=hm[0], minute=hm[1])
            L["end"] = end if end > L["start"] else None
    L["title"] = row.get("title", "")
    L["time_text"] = fmt_time(L["start"], L["end"])
    L["location"]["name"], L["location"]["city"] = row.get("venue", ""), row.get("town", "")
    L["sold_out"] = bool(row.get("sold_out_text"))
    return L


# ============================================================================ Ticket Tailor (box-office listing rows)
def tickettailor_rows(page: str) -> dict[str, dict]:
    """Event rows on a Ticket Tailor box-office page (/events/<box-office>): title, date/time range and a location line
    that is usually 'venue, street, town, postcode'. No price or description - those need the event page."""
    rows: dict[str, dict] = {}
    t = html.unescape(page)
    for ch in re.split(r'(?=<li[^>]+events-listing__item)', t)[1:]:
        href = re.search(r"""href=["']/events/([A-Za-z0-9_\-]+)/(\d+)["']""", ch)
        if not href:
            continue
        title = re.search(r"""class=["']event__link["'][^>]*>(.*?)</a>""", ch, re.S)
        when = re.search(r"""event-meta__date["'][^>]*>(.*?)</span>\s*<span""", ch, re.S) or re.search(r"""event-meta__date["'][^>]*>(.*?)</span>""", ch, re.S)
        where = re.search(r"""event-meta__location["'][^>]*>(.*?)</span>""", ch, re.S)
        rows[f"tt:{href.group(1).lower()}/{href.group(2)}"] = {
            "site": "tickettailor", "path": f"/events/{href.group(1)}/{href.group(2)}",
            "title": _ts_text(title.group(1)) if title else "", "when": _ts_text(when.group(1)) if when else "",
            "where": _ts_text(where.group(1)) if where else "", "sold_out_text": bool(re.search(r"sold\s*out", ch, re.I)),
        }
    return rows


def tt_parse_where(where: str) -> dict:
    """'Venue, street, town, postcode' (Ticket Tailor's location line) -> a Listing location."""
    if re.match(r"(?i)(online|zoom)\b", where or ""):
        return {"name": where, "street": "", "city": "", "postcode": "", "latlon": None, "online": True, "hybrid": False}
    pc = extract_postcode_or_eircode(where) or ""
    parts = [x.strip() for x in (where or "").split(",") if x.strip()]
    no_pc = parts[:-1] if pc and parts and extract_postcode_or_eircode(parts[-1]) == pc else parts
    return {"name": parts[0] if parts else "", "street": ", ".join(parts[1:]), "postcode": pc,
            "city": no_pc[-1] if len(no_pc) > 1 else "", "latlon": None}


def parse_tickettailor(page: str, url: str) -> dict | str:
    """Event page: JSON-LD for dates/price, then the visible page for what the JSON-LD gets wrong -
    its description is cut off after ~200 characters and its location name is 'venue, town'."""
    L = parse_jsonld(page, url)
    if isinstance(L, str):
        return L
    m = re.search(r"event-page-description[^>]*>\s*<div[^>]*>(.*?)</div>\s*</section>", page, re.S)
    if m:
        full = clean_text(m.group(1))
        if len(full) > len(L["description"]):
            L["description"] = full
    w = re.search(r"event-meta__location[\"'][^>]*>(.*?)</span>", page, re.S)
    if w and not L["online"]:
        loc = tt_parse_where(_ts_text(w.group(1)))
        if loc["name"] and not loc.get("online"):
            L["location"].update(loc)
    offers = next((e.get("offers") for e in jsonld_events(page) if e.get("offers")), None) or []
    tiers = [(o.get("name"), o.get("price")) for o in offers if isinstance(o, dict) and o.get("price") is not None]
    if len(tiers) > 1:
        L["notes"].append("ticket tiers: " + "; ".join(f"{n} \u00a3{money(float(pr))}" for n, pr in tiers))
    return L


def tt_row_to_listing(row: dict) -> dict | str:
    url = f"https://www.tickettailor.com{row['path']}"
    L = listing_template("tickettailor", url)
    dates = re.findall(r"(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})", row.get("when", ""))
    times = re.findall(r"\d{1,2}:\d{2}\s*[AP]M", row.get("when", ""), re.I)

    def mk(d, tm):
        mon = MONTHS.get(d[1].lower())
        hm = clock_to_hm(tm) if tm else (0, 0)
        return dt.datetime(int(d[2]), mon, int(d[0]), *(hm or (0, 0)), tzinfo=UK) if mon else None
    if not dates:
        return "no date in the listing row"
    L["start"] = mk(dates[0], times[0] if times else "")
    if not L["start"]:
        return "unrecognised date in the listing row"
    if len(times) > 1:
        L["end"] = mk(dates[1] if len(dates) > 1 else dates[0], times[1])
    multi = bool(L["end"] and (L["end"].date() - L["start"].date()).days >= 1)
    if multi:
        L["notes"].append(f"runs {fmt_dmy(L['start'].date())}-{fmt_dmy(L['end'].date())}; only start date recorded")
    L["time_text"] = fmt_time(L["start"], None if multi else L["end"])
    L["title"] = row.get("title", "")
    L["sold_out"] = bool(row.get("sold_out_text"))
    L["location"].update(tt_parse_where(row.get("where", "")))
    L["online"] = bool(L["location"].get("online"))
    return L


def listing_rows(page: str) -> dict[str, dict]:
    return {**ticketsource_rows(page), **tickettailor_rows(page)}


def row_to_listing(row: dict) -> dict | str:
    return tt_row_to_listing(row) if row.get("site") == "tickettailor" else ts_row_to_listing(row)


def parse_ticketsource(page: str, url: str) -> dict | str:
    """Event page: schema.org JSON-LD if the page has it, otherwise its microdata Event."""
    res = parse_jsonld(page, url)
    if isinstance(res, dict):
        return res
    rows = ticketsource_rows(page)
    keys = ticket_keys(url)
    row = next((r for k, r in rows.items() if k in keys), next(iter(rows.values()), None))
    if row:
        L = ts_row_to_listing(row)
        if isinstance(L, dict):
            L["notes"].append("TicketSource event page read from its microdata only (no price/description/address): check")
        return L
    return res


PARSERS = {"wegottickets": parse_wgt, "ticketsource": parse_ticketsource, "tickettailor": parse_tickettailor}


def parse_page(page: str, url: str) -> dict | str:
    site = site_of(url)
    if site in PARSERS:
        res = PARSERS[site](page, url)
        if isinstance(res, dict) or not jsonld_events(page):
            return res
    return parse_jsonld(page, url)


# ============================================================================ feed index / reconciliation
BUCKETS = ("specificEvents", "musicEvents", "poetryEvents")
AREA_STOP = {"road", "street", "lane", "close", "way", "avenue", "drive", "county", "ireland", "united", "kingdom",
             "england", "scotland", "wales", "north", "south", "east", "west"}


class Feed:
    def __init__(self, feed: dict):
        self.feed = feed
        self.slots: list[dict] = []
        self.pos: dict[int, tuple[str, int]] = {}     # id(record) -> (bucket, index): the builder's updatedEvents key
        for b in BUCKETS:
            for i, r in enumerate(feed.get(b, [])):
                self.slots.append(r)
                self.pos[id(r)] = (b, i)
        for t in feed.get("tours", {}).values():
            self.slots += t.get("tour_dates", [])
        for sh in feed.get("repertoire_shows", {}).values():
            self.slots += sh.get("show_dates", [])
        self.by_key: dict[str, list[dict]] = {}
        self.by_slot: dict[tuple[str, str], list[dict]] = {}
        self.event_ids: set[str] = set()
        for r in self.slots:
            if r.get("eventId"):
                self.event_ids.add(r["eventId"])
            for v in r.values():
                for k in ticket_keys(v) if isinstance(v, str) else []:
                    self.by_key.setdefault(k, []).append(r)
            for iso in self.record_dates(r):
                self.by_slot.setdefault((iso, r.get("venue_id", "")), []).append(r)
        self.festival_keys = {k for f in feed.get("festivals", {}).values() for k in ticket_keys(f.get("ticket_url", ""))}
        self.aff = feed.get("affiliate_ids", {})
        # venues: many records carry only full_address + latlon, so postcode/city are derived the way the builder does
        self.venues: dict[str, dict] = feed.get("venues", {})
        self.vinfo: dict[str, dict] = {}
        for vid, v in self.venues.items():
            self._index_venue(vid, v)

    def _index_venue(self, vid: str, v: dict) -> None:
        fa = v.get("full_address", "")
        parsed = parse_town_postcode_from_address(fa) or {}
        self.vinfo[vid] = {"postcode": v.get("postcode") or extract_postcode_or_eircode(fa) or "",
                           "city": v.get("city") or parsed.get("town", ""),
                           "text": " ".join(x for x in (v.get("name"), fa, v.get("city")) if x).lower()}

    def add_venue(self, v: dict) -> None:
        """Make a venue created during this run visible to match_venue, so later events at it reuse it."""
        self.venues[v["id"]] = v
        self._index_venue(v["id"], v)

    @staticmethod
    def record_dates(r: dict) -> list[str]:
        out = []
        for s in [r.get("date", "")] + list(r.get("dates", [])) + [x.split(":")[0].strip() for x in r.get("datetimes", [])]:
            d = parse_dmy(s) if isinstance(s, str) and s else None
            if d:
                out.append(d.isoformat())
        return out

    # ---- listing page -> performer / promoter / club
    def resolve_listing(self, url: str) -> dict:
        res = {"performer_id": "", "promoter_id": "", "club": ""}
        lid = listing_id(url)
        if not lid:
            return res

        def hit(rec, keys):
            return any(listing_id(str(rec.get(k, ""))) == lid for k in keys)
        for p in self.feed.get("performers", {}).values():
            if hit(p, ("tickets_url", "ticketing_url", "url")) and not res["performer_id"]:
                res["performer_id"] = p["id"]
        for p in self.feed.get("promoters", {}).values():
            if hit(p, ("ticketing_url", "tickets_url", "promoter_link", "url")) and not res["promoter_id"]:
                res["promoter_id"] = p["promoter_id"]
        for c in self.feed.get("clubs", []):
            if c.get("club") and hit(c, ("tickets_url", "ticketing_url", "link")) and not res["club"]:
                res["club"] = c["club"]
        return res

    def promoter_by_name(self, name: str) -> str:
        n = norm_name(name)
        for p in self.feed.get("promoters", {}).values():
            if n and n in (norm_name(p.get("name", "")), norm_name(p.get("promoter_id", ""))):
                return p["promoter_id"]
        return ""

    def performer_name(self, pid: str) -> str:
        return self.feed.get("performers", {}).get(pid, {}).get("name", "")

    def match_lineup(self, lineup: str) -> tuple[list[str], list[str]]:
        found, missing = [], []
        for n in (x.strip() for x in re.split(r",|\band\b|&", lineup) if x.strip()):
            nn = norm_name(n)
            pid = next((p["id"] for p in self.feed.get("performers", {}).values()
                        if nn and nn == norm_name(re.sub(r"\s*\(.*?\)", "", p.get("name", "")))), "")
            (found if pid else missing).append(pid or n)
        return list(dict.fromkeys(found)), missing

    def infer_performer(self, title: str, desc: str) -> tuple[str, str]:
        def hits(text):
            t = text.lower()
            out = []
            for p in self.feed.get("performers", {}).values():
                n = re.sub(r"\s*\(.*?\)", "", p.get("name", "")).strip().lower()
                if len(n) >= 5 and re.search(r"(?<![a-z])" + re.escape(n) + r"(?![a-z])", t):
                    out.append(p["id"])
            return out
        for text, where in ((title, "title"), (desc[:500], "description")):
            h = hits(text)
            if len(h) == 1:
                return h[0], where
        return "", ""

    def infer_club(self, text: str) -> str:
        t = text.lower()
        for c in self.feed.get("clubs", []):
            n = (c.get("name") or "").lower().replace("[lapsed?]", "").strip()
            if c.get("club") and len(n) >= 8 and n in t:
                return c["club"]
        return ""

    # ---- venues: the builder's "Possible duplicate venues" signals, used as an auto-match with a stricter bar
    def match_venue(self, loc: dict) -> dict:
        name, ll = loc["name"], loc["latlon"]
        pc = norm_pc(loc["postcode"]) or norm_pc(extract_postcode_or_eircode(" ".join([loc["street"], loc["city"]])) or "")
        area = {t for t in re.findall(r"[a-z]{4,}", re.sub(r"\b[a-z]{1,2}\d[a-z\d]?\s*\d[a-z]{2}\b", " ", f"{loc['street']} {loc['city']}".lower()))
                if t not in AREA_STOP}
        cands = []
        for vid, v in self.venues.items():
            info = self.vinfo[vid]
            same_pc = bool(pc) and pc == norm_pc(info["postcode"])
            dist = haversine(ll, v["latlon"]) if ll and isinstance(v.get("latlon"), list) and len(v["latlon"]) == 2 else None
            close = dist is not None and dist < 150
            core = core_name_similarity(name, v.get("name", ""))
            strong = core >= 0.85
            if not (same_pc or close or strong):
                continue
            full = difflib.SequenceMatcher(None, " ".join(venue_tokens(name)), " ".join(venue_tokens(v.get("name", "")))).ratio()
            generic = not core_venue_name(name) or not core_venue_name(v.get("name", ""))
            cands.append({"id": vid, "name": v.get("name", vid), "same_pc": same_pc, "dist": dist, "close": close, "core": core,
                          "strong": strong, "full": full, "generic": generic,
                          "area_hit": bool(area & set(re.findall(r"[a-z]{4,}", info["text"]))),
                          "score": (0.4 if same_pc else 0) + (0.4 * (1 - dist / 150) if close else 0) + (core * 0.5 if strong else 0)})
        cands.sort(key=lambda c: -c["score"])
        loc_hits = sum(1 for c in cands if c["same_pc"] or c["close"])

        def verdict(c):
            name_ok = c["core"] >= 0.5 or c["full"] >= 0.6 or (c["generic"] and loc_hits == 1)
            if (c["same_pc"] or c["close"]) and name_ok:
                return "high"
            if c["same_pc"] and c["close"]:
                return "high"
            if c["same_pc"] and c["core"] >= 0.3:
                return "medium"
            if c["strong"] and c["area_hit"]:
                return "medium"
            return None

        def why(c):
            r = []
            if c["same_pc"]:
                r.append("same postcode")
            if c["close"]:
                r.append(f"{c['dist']:.0f}m apart")
            if c["core"]:
                r.append(f"core name {c['core'] * 100:.0f}%")
            return ", ".join(r) or "weak signal"
        ok = [c for c in cands if verdict(c)]
        res = {"venue_id": None, "confidence": "none", "how": "", "similar": []}
        if ok and not (len(ok) > 1 and verdict(ok[0]) == verdict(ok[1]) and ok[0]["score"] - ok[1]["score"] < 0.1):
            return {**res, "venue_id": ok[0]["id"], "confidence": verdict(ok[0]), "how": why(ok[0])}
        res["how"] = "ambiguous between several venues - not auto-matched" if ok else ""
        res["similar"] = [{"id": c["id"], "name": c["name"], "why": why(c)} for c in cands[:5]]
        if ll:   # nearby locale detection (findNearbyByLatLon), for the reviewer
            seen = {x["id"] for x in res["similar"]}
            res["similar"] += [{"id": vid, "name": v.get("name", vid), "why": f"{d * 1000:.0f}m away"}
                               for vid, v, d in find_nearby_by_latlon(ll[0], ll[1], self.venues, 2, 5) if vid not in seen]
        return res

    def new_venue(self, loc: dict, taken: set[str]) -> dict:
        """A newVenues record shaped like the builder's: {id, name, full_address, city, postcode, latlon}."""
        name = loc["name"] or "Unknown venue"
        street, city = loc["street"], loc["city"]
        pc = loc["postcode"] or extract_postcode_or_eircode(street) or ""
        parts = [name, street]
        if city and city.lower() not in street.lower():
            parts.append(city)
        if pc and pc.replace(" ", "").lower() not in street.replace(" ", "").lower():
            parts.append(pc)
        full = ", ".join(x for x in parts if x)
        rec = {"id": unique_id(slugify(name), lambda i: i in self.venues or i in taken), "name": name, "full_address": full}
        parsed = parse_town_postcode_from_address(full) or {}
        if city or parsed.get("town"):
            rec["city"] = parsed.get("town") or city
        if pc or parsed.get("postcode"):
            rec["postcode"] = pc or parsed["postcode"]
        if loc["latlon"]:
            rec["latlon"] = loc["latlon"]
        return rec


def clock_tokens(s: str) -> set[tuple[int, int]]:
    toks = [(int(m.group(1)), int(m.group(2) or 0), (m.group(3) or "").lower())
            for m in re.finditer(r"(\d{1,2})(?:[.:](\d{2}))?\s*(am|pm)?", s or "", re.I)]
    out = set()
    for i, (h, mi, mer) in enumerate(toks):
        mer = mer or next((t[2] for t in toks[i + 1:] if t[2]), "")
        for m_ in ([mer] if mer else ["am", "pm"]):
            out.add(((h % 12) + (12 if m_ == "pm" else 0), mi))
    return out


def price_numbers(s: str) -> set[float]:
    return {float(x) for x in re.findall(r"\d+(?:\.\d+)?", s or "")}


def reconcile_existing(old: dict, new: dict, L: dict) -> tuple[list, list]:
    """Fill blanks and refresh status flags only; everything else differing is a reported conflict."""
    applied, conflicts = [], []

    def put(field, val):
        applied.append({"field": field, "old": old.get(field), "new": val})
        old[field] = val
    for f in ("time", "price", "description", "ticket_url", "age_rating", "min_age", "venue_id"):
        if f in ("age_rating", "min_age") and old.get("age_rating"):
            continue   # never mix a site's age with an existing age_rating
        if new.get(f) not in (None, "") and old.get(f) in (None, ""):
            put(f, new[f])
    if new.get("isCancelled") and not old.get("isCancelled"):
        put("isCancelled", True)
    if new.get("isSoldOut") and not old.get("isSoldOut"):
        put("isSoldOut", True)
    elif not new.get("isSoldOut") and old.get("isSoldOut"):
        conflicts.append({"field": "isSoldOut", "feed": True, "site": False,
                          "note": "site now shows tickets available - check, then remove the flag"})
    if old.get("date") and new.get("date") and old["date"] != new["date"]:
        conflicts.append({"field": "date", "feed": old["date"], "site": new["date"], "note": "rescheduled? eventId left unchanged"})
    if old.get("venue_id") and new.get("venue_id") and old["venue_id"] != new["venue_id"]:
        conflicts.append({"field": "venue_id", "feed": old["venue_id"], "site": new["venue_id"]})
    start = L["start"]
    if start and (start.hour, start.minute) != (0, 0) and old.get("time") and clock_tokens(old["time"]) \
            and (start.hour, start.minute) not in clock_tokens(old["time"]) \
            and not (L["structured_time"] and any(clock_to_hm(t["time"]) in clock_tokens(old["time"]) for t in L["structured_time"])):
        conflicts.append({"field": "time", "feed": old["time"], "site": new.get("time")})
    if old.get("price") and new.get("price"):
        olds = price_numbers(old["price"])
        ok = ("free" in new["price"].lower() and ("free" in old["price"].lower() or 0 in olds)) or \
            any(abs(a - b) < 0.011 for a in (L["price_ok"] or price_numbers(new["price"])) for b in olds)
        if not ok and re.search(r"fee", old["price"], re.I):
            lo = min(L["price_ok"] or price_numbers(new["price"]) or {0})
            ok = any(o <= lo <= o * 1.3 + 0.5 for o in olds)   # feed says "+ fee"; site price likely includes it
        if not ok:
            conflicts.append({"field": "price", "feed": old["price"], "site": new["price"],
                              "note": "feed prices often include booking fees, so compare by eye"})
    return applied, conflicts


def apply_affiliate(url: str, site: str, feed: Feed, args) -> str:
    """Rebuild a new ticket_url in the feed's own affiliate style, if one is configured."""
    if site == "wegottickets":
        m = re.search(r"/(event|f)/(\d+)", url)
        aff = args.wgt_aff or feed.aff.get("wegottickets")
        if m and aff and not args.no_aff:
            return f"https://wegottickets.com/af/{aff}/{m.group(1)}/{m.group(2)}"
    if site == "eventbrite" and args.aff and "aff=" not in url:
        return f"{url}?aff={args.aff}"
    return url


# ============================================================================ main
def disambiguate_id(base: str, title: str, key: str, used: set[str]) -> str:
    words = [w for w in slugify(title).split("-") if w not in {"the", "a", "of", "and", "in", "to"}][:2]
    cand = f"{base}-{'-'.join(words)}" if words else base
    return cand if cand not in used else f"{base}-{re.sub(r'[^0-9a-z]', '', key)[-6:]}"


def note_ts_paging(found: dict, source: str, report: dict) -> None:
    """TicketSource promoter pages show 12 events per load; the rest come in via a 'show more' request."""
    n = sum(1 for k in found if k.startswith("ts:"))
    if n >= 12:
        report["warnings"].append(f"{source}: {n} TicketSource events found - the page shows 12 at a time, so later events may be "
                                  "missing. Scroll/'show more' to the end in your browser, save the page and pass it via --listing-html.")


def load_prior_output(path: str) -> dict:
    """The existing output file, if any (so a new run can be added to it). Refuses to carry on if it can't be read,
    rather than risk overwriting someone's work."""
    p = Path(path)
    if not p.exists():
        return {}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("top level is not an object")
        for k, t in (("newVenues", dict), ("specificEvents", list), ("updatedEvents", dict)):
            if k in data and not isinstance(data[k], t):
                raise ValueError(f"{k} should be a {t.__name__}")
    except (ValueError, OSError) as e:
        sys.exit(f"ERROR: {path} exists but can't be used ({e}). Fix or move it, or pass --overwrite to replace it.")
    return data


def same_record(a: dict, b: dict) -> bool:
    """Do two copies of a feed record describe the same event? (guards updatedEvents' positional keys)"""
    if a.get("eventId") and b.get("eventId"):
        return a["eventId"] == b["eventId"]
    return all(a.get(k) == b.get(k) for k in ("name", "date", "venue_id"))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("feed", help="events_normalized.json")
    ap.add_argument("urls", nargs="*", help="listing/promoter/organiser pages and/or event pages (mixed is fine)")
    ap.add_argument("-o", "--out", default="new_event_data.json", help="the single output file (builder format)")
    ap.add_argument("--overwrite", action="store_true", help="replace the output file instead of adding this run to it")
    ap.add_argument("--report", default=None, help="also save the review notes as JSON")
    ap.add_argument("--listing-html", nargs="*", default=[], help="saved listing page(s) to scan for event links")
    ap.add_argument("--event-html", nargs="*", default=[], help="saved event page(s); the URL is guessed from the page")
    ap.add_argument("--cache", default=".ticket_cache", help="page cache dir")
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--delay", type=float, default=1.5)
    ap.add_argument("--include-past", action="store_true")
    ap.add_argument("--include-online", action="store_true", help="keep online-only events (hybrid is always kept)")
    ap.add_argument("--performer", default=None, help="force performer_id for pasted event URLs")
    ap.add_argument("--promoter", default=None, help="force promoter_id for pasted event URLs")
    ap.add_argument("--aff", default=None, help="Eventbrite: append ?aff=<value> to new ticket_urls")
    ap.add_argument("--wgt-aff", default=None, help="WeGotTickets affiliate id (default: affiliate_ids.wegottickets in the feed)")
    ap.add_argument("--no-aff", action="store_true", help="do not build /af/<id>/ WeGotTickets URLs")
    ap.add_argument("--geocode", action="store_true", help="geocode NEW venues without coordinates via Nominatim (builder's method)")
    ap.add_argument("--debug-text", default=None, metavar="DIR", help="write the text each page parser saw to DIR")
    ap.add_argument("--today", default=None, help="override today (dd/mm/yyyy) - for testing")
    a = ap.parse_args(argv)

    prior = {} if a.overwrite else load_prior_output(a.out)
    feed_raw = json.loads(Path(a.feed).read_text(encoding="utf-8"))
    # venues created by an earlier run are not in the feed yet, but should still be matched (not re-created)
    if prior.get("newVenues"):
        feed_raw["venues"] = {**{k: v for k, v in prior["newVenues"].items() if k not in feed_raw.get("venues", {})},
                              **feed_raw.get("venues", {})}
    feed = Feed(feed_raw)
    prior_keys = {k for r in prior.get("specificEvents", []) for k in ticket_keys(r.get("ticket_url", ""))}
    cache = Path(a.cache)
    today = parse_dmy(a.today) if a.today else dt.datetime.now(UK).date()
    report: dict = {"run": dt.datetime.now(UK).isoformat(timespec="seconds"), "listings": {}, "events": [], "warnings": [],
                    "missing_from_site": []}

    # ---- sources
    listings: dict[str, dict] = {}
    pool: dict[str, dict] = {}
    for u in a.urls:
        if is_event_url(u):
            ks = ticket_keys(u)
            pool.setdefault(ks[0] if ks else u, {"url": u, "ctx": None, "html": None})
            continue
        ctx = {"url": u, **feed.resolve_listing(u), "found": 0}
        listings[u] = ctx
        report["listings"][u] = ctx
        if not (ctx["performer_id"] or ctx["promoter_id"] or ctx["club"]):
            report["warnings"].append(f"{u}: nothing in the feed links to this page (performer/promoter/club) - "
                                      "records get no performer_id/promoter_id unless one is inferred from the title")
        try:
            ptxt = get_page(u, cache, a.refresh, a.delay)
        except RuntimeError as e:
            report["warnings"].append(f"{u}: {e}")
            continue
        found, rows = extract_links(ptxt), listing_rows(ptxt)
        note_ts_paging(found, u, report)
        ctx["found"] = len(found)
        if not found:
            report["warnings"].append(f"{u}: no event links found in the fetched HTML (the list may be rendered client-side). "
                                      "Save the loaded page from your browser and pass it via --listing-html.")
        for k, link in found.items():
            pool.setdefault(k, {"url": link, "ctx": ctx, "html": None, "row": rows.get(k)})
    for f in a.listing_html:
        ctx = next(iter(listings.values())) if len(listings) == 1 else None
        ltxt = Path(f).read_text(encoding="utf-8", errors="replace")
        found, rows = extract_links(ltxt), listing_rows(ltxt)
        note_ts_paging(found, f, report)
        for k, link in found.items():
            pool.setdefault(k, {"url": link, "ctx": ctx, "html": None, "row": rows.get(k)})
    for f in a.event_html:
        txt = Path(f).read_text(encoding="utf-8", errors="replace")
        canon = re.search(r"""(?:rel=["']canonical["'][^>]*href|property=["']og:url["'][^>]*content)=["']([^"']+)""", html.unescape(txt))
        guess = (next((str(e["url"]) for e in jsonld_events(txt) if e.get("url")), "")
                 or (canon.group(1) if canon else "") or next(iter(extract_links(txt).values()), ""))
        pool[(ticket_keys(guess) or [f])[0]] = {"url": guess or f, "ctx": None, "html": txt}
    discovery_incomplete = any(c["found"] == 0 for c in listings.values()) and not (a.listing_html or a.event_html)

    # ---- fetch + parse
    parsed: list[tuple[dict, dict]] = []
    for key, item in sorted(pool.items()):
        entry = {"key": key, "url": item["url"]}
        try:
            page = item["html"] or get_page(item["url"], cache, a.refresh, a.delay)
            L = parse_page(page, item["url"])
        except RuntimeError as e:
            L = f"fetch failed: {e}"
        if isinstance(L, str) and item.get("row"):
            # e.g. TicketSource event pages blocked or unreadable: the listing row still has title/venue/date
            why = L
            L = row_to_listing(item["row"])
            if isinstance(L, dict):
                L["notes"].append(f"built from the listing row only ({why}): no price or description")
        if isinstance(L, str):
            if L.startswith("fetch failed"):
                entry["status"] = L
                report["events"].append(entry)
                continue
            entry["status"] = f"skipped: {L}"
            report["events"].append(entry)
            continue
        if a.debug_text and L.get("_lines"):
            d = Path(a.debug_text)
            d.mkdir(parents=True, exist_ok=True)
            (d / (re.sub(r"[^0-9A-Za-z]+", "_", key) + ".txt")).write_text("\n".join(L["_lines"]), encoding="utf-8")
        L.pop("_lines", None)
        parsed.append((L, {"entry": entry, "ctx": item["ctx"]}))

    # ---- same event reached via two URL forms (e.g. WeGotTickets /event/ and /f/)
    seen_sig: dict[tuple, dict] = {}
    deduped = []
    for L, meta in parsed:
        sig = (norm_name(L["title"]), L["start"], norm_name(L["location"]["name"]))
        if sig in seen_sig:
            seen_sig[sig]["keys"] += [k for k in L["keys"] if k not in seen_sig[sig]["keys"]]
            meta["entry"].update(status=f"duplicate of {seen_sig[sig]['url']} (same title, time and venue - kept that URL form)",
                                 title=L["title"], site=L["site"])
            report["events"].append(meta["entry"])
            continue
        seen_sig[sig] = L
        deduped.append((L, meta))

    # ---- build records (the builder's specificEvent shape and key order)
    new_records: list[dict] = []
    new_venues: dict[str, dict] = {}
    updated_events: dict[str, dict] = {}
    used_ids = set(feed.event_ids) | {r["eventId"] for r in prior.get("specificEvents", []) if r.get("eventId")}
    updated_fields: dict[str, list[str]] = {}
    noted_promoters: set[str] = set()
    stamp = fmt_dmy(today)
    for L, meta in deduped:
        entry, ctx = meta["entry"], meta["ctx"] or {}
        notes = list(L["notes"])
        entry["site"], entry["title"] = L["site"], L["title"]
        if not a.include_past and (L["past"] or (L["end"] or L["start"]).date() < today):
            entry["status"] = "skipped: past"
        elif any(k in feed.festival_keys for k in L["keys"]):
            entry["status"] = "skipped: already tracked as a festival entry"
        elif prior_keys & set(L["keys"]):
            entry["status"] = f"skipped: already in {a.out} (left as it is)"
        elif L["online"] and not a.include_online:
            entry["status"] = "skipped: online-only (use --include-online to keep these)"
        elif L["site"] == "eventbrite" and L["organiser_id"] and ctx.get("url") and listing_id(ctx["url"]) not in (None, L["organiser_id"]):
            entry["status"] = f"skipped: organiser {L['organiser_id']} differs from the listing it was found on"
        if entry.get("status"):
            report["events"].append(entry)
            continue

        # --- venue
        loc, venue_id = L["location"], ""
        if L["online"]:
            notes.append("online-only event: no venue_id, online='online'")
        else:
            vm = feed.match_venue(loc)
            if vm["venue_id"]:
                venue_id = vm["venue_id"]
                entry["venue"] = f"{venue_id} [{vm['confidence']}: {vm['how']}]"
            else:
                nv = feed.new_venue(loc, set(new_venues))
                if a.geocode and not nv.get("latlon"):
                    g = geocode_venue(nv["name"], nv["full_address"], nv.get("postcode", ""), nv.get("city", ""))
                    if g:
                        nv["latlon"] = g[0]
                        notes.append(f"venue latlon from Nominatim query {g[1]!r} - check the pin")
                    else:
                        notes.append("venue could not be geocoded - use the builder's Geocode button")
                elif not nv.get("latlon"):
                    notes.append("new venue has no latlon - geocode it in the builder (or rerun with --geocode)")
                new_venues[nv["id"]] = nv
                feed.add_venue(nv)
                venue_id = nv["id"]
                entry["venue"] = f"{venue_id} [NEW venue" + (f"; {vm['how']}" if vm["how"] else "") + "]"
                if vm["similar"]:
                    entry["similar_venues"] = vm["similar"]
                    notes.append("similar existing venues: " + "; ".join(f"{x['id']} ({x['why']})" for x in vm["similar"]))

        # --- performer / promoter / club
        performer, performer_ids = ctx.get("performer_id", ""), []
        promoter, club = ctx.get("promoter_id", ""), ctx.get("club", "")
        if club:   # a promoter page can list one-offs elsewhere: keep the club only if it plausibly applies
            crec = next((c for c in feed_raw.get("clubs", []) if c.get("club") == club), {})
            here = venue_id and venue_id in {crec.get("venue_id"), *(v.get("venue_id") for v in (crec.get("alternate_locations") or {}).values())}
            named = (crec.get("name") or "").lower() in f"{L['title']} {L['description']}".lower()
            if not (here or named):
                club = ""
        if not meta["ctx"]:   # a pasted event URL
            performer, promoter = a.performer or performer, a.promoter or promoter
            if L["organiser_id"] and L["organiser_id"].startswith("eb-org:"):
                r = feed.resolve_listing(f"https://www.eventbrite.co.uk/o/{L['organiser_id'].split(':')[1]}")
                performer, promoter, club = performer or r["performer_id"], promoter or r["promoter_id"], club or r["club"]
            elif L["organiser_id"] and L["organiser_id"].startswith("tt:"):
                r = feed.resolve_listing(f"https://www.tickettailor.com/events/{L['organiser_id'].split(':', 1)[1]}")
                performer, promoter, club = performer or r["performer_id"], promoter or r["promoter_id"], club or r["club"]
        if not promoter and L["promoter_name"]:
            promoter = feed.promoter_by_name(L["promoter_name"])
            if promoter:
                notes.append(f"promoter_id '{promoter}' matched from the organiser name '{L['promoter_name']}'")
            elif L["site"] == "wegottickets" and L["promoter_name"] not in noted_promoters:
                noted_promoters.add(L["promoter_name"])
                notes.append(f"promoter '{L['promoter_name']}' is not in the feed's promoters (noted once per run)")
        free_performer = ""
        if not performer and L["lineup"]:
            found, missing = feed.match_lineup(L["lineup"])
            if len(found) == 1 and not missing:
                performer = found[0]
            elif found:
                performer_ids = found
            if missing:
                notes.append(f"lineup names not in the feed's performers: {', '.join(missing)}")
            if not found:
                free_performer = L["lineup"]
        if not performer and not performer_ids and not free_performer:
            performer, where = feed.infer_performer(L["title"], L["description"])
            if performer:
                notes.append(f"performer_id '{performer}' inferred from the event {where} - check")
        display = feed.performer_name(performer) if performer else " & ".join(feed.performer_name(x) for x in performer_ids)
        title = L["title"]
        name = f"{title} [{display}]" if display and display.lower() not in title.lower() else title

        # --- age (builder's parser; always a suggestion)
        age = parse_age_rating_from_text(L["age_text"]) if L["age_text"] else None
        age = age or parse_age_rating_from_text(title) or parse_age_rating_from_text(L["description"])
        if age and not L["age_text"]:
            notes.append(f"age_rating '{age['rating']}' suggested from: \"{age['sentence'][:80]}\"")

        # --- price / time text, kept consistent with any structured_* fields the way the builder does
        price_text, sp = L["price_text"], L["structured_price"]
        if sp and L["price_text"] and not L["price_text"].startswith("€"):
            price_text = render_structured_price(sp)
        else:
            sp = None
        url = apply_affiliate(L["url"], L["site"], feed, a)

        rec: dict = {"name": name, "showname": title, "date": fmt_dmy(L["start"].date()), "venue_id": venue_id}
        if performer:
            rec["performer_id"] = performer
        if performer_ids:
            rec["performer_ids"] = performer_ids
        if free_performer:
            rec["performer"] = free_performer
        id_basis = {"performer_id": performer, "performer_ids": performer_ids, "venue_id": venue_id}
        eid = build_structured_event_id(id_basis, L["start"].date())
        rec["eventId"], rec["date_added"] = eid, stamp
        if L["time_text"]:
            rec["time"] = L["time_text"]
        if L["structured_time"]:
            rec["structured_time"] = L["structured_time"]
        club = club or feed.infer_club(f"{title} {L['description']}")
        if club:
            rec["club"] = club
        if promoter:
            rec["promoter_id"] = promoter
        if price_text:
            rec["price"] = price_text
        if sp:
            rec["structured_price"] = sp
        desc = encode_paragraph_breaks(L["description"])
        if desc:
            rec["description"] = desc
        if age:
            rec["age_rating"] = age["rating"]
            if age["minAge"]:
                rec["min_age"] = age["minAge"]
        rec["ticket_url"] = url
        if L["hybrid"]:
            rec["online"] = "hybrid"
        elif L["online"]:
            rec["online"] = "online"
        if L["cancelled"]:
            rec["isCancelled"] = True
        if L["sold_out"]:
            rec["isSoldOut"] = True
        rec["isSpecial"] = True
        if L["site"] == "eventbrite" and L["description"]:
            notes.append("description is Eventbrite's JSON-LD summary and may be shorter than the full listing")

        # --- reconcile with the feed
        existing, how = None, ""
        for k in L["keys"]:
            if k in feed.by_key:
                existing, how = feed.by_key[k][0], f"ticket id {k} in an existing ticket_url"
                break
        if existing is None:
            slot = feed.by_slot.get((L["start"].date().isoformat(), venue_id), [])
            who = {performer, *performer_ids} - {""}
            same = [r for r in slot if not who or r.get("performer_id") in (None, "", *who) or set(r.get("performer_ids", [])) & who]
            other = [r for r in slot if r not in same]
            if same:
                cand = same[0]
                kinds = {k.split(":")[0] for k in L["keys"]}
                clash = [k for k in ticket_keys(cand.get("ticket_url", "")) if k.split(":")[0] in kinds and k not in L["keys"]]
                if clash:
                    notes.append(f"same date+venue as {cand.get('eventId') or cand.get('showname')} but a different ticket id ({clash[0]}): treated as a separate show")
                else:
                    existing, how = cand, "same date + venue" + (" + performer" if who else "")
                    other_keys = ticket_keys(cand.get("ticket_url", ""))
                    if other_keys and not set(other_keys) & set(L["keys"]):
                        notes.append(f"feed ticket_url uses a different URL form ({other_keys[0]}); same slot, so treated as the same event")
            if other and not existing:
                notes.append("same date+venue in the feed for a different performer: " + ", ".join(r.get("eventId") or r.get("showname", "?") for r in other))

        if existing is not None:
            old_id = existing.get("eventId") or build_structured_event_id(existing, parse_dmy(existing.get("date", "")) or L["start"].date())
            applied, conflicts = reconcile_existing(existing, rec, L)
            entry.update(status="matched existing", matched_by=how, eventId=old_id, applied=applied, conflicts=conflicts, notes=notes)
            if applied:
                if id(existing) in feed.pos:
                    b, i = feed.pos[id(existing)]
                    updated_events[f"{b}#{i}"] = json.loads(json.dumps(existing))
                    updated_fields[f"{b}#{i}"] = [x["field"] for x in applied]
                else:
                    notes.append("matched a tour/show date: changes listed here but not exported (use the builder's tour editor)")
        else:
            if eid in used_ids:
                eid2 = disambiguate_id(eid, title, L["keys"][0] if L["keys"] else title, used_ids)
                notes.append(f"eventId COLLISION: {eid} is already used; suffixed to {eid2} - rename if you prefer (e.g. -matinee)")
                rec["eventId"] = eid = eid2
            used_ids.add(eid)
            if not (performer or performer_ids):
                notes.append("no performer_id: eventId uses the builder's 'unknown-performer' fallback - add one with --performer ID")
            new_records.append(rec)
            entry.update(status="new record", eventId=eid, notes=notes)
        report["events"].append(entry)

    # ---- feed events that the supplied listings no longer show
    if not discovery_incomplete:
        listed = {k for L, _ in deduped for k in L["keys"]}
        kinds = {k.split(":")[0] for k in listed}
        wanted = {c["performer_id"] for c in listings.values() if c["performer_id"]}
        wanted_p = {c["promoter_id"] for c in listings.values() if c["promoter_id"]}
        for r in feed.slots:
            ks = [k for k in ticket_keys(r.get("ticket_url", "")) if k.split(":")[0] in kinds]
            d = parse_dmy(r.get("date", "")) if isinstance(r.get("date"), str) else None
            if ks and not set(ks) & listed and d and d >= today and (r.get("performer_id") in wanted or r.get("promoter_id") in wanted_p):
                report["missing_from_site"].append({"event": r.get("eventId") or r.get("showname"), "date": r["date"]})
    elif listings:
        report["warnings"].append("skipped the 'missing from site' check because a listing page yielded no links")

    # ---- the single output file, in the builder's own shape (added to the existing file unless --overwrite)
    out: dict = dict(prior)
    merged_venues = dict(prior.get("newVenues", {}))
    for vid, v in new_venues.items():
        merged_venues.setdefault(vid, v)
    merged_events = list(prior.get("specificEvents", [])) + new_records
    merged_updates = dict(prior.get("updatedEvents", {}))
    n_combined = 0
    for key, rec2 in updated_events.items():
        rec1 = merged_updates.get(key)
        if rec1 is None:
            merged_updates[key] = rec2
        elif same_record(rec1, rec2):
            merged = dict(rec1)
            for f in updated_fields.get(key, []):
                merged[f] = rec2.get(f)
            merged_updates[key] = merged
            n_combined += 1
        else:
            report["warnings"].append(
                f"{a.out} already has an update under {key} for a different record ({rec1.get('showname') or rec1.get('name')}, "
                f"{rec1.get('date')}) - the feed has changed since that run; replaced it with this run's "
                f"({rec2.get('showname') or rec2.get('name')}, {rec2.get('date')}). updatedEvents keys are positions in the feed, "
                "so use the same feed file for every run that feeds one output file.")
            merged_updates[key] = rec2
    if merged_venues:
        out["newVenues"] = merged_venues
    if merged_events:
        out["specificEvents"] = merged_events
    if merged_updates:
        out["updatedEvents"] = merged_updates
    tmp = Path(str(a.out) + ".tmp")
    tmp.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(a.out)
    if a.report:
        Path(a.report).write_text(json.dumps(report, indent=2, ensure_ascii=False, default=str), encoding="utf-8")

    # ---- console review
    n_match = sum(1 for e in report["events"] if e.get("status") == "matched existing")
    print(f"{len(pool)} event page(s): {len(new_records)} new record(s), {n_match} matched existing "
          f"({len(updated_events)} with updates), {len(new_venues)} new venue(s)  ->  {a.out}")
    if prior:
        print(f"  added to the existing {a.out} (now {len(merged_events)} new event(s), {len(merged_venues)} new venue(s), "
              f"{len(merged_updates)} update(s)); use --overwrite to start afresh")
    for e in report["events"]:
        print(f"\n[{e.get('status')}] {e.get('title', '')}  ({e.get('site', '?')}, {e['key']})")
        if e.get("eventId"):
            print(f"   eventId: {e['eventId']}" + (f"   (matched by {e['matched_by']})" if e.get("matched_by") else ""))
        if e.get("venue"):
            print(f"   venue:   {e['venue']}")
        for ap_ in e.get("applied", []):
            print(f"   APPLIED  {ap_['field']}: {ap_['old']!r} -> {ap_['new']!r}")
        for c in e.get("conflicts", []):
            print(f"   CONFLICT {c['field']}: feed={c.get('feed')!r} site={c.get('site')!r}" + (f"  ({c['note']})" if c.get("note") else ""))
        for n in e.get("notes", []):
            print(f"   note: {n}")
    if report["missing_from_site"]:
        print("\nIn the feed (future) but not on the supplied listing(s):")
        for m in report["missing_from_site"]:
            print(f"   {m['date']}  {m['event']}")
    for w in report["warnings"]:
        print("WARNING:", w, file=sys.stderr)


if __name__ == "__main__":
    main()
