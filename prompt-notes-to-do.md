

TO give more to search on, pull the podcast feeds if possible (and maybe give a warning in console about podcasts where a feed can't be found?)

Other performer page updates to explore:
- for the listings, maybe even highlight the background of things in current and next seven days, or use a sliding palette to make close in time and still to happen hotter?
- I wonder if the performer page should also have an option to reveal a map of all (previous + upcoming) as well as current/upcoming shows??? What do you think? There is lots of code can be reused, eg from the venues page?  As scoping for that, there is a map/listing view for tours (and on the event page (though that is more elaborate).). Could that tour widget provide the basis of a reusable component eg used on tour and performer page? (I am just wanting you to scope this at first rather than change the performer page)

Media page
- in the schema, should taking tradition on and word storytelling cafe have an "industry_standard" attribute to power such features in a scaleable way (eg if there are more podcasts (audio or video) with representation from lots of tellers that get added in future?)

The search tool in the podcast appearance / yt page is an important part of that I think, particularly if/when I add an episode / video "description" field (maybe worth factoring that into the schema, handler and search tool now?) (There may be reusable search patterns elsewhere?) Ideally search filtering by proper name fields, etc, but also free text etc into the title and description; I wonder if I should also have metadata tags eg "story", or "interview"; atm, I think there is a "story_name" field which is not really correct eg if it is an interview; (maybe consider changing that attribute name in the schema  and parser/handler etc?) These tags could lso be display badges for listed items / filtering?

In the podcast autodetection, if I post an apple podcast link eg. https://podcasts.apple.com/us/podcast/the-three-ravens-podcast/id1675830991 isn't there a crib in the html element id="serialized-server-data" to a feed that includes the "feedUrl"?


On the performer page, should there be a badge to show if the performer has at least one audio podcast feed associated with them and viewable on their page (this is different to podcast episode appearances ).

I have recently extracted css and js from html pages into their own files in an attempt to make things easier to maintain, although at the expense of increasing the number of files to review.
- is there any opportunity to rationalise/normalise/standardise any of the css, eg into shared file or one or more new files; eg things like standardised colour/palette names, card handling, etc? BE VERY WARY OF SUGGESTING ANY CHANGE THAT MAY BREAK HOW JS IS OPERATING. Would it make sense to split css into separate files, or similarly organised areas in the css files on the way to then looking for standardisation/normalisation/reconciliation opportunities?
- is there any opportunity to rationalise/normalise/standardise any of the js, eg common functions into shared file or one or more new files? (DO NOT BREAK ANYTHING, PARTICULARLY IF YOU ARE GENERALISING SIMILAR THINGS THAT ARE NOT EXACT CODE MATCHES. THERE MAY BE SUBTLETIES IN HOW SLIGHTLY DIFFERENT THINGS ARE HANDLING THINGS.) ALSO BE VERY WARY OF SUGGESTING ANY CHANGE THAT MAY BREAK HOW CSS IS OPERATING. Would it make sense to split js into separate files or move code into clearly identified sections within current js pages, eg data loading and parsing, renderers, card definition/handling/rendering, podcast  handlers, tour handlers, flyer handlers, other handlers, date handlers, navigation handlers, generic utilities, perhaps on the way to then looking for reusable or shared utility functions across files? IF YOU DO REORDER FILES, MAKE SURE THE CODE STILL RUNS AND FUNCTION DEPENDENCIES AREN'T BROKEN BECAUSE OF MESSED UP FUNCTION DEFINITION ORDER!
- is there any standardisation / normalisation of html page structures (do you need to see the css to make most sense of that? Or can you comment initially based on just the html structure then make a notes file that can be passed to a css and/or js review?). DO NOT MAKE ANY CHANGES THAT WILL BREAK ANYTHING, EG IN CASE WHERE JS AND / OR CSS MAY BE RELYING ON SOMETHING IN THE HTML. Is there any scope for defining reusable web components across pages (do you need to see css and / or js to make that judgement?)? Should there be a standardisation of cards and how they are handled (do you need to see js and css for that).


In the event builder: (upload event builder, schema, and stats js etc)
- in the builder and in the schema, should the video appearance have an option for the format[?] (eg storytelling performance, interview (there is a similar characterisation elsewhere)); also note that some episode may have a telling and/or a interview, so the format should be a string or a list. Also, give examples of format but do not prescribe it if s/one comes up with a new tag.
- on the New Venue page, the Website, tickets, Facebook, and Instagram are all URLs or URLs can be generated from them. To improve usability and flow, what do you think about having a URLs section, option to add url and identify type.  (do a regex check on it, maybe an optional poll check and/or open Url arrow) and a dropdown to select the type (web, ticketing, facebook personal / page / group, (?),  instagram) and then assign the url to the appropriate field in the json; check only one url of each type entered; also make sure the loader previews correctly for edited venues;
- in the enricher as quality feed validation, generate the price string from the structured price and check they are the same, reporting if they are not; (WHERE IS THE PRICE GENERATOR CODE? IS IT USED BY THE BUILDER?)
- re: the URLs, I think it makes sense to have top level facebook_url, instagram_url, (web_)url, items, versus links in the schema of the form:[{"type":"web", "url":URL}] (there are quite a few url handles around the wider site js that would need refactoring etc.) But it might be handy in the builder to have an option to enter a URL and click a button that attempts to assign it to one of those specific url types (eg easy to identify inst, facebook groups have different url structure to personal page i think?), ticketing domains for ticketing_url are often in a common set of domains, (tickettalior, ticketsource, wegottickets, eventbrite, ticketsolve, seetickets, sumup, alltickets, stripe, skiddle, etc);
- explore building importers from loading ticket URl pages, so given ticketing url, can start to populate some of the form fields; (are there rss/xml/json feed urls derivable from ticketing pages); (the url would have to be entered at the top of the page? Maybe in a labelled text box "Attempt to load event from ticketing /event url") for example, how about importing data from ticketing urls that are associated with following event records (can you load the ticket page urls to see how to extract the data? Note the affiliate link path (ets.com/af/671/event/68) in one of the ticket urls):
{
      "fb_event": 1338473741103128,
      "name": "Jess Silk",
      "date": "26/09/2026",
      "time": "6.30pm",
      "ticket_url": "https://wegottickets.com/af/671/event/682723",
      "price": "£12.50(+£1.30)",
      "isMusic": true,
      "isSpecial": true,
      "event_flyer": "jess-silk-sept-2026.png",
      "venue_id": "katie-fitzgeralds-stourbridge"
    }, {
      "name": "The Nutcracker [Jason Buck]",
      "showname": "The Nutcracker",
      "date": "22/12/2026",
      "time": "7pm for 7.30pm start",
      "club": "",
      "price": "£15.00 (+ £1.50)",
      "event_flyer": "",
      "description": "Hear the tale of the story of a magical and dreamy Christmas, that inspired music, ballet and films, presented live for the festive season.\n\n\n\nAward-winning storyteller, Jason Buck Storyteller, brings this favourite to life, with humour, wonder and an immersive experience for young and old - traditional storytelling for a modern audience, in Sheffield's cosiest cafe.\n\n\n\nAge recommendation: Adult and families (9+)",
      "ticket_url": "https://wegottickets.com/af/671/f/25363",
      "isSpecial": true,
      "date_added": "15/08/2026",
      "venue_id": "cafe-9-sheffield",
      "performer_id": "jason-buck"
    }
    For wegottickets, there is a wegottickets location id; should that be an optional part of my venue record data? Do other ticketing sites have their own venue IDs too?
- review the builder pages wrt the schema and tell me where things may mismatch (don't edit or build anything yet; this is just an audit) For example, in the shared guesser, I think there is a min_age [numeric] suggestion that perhaps isn't in the schema? (Is the min_age useful or not do you think?)
- would it be appropriate to be able to add a date to a repertoire list from the event page if a repertoire_id is provided? (I'm not sure in the wider site if a simple event can inherit from a repertoire event?)
- on the event page, isn't there an option to add multiple event flyers as there is in the tour page? (should make reuse of that if appropriate; for example, is that also a shared component with the tour tour flyers?) Does the schema suggest optional multiple flyers in other areas? FOr example, in repertoire should the headline flyer also be similarly supporting of optional multiple possible flyers?  And in repertoire event? DO NOT BREAK ANYTHING WHERE OTHER SCHEMA HANDLERS IN OTHER FILES YOU HAVEN'T SEEN FROM THE WIDER SITE THAT CONSUME THE JSON DATA FEED PRODUCED THAT MAY RELY ON A SINGLE STRING FLYER 
TO DO  in js check / add support for optional multiple flyers if schema has unsupported _flyers elements.
- it may be worth adding the podcast tools thing as an event builder tab? (reuse the js etc; I may want to run the separate podcast page as well, but if I update the js etc it would be best to only do it in one place); or using parts of that to help build podcast appearances (would need to be collapsed most of the time?)
- similarly, if a repertoire_id is provided, could inherited ghosted or grey content be previewed in the tour display but not added into the generated json unless it is manually edited (eg if a user clicks in the inheriting field, un-ghosts the text and makes it editable 
in the postcode/town extractor, if the address field is edited, the town and postcode should be updated
- add what three words option for location, maybe then also geocode from that
- would be useful to load repoertoire show from jey to allow additional dates to be added
- I note if i add a tour to batch, there is no edit button for it;
- put full address above town and postcode; And prepopulate postcode on enter address if you can parse out a postcode. eg when I add or change an address in a venue address field, if the last thing after a comma matches a postcode, copy the postcode into the postcode field, and the thing between commas before it, assume that is the town (I want to be able to edit town/postcode if the address is wrong; and use those fields, NOT the guesser from the address, when creating the batched record/json etc); is a "town" is wales or Isle of Wight, then the town is the word before that then comma then wales or isle of wight; if an address is loaded from json, eg when editing loaded venue record, do not run the autoextract tow/postcode into a town or postcode field if it is populated, although it may be worth warning if the automated guess of values for those fields is different to their actual values.
- in text fields, strip leading and trailing white space when you save to the batch;
- are all ids auto generated? can this be over-ridden with a manually set id?

- Maybe also need a check on the podcast feeds to see if they work as rss feeds and if not flag an issue. THe format tag used to annotate podcast and video links should be checked for existence and records lacking it identified. If a facebook url and eg a generic url are both supported (In venue maybe?) do an enricher test that identifies where the generic url is a facebook url and suggest moving it to the other field.
- can you check whether there are one or two ways of handling price parsing - one in the builder and one in the stats page; the stats page should look first to a record for structured data then analyse on that, then onto a parse of the unstructured price string if that is the only one available; but it would make sense for that parser to parse into the structured format, and do the stats on the structured data?
- in the enricher, which is now a data quality checker as much as anything, give a status indication as to whether the feed loads correctly (green) or is broken/doesn't parse as json (red) (and if so, alert as to where the issue is; there is something similar in the shared_utils I think?) Might it also be worth validating an uploaded event json data feed against the schema when the event json data feed is uploaded; then if the data feed conforms to the schema, show a green led; if it has mismatches, orange; if it fails to load/parse at all, red, (with an option to display error message and preview that part of the feed). What do you think? How much of an overhead does that is in terms of validation code?
- for the venue schema, would it be better if there was a key (or free text) for the venue_type, that can get resolved via a venue_types dict (eg {"pub-bar-cafe": {"label": "Pub / bar / cafe}, "description":""}) or is that overkill? Help me think through how this could work. In parsing, if the venue_type doesn't match a venue_types dict key, then the unmatched key free text could be displayed? (I also note another venue type is "bookshop" and "social-club" and "live-music-venue"); schema should also allow for multiple slugs eg ["pub", "live-music-venue"]; in the enricher list, provide a link for the venue in the suggestions so i can easily look at the web page to check a designation.
- Should you do a similar handler to age handler for price (could/should this be handled edit and generation wise as per the corresponding fields in the event builders? (It would be useful to preview the structured price elements)
- in the formatter Maybe provide a panel with checkboxed for which schema parts are going to be "formatted" (or linted...)  (eg .facebook, .description, etc)
- in the formatter, in the desc, why do you strip \n\n\n\n in this? > Commedic energy and wit leading to a style all of his own.\n\n\n\n The origins of Ian'< Is is because of a space before or after the \n ? (or maybe there was a double space in the para I didn't spot?)
- in the event builder, the age rating suggester provides a checkbox option to remove the age string from the description; should there be a similar option in the enricher? if so, should the description before/after be shown?
- should there be an option to try to extract the time from the description? I wonder, should there be an option at the top to paste a chunk of text that the various parsers apply to, extracting what they can then dumping the rest into a description field? This might include trying to scan for venues, performers, etc?
- If the enricher augments a feed, run the feed through the validator before and after (are there js json schema validators we could import from a cdn? or is it just as quick/easy to write something to handle this schema in particular)  - there should be no new errors; if there are fewer or changed errors for a record, report on that also (ie report what error the update fixed). If there is now a validator against the schema available in the builder, that should validate generated fragments and warn somehow if generated fragments are invalid. Again, make use of green (all good), orange (non-validating), red (broken/doesn't parse) (with an option to display error message and preview that part of the feed); report on errors and offer to fix some; eg. if there are duplicate records;
- in the enricher, would it be sensible to have a download enriched feed at bottom as well (eg to finish a workflow working down the list);
- in the enricher, support a report that produces a warning of duplicate records - eg if a tour date for a performer is also explicitly listed as a special event for the same performer, or the same datetime event, or the same date/same performer etc; also have a check on all performer_id/ids wherever they appear, that check whether an id referenced in an event, tour, etc reconciles to a performer key in the performer records; also a potential deduper between performer record; also have a check that for events that reference a venue_id, there is a venue defined with that venue_id (does this all count as linting?)
- in the event  builder event panel, it might be useful to preview the event listing card that would appear on the event page for that event; this might be useful elsewhere, so may be worth considering extracting into an infocard js, css, webcomponent etc? does that make sense or represent case of doing it because you can rather than because it's architecturally sensible?

- builder has no support for recurring  club events? (same form for different types - story, irish, folk  poetry?)

in the formatter, should the list of performers, storyclubs and venues be in alphabetical order? Or maybe have a toggle switch a user can select that will do sorting for each of those collections separately? (or maybe there should be an option to sort venues by proximity to each other; how hard would that be? maybe ordered by latitude, then longitude??)
in the report of possible issues, should there be a list of performers with no url of any sort; and venues with no url of any sort; then other filters to allow eg no weburl; no fb url (group, individual, or page)? no insta url. and an option for use to add one and add to batch as the person venue or club record?
in the tours page, support tour_flyers as a list of possible tour_flyer images; also add a tour_banner (and to schema) that is a flyer for a tour without the dates on it; this should not be displayed in the flyers.js but should be displayed as artwork on a tour/repertoire page and on a performer page to illustrate a repertoire show
NOTE TO SELF _       "tour_flyer": "tour_katy_cawkwell_lilith_2026_2027.jpeg", should be tour_banner

In the stats page, if price is split out to a price and a fee, do some stats on the % of the price that the fee appears to be.

If i have a tour date that is eg a musician appearing at a folk club as a special guest, how should I add that? How should I handle it for just a performer event? (I think a storyclub can have a special guest performer_id?)

In event cards, can simple defined event inherit from a repertoire show like a tour can?

TO DO - add details of folk with Arts Council, National Lottery funding

Need somewhere to add affiliate code to eg wegottickets etc

In the schema, is the events list actually a regular_events or scheduled_events list? (ie ith the events key misleading?)

Schema
- in repertoire, require performer_id inclusive OR performer_ids

If there isn't already, in the schema and the event builder venue forms, there should be an optional description free text field.

If there isn't already, in the schema and the event builder story club forms, there should be an optional description free text field.

In each of the builder forms, when json is generated, also run it through the linter before displaying it?


For each venue, consider a screenshot of the web page as a large thumbnail for venue page.

Don't implement this - just a question for now; what checks would a linter add over the json formatter in the enricher/quality tool? How is a linter different to eg a validator that checks the data feed against the schema?

On the media page, should watch/listen should be two tabs to make better use of screen real estate? Also, the media page does not have audio podcast feeds content? Should there also be a third tab ,personal podcast, for if a performer runs their own podcast). That said, how would this affect search (eg i was considering having filters for audio, video? Or should audio podcasts be supported/surfaced differently?). What do you think? Review suggestions to me before doing anything

Check every page in the event builder against the schema - do they correspond? if anything is missing or extra, tell me what?

Would it make sense to be able to download  calendar / ical records etc from somewhere?

There is currently no way to link to an individual event; review the possibilities.

touring / repertoire event multiple flyers - need handling in tour page, flyers page, performer page?

Does the event builder also need tweaked support for multi flyers?

? Education tab

eg https://www.akdaniel.co.uk/single-post/copy-of-storying-the-past-part-4-artefact-focused-storying

crick crack

Add tracking onto every url - ?utm_source=newtroubadours.org


sitemap generator and downloader for 

https://newtroubadours.org/performers.html?performer=ailsa-dixon
https://newtroubadours.org/venues.html?venue=1st-fordingbridge-scout-hut-roundhill
https://newtroubadours.org/storyclub.html?club=huddersfield-story-circle


In google tools, i inspected https://newtroubadours.org/performers.html?performer=nell-phoenix and requested indexing; also on bing

To aid web search engine indexing, should there be a link farm html page not linked from anywhere else that just reads the json file then generates a link to each performer, venue, storyclub? THis single page can then be submitted to google for indexing, which renders js, which should get all the links indexed and potentially crawlable?

Storyclub page - maybe have a members of performer_id and a sidebar listing of events involving club members within so many miles? 