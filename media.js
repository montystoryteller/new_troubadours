let podcastsLookup = {};
let videoItems = []; // { performerId, performerName, title, videoId, embedUrl, source?, format?, podcast_id? }
let audioItems = []; // { performerId, performerName, episode_name, audio_url, episode_url, podcast_id?, podcast?, podcast_url?, format? }

// Format-filter state (see renderFormatFilterBar()) — populated once at
// init() from whatever format values actually appear in the data (only
// "telling"/"interview" exist at time of writing, but this stays correct
// if more are added). "" (empty string) is its own bucket, "Other", for
// items with no format set at all — most podcasts/videos don't have one.
let allFormats = [];
let activeFormats = new Set();

// Series lock (see readSeriesLockFromUrl()) — set when the page is
// opened with ?series=<podcast_id>, e.g. from a 🌍 WSC/TTTO badge on the
// performers page. Restricts both Watch and Listen to that one series
// (on top of, not instead of, the search box and format filter), with a
// banner + clear link to drop back to the full page.
let seriesLock = null;

// collectPerformerAppearances()/collectPerformerVideoAppearances()/
// resolvePodcastAppearanceMeta()/extractYoutubeId() are defined in
// shared_utils.js (also used by the performer profile page,
// performers.js) — pulled out to one shared place so this page can't
// quietly drift out of sync with the podcasts registry schema again (it
// previously had its own older copy that had fallen behind: it only read
// performer.youtube_videos directly, so every registry-sourced video —
// e.g. World Storytelling Cafe/Taking the Tradition On guest spots — was
// silently missing from Watch entirely).

// ── Lazy image loading — see createLazyImageLoader() in shared_utils.js
// (also used by the flyers/tour/performer pages). Nothing is fetched from
// img.youtube.com for a video card's thumbnail until it actually scrolls
// near the viewport — this page can list many performers' videos at
// once, and nobody scrolling through the first few should trigger a
// thumbnail request for every video further down the page.
const videoThumbLoader = createLazyImageLoader({
  rootMargin: "250px 0px",
  errorMessage: "Thumbnail not available",
});

function groupByPerformer(items) {
  const groups = new Map(); // performerId -> { performerName, items: [] }
  items.forEach((item) => {
    if (!groups.has(item.performerId)) {
      groups.set(item.performerId, {
        performerName: item.performerName,
        items: [],
      });
    }
    groups.get(item.performerId).items.push(item);
  });
  return [...groups.entries()]
    .map(([performerId, g]) => ({
      performerId,
      performerName: g.performerName,
      items: g.items,
    }))
    .sort((a, b) => a.performerName.localeCompare(b.performerName));
}

// Builds one performer's collapsible group. Deliberately builds NO
// content at all (no video cards, no audio rows, no thumbnail <img>s)
// until the group is actually opened for the first time — not just
// hidden-but-present, genuinely not created — so collapsing a performer
// you don't care about means zero requests for their thumbnails/audio,
// not merely deferred-but-still-queued ones. `buildBody` is called at
// most once per group, the first time it's opened.
// @param {{performerId, performerName, items}} group
// @param {string} noun - singular noun for the count label ("video"/"appearance")
// @param {() => HTMLElement} buildBody - lazily constructs the group's content
// @param {boolean} defaultOpen - true when the user has an active search
function makeMediaGroupDetails(group, noun, buildBody, defaultOpen) {
  const details = document.createElement("details");
  details.className = "media-group-details";
  if (defaultOpen) details.open = true;

  const summary = document.createElement("summary");
  summary.className = "media-group-summary";
  const link = document.createElement("a");
  link.href = `new_troubadours_performers.html?performer=${encodeURIComponent(group.performerId)}`;
  link.textContent = group.performerName;
  // Don't let a click on the performer's own name also toggle the
  // accordion open/closed — it should just navigate.
  link.addEventListener("click", (e) => e.stopPropagation());
  const countEl = document.createElement("span");
  countEl.className = "media-group-count";
  countEl.textContent = `${group.items.length} ${noun}${group.items.length !== 1 ? "s" : ""}`;
  summary.appendChild(link);
  summary.appendChild(countEl);
  details.appendChild(summary);

  const body = document.createElement("div");
  body.className = "media-group-body";
  details.appendChild(body);

  let built = false;
  const ensureBuilt = () => {
    if (built) return;
    built = true;
    body.appendChild(buildBody());
  };

  if (defaultOpen) ensureBuilt();
  details.addEventListener("toggle", () => {
    if (details.open) ensureBuilt();
  });

  return details;
}

// ── Watch (video) rendering ──────────────────────────────────────────

// One shared "now playing" panel per page, rather than each thumbnail
// morphing into its own (non-autoplaying) iframe in place — that required
// a confusing second click inside the embed itself to actually start
// playback, and stayed constrained to the thumbnail grid's narrow column
// width. Clicking any thumbnail now just points this one big panel at
// that video (with autoplay=1, since the click is a direct user gesture)
// and scrolls it into view; clicking another thumbnail re-targets it.
function getNowPlayingPanel() {
  let panel = document.getElementById("nowPlayingPanel");
  if (panel) return panel;

  panel = document.createElement("div");
  panel.id = "nowPlayingPanel";
  panel.className = "now-playing-panel";
  panel.style.display = "none";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "now-playing-close";
  closeBtn.setAttribute("aria-label", "Close video");
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", closeNowPlaying);
  panel.appendChild(closeBtn);

  const frameWrap = document.createElement("div");
  frameWrap.className = "now-playing-frame-wrap";
  const iframe = document.createElement("iframe");
  iframe.className = "now-playing-iframe";
  iframe.frameBorder = "0";
  iframe.allow =
    "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
  iframe.referrerPolicy = "strict-origin-when-cross-origin";
  iframe.allowFullscreen = true;
  frameWrap.appendChild(iframe);
  panel.appendChild(frameWrap);

  const title = document.createElement("div");
  title.className = "now-playing-title";
  panel.appendChild(title);

  document.getElementById("watchGroups").insertAdjacentElement(
    "beforebegin",
    panel,
  );
  return panel;
}

function closeNowPlaying() {
  const panel = document.getElementById("nowPlayingPanel");
  if (!panel) return;
  panel.style.display = "none";
  panel.querySelector("iframe").src = "";
  document
    .querySelectorAll(".video-card-thumb.playing")
    .forEach((el) => el.classList.remove("playing"));
}

function playVideoInPanel(item, thumbBtn) {
  const panel = getNowPlayingPanel();
  document
    .querySelectorAll(".video-card-thumb.playing")
    .forEach((el) => el.classList.remove("playing"));
  thumbBtn.classList.add("playing");
  panel.querySelector("iframe").src = `${item.embedUrl}?autoplay=1`;
  panel.querySelector(".now-playing-title").textContent = item.title;
  panel.style.display = "";
  panel.scrollIntoView({ behavior: "smooth", block: "center" });
}

function makeVideoCard(item) {
  const card = document.createElement("div");
  card.className = "video-card";

  // Plain clickable thumbnail — no per-card play/iframe state; clicking
  // always targets the one shared now-playing panel (see above).
  const thumbBtn = document.createElement("button");
  thumbBtn.className = "video-card-thumb";
  thumbBtn.setAttribute("aria-label", `Play video: ${item.title}`);

  // Thumbnail image — lazy-loaded via videoThumbLoader (see top of file),
  // not fetched until this card is actually near the viewport.
  const thumbImg = document.createElement("img");
  thumbImg.className = "video-card-thumb-img";
  thumbImg.alt = "";
  thumbImg.dataset.src = `https://img.youtube.com/vi/${item.videoId}/hqdefault.jpg`;
  thumbBtn.appendChild(thumbImg);
  videoThumbLoader.observe(thumbImg);

  thumbBtn.addEventListener("click", () => playVideoInPanel(item, thumbBtn));

  const caption = document.createElement("div");
  caption.className = "video-card-caption";
  const titleEl = document.createElement("div");
  titleEl.className = "video-card-title";
  titleEl.textContent = item.title;
  caption.appendChild(titleEl);

  // Source/format badges — same convention as the performer profile
  // page's Videos section (source = the registry series it's from, e.g.
  // "World Storytelling Cafe"; format = "telling"/"interview" etc.).
  // Neither is set for a performer's own inline youtube_videos entry,
  // since those don't belong to a registered series.
  if (item.source || item.format) {
    const badges = document.createElement("div");
    badges.className = "video-card-badges";
    if (item.source) {
      const b = document.createElement("span");
      b.className = "video-card-source-badge";
      b.textContent = item.source;
      badges.appendChild(b);
    }
    if (item.format) {
      const b = document.createElement("span");
      b.className = "video-card-format-badge";
      b.textContent = item.format;
      badges.appendChild(b);
    }
    caption.appendChild(badges);
  }

  card.appendChild(thumbBtn);
  card.appendChild(caption);
  return card;
}

function renderWatchSection(items, searchActive) {
  const container = document.getElementById("watchGroups");
  container.innerHTML = "";
  const groups = groupByPerformer(items);
  groups.forEach((group) => {
    container.appendChild(
      makeMediaGroupDetails(
        group,
        "video",
        () => {
          const grid = document.createElement("div");
          grid.className = "video-grid";
          group.items.forEach((item) => grid.appendChild(makeVideoCard(item)));
          return grid;
        },
        searchActive,
      ),
    );
  });
  document.getElementById("watchEmptyMsg").style.display = groups.length
    ? "none"
    : "";
}

// ── Listen (podcast) rendering ───────────────────────────────────────
function toggleAudioPreview(row, audioUrl, btn) {
  const existing = row.querySelector(".audio-player-holder");
  if (existing) {
    existing.remove();
    btn.textContent = "▶ Play";
    return;
  }
  document.querySelectorAll(".audio-player-holder").forEach((h) => h.remove());
  document
    .querySelectorAll(".audio-preview-btn")
    .forEach((b) => (b.textContent = "▶ Play"));

  const holder = document.createElement("div");
  holder.className = "audio-player-holder";
  const audio = document.createElement("audio");
  audio.controls = true;
  audio.autoplay = true;
  audio.src = audioUrl;
  audio.addEventListener("error", () => {
    if (audio.dataset.retried) return;
    audio.dataset.retried = "1";
    audio.src = proxiedPodcastUrl(audioUrl);
  });
  holder.appendChild(audio);
  row.appendChild(holder);
  btn.textContent = "■ Close";
}

function makeAudioRow(item) {
  const row = document.createElement("div");
  row.className = "audio-row";

  const top = document.createElement("div");
  top.className = "audio-row-top";

  const body = document.createElement("div");
  body.className = "audio-row-body";

  const title = document.createElement("div");
  title.className = "audio-row-title";
  title.textContent = item.episode_name;
  body.appendChild(title);

  const meta = resolvePodcastAppearanceMeta(item, podcastsLookup);
  if (meta.name) {
    const metaLine = document.createElement("div");
    metaLine.className = "audio-row-meta";
    const metaLink = meta.url
      ? createExternalLink(meta.url, meta.name, {})
      : null;
    metaLine.appendChild(metaLink || document.createTextNode(meta.name));
    body.appendChild(metaLine);
  }
  if (meta.format) {
    const formatBadge = document.createElement("span");
    formatBadge.className = "audio-row-format-badge";
    formatBadge.textContent = meta.format;
    body.appendChild(formatBadge);
  }
  top.appendChild(body);

  if (item.audio_url) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "audio-preview-btn";
    btn.textContent = "▶ Play";
    btn.addEventListener("click", () =>
      toggleAudioPreview(row, item.audio_url, btn),
    );
    top.appendChild(btn);
  }

  row.appendChild(top);
  return row;
}

function renderListenSection(items, searchActive) {
  const container = document.getElementById("listenGroups");
  container.innerHTML = "";
  const groups = groupByPerformer(items);
  groups.forEach((group) => {
    container.appendChild(
      makeMediaGroupDetails(
        group,
        "appearance",
        () => {
          const list = document.createElement("div");
          list.className = "audio-list";
          group.items.forEach((item) => list.appendChild(makeAudioRow(item)));
          return list;
        },
        searchActive,
      ),
    );
  });
  document.getElementById("listenEmptyMsg").style.display = groups.length
    ? "none"
    : "";
}

// ── Search / filter ──────────────────────────────────────────────────

// Builds the "All / None / Telling / Interview / Other" format chips and
// inserts them right after the search bar. Fully self-styled (see
// .format-chip in media-styles.css) rather than reusing the directory
// page's .dir-filter-btn/.type-filter-btn/.active-teal classes — those
// are defined in shared-styles.css, and whatever combination of rules
// makes them render correctly there didn't carry over cleanly here (the
// "active" state showed dark, barely-readable text on the green
// background instead of white). A no-op if there's only one format (or
// none) in the data — nothing to usefully filter by in that case.
function renderFormatFilterBar() {
  const existing = document.getElementById("formatFilterBar");
  if (existing) existing.remove();
  if (allFormats.length < 2) return;

  const wrap = document.createElement("div");
  wrap.id = "formatFilterBar";
  wrap.className = "format-filter-bar";

  const label = document.createElement("span");
  label.className = "filter-bar-label";
  label.textContent = "Format";
  wrap.appendChild(label);

  const allBtn = document.createElement("button");
  allBtn.className = "format-chip format-chip-meta active";
  allBtn.textContent = "All";
  allBtn.onclick = () => {
    allFormats.forEach((f) => activeFormats.add(f));
    refreshFormatBtns();
    applyFilter();
  };
  wrap.appendChild(allBtn);

  const noneBtn = document.createElement("button");
  noneBtn.className = "format-chip format-chip-meta";
  noneBtn.textContent = "None";
  noneBtn.onclick = () => {
    activeFormats.clear();
    refreshFormatBtns();
    applyFilter();
  };
  wrap.appendChild(noneBtn);

  const formatBtnEls = [];
  allFormats.forEach((f) => {
    const btn = document.createElement("button");
    btn.className = "format-chip active";
    btn.dataset.format = f;
    btn.textContent = f ? capitalise(f) : "Other";
    btn.onclick = () => {
      if (activeFormats.has(f)) activeFormats.delete(f);
      else activeFormats.add(f);
      refreshFormatBtns();
      applyFilter();
    };
    formatBtnEls.push(btn);
    wrap.appendChild(btn);
  });

  function refreshFormatBtns() {
    formatBtnEls.forEach((btn) =>
      btn.classList.toggle("active", activeFormats.has(btn.dataset.format)),
    );
    allBtn.classList.toggle("active", activeFormats.size === allFormats.length);
    noneBtn.classList.toggle("active", activeFormats.size === 0);
  }

  document.querySelector(".filter-bar").insertAdjacentElement("afterend", wrap);
}

// Reads ?series=<podcast_id> from the URL, validates it against the
// loaded podcasts registry, and — if valid — renders a "Currently
// showing: X" banner with a link back to the unscoped page. Called once
// at init(); the podcast_id itself (not e.g. its series_title) is what's
// matched against each item's own podcast_id below in applyFilter().
function readSeriesLockFromUrl() {
  const param = new URLSearchParams(window.location.search).get("series");
  if (!param || !podcastsLookup[param]) return;
  seriesLock = param;

  const banner = document.createElement("div");
  banner.className = "series-lock-banner";
  const seriesName = podcastsLookup[param].series_title || param;
  const label = document.createElement("span");
  label.textContent = `Showing: ${seriesName}`;
  banner.appendChild(label);
  const clear = document.createElement("a");
  clear.href = "new_troubadours_media.html";
  clear.className = "series-lock-clear";
  clear.textContent = "✕ Show everything";
  banner.appendChild(clear);
  document.querySelector(".filter-bar").insertAdjacentElement("afterend", banner);
}

function applyFilter() {
  const q = document.getElementById("mediaSearch").value.trim().toLowerCase();
  const matchesVideo = (v) =>
    (!q ||
      v.performerName.toLowerCase().includes(q) ||
      v.title.toLowerCase().includes(q)) &&
    activeFormats.has(v.format || "") &&
    (!seriesLock || v.podcast_id === seriesLock);
  const matchesAudio = (a) =>
    (!q ||
      a.performerName.toLowerCase().includes(q) ||
      a.episode_name.toLowerCase().includes(q)) &&
    activeFormats.has(a.format || "") &&
    (!seriesLock || a.podcast_id === seriesLock);

  const filteredVideos = videoItems.filter(matchesVideo);
  const filteredAudio = audioItems.filter(matchesAudio);

  // Auto-expand groups when there's an active search OR a series lock —
  // landing on the page with neither keeps every performer collapsed
  // (see makeMediaGroupDetails()), but a deliberate search, or arriving
  // via a series badge, is a strong enough signal to show the match(es)
  // already open.
  const revealActive = q.length > 0 || !!seriesLock;
  renderWatchSection(filteredVideos, revealActive);
  renderListenSection(filteredAudio, revealActive);

  const total = filteredVideos.length + filteredAudio.length;
  document.getElementById("resultCount").textContent = q
    ? `${total} match${total !== 1 ? "es" : ""}`
    : "";
  document.getElementById("noResultsMsg").style.display =
    q && total === 0 ? "" : "none";
  document.getElementById("watchSection").style.display = filteredVideos.length
    ? ""
    : "none";
  document.getElementById("listenSection").style.display = filteredAudio.length
    ? ""
    : "none";
}

(async function init() {
  const loaded = await loadEventsData();
  if (!loaded) {
    document.getElementById("loadingMsg").textContent =
      "Could not load events data — please try again shortly.";
    return;
  }
  const performersLookup = loaded.performersLookup;
  podcastsLookup = loaded.podcastsLookup;

  Object.entries(performersLookup).forEach(([performerId, performer]) => {
    // collectPerformerVideoAppearances() (shared_utils.js) merges
    // registry-sourced videos (e.g. World Storytelling Cafe/Taking the
    // Tradition On guest spots, tagged via performer_id/performer_ids on
    // a podcast's items[]) with the performer's own inline
    // youtube_videos, de-duped by video id.
    collectPerformerVideoAppearances(
      performer,
      performerId,
      podcastsLookup,
    ).forEach((v) => {
      const embedUrl = getYouTubeEmbedUrl(v.yt_url);
      if (!embedUrl) return;
      const videoId = embedUrl.split("/embed/")[1];
      if (!videoId) return;
      videoItems.push({
        performerId,
        performerName: performer.name || performerId,
        title: v.story_name || "Untitled",
        videoId,
        embedUrl,
        source: v.source || "",
        format: v.format || "",
        podcast_id: v.podcast_id || "",
      });
    });

    collectPerformerAppearances(performer, performerId, podcastsLookup).forEach(
      (a) => {
        if (!a.episode_name || !a.audio_url) return;
        audioItems.push({
          performerId,
          performerName: performer.name || performerId,
          ...a,
          format: resolvePodcastAppearanceMeta(a, podcastsLookup).format || "",
        });
      },
    );
  });

  // Format-filter setup — every distinct format value actually present
  // in the data (see renderFormatFilterBar()), all active by default so
  // nothing is hidden until the user actually narrows it down.
  allFormats = [
    ...new Set([...videoItems, ...audioItems].map((i) => i.format || "")),
  ].sort();
  activeFormats = new Set(allFormats);
  renderFormatFilterBar();
  readSeriesLockFromUrl();

  document.getElementById("loadingMsg").style.display = "none";
  applyFilter();
  document.getElementById("mediaSearch").addEventListener("input", applyFilter);
})();
