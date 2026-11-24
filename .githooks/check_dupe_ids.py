#!/usr/bin/env python3
"""Warn (never block) about duplicate ids in the events JSON, read from stdin.
Reports: repeated object keys (json.load silently keeps only the last one),
repeated id values inside one section (id; promoter_id/podcast_id/publisher_id in their own sections), and repeated eventId
values anywhere in the file."""
import json, sys, collections

name = sys.argv[1] if len(sys.argv) > 1 else "events"
# an id field only counts as "own" in its own section (elsewhere it is a reference)
OWN_IDS = {"id": None, "promoter_id": "promoters", "podcast_id": "podcasts", "publisher_id": "publishers"}
keydups = []

def hook(pairs):
    c = collections.Counter(k for k, _ in pairs)
    keydups.extend(k for k, n in c.items() if n > 1)
    return dict(pairs)

try:
    data = json.loads(sys.stdin.read(), object_pairs_hook=hook)
except json.JSONDecodeError:
    sys.exit(0)  # invalid JSON is reported by the blocking check

warn = []
for k in sorted(set(keydups)):
    warn.append(f'object key "{k}" appears more than once in the same object')

for section, v in (data.items() if isinstance(data, dict) else []):
    recs = list(v.values()) if isinstance(v, dict) else v if isinstance(v, list) else []
    for field, only in OWN_IDS.items():
        if only and only != section: continue
        c = collections.Counter(r[field] for r in recs if isinstance(r, dict) and isinstance(r.get(field), (str, int)))
        for i, n in c.items():
            if n > 1:
                warn.append(f'{section}: {field} "{i}" used {n} times')

ev = collections.Counter()
def walk(o):
    if isinstance(o, dict):
        if isinstance(o.get("eventId"), (str, int)):
            ev[o["eventId"]] += 1
        for x in o.values(): walk(x)
    elif isinstance(o, list):
        for x in o: walk(x)
walk(data)
for i, n in ev.items():
    if n > 1:
        warn.append(f'eventId "{i}" used {n} times')

if warn:
    print(f"pre-commit WARNING: duplicate ids in {name} (commit not blocked):", file=sys.stderr)
    for w in warn[:30]:
        print("  - " + w, file=sys.stderr)
    if len(warn) > 30:
        print(f"  ... and {len(warn) - 30} more", file=sys.stderr)
