#!/usr/bin/env python3
"""
Find the promoter/organiser behind each ticket URL in events_normalized.json
and propose entries for the top-level `promoters` registry (events-schema.json).

Usage:
  pip install requests beautifulsoup4
  python grab_promoters.py events_normalized.json --list              # offline: count URLs per site
  python grab_promoters.py events_normalized.json --limit 20          # try a small sample first
  python grab_promoters.py events_normalized.json                     # full run (cached, resumable)
  python grab_promoters.py events_normalized.json --apply             # also write events_with_promoters.json

Outputs (in ./promoter_out/):
  page_cache/            raw HTML per URL (so re-runs don't re-fetch)
  url_results.csv        one row per ticket URL: what was found
  promoter_candidates.csv  one row per distinct promoter: proposed registry entry
  events_with_promoters.json  (only with --apply) copy of your data with new
                              promoter entries + promoter_id on events that lacked one

Venues: every event's venue_id is linked to its promoter via the promoter's
`promoter_venues` list (only venue ids that exist in your top-level `venues` are
used; others are listed in the CSV for review).

Nothing existing is overwritten: events that already have promoter_id are skipped,
and existing registry entries are only ever added to (new venue ids appended to
promoter_venues), never changed or removed.
"""
import argparse, csv, hashlib, json, re, sys, time
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import urlparse, urljoin

OUT = Path("promoter_out")
CACHE = OUT / "page_cache"
UA = "Mozilla/5.0 (compatible; promoter-lookup/1.0; personal events directory)"

# ---------------------------------------------------------------- collect URLs
def collect(data):
    """Yield (record, url, kind) for every record that can carry promoter_id."""
    for key in ("specificEvents", "musicEvents", "poetryEvents"):
        for r in data.get(key, []):
            if r.get("ticket_url"):
                yield r, r["ticket_url"], key
    for _id, show in data.get("repertoire_shows", {}).items():
        for r in show.get("show_dates", []):
            if r.get("ticket_url"):
                yield r, r["ticket_url"], "show_date"
    for _id, tour in data.get("tours", {}).items():
        for r in tour.get("tour_dates", []):
            if r.get("ticket_url"):
                yield r, r["ticket_url"], "tour_date"

def has_promoter(r):
    return bool(r.get("promoter_id") or r.get("promoter"))

# ---------------------------------------------------------------- fetching
def fetch(url, delay):
    import requests
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / (hashlib.sha1(url.encode()).hexdigest() + ".html")
    if f.exists():
        return f.read_text("utf-8", "ignore"), "cached"
    try:
        resp = requests.get(url, headers={"User-Agent": UA}, timeout=20)
        time.sleep(delay)
        if resp.status_code != 200:
            return None, f"HTTP {resp.status_code}"
        f.write_text(resp.text, "utf-8")
        return resp.text, "ok"
    except Exception as e:  # noqa
        return None, f"error: {type(e).__name__}"

# ---------------------------------------------------------------- extraction
def jsonld(soup):
    out = []
    for s in soup.find_all("script", type="application/ld+json"):
        try:
            j = json.loads(s.string or "")
        except Exception:
            continue
        stack = [j]
        while stack:
            o = stack.pop()
            if isinstance(o, list):
                stack.extend(o)
            elif isinstance(o, dict):
                out.append(o)
                stack.extend(v for v in o.values() if isinstance(v, (dict, list)))
    return out

def clean(s):
    return re.sub(r"\s+", " ", s or "").strip()

def organiser_from_jsonld(soup):
    for o in jsonld(soup):
        org = o.get("organizer") or o.get("organiser")
        if isinstance(org, list) and org:
            org = org[0]
        if isinstance(org, dict) and org.get("name"):
            return {"name": clean(org["name"]), "promoter_link": org.get("url", ""),
                    "email": org.get("email", ""), "description": clean(org.get("description", ""))}
    return None

TEXT_PATTERNS = re.compile(
    r"(?:promoter|promoted by|presented by|organiser|organizer|organised by|organized by|hosted by)\s*[:\-]?\s*$",
    re.I)

def organiser_from_text(soup):
    """Heuristic: a label like 'Promoter:' / 'Presented by' followed by text or a link."""
    for el in soup.find_all(string=TEXT_PATTERNS):
        nxt = el.find_next(["a", "span", "strong", "b"])
        if nxt and clean(nxt.get_text()):
            a = nxt if nxt.name == "a" else nxt.find("a")
            return {"name": clean(nxt.get_text()), "promoter_link": (a.get("href") if a else "") or ""}
    for el in soup.find_all(string=re.compile(r"(promoter|promoted by|presented by)\s*:", re.I)):
        m = re.search(r"(?:promoter|promoted by|presented by)\s*:\s*(.+)", clean(el), re.I)
        if m:
            return {"name": m.group(1).strip(" .")[:120], "promoter_link": ""}
    return None

def social(soup, base):
    fb = em = ""
    for a in soup.find_all("a", href=True):
        h = a["href"]
        if not fb and re.search(r"facebook\.com/(?!sharer|share|tr\?|dialog)", h):
            fb = h
        if not em and h.startswith("mailto:"):
            em = h[7:].split("?")[0]
    return fb, em

def extract(url, html):
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, "html.parser")
    p = urlparse(url)
    host = p.netloc.lower().replace("www.", "")
    parts = [x for x in p.path.split("/") if x]
    res = organiser_from_jsonld(soup) or organiser_from_text(soup) or {}
    res.setdefault("name", "")
    res.setdefault("promoter_link", "")

    # Organiser/shop page on the ticketing platform = registry `ticketing_url`
    ticketing = ""
    if host == "tickettailor.com" and len(parts) >= 2 and parts[0] == "events":
        ticketing = f"https://www.tickettailor.com/events/{parts[1]}"
        if not res["name"]:
            og = soup.find("meta", property="og:site_name")
            res["name"] = clean(og["content"]) if og and og.get("content") else parts[1]
    elif host == "wegottickets.com":
        # /<Slug> is an organiser page; /event/<id> is an event page.
        if parts and parts[0].lower() != "event":
            ticketing = f"https://wegottickets.com/{parts[0]}"
        else:
            for a in soup.find_all("a", href=True):
                m = re.match(r"^(?:https?://(?:www\.)?wegottickets\.com)?/([A-Za-z0-9_\-]+)/?$", a["href"])
                if m and m.group(1).lower() not in {"event", "search", "login", "register", "help", "about"} \
                        and res["name"] and clean(a.get_text()).lower() == res["name"].lower():
                    ticketing = f"https://wegottickets.com/{m.group(1)}"
                    break
    elif host.startswith("eventbrite"):
        for a in soup.find_all("a", href=re.compile(r"eventbrite\.[a-z.]+/o/")):
            ticketing = a["href"].split("?")[0]
            break
    elif host.startswith("ticketsource"):
        for a in soup.find_all("a", href=re.compile(r"ticketsource\.[a-z.]+/(?!.*event)")):
            pass  # no reliable organiser-page pattern known; left blank for manual review

    fb, em = social(soup, url)
    res.update({"ticketing_url": ticketing, "facebook": fb if "facebook" in fb else "",
                "email": res.get("email") or em, "host": host})
    if res["promoter_link"]:
        res["promoter_link"] = urljoin(url, res["promoter_link"])
    return res

# ---------------------------------------------------------------- matching
def norm(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())

def norm_url(u):
    u = (u or "").lower().split("?")[0].rstrip("/")
    return re.sub(r"^https?://(www\.)?", "", u)

def slugify(s):
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", s.lower())).strip("-")

def build_index(promoters):
    idx = {}
    for pid, p in promoters.items():
        for k in (pid, p.get("name", "")):
            if k:
                idx[("name", norm(k))] = pid
        for k in ("ticketing_url", "promoter_link", "url"):
            if p.get(k):
                idx[("url", norm_url(p[k]))] = pid
    return idx

def match(res, idx):
    for key in (("url", norm_url(res.get("ticketing_url"))),
                ("url", norm_url(res.get("promoter_link"))),
                ("name", norm(res.get("name")))):
        if key[1] and key in idx:
            return idx[key]
    return None

# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("events_json")
    ap.add_argument("--list", action="store_true", help="just count URLs per site (no network)")
    ap.add_argument("--limit", type=int, default=0, help="only fetch the first N URLs")
    ap.add_argument("--delay", type=float, default=1.0, help="seconds between requests")
    ap.add_argument("--apply", action="store_true", help="write events_with_promoters.json")
    a = ap.parse_args()

    data = json.load(open(a.events_json, encoding="utf-8"))
    promoters = data.get("promoters", {})
    by_url = defaultdict(list)
    for rec, url, kind in collect(data):
        by_url[url].append((rec, kind))

    # URLs worth fetching: at least one record lacks a promoter_id
    todo = [u for u, recs in by_url.items() if any(not has_promoter(r) for r, _ in recs)]
    hosts = Counter(urlparse(u).netloc.replace("www.", "") for u in todo)
    print(f"{len(by_url)} unique ticket URLs, {len(todo)} on events with no promoter_id yet")
    for h, n in hosts.most_common(15):
        print(f"  {n:4d}  {h}")
    if a.list:
        return

    OUT.mkdir(exist_ok=True)
    if a.limit:
        todo = todo[:a.limit]
    idx = build_index(promoters)
    known_venues = set(data.get("venues", {}))
    results = {}
    for i, url in enumerate(todo, 1):
        html, status = fetch(url, a.delay)
        res = extract(url, html) if html else {}
        res["status"] = status
        res["matched_id"] = match(res, idx) if res.get("name") or res.get("ticketing_url") else None
        results[url] = res
        print(f"[{i}/{len(todo)}] {status:10s} {res.get('name','-')[:40]:40s} {url[:70]}")

    with open(OUT / "url_results.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["url", "status", "promoter_name", "matched_existing_id", "ticketing_url",
                    "promoter_link", "facebook", "email"])
        for u, r in results.items():
            w.writerow([u, r.get("status"), r.get("name"), r.get("matched_id"), r.get("ticketing_url"),
                        r.get("promoter_link"), r.get("facebook"), r.get("email")])

    # group URLs into distinct promoters
    groups = {}
    for u, r in results.items():
        if not r.get("name"):
            continue
        key = r["matched_id"] or ("new:" + norm(r["name"]))
        g = groups.setdefault(key, {"res": r, "urls": [], "venues": set(), "bad_venues": set()})
        g["urls"].append(u)
        for rec, _kind in by_url[u]:
            v = rec.get("venue_id")
            if v:
                (g["venues"] if v in known_venues else g["bad_venues"]).add(v)
        for k in ("ticketing_url", "promoter_link", "facebook", "email", "description"):
            if not g["res"].get(k) and r.get(k):
                g["res"][k] = r[k]

    used_ids = set(promoters)
    proposed = {}
    for key, g in groups.items():
        if key.startswith("new:"):
            pid, n = slugify(g["res"]["name"]), 2
            while pid in used_ids:
                pid, n = f"{slugify(g['res']['name'])}-{n}", n + 1
            used_ids.add(pid)
        else:
            pid = key
        g["pid"] = pid
        g["is_new"] = key.startswith("new:")
        entry = {"promoter_id": pid, "name": g["res"]["name"]}
        for k in ("promoter_link", "ticketing_url", "facebook", "email", "description"):
            if g["res"].get(k):
                entry[k] = g["res"][k]
        if g["venues"]:
            entry["promoter_venues"] = sorted(g["venues"])
        g["entry"] = entry

    with open(OUT / "promoter_candidates.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["promoter_id", "status", "name", "ticketing_url", "promoter_link", "facebook",
                    "email", "n_urls", "example_url", "venue_ids", "unknown_venue_ids"])
        for g in sorted(groups.values(), key=lambda g: -len(g["urls"])):
            e = g["entry"]
            w.writerow([g["pid"], "NEW" if g["is_new"] else "existing", e["name"], e.get("ticketing_url", ""),
                        e.get("promoter_link", ""), e.get("facebook", ""), e.get("email", ""),
                        len(g["urls"]), g["urls"][0],
                        ";".join(sorted(g["venues"])), ";".join(sorted(g["bad_venues"]))])
    print(f"\nWrote {OUT}/url_results.csv and promoter_candidates.csv "
          f"({sum(g['is_new'] for g in groups.values())} new, "
          f"{sum(not g['is_new'] for g in groups.values())} matched existing)")

    if a.apply:
        url_to_pid = {u: g["pid"] for g in groups.values() for u in g["urls"]}
        added_venues = 0
        for g in groups.values():
            if g["is_new"]:
                promoters[g["pid"]] = g["entry"]
            elif g["venues"]:
                # existing promoter: only ever ADD venue ids to promoter_venues
                have = promoters[g["pid"]].setdefault("promoter_venues", [])
                for v in sorted(g["venues"]):
                    if v not in have:
                        have.append(v)
                        added_venues += 1
        data["promoters"] = promoters
        n = 0
        for rec, url, _ in collect(data):
            if url in url_to_pid and not has_promoter(rec):
                rec["promoter_id"] = url_to_pid[url]
                n += 1
        json.dump(data, open(OUT / "events_with_promoters.json", "w", encoding="utf-8"),
                  ensure_ascii=False, indent=2)
        print(f"Added {added_venues} venue(s) to existing promoters' promoter_venues")
        print(f"Set promoter_id on {n} records -> {OUT}/events_with_promoters.json")

if __name__ == "__main__":
    main()
