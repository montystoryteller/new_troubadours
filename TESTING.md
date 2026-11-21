# Testing the tour planner

## 1. Run only the new automated tests

Needs Node and Playwright (`npm i -D playwright && npx playwright install chromium`). No internet needed: the tests serve the repo themselves and stub the map library.

```
tests/run_new.sh               # all new tests
tests/run_new.sh quickstart    # one test (file name in tests/new/, without .js)
```

| Test | What it checks |
|---|---|
| `quickstart` | Before the first build only dates + a "More options" button show; the button, a build, or loading a plan brings the rest in |
| `collect` | The shared collector (`js/event_collect.js`) returns exactly what the gig planner's own collector does, over four date ranges |
| `stages` | The stage hint stays one quiet link until used; stage 2 starts on the next free Friday, avoids stage 1's venues, refuses overlapping dates; plan file round trip, reopen and remove |
| `manager` | Tour Manager: plan handover from the planner, route map (numbered gigs, dashed estimate vs solid routed road line), Cards view, gig details from the events data, pickups, hotel suggestions (drive up to N min towards the next gig, wrong-way hotels never offered, clear message when nothing fits), routed times (OpenRouteService stubbed), save/reload with logistics, staged plans |
| `tour_format` | The manager opens a tour from the listings, a file in the events-data tour format (single or several tours) or `?tour=<id>`; start point; exports the plan as events-format tours (valid against events-schema.json) and re-opens its own export |
| `rail` | Constraint rail: chips add one panel each before a build, jump and show counts after, pool-only chips hidden elsewhere |
| `must_once` | A required venue already in the tour isn't listed again on other days |
| `improvements` | Save plan doesn't change the stages on screen; phone action bar; handover copy cleared; overnights only for next-day gigs unless ticked; mph setting; gig notes saved and exported; real drive times refetched around a newly chosen hotel |
| `gigs_and_plan` | Booked / queried / pencilled must-visits, a 3-night run, Save plan and Load plan round trip |

Some counts depend on today's date, so these tests assert behaviour, not fixed numbers.

## 2. Scenarios for a human tester

Say what you expected to happen before each step and note where the tool surprised you.

1. **Quick tour from a favourite act.** Choose "Venue pool", tick one performer, pick dates, press Develop tour. Success: you got a route without opening any other panel. Where did you hesitate?
2. **Two fixed dates.** After a build, open must-visit places. Add venue X as *booked* on one date and venue Y as *booked* on another. Develop tour. Success: both appear on those nights and the rest is filled around them.
3. **Pencilled.** Add a venue as *pencilled*. Success: it is placed, but clicking it frees it and the route can use another gig that night.
4. **Queried with two dates.** Mark a venue *queried* with a main date and one alternative. Success: only one of the two dates is used.
5. **Three-night run.** Book a venue for 3 nights. Success: consecutive nights at one venue, labelled "night 1 of 3" and so on.
6. **Save and come back.** Save plan, reload the page, Load plan. Success: statuses, dates and the route return.
7. **Clash finder.** Under Filters tick "Show known clashes". Success: nights with another event at the same venue (red) or in the same town (amber) are flagged, and unticking removes every badge.
8. **Three weekends from home.** Pick your acts, set a home start, choose a weekend, build and pick gigs, then "Plan it in stages" and "Save stage 1 & start the next". Repeat for two more. Success: no venue repeats across stages, the totals line adds up, and Save plan / Load plan brings all stages back.
9. **Hand it to the tour manager.** In the planner press "Open in tour manager". Add two pickups. Success: the run sheet starts with the pickups in order, each leg has miles and time, and Save plan with logistics reloads with the pickups.
10. **A listed tour.** Open `tour_manager.html`, choose a tour from "a tour from the listings", set a start town, then press "Download as tour (events format)". Success: the downloaded file has the same dates and venues, and opens again in the manager.
11. **Map and cards.** In the manager check the map shows your start, numbered gigs in order and a line between them; press a gig's "📍 map" to jump to it, and switch to Cards. Success: one card per gig; a gig that is a real event shows its title, bill, price and an Event details link; a venue night not yet in the events data says so. (The map needs internet for tiles; tests stub it.)
12. **Overnight.** After running `node tools/fetch_budget_hotels.js` once (needs internet), set "drive up to 60 min after a gig" and look at a long leg. Success: Premier Inns / Travelodges roughly towards the next gig appear, nearest the next gig first; choosing one adds a Sleep line and the following leg's time changes.
13. **Real drive times.** Paste an OpenRouteService key and press Get real drive times. Success: legs say (routed) and totals change; Back to estimates restores the old figures. (Not covered by tests against the real service.)
14. **Phone.** Repeat 1 and 2 on a phone. Note anything cut off or hard to tap. (Not covered by the automated tests.)

## 3. Not covered here

Real map tiles/markers (tests stub Leaflet), phone layouts, the live OpenRouteService and postcodes.io services (stubbed in tests), and the real hotel data (the tests use a tiny fixture; run the fetch script and compare its counts with the chains' published totals).
