let podcastsLookup = {};
let videoItems = []; // { performerId, performerName, title, videoId, embedUrl, source?, format? }
let audioItems = []; // { performerId, performerName, episode_name, audio_url, episode_url, podcast_id?, podcast?, podcast_url? }

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
function closeAllVideoCards(exceptCard) {
  document.querySelectorAll(".video-card.open").forEach((card) => {
    if (card === exceptCard) return;
    card.classList.remove("open");
    const frame = card.querySelector("iframe");
    if (frame) frame.src = "";
  });
}

function makeVideoCard(item) {
  const card = document.createElement("div");
  card.className = "video-card";

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

  const playIcon = document.createElement("span");
  playIcon.className = "video-card-play";
  playIcon.textContent = "▶";
  thumbBtn.appendChild(playIcon);

  const wrapper = document.createElement("div");
  wrapper.className = "video-card-frame-wrap";
  const iframe = document.createElement("iframe");
  iframe.title = item.title;
  iframe.frameBorder = "0";
  iframe.allow =
    "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
  iframe.referrerPolicy = "strict-origin-when-cross-origin";
  iframe.allowFullscreen = true;
  wrapper.appendChild(iframe);

  thumbBtn.addEventListener("click", () => {
    const isOpen = card.classList.contains("open");
    closeAllVideoCards(card);
    card.classList.toggle("open", !isOpen);
    iframe.src = isOpen ? "" : item.embedUrl;
  });

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
  card.appendChild(wrapper);
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
function applyFilter() {
  const q = document.getElementById("mediaSearch").value.trim().toLowerCase();
  const matchesVideo = (v) =>
    !q ||
    v.performerName.toLowerCase().includes(q) ||
    v.title.toLowerCase().includes(q);
  const matchesAudio = (a) =>
    !q ||
    a.performerName.toLowerCase().includes(q) ||
    a.episode_name.toLowerCase().includes(q);

  const filteredVideos = videoItems.filter(matchesVideo);
  const filteredAudio = audioItems.filter(matchesAudio);

  // Auto-expand groups only when there's an active search — landing on
  // the page with nothing typed keeps every performer collapsed (see
  // makeMediaGroupDetails()), but once someone's deliberately searched
  // for something, showing the matching group(s) already open saves an
  // extra click on what they were just looking for.
  const searchActive = q.length > 0;
  renderWatchSection(filteredVideos, searchActive);
  renderListenSection(filteredAudio, searchActive);

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
      });
    });

    collectPerformerAppearances(performer, performerId, podcastsLookup).forEach(
      (a) => {
        if (!a.episode_name || !a.audio_url) return;
        audioItems.push({
          performerId,
          performerName: performer.name || performerId,
          ...a,
        });
      },
    );
  });

  document.getElementById("loadingMsg").style.display = "none";
  applyFilter();
  document.getElementById("mediaSearch").addEventListener("input", applyFilter);
})();
