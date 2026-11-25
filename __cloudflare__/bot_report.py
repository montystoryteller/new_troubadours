#!/usr/bin/env python3
"""Fetch the gatekeeper's bot report and write it as a standalone HTML page.

Usage:
  export NT_DEBUG_SECRET=your-secret
  python3 bot_report.py                      # last 30 days -> bot_report.html
  python3 bot_report.py --days 7 --open      # last 7 days, open in browser
  python3 bot_report.py --from-file r.json   # render a saved JSON report instead

A fetched report also compares search-engine hits with <lastmod> in sitemap.xml,
querying D1 through wrangler on this machine (installed and logged in). The
bot-stats database is found automatically; --d1 or $NT_D1_NAME overrides that.
Standard library only (Python 3.8+).
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
import webbrowser
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from html import escape
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

DEFAULT_SITE = "https://newtroubadours.org"


def fetch(site, days, secret):
    req = urllib.request.Request(
        f"{site.rstrip('/')}/?days={days}",
        headers={
            "x-bot-report": secret,
            # Cloudflare often blocks Python's default User-Agent.
            "User-Agent": "bot-report-cli/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        sys.exit(f"Report request failed: HTTP {e.code} {e.reason}\n{e.read()[:300].decode(errors='replace')}")
    except (urllib.error.URLError, json.JSONDecodeError) as e:
        sys.exit(f"Report request failed: {e}")


def page_url(page):
    """Full address for a report page key: "/venues?venue=x" -> ".../venues.html?venue=x".

    The gatekeeper strips ".html" from page keys, so put it back (except on "/").
    """
    path, sep, query = page.partition("?")
    if path != "/" and not path.endswith(".html"):
        path += ".html"
    return f"{DEFAULT_SITE}{path}{sep}{query}"


def table(headers, rows):
    head = "".join(f"<th>{escape(h)}</th>" for h in headers)
    body = "".join(
        "<tr>" + "".join(f"<td>{c}</td>" for c in row) + "</tr>" for row in rows
    )
    if not rows:
        body = f'<tr><td colspan="{len(headers)}" class="muted">None</td></tr>'
    return f'<div class="scroll"><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>'


def bar(pct):
    pct = pct or 0
    return (
        f'<div class="bar"><div style="width:{min(pct, 100)}%"></div></div>'
        f'<span class="pct">{pct}%</span>'
    )


def heat(hit, total, pct):
    """A shaded percentage cell; the hover text shows the raw counts."""
    pct = pct or 0
    return (
        f'<span class="heat" style="--p:{min(pct, 100)}%" '
        f'title="{hit:,} of {total:,} pages">{pct:g}%</span>'
    )


def coverage_by_type(d):
    """Matrix: one row per page type, one column for any bot plus one per bot."""
    by_type = d.get("byType")
    if not by_type:
        return '<p class="muted">No per-type data (report came from an older gatekeeper).</p>'
    bots = [b["bot"] for b in d.get("perBot", [])]
    # Include any bot that appears per-type but not in perBot, just in case.
    for t in by_type:
        for b in t.get("perBot", {}):
            if b not in bots:
                bots.append(b)
    rows = []
    for t in by_type:
        total = t["total"]
        cells = [
            f'<code>{escape(t["type"])}</code>',
            f"{total:,}",
            heat(t["hit"], total, t.get("coveragePercent")),
        ]
        for b in bots:
            hit = t.get("perBot", {}).get(b, {}).get("hit", 0)
            pct = round(hit / total * 100, 1) if total else 0
            cells.append(heat(hit, total, pct))
        rows.append(cells)
    return table(["Page type", "Pages", "Any bot"] + [escape(b) for b in bots], rows)


# Search engines, including AI search indexes. Social previewers and "a person
# asked an assistant" fetchers are left out.
SEARCH_ENGINE_BOTS = [
    "googlebot", "bingbot", "duckduckbot", "applebot", "yandexbot", "baiduspider", "slurp",
    "oai-searchbot", "perplexitybot", "claude-searchbot",
]


LIST_BOT = "googlebot"  # the one engine whose waiting pages are listed
LIST_LIMIT = 200


def match_key(url):
    """Compare sitemap addresses with D1 page keys, whatever their encoding or ".html"."""
    parts = urlsplit(url)
    path = parts.path[:-5] if parts.path.endswith(".html") else parts.path
    return path, tuple(sorted(parse_qsl(parts.query)))


def sitemap_lastmods(site):
    """[(address, lastmod)] for sitemap pages that have a <lastmod>, newest first."""
    req = urllib.request.Request(
        f"{site.rstrip('/')}/sitemap.xml", headers={"User-Agent": "bot-report-cli/1.0"}
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        root = ET.fromstring(resp.read())
    ns = "{http://www.sitemaps.org/schemas/sitemap/0.9}"
    dated = [
        (u.findtext(f"{ns}loc"), u.findtext(f"{ns}lastmod"))
        for u in root.iter(f"{ns}url")
    ]
    dated = sorted((loc, lm[:10]) for loc, lm in dated if loc and lm)
    return sorted(dated, key=lambda x: x[1], reverse=True)


def wrangler_json(*args):
    npx = shutil.which("npx")
    if not npx:
        raise RuntimeError("npx not found")
    run = subprocess.run(
        [npx, "wrangler", *args, "--json"],
        stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding="utf-8", timeout=120,
    )
    if run.returncode:
        raise RuntimeError((run.stderr.strip() or run.stdout.strip())[-600:])
    return json.loads(run.stdout)


def d1_last_hits(database=None):
    """Latest hit per search engine and page, from all recorded history.

    With no database named, try each one on the account until one has bot_hits.
    """
    bots = ", ".join(f"'{b}'" for b in SEARCH_ENGINE_BOTS)
    sql = (
        "SELECT bot, page, MAX(last_seen) AS last_seen FROM bot_hits "
        f"WHERE bot IN ({bots}) GROUP BY bot, page"
    )
    names = [database] if database else [db["name"] for db in wrangler_json("d1", "list")]
    error = RuntimeError("no D1 databases found")
    for name in names:
        try:
            return wrangler_json("d1", "execute", name, "--remote", "--command", sql)[0]["results"]
        except RuntimeError as e:
            error = e
    raise error


def freshness(dated, rows):
    """Per engine: which dated pages has it requested since their lastmod?

    lastmod has day precision, so a hit on the same UTC day is counted separately.
    """
    seen = {LIST_BOT: {}}  # engine -> {page key: UTC day of latest hit}
    for r in rows:
        day = datetime.fromtimestamp(r["last_seen"] / 1000, timezone.utc).strftime("%Y-%m-%d")
        hits = seen.setdefault(r["bot"], {})
        key = match_key(r["page"])
        hits[key] = max(day, hits.get(key, day))
    engines = []
    for bot, hits in seen.items():
        e = {"bot": bot, "after": 0, "sameDay": 0, "before": 0, "never": 0}
        waiting = []  # not requested on or after the lastmod day
        for url, lastmod in dated:
            last = hits.get(match_key(url))
            if not last:
                e["never"] += 1
            elif last > lastmod:
                e["after"] += 1
            elif last == lastmod:
                e["sameDay"] += 1
            else:
                e["before"] += 1
            if not last or last < lastmod:
                waiting.append({"url": url, "lastmod": lastmod, "lastHit": last})
        if bot == LIST_BOT:
            e["waiting"] = waiting[:LIST_LIMIT]
        e["afterPercent"] = round(e["after"] / len(dated) * 100, 1) if dated else None
        engines.append(e)
    engines.sort(key=lambda e: (-e["after"], e["bot"]))
    return {"datedPages": len(dated), "engines": engines}


def freshness_section(d):
    f = d.get("freshness")
    if not f:
        return '<p class="muted">Not included. See the message printed when the report was generated.</p>'
    engines = f.get("engines", [])
    summary = table(
        ["Engine", "Hit after lastmod", "Same day", "Only before", "Never", "Up to date"],
        [
            [
                escape(e["bot"]),
                f'{e["after"]:,}',
                f'{e["sameDay"]:,}',
                f'{e["before"]:,}',
                f'{e["never"]:,}',
                bar(e.get("afterPercent")),
            ]
            for e in engines
        ],
    )
    details = ""
    for e in engines:
        if e["bot"] == LIST_BOT:
            rows = [
                [
                    f'<code class="url">{escape(p["url"])}</code>',
                    escape(p["lastmod"]),
                    escape(p.get("lastHit") or "never"),
                ]
                for p in e.get("waiting", [])
            ]
            details = (
                f'<details><summary>{LIST_BOT}: {e["before"] + e["never"]:,} not hit since lastmod '
                f'(up to {LIST_LIMIT} shown, newest changes first)</summary>'
                f'{table(["Page", "Lastmod", "Last hit"], rows)}</details>'
            )
    return summary + details


def render(d):
    site_pages = d.get("sitemapPages", 0)
    hit = d.get("sitemapPagesHitByAnyBot", 0)
    never = d.get("neverHit", {})
    outside = d.get("notInSitemap", {})
    total_hits = sum(b.get("hits", 0) for b in d.get("perBot", []))

    per_bot = table(
        ["Bot", "Hits", "Pages hit", "Sitemap pages hit", "Coverage"],
        [
            [
                escape(b["bot"]),
                f'{b["hits"]:,}',
                f'{b["pagesHit"]:,}',
                f'{b["sitemapPagesHit"]:,}',
                bar(b.get("coveragePercent")),
            ]
            for b in d.get("perBot", [])
        ],
    )
    by_type = coverage_by_type(d)
    fresh = freshness_section(d)
    dated = (d.get("freshness") or {}).get("datedPages", 0)
    top = table(
        ["Page", "Hits", "Bots", "In sitemap"],
        [
            [
                f'<code>{escape(p["page"])}</code>',
                f'{p["hits"]:,}',
                escape(", ".join(sorted(set(p.get("bots", []))))),
                "yes" if p.get("inSitemap") else "no",
            ]
            for p in d.get("topPages", [])
        ],
    )
    out_tbl = table(
        ["Page", "Hits", "Bots"],
        [
            [
                f'<code>{escape(p["page"])}</code>',
                f'{p["hits"]:,}',
                escape(", ".join(sorted(set(p.get("bots", []))))),
            ]
            for p in outside.get("top", [])
        ],
    )
    never_tbl = table(
        ["Page"],
        [[f'<code class="url">{escape(page_url(p))}</code>'] for p in never.get("sample", [])],
    )
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bot report</title>
<style>
:root {{ --bg:#fff; --fg:#1b1b1f; --muted:#6b6b76; --line:#e2e2e8; --accent:#2f6fed; --card:#f6f6f9; }}
@media (prefers-color-scheme: dark) {{
  :root {{ --bg:#15161a; --fg:#e8e8ec; --muted:#9a9aa6; --line:#2b2c33; --accent:#6c9bff; --card:#1d1e24; }}
}}
body {{ font:15px/1.5 system-ui,sans-serif; background:var(--bg); color:var(--fg); max-width:1000px; margin:2rem auto; padding:0 1rem; }}
h1 {{ margin-bottom:.2rem }} h2 {{ margin-top:2.2rem; border-bottom:1px solid var(--line); padding-bottom:.3rem }}
.muted {{ color:var(--muted) }}
.cards {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:.8rem; margin:1.2rem 0 }}
.card {{ background:var(--card); border:1px solid var(--line); border-radius:8px; padding:.8rem 1rem }}
.card b {{ display:block; font-size:1.6rem }}
.scroll {{ overflow-x:auto }}
table {{ border-collapse:collapse; width:100%; font-size:14px }}
th,td {{ text-align:left; padding:.4rem .6rem; border-bottom:1px solid var(--line); vertical-align:middle }}
th {{ color:var(--muted); font-weight:600 }}
code {{ font-size:13px; word-break:break-all }}
.url {{ user-select:all }}
summary {{ cursor:pointer; margin:.8rem 0 .3rem }}
.bar {{ display:inline-block; width:110px; height:8px; background:var(--line); border-radius:4px; vertical-align:middle; overflow:hidden }}
.bar div {{ height:100%; background:var(--accent) }}
.pct {{ margin-left:.5rem }}
.heat {{ display:block; padding:.1rem .5rem; border-radius:4px; text-align:right; white-space:nowrap;
  background:color-mix(in srgb, var(--accent) var(--p), transparent) }}
</style></head><body>
<h1>Bot report</h1>
<p class="muted">Since {escape(str(d.get("since", "?")))} ({d.get("days", "?")} days) · generated {generated}</p>

<div class="cards">
  <div class="card"><b>{total_hits:,}</b>bot page requests</div>
  <div class="card"><b>{d.get("coveragePercent", 0)}%</b>of sitemap pages hit by any bot</div>
  <div class="card"><b>{hit:,} / {site_pages:,}</b>sitemap pages hit</div>
  <div class="card"><b>{never.get("count", 0):,}</b>sitemap pages never hit</div>
</div>

<h2>By bot</h2>{per_bot}
<h2>Coverage by page type</h2>
<p class="muted">Share of each type's sitemap pages that a bot requested in this period. Hover a cell for the page counts.</p>{by_type}
<h2>Crawled since last change</h2>
<p class="muted">{dated:,} sitemap pages have a lastmod. Uses all recorded hits, not only the period above. "Same day" hits may be before or after the change.</p>{fresh}
<h2>Most-requested pages</h2>{top}
<h2>Hit by bots but not in the sitemap ({outside.get("count", 0):,})</h2>
<p class="muted">Outdated event ids and bad or probed keys. Top 50 shown.</p>{out_tbl}
<h2>Sitemap pages no bot has requested ({never.get("count", 0):,})</h2>
<p class="muted">Sample of up to 200. Click an address to select it all, then copy.</p>{never_tbl}
</body></html>
"""


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--site", default=DEFAULT_SITE)
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument(
        "--secret",
        default=os.environ.get("NT_DEBUG_SECRET"),
        help="defaults to $NT_DEBUG_SECRET",
    )
    ap.add_argument(
        "--d1",
        default=os.environ.get("NT_D1_NAME"),
        help="bot-stats D1 database name (default: $NT_D1_NAME, else found automatically)",
    )
    ap.add_argument("--out", default="bot_report.html")
    ap.add_argument("--from-file", help="render a saved JSON report instead of fetching")
    ap.add_argument("--save-json", help="also save the raw JSON here")
    ap.add_argument("--open", action="store_true", help="open the result in a browser")
    a = ap.parse_args()

    if a.from_file:
        data = json.loads(Path(a.from_file).read_text())
    else:
        if not a.secret:
            sys.exit("Set NT_DEBUG_SECRET in the environment or pass --secret.")
        data = fetch(a.site, a.days, a.secret)
        # Optional extra: a failure here must not lose the rest of the report.
        try:
            data["freshness"] = freshness(sitemap_lastmods(a.site), d1_last_hits(a.d1))
        except Exception as e:
            print(f"Skipped 'crawled since last change': {e}", file=sys.stderr)
    if a.save_json:
        Path(a.save_json).write_text(json.dumps(data, indent=2))

    out = Path(a.out)
    out.write_text(render(data), encoding="utf-8")
    print(f"Wrote {out.resolve()}")
    if a.open:
        webbrowser.open(out.resolve().as_uri())


if __name__ == "__main__":
    main()
