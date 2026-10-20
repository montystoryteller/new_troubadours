# BUILD

On local machine, githooks configured via:

`git config core.hooksPath .githooks`

## Bypassing the Worker for CSS

Site stylesheets are stored under `/css/` and referenced from that path. To keep
stylesheet requests from counting as Worker invocations, add a more-specific
route in Cloudflare for `newtroubadours.org/css/*` with no Worker attached. It
will bypass the broader `newtroubadours.org/*` gatekeeper route and go to the
configured origin. Keep the gatekeeper route for HTML pages and `/sitemap.xml`.


## gatekeeper logging

outcome	What the bot got	Why
hit-fresh	stored snapshot	young enough
hit-stale-refreshing	old snapshot	stale, and this bot is allowed to start a refresh
hit-stale	old snapshot	stale, but this bot (e.g. Googlebot) never triggers a refresh
miss-rendered	fresh render	no snapshot, and the render worked
miss-origin-render-failed	plain origin page	no snapshot, and the render failed
miss-origin-no-render	plain origin page	no snapshot, and this bot never triggers renders

## clouflare http console

#	Headers to add	What you should see
1	x-force-render: <your DEBUG_SECRET> and x-only-if-older-than: 158400	If a fresh snapshot exists, the body says fresh, skipped, with x-prerender-skipped: true. No browser time used. If there's no snapshot, it renders: 200 with x-prerendered: true, or 429/502 on failure.
2	User-Agent: Mozilla/5.0 (compatible; bingbot/2.0)	The stored snapshot, with x-prerendered: true and x-prerender-stale: false. If none exists, one render attempt, or the plain origin page if that fails.
3	User-Agent: Googlebot/2.1	The snapshot if one exists. If none, the origin page. It never triggers a render.
4	x-mark-stale: <secret>, then repeat #2	Body Marked stale: .... Then #2 returns x-prerender-stale: true and starts a background refresh.
5	x-purge-cache: <secret>	Body Purged cache for .... This deletes that one page's snapshot.

## update

./updatecache page (default)	Renders now. Success replaces the snapshot, and failure keeps the old one.	Yes

./updatecache --stale page	Keeps the old snapshot and marks it stale. The next prewarm run or render-tier bot request refreshes it.	None

./updatecache --soft-purge-all	Marks every snapshot stale and deletes none.	None

./updatecache --purge-only page	Deletes that one snapshot.	None

./updatecache --hard-purge-all	Every existing snapshot counts as missing. It asks you to type YES first.	None


## indexer


`./__cloudflare__/indexnow.sh -n *.html`

## updatecache docs

On updating events json:

./updatecache --list-new          # dry run: print the new-page URLs, change nothing
./updatecache --delta             # sync keys, render new pages, keep leftovers pending
./updatecache --delta 40          # same, but render at most 40 this run
./updatecache --delta --indexnow  # also send the pages that rendered to indexnow.sh

./updatecache --refresh-stale [N] [type] (eg type performer)