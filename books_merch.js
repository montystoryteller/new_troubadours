// ---------------------------------------------------------------------------
// books_merch.js — books_merch.html
//
// Same pattern as promoters.html:
//   no query arg      : tabbed directory. Tabs: Performers (tiles), Publishers
//                       (tiles), Everything (searchable list of all items).
//                       Choosing a tile navigates to that tile's own page.
//   ?performer=<id>   : only items by / crediting that performer.
//   ?publisher=<key>  : only books from that publisher (a registry id, or
//                       "name:<name>" for books with only free-text publisher).
//   ?view=performers|publishers|all : which tab the directory opens on.
// Scoped pages carry a back link to the directory.
//
// Card markup and the data collectors live in books_utils.js.
// ---------------------------------------------------------------------------

let eventsData = null;
let performersLookup = {};
let publishers = {};
let allBooks = [];
let allMerch = [];

let scopePerformerId = null;
let scopePublisherKey = null;
let currentView = "performers";

const VIEWS = ["performers", "publishers", "all"];
const filters = { kind: "all", q: "", publisher: "", type: "" };

function publisherKey(book) {
  return bookPublisherKey(book, publishers);
}

function performerName(id) {
  return performersLookup[id]?.name || id;
}

function pluralise(n, word) {
  return `${n} ${word}${n !== 1 ? "s" : ""}`;
}

function merchTypeKey(item) {
  return (item.type || "").trim().toLowerCase();
}

// typeCounts: Map of type key ("" = untyped) -> count.
// Returns e.g. "4 CDs" or "3 CDs, 2 T-shirts". Most common type first.
function merchCountText(typeCounts) {
  return [...typeCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, n]) =>
      pluralise(n, type ? merchTypeLabel(type) : "merch item"),
    )
    .join(", ");
}

function countMerchTypes(entries) {
  const counts = new Map();
  entries.forEach(({ item }) => {
    const key = merchTypeKey(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return counts;
}

function bookSearchText({ ownerId, book }) {
  const { subtitle, description } = bookSubtitleAndBlurb(book);
  const pub = bookPublisherInfo(book, publishers);
  return [
    book.title,
    subtitle,
    description,
    pub?.name,
    book.isbn,
    performerName(ownerId),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function merchSearchText({ item, credited }) {
  return [
    item.title,
    item.description,
    merchTypeLabel(item.type),
    ...credited.map(performerName),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Directory summaries (feed the tiles)
// ---------------------------------------------------------------------------

// Everyone with at least one book or credited merch item. Merch counts include
// items held on someone else's record that credit this performer.
function performerSummaries() {
  const out = new Map();
  const get = (id) => {
    if (!out.has(id))
      out.set(id, { id, books: 0, merch: 0, merchTypes: new Map(), publishers: new Set() });
    return out.get(id);
  };
  allBooks.forEach(({ ownerId, book }) => {
    const s = get(ownerId);
    s.books += 1;
    const key = publisherKey(book);
    if (key) s.publishers.add(key);
  });
  allMerch.forEach(({ item, credited }) =>
    credited.forEach((id) => {
      const s = get(id);
      const key = merchTypeKey(item);
      s.merch += 1;
      s.merchTypes.set(key, (s.merchTypes.get(key) || 0) + 1);
    }),
  );
  return [...out.values()].sort((a, b) =>
    performerName(a.id).localeCompare(performerName(b.id)),
  );
}

// Publishers that at least one book points at (so a registry entry with no
// books yet isn't shown, and a book naming an unregistered publisher still is).
function publisherSummaries() {
  const out = new Map();
  allBooks.forEach(({ ownerId, book }) => {
    const key = publisherKey(book);
    if (!key) return;
    if (!out.has(key)) {
      const info = bookPublisherInfo(book, publishers);
      out.set(key, { key, name: info.name, url: info.url, books: 0, performers: new Set() });
    }
    const s = out.get(key);
    s.books += 1;
    s.performers.add(ownerId);
  });
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

function tileBadge(text) {
  return el("span", "bm-tile-badge", text);
}

function buildTile(href, name, badges, note) {
  const tile = el("a", "bm-tile");
  tile.href = href;
  tile.appendChild(el("div", "bm-tile-name", name));
  if (note) tile.appendChild(el("div", "bm-tile-note", note));
  const row = el("div", "bm-tile-badges");
  badges.forEach((b) => row.appendChild(tileBadge(b)));
  tile.appendChild(row);
  return tile;
}

function renderPerformerTiles(container) {
  const summaries = performerSummaries();
  if (!summaries.length) {
    container.appendChild(el("p", "books-empty", "No performers with books or merch yet."));
    return;
  }
  const grid = el("div", "bm-tiles-grid");
  summaries.forEach((s) => {
    const badges = [];
    if (s.books) badges.push(`📚 ${pluralise(s.books, "book")}`);
    if (s.merch) badges.push(`💿 ${merchCountText(s.merchTypes)}`);
    grid.appendChild(
      buildTile(
        `books_merch.html?performer=${encodeURIComponent(s.id)}`,
        performerName(s.id),
        badges,
      ),
    );
  });
  container.appendChild(grid);
}

function renderPublisherTiles(container) {
  const summaries = publisherSummaries();
  if (!summaries.length) {
    container.appendChild(el("p", "books-empty", "No publishers listed yet."));
    return;
  }
  const grid = el("div", "bm-tiles-grid");
  summaries.forEach((s) => {
    const badges = [`📚 ${pluralise(s.books, "book")}`];
    if (s.performers.size) badges.push(`🎤 ${pluralise(s.performers.size, "author")}`);
    grid.appendChild(buildTile(publisherPageHref(s.key), s.name, badges));
  });
  container.appendChild(grid);
}

// ---------------------------------------------------------------------------
// Filtering (Everything tab and scoped pages)
// ---------------------------------------------------------------------------

function visibleBooks() {
  if (filters.kind === "merch") return [];
  const q = filters.q;
  return allBooks.filter((entry) => {
    if (scopePerformerId && entry.ownerId !== scopePerformerId) return false;
    if (scopePublisherKey && publisherKey(entry.book) !== scopePublisherKey)
      return false;
    if (filters.publisher && publisherKey(entry.book) !== filters.publisher)
      return false;
    if (q && !bookSearchText(entry).includes(q)) return false;
    return true;
  });
}

function visibleMerch() {
  // Merch has no publisher, so a publisher page or publisher filter hides it.
  if (filters.kind === "books" || scopePublisherKey || filters.publisher)
    return [];
  const q = filters.q;
  return allMerch.filter((entry) => {
    if (scopePerformerId && !entry.credited.includes(scopePerformerId))
      return false;
    if (
      filters.type &&
      merchTypeKey(entry.item) !== filters.type
    )
      return false;
    if (q && !merchSearchText(entry).includes(q)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Item list rendering
// ---------------------------------------------------------------------------

function newestFirst(getItem) {
  return (a, b) => sortNewestFirst(a, b, getItem);
}

function summaryText(nBooks, merchEntries) {
  const parts = [];
  if (nBooks) parts.push(pluralise(nBooks, "book"));
  if (merchEntries.length)
    parts.push(merchCountText(countMerchTypes(merchEntries)));
  return parts.join(" · ");
}

function renderGroups() {
  const container = document.getElementById("booksGroups");
  container.innerHTML = "";

  const books = visibleBooks().sort(newestFirst((x) => x.book));
  const merch = visibleMerch().sort(newestFirst((x) => x.item));

  document.getElementById("booksSummary").textContent = summaryText(
    books.length,
    merch,
  );

  if (!books.length && !merch.length) {
    container.appendChild(
      el("div", "books-empty", "Nothing matches — try loosening the filters."),
    );
    return;
  }

  // Group by the performer record that holds the item (a joint CD is listed
  // once, with its other credits shown on the card).
  const groups = new Map();
  const groupFor = (id) => {
    if (!groups.has(id)) groups.set(id, { books: [], merch: [] });
    return groups.get(id);
  };
  books.forEach((entry) => groupFor(entry.ownerId).books.push(entry));
  merch.forEach((entry) => groupFor(entry.ownerId).merch.push(entry));

  const orderedIds = [...groups.keys()].sort((a, b) =>
    performerName(a).localeCompare(performerName(b)),
  );

  orderedIds.forEach((id) => {
    const { books: gBooks, merch: gMerch } = groups.get(id);
    const section = el("section", "books-group");

    // On a single-performer page the page heading already names them.
    if (!scopePerformerId) {
      const heading = el("h3", "books-group-heading");
      const link = el("a", "", performerName(id));
      link.href = `performers.html?performer=${encodeURIComponent(id)}`;
      heading.appendChild(link);
      section.appendChild(heading);
    }

    if (gBooks.length) {
      // Sub-headings only when a group has both kinds.
      if (gMerch.length) section.appendChild(el("div", "bm-subheading", "Books"));
      const list = el("div", "bm-list");
      gBooks.forEach(({ book }) => {
        list.appendChild(createBookCard(book, { publishers, performersLookup }));
      });
      section.appendChild(list);
    }

    if (gMerch.length) {
      if (gBooks.length) section.appendChild(el("div", "bm-subheading", "Merch"));
      const list = el("div", "bm-list");
      gMerch.forEach(({ item, credited }) => {
        // Excluding the group's own performer keeps a joint CD from reading
        // "with Hugh Lupton" under Hugh Lupton.
        const others = credited.filter((cid) => cid !== id);
        list.appendChild(
          createMerchCard(item, {
            performersLookup,
            creditIds: others,
            creditPrefix: "with ",
          }),
        );
      });
      section.appendChild(list);
    }

    container.appendChild(section);
  });
}

// ---------------------------------------------------------------------------
// Controls (search / kind / publisher / type)
// ---------------------------------------------------------------------------

function populateSelect(select, entries) {
  entries.forEach(([value, label]) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    select.appendChild(opt);
  });
}

function initControls() {
  const publisherSelect = document.getElementById("publisherFilter");
  const typeSelect = document.getElementById("typeFilter");

  // Options come from what's in scope, so a performer's page doesn't offer
  // publishers they've never used.
  const scopedBooks = allBooks.filter(
    (e) =>
      (!scopePerformerId || e.ownerId === scopePerformerId) &&
      (!scopePublisherKey || publisherKey(e.book) === scopePublisherKey),
  );
  const scopedMerch = allMerch.filter(
    (e) => !scopePerformerId || e.credited.includes(scopePerformerId),
  );

  const pubs = new Map();
  scopedBooks.forEach(({ book }) => {
    const key = publisherKey(book);
    if (key) pubs.set(key, bookPublisherInfo(book, publishers).name);
  });
  populateSelect(
    publisherSelect,
    [...pubs.entries()].sort((a, b) => a[1].localeCompare(b[1])),
  );

  const types = new Map();
  scopedMerch.forEach(({ item }) => {
    const t = merchTypeKey(item);
    if (t) types.set(t, merchTypeLabel(t));
  });
  populateSelect(
    typeSelect,
    [...types.entries()].sort((a, b) => a[1].localeCompare(b[1])),
  );

  // Controls that can't change anything are hidden rather than left inert.
  const hasBooks = scopedBooks.length > 0;
  const hasMerch = scopedMerch.length > 0 && !scopePublisherKey;
  publisherSelect.style.display = pubs.size > 1 && !scopePublisherKey ? "" : "none";
  typeSelect.style.display = types.size > 1 && !scopePublisherKey ? "" : "none";
  document.getElementById("kindToggle").style.display =
    hasBooks && hasMerch ? "" : "none";

  publisherSelect.addEventListener("change", () => {
    filters.publisher = publisherSelect.value;
    renderGroups();
  });
  typeSelect.addEventListener("change", () => {
    filters.type = typeSelect.value;
    renderGroups();
  });
  document.getElementById("booksSearch").addEventListener("input", (e) => {
    filters.q = e.target.value.trim().toLowerCase();
    renderGroups();
  });
  document.querySelectorAll("#kindToggle button").forEach((btn) => {
    btn.addEventListener("click", () => {
      filters.kind = btn.dataset.kind;
      document
        .querySelectorAll("#kindToggle button")
        .forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      renderGroups();
    });
  });
}

// ---------------------------------------------------------------------------
// Tabs (directory mode only)
// ---------------------------------------------------------------------------

function showView(view, updateUrl = true) {
  currentView = VIEWS.includes(view) ? view : "performers";

  document.querySelectorAll("#booksTabs [role=tab]").forEach((tab) => {
    const active = tab.dataset.view === currentView;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });

  const tiles = document.getElementById("tilesPanel");
  const list = document.getElementById("everythingPanel");
  tiles.style.display = currentView === "all" ? "none" : "";
  list.style.display = currentView === "all" ? "" : "none";

  if (currentView !== "all") {
    tiles.innerHTML = "";
    tiles.setAttribute("aria-labelledby", `tab-${currentView}`);
    if (currentView === "performers") renderPerformerTiles(tiles);
    else renderPublisherTiles(tiles);
  } else {
    renderGroups();
  }

  if (updateUrl) {
    const url = new URL(window.location.href);
    url.searchParams.set("view", currentView);
    history.replaceState(null, "", url);
  }
  // The canonical URL follows the tab, since each tab is a different page.
  setCanonical("view");
}

function initTabs() {
  const tabs = [...document.querySelectorAll("#booksTabs [role=tab]")];
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => showView(tab.dataset.view));
    // Arrow keys move between tabs, per the WAI-ARIA tabs pattern.
    tab.addEventListener("keydown", (e) => {
      const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!delta) return;
      const next = tabs[(i + delta + tabs.length) % tabs.length];
      next.focus();
      showView(next.dataset.view);
      e.preventDefault();
    });
  });
}

// ---------------------------------------------------------------------------
// Page modes
// ---------------------------------------------------------------------------

function setScopedHeading(title, description, heading) {
  document.title = `${title} — New Troubadours`;
  updateMeta("description", description, " — ");
  document.getElementById("pageHeading").textContent = heading;
  document.getElementById("pageSubheading").style.display = "none";
}

function applyDirectoryMode() {
  document.getElementById("booksTabs").style.display = "";
  document.getElementById("scopeNote").style.display = "none";
  document.getElementById("everythingPanel").style.display = "none";
}

function applyScopedMode() {
  const note = document.getElementById("scopeNote");
  note.innerHTML = "";

  const back = el("a", "back-link", "");
  back.textContent =
    scopePerformerId ? "← All performers' books & merch" : "← All publishers";
  back.href = `books_merch.html?view=${scopePerformerId ? "performers" : "publishers"}`;
  note.appendChild(back);

  if (scopePerformerId) {
    const name = performerName(scopePerformerId);
    setScopedHeading(
      `Books & Merch by ${name}`,
      `${name}: books, CDs and merch`,
      `${name} — Books & Merch`,
    );
    const profile = el("a", "", `${name}'s performer page`);
    profile.href = `performers.html?performer=${encodeURIComponent(scopePerformerId)}`;
    note.append(document.createTextNode(" · "), profile);
  } else {
    const pub = publisherSummaries().find((p) => p.key === scopePublisherKey);
    const name = pub.name;
    setScopedHeading(
      `Books published by ${name}`,
      `Books published by ${name}`,
      `Published by ${name}`,
    );
    const site = pub.url ? createExternalLink(pub.url, `${name} website ↗`) : null;
    if (site) note.append(document.createTextNode(" · "), site);
  }

  note.style.display = "";
  document.getElementById("booksTabs").style.display = "none";
  document.getElementById("tilesPanel").style.display = "none";
  document.getElementById("everythingPanel").style.display = "";
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const urlParams = new URLSearchParams(window.location.search);
scopePerformerId = urlParams.get("performer");
scopePublisherKey = scopePerformerId ? null : urlParams.get("publisher");
const requestedView = urlParams.get("view");

// A ?performer= / ?publisher= page is its own canonical page; on the
// directory the canonical URL keeps ?view= (each tab is a different page).
setCanonical(
  scopePerformerId ? "performer" : scopePublisherKey ? "publisher" : "view",
);

(async () => {
  const loaded = await loadEventsData();
  if (!loaded) return showNotFound();

  eventsData = loaded.eventsData;
  performersLookup = loaded.performersLookup;
  publishers = eventsData.publishers || {};
  displayDataLastUpdated(loaded.lastUpdateTime);
  initNavFeedback();

  const all = collectAllBooksAndMerch(performersLookup);
  allBooks = all.books;
  allMerch = all.merch;

  if (scopePerformerId && !performersLookup[scopePerformerId])
    return showNotFound();
  if (
    scopePublisherKey &&
    !publisherSummaries().some((p) => p.key === scopePublisherKey)
  )
    return showNotFound();

  initControls();
  if (scopePerformerId || scopePublisherKey) {
    applyScopedMode();
    renderGroups();
  } else {
    applyDirectoryMode();
    initTabs();
    showView(VIEWS.includes(requestedView) ? requestedView : "performers", false);
  }

  document.getElementById("loadingState").style.display = "none";
  document.getElementById("booksContent").style.display = "";
})();
