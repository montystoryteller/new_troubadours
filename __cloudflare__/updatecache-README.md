# updatecache

A command-line helper for managing the prerender cache behind **newtroubadours.org**.
It talks to the gatekeeper Worker (using its debug secret) to re-render pages, mark
them stale, delete them, fill gaps in the cache, and keep the valid-key index up to
date.

## How the pieces fit together

| Piece | Role |
|---|---|
| **gatekeeper** Worker | Sits on `newtroubadours.org/*`. Sends known crawlers a prerendered snapshot from KV; everyone else goes straight to the origin. |
| **renderer** Worker | Renders a page with Cloudflare Browser Run and returns the HTML. Only the gatekeeper calls it. |
| **KV** (`newtroubadours-render-cache`) | Stores snapshots (`render:<url>`), the valid-key index (`meta:keys`), the render cooldown (`lock:render`) and purge timestamps (`meta:epochs`). |
| **prewarm** GitHub Action | Runs daily: syncs the key index, then re-renders stale pages within the daily budget. |
| **updatecache** | Manual control from your terminal. |

Free-plan Browser Run limits shape everything here: about **one render per 10 seconds**
and **10 browser-minutes per day**, both account-wide. Hitting the first gives a
`429 Rate limit exceeded` (code 2001); hitting the second gives a `time limit exceeded`
message.

## Setup

1. **Set the secret.** It must equal the Worker's `DEBUG_SECRET`.

   ```bash
   export NT_DEBUG_SECRET='your-DEBUG_SECRET-value'
   ```

2. **Install dependencies** (only needed for some commands):

   | Needed by | Tools |
   |---|---|
   | `--sync-keys`, `--performer`, `--venue`, `--storyclub` | `jq` |
   | `--performer`, `--venue`, `--storyclub` | `shuf`, `comm` (standard on Linux; on macOS install coreutils or use `sort -R`), `npx wrangler` |

3. **For the fill commands only:** log in to Cloudflare and set the namespace ID.

   ```bash
   npx wrangler login
   npx wrangler kv namespace list      # find newtroubadours-render-cache and copy its 32-char "id"
   ```

   Then either edit `PASTE_NAMESPACE_ID_HERE` in the script, or
   `export NT_KV_NAMESPACE_ID=<id>`. (The *title* `newtroubadours-render-cache` is not
   the ID; wrangler needs the hex ID.)

## Commands

```
./updatecache <page-or-url> [...]        refresh now (default)
./updatecache --stale <pages>            mark stale, no browser time
./updatecache --purge-only <pages>       delete snapshot(s)
./updatecache --purge <pages>            delete, then refresh now
./updatecache --soft-purge-all           mark every snapshot stale
./updatecache --hard-purge-all           treat every snapshot as missing
./updatecache --performer                render one uncached performer page, with optional no. of updates
./updatecache --venue                    render one uncached venue page, with optional no. of updates
./updatecache --storyclub                render one uncached story club page, with optional no. of updates
./updatecache --sync-keys                rebuild the valid-key index
./updatecache --list-performers          list performers without a KV index entry
./updatecache --list-venues              list venues without a KV index entry
./updatecache --list-storyclubs          list storyclubs without a KV index entry
./updatecache --list-festivals
./updatecache --list-promoters
./updatecache --list-booksmerch
./updatecache --performer tis-tales
./updatecache --promoter some-promoter another-promoter
./updatecache --booksmerch N
./updatecache --performer 'Jane Doe'
```

`NT_DELAY=10 ./updatecache --performer 20`

### Specifying pages

A page can be a path, a path with query, or a full URL:

```bash
./updatecache index.html
./updatecache 'performers.html?performer=gaz-brookfield'
./updatecache https://newtroubadours.org/venues?venue=scottish-storytelling-centre
```

Quote anything containing `?` or `&`. Several pages can be given at once; renders are
spaced 12 seconds apart to stay under the rate limit.

> **Match the URL form bots use.** Snapshots are keyed by the exact path, so
> `performers.html?performer=x` and `performers?performer=x` are different entries.
> Refresh the form your sitemap and internal links use.

### Refreshing

**`<page> [...]`** force-renders each page and overwrites its snapshot. If the render
fails (rate limit or daily quota), the old snapshot is kept and marked stale, so the
next prewarm run or crawler request retries it. The output line shows the response
headers: `x-prerendered: true` means success; `x-marked-stale: true` means it failed
and was queued for retry; `x-quota-exhausted: true` means the daily browser time is
gone (try again after 00:00 UTC).

**`--stale <pages>`** keeps serving the old snapshot but flags it for refresh. Uses no
browser time, so it's the right choice after bulk edits or when the daily quota is
used up. The refresh happens at the next prewarm run, or when a render-tier crawler
next requests the page (crawler refreshes are limited to about one per minute).

**`--soft-purge-all`** does the same for every snapshot at once. Nothing is deleted.

### Deleting

**`--purge-only <pages>`** deletes the snapshot. Use it for a bad render or a page
that no longer exists. Crawlers get the plain origin page until it is re-rendered.

**`--purge <pages>`** deletes, then immediately re-renders. Risky if the quota is gone:
you can end up with no snapshot and no way to make one.

**`--hard-purge-all`** makes every existing snapshot count as missing (after a `YES`
confirmation). Nothing is deleted from KV, but nothing is served either. On the free
plan, re-rendering everything can take weeks, so prefer `--soft-purge-all`.

### Filling gaps

**`--performer`**, **`--venue`**, **`--storyclub`** each render **one random page of
that type that has no snapshot yet**. The script reads the keys from
`events_normalized.json`, lists the matching snapshots in KV (list calls don't count
as reads), and renders one missing page. It makes a single render attempt per run, so
it can't hammer Browser Run. If every page of that type is cached, it says so and
exits.

| Command | Page filled | Keys come from |
|---|---|---|
| `--performer` | `performers.html?performer=KEY` | `.performers` (object keys) |
| `--venue` | `venues.html?venue=KEY` | `.venues` (object keys) |
| `--storyclub` | `storyclub.html?club=KEY` | `.clubs[].club` |

These only fill pages that are **missing**. Stale snapshots are refreshed by the
prewarm and by crawlers, not by these commands.

### Keeping the key index current

**`--sync-keys`** builds a list of valid keys (performers, venues, clubs, promoters,
festivals, tours) from the JSON and uploads it to the gatekeeper. The gatekeeper uses
it to refuse bot-triggered renders for pages that don't exist, such as
`storyclub.html?club=nonexistent`, so no render is wasted on them. The prewarm Action
runs this daily; run it by hand after changing the data if you want it to take effect
sooner. It takes up to about 5 minutes for the Workers to pick up a new index.

If the index is missing or can't be read, the gatekeeper allows rendering, so a
failed sync never breaks anything. The gatekeeper rejects an index containing empty
lists.

## Environment variables

| Variable | Used by | Purpose |
|---|---|---|
| `NT_DEBUG_SECRET` | all | **Required.** The Worker's `DEBUG_SECRET`. |
| `NT_KV_NAMESPACE_ID` | fill commands | 32-char KV namespace ID (or edit the script). |
| `NT_EVENTS_JSON` | `--sync-keys`, fill commands | Full URL of the JSON. By default the script tries `events_normalized.json`, then `events_normalised.json`, on the site. |
| `NT_KEYS_JQ_PERFORMER` | `--performer` | jq filter that prints one performer key per line. |
| `NT_KEYS_JQ_VENUE` | `--venue` | Same, for venues. |
| `NT_KEYS_JQ_STORYCLUB` | `--storyclub` | Same, for clubs. |

Override the jq filters only if the JSON structure changes.

## Common workflows

```bash
# Edited one performer's bio: refresh just that page
./updatecache 'performers.html?performer=nell-phoenix'

# Changed the site header on every page: queue everything, no browser time
./updatecache --soft-purge-all

# Daily quota is gone but a page needs refreshing: queue it for tomorrow
./updatecache --stale 'venues.html?venue=strode-theatre'

# Gradually build up coverage: run a few times (the script paces itself per run,
# so leave 12+ seconds between runs)
./updatecache --performer
./updatecache --venue
./updatecache --storyclub

# Added a performer to the JSON
./updatecache --sync-keys
```

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `Set NT_DEBUG_SECRET first...` | Export `NT_DEBUG_SECRET`. |
| `Edit updatecache and set NT_KV_NAMESPACE_ID` | Paste the 32-char ID into the script, or export it. |
| `No ... keys found; set NT_KEYS_JQ_... ` | The JSON couldn't be fetched, or its structure changed. Check `NT_EVENTS_JSON` and the jq filter. |
| Fill command errors or lists nothing | Run `npx wrangler login`. On newer wrangler versions the list command may need `--remote`. |
| `[HTTP 429]` / `x-marked-stale: true` | Rate limited. Wait at least 12 seconds between renders and retry. The old snapshot is kept. |
| `x-quota-exhausted: true` | Daily browser time is used up. Use `--stale` and wait until after 00:00 UTC. |
| A key keeps showing as missing after rendering | The key has characters that the Worker encodes differently from `jq @uri` (for example a space becomes `+`). Plain slug keys are unaffected. |
| A new page isn't rendered for crawlers | Its key isn't in the index yet. Run `--sync-keys`. |
| `--sync-keys` prints a 400 error | The index had an empty list or a non-string entry. Check that the JSON still has performers, venues, etc. |

## Gatekeeper headers (for reference)

`updatecache` works by sending these headers, with the secret as the value, to
`https://newtroubadours.org/`:

| Header | Effect |
|---|---|
| `x-force-render` | Render live and overwrite the snapshot. Combine with `x-only-if-older-than: <seconds>` to skip pages whose snapshot is younger (no browser used). The prewarm uses this. |
| `x-mark-stale` | Mark one page stale. |
| `x-soft-purge` | Mark every snapshot stale. |
| `x-purge-cache` | Delete one page's snapshot. |
| `x-hard-purge-all` | Treat every snapshot as missing. |
| `x-sync-keys` | `POST` the valid-key index JSON as the request body. |
