# Daily Maintenance

Check badness
./updatecache --list-retry

A few daily checks
 ./updatecache --daily


Refresh stale and update lastmod and index


 ./updatecache --refresh-stale 30 --oldest --skip-bad --skip-capped --no-old-events --lastmod --indexnow


Purge from bad link list

./updatecache --purge-only 'https://newtroubadours.org/venues.html?venue=bad-key'

