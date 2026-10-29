#!/usr/bin/env python3
"""Fetch the gatekeeper's bot report and write it as a standalone HTML page.

Usage:
  export NT_DEBUG_SECRET=your-secret
  python3 bot_report.py                      # last 30 days -> bot_report.html
  python3 bot_report.py --days 7 --open      # last 7 days, open in browser
  python3 bot_report.py --from-file r.json   # render a saved JSON report instead

Standard library only (Python 3.8+).
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
import webbrowser
from datetime import datetime, timezone
from html import escape
from pathlib import Path

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
        ["Page"], [[f"<code>{escape(p)}</code>"] for p in never.get("sample", [])]
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
<h2>Most-requested pages</h2>{top}
<h2>Hit by bots but not in the sitemap ({outside.get("count", 0):,})</h2>
<p class="muted">Outdated event ids and bad or probed keys. Top 50 shown.</p>{out_tbl}
<h2>Sitemap pages no bot has requested ({never.get("count", 0):,})</h2>
<p class="muted">Sample of up to 200.</p>{never_tbl}
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
    if a.save_json:
        Path(a.save_json).write_text(json.dumps(data, indent=2))

    out = Path(a.out)
    out.write_text(render(data), encoding="utf-8")
    print(f"Wrote {out.resolve()}")
    if a.open:
        webbrowser.open(out.resolve().as_uri())


if __name__ == "__main__":
    main()
