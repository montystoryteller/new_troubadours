// ---------------------------------------------------------------------------
// books_utils.js
// Shared by performers.html (Books / Merch sections on a performer's page) and
// books_merch.html (the all-performers Books & Merch page).
//
// Data shapes — see events-schema.json → $defs.book / merchItem / publisher:
//   performer.books   : array of book objects. Co-authors come from
//                       book.performer_ids (preferred) or the older book.authors;
//                       links from book.buy_url and book.publication_url
//   performer.merch   : OBJECT of merch items keyed by slug (joint items list
//                       everyone credited in item.performer_ids)
//   eventsData.publishers : registry keyed by publisher_id; a book points at it
//                       via book.publisher_id (older books have a free-text
//                       book.publisher instead)
//
// Depends on shared_utils.js (el, createExternalLink, appendParagraphs, capitalise).
// ---------------------------------------------------------------------------

// Where relative `book.cover` filenames are loaded from (absolute URLs are used
// as-is). Most covers in the data are empty, in which case the ISBN fallback
// below is used.
const BOOK_COVER_BASE = "./book_covers/";

// Fallback for books with an ISBN but no `cover`: Open Library's Covers API
// (no key needed; ~100 lookups per visitor IP per 5 minutes). `?default=false`
// makes a missing cover a 404 so the placeholder below is shown instead of a
// blank image. Please keep the courtesy link back to Open Library in the page
// colophon. Don't crawl it; for bulk use, save covers into BOOK_COVER_BASE.
const OPEN_LIBRARY_COVER_BASE = "https://covers.openlibrary.org/b/isbn/";

// A `subtitle` longer than this is treated as blurb text that was pasted into
// the wrong field (one record has its whole description there): it's shown as
// the description instead of as a subtitle.
const MAX_SUBTITLE_CHARS = 140;

const MERCH_TYPE_LABELS = {
  cd: "CD",
  vinyl: "Vinyl",
  cassette: "Cassette",
  download: "Download",
  "t-shirt": "T-shirt",
  tshirt: "T-shirt",
  poster: "Poster",
};

function merchTypeLabel(type) {
  const t = (type || "").trim().toLowerCase();
  if (!t) return "Merch";
  return MERCH_TYPE_LABELS[t] || capitalise(t);
}

// Buy links are hand-entered; strip stray whitespace (e.g. "https: //…") before
// they reach the URL sanitiser, which would otherwise reject or mangle them.
function cleanBuyUrl(url) {
  return (url || "").replace(/\s+/g, "");
}

// "Taith Records · TRCD00012" from merch item.label / item.label_no, or "".
function merchLabelText(item) {
  return [item?.label, item?.label_no]
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean)
    .join(" · ");
}

function bookSubtitleAndBlurb(book) {
  let subtitle = (book.subtitle || "").trim();
  let description = (book.description || "").trim();
  if (subtitle.length > MAX_SUBTITLE_CHARS) {
    if (!description) description = subtitle;
    subtitle = "";
  }
  return { subtitle, description };
}

// -> { name, url, id } or null. Registry entry wins over legacy free text.
function bookPublisherInfo(book, publishers) {
  if (book.publisher_id) {
    const rec = (publishers || {})[book.publisher_id];
    return {
      id: book.publisher_id,
      name: rec?.name || book.publisher || book.publisher_id,
      url: rec?.url || "",
    };
  }
  if (book.publisher) return { id: "", name: book.publisher, url: "" };
  return null;
}

// Stable key for ?publisher=: the registry id, or "name:<lowercased name>" for
// older books that only carry free-text publisher text. "" when none.
function bookPublisherKey(book, publishers) {
  const info = bookPublisherInfo(book, publishers);
  if (!info) return "";
  return info.id || `name:${info.name.trim().toLowerCase()}`;
}

function publisherPageHref(key) {
  return `books_merch.html?publisher=${encodeURIComponent(key)}`;
}

function bookYearNumber(y) {
  return typeof y === "number" && Number.isFinite(y) ? y : null;
}

// ---------------------------------------------------------------------------
// Collecting
// ---------------------------------------------------------------------------

function merchEntries(performer) {
  const m = performer?.merch;
  if (!m) return [];
  if (Array.isArray(m)) return m.map((item, i) => [String(i), item]);
  return Object.entries(m);
}

// Everyone credited on a merch item: its holder, plus item.performer_ids.
function merchCreditIds(ownerId, item) {
  const ids = [ownerId];
  (Array.isArray(item?.performer_ids) ? item.performer_ids : []).forEach(
    (id) => {
      if (!ids.includes(id)) ids.push(id);
    },
  );
  return ids;
}

function sortNewestFirst(a, b, get) {
  const ya = bookYearNumber(get(a).year) ?? -1;
  const yb = bookYearNumber(get(b).year) ?? -1;
  if (ya !== yb) return yb - ya;
  return (get(a).title || "").localeCompare(get(b).title || "");
}

// Everyone credited on a book: the record that holds it (the main / first
// author), plus any others named in book.performer_ids (preferred, same as
// merch) or the older book.authors. Owner first, then in listed order.
function bookCreditIds(ownerId, book) {
  const ids = [ownerId];
  [book?.performer_ids, book?.authors].forEach((list) =>
    (Array.isArray(list) ? list : []).forEach((id) => {
      if (id && !ids.includes(id)) ids.push(id);
    }),
  );
  return ids;
}

// Books held by, or crediting, any of these ids. Each book appears once even
// if several of the ids are credited on it.
function collectBooksFor(ids, performersLookup) {
  const idSet = ids instanceof Set ? ids : new Set(ids);
  const out = [];
  Object.entries(performersLookup).forEach(([ownerId, performer]) => {
    (Array.isArray(performer?.books) ? performer.books : []).forEach((book) => {
      if (!book || !book.title) return;
      const credited = bookCreditIds(ownerId, book);
      if (credited.some((id) => idSet.has(id))) {
        out.push({ ownerId, book, credited });
      }
    });
  });
  return out.sort((a, b) => sortNewestFirst(a, b, (x) => x.book));
}

// Merch held by, or crediting, any of these ids. Each item appears once even
// if several of the ids are credited on it.
function collectMerchFor(ids, performersLookup) {
  const idSet = ids instanceof Set ? ids : new Set(ids);
  const out = [];
  Object.entries(performersLookup).forEach(([ownerId, performer]) => {
    merchEntries(performer).forEach(([key, item]) => {
      if (!item || !item.title) return;
      const credited = merchCreditIds(ownerId, item);
      if (credited.some((id) => idSet.has(id))) {
        out.push({ key, ownerId, item, credited });
      }
    });
  });
  return out.sort((a, b) => sortNewestFirst(a, b, (x) => x.item));
}

// Groups / duos / collaborations that list `memberId` in performer_ids (or the
// legacy `ids` field). Derived, never stored, so it can't drift out of sync.
function groupIdsForMember(memberId, performersLookup) {
  return Object.entries(performersLookup)
    .filter(([id, p]) => {
      const members = p?.performer_ids || p?.ids;
      return id !== memberId && Array.isArray(members) && members.includes(memberId);
    })
    .map(([id]) => id)
    .sort((a, b) =>
      (performersLookup[a].name || a).localeCompare(performersLookup[b].name || b),
    );
}

// Everything in the data, each item once (merch under the record that holds it).
function collectAllBooksAndMerch(performersLookup) {
  const books = [];
  const merch = [];
  Object.entries(performersLookup).forEach(([ownerId, performer]) => {
    (Array.isArray(performer.books) ? performer.books : []).forEach((book) => {
      if (book && book.title)
        books.push({ ownerId, book, credited: bookCreditIds(ownerId, book) });
    });
    merchEntries(performer).forEach(([key, item]) => {
      if (item && item.title) {
        merch.push({
          key,
          ownerId,
          item,
          credited: merchCreditIds(ownerId, item),
        });
      }
    });
  });
  return { books, merch };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function performerLink(id, performersLookup) {
  // An id with no performer record (a typo in the data) is named but not
  // linked, rather than linking to a page that can only say "not found".
  if (!performersLookup[id]) return el("span", "bm-performer-link", id);
  const name = performersLookup[id].name || id;
  const a = el("a", "bm-performer-link", name);
  a.href = `performers.html?performer=${encodeURIComponent(id)}`;
  return a;
}

// Comma-joined performer links, prefixed by `prefix` (e.g. "by ", "with ").
function creditLine(prefix, ids, performersLookup) {
  const line = el("div", "bm-credit");
  line.appendChild(document.createTextNode(prefix));
  ids.forEach((id, i) => {
    if (i > 0) line.appendChild(document.createTextNode(i === ids.length - 1 ? " & " : ", "));
    line.appendChild(performerLink(id, performersLookup));
  });
  return line;
}

// "Also performs as: Devils Violin, Daniel Morden | Hugh Lupton | …" or null.
function collaborationsLine(memberId, performersLookup) {
  const ids = groupIdsForMember(memberId, performersLookup);
  if (!ids.length) return null;
  const line = el("div", "bm-credit bm-collabs");
  line.appendChild(document.createTextNode("Also performs as: "));
  ids.forEach((id, i) => {
    if (i > 0) line.appendChild(document.createTextNode(", "));
    line.appendChild(performerLink(id, performersLookup));
  });
  return line;
}

function buyLink(url, label) {
  const clean = cleanBuyUrl(url);
  if (!clean) return null;
  const link = createExternalLink(clean, label || "Buy / more info →", {
    className: "bm-buy",
  });
  if (!link) return null;
  try {
    const host = new URL(link.href).hostname.replace(/^www\./, "");
    link.title = `Opens ${host}`;
  } catch (e) {
    /* title is a nicety only */
  }
  return link;
}

function descriptionDropdown(text, label) {
  if (!text) return null;
  const details = el("details", "bm-desc");
  details.appendChild(el("summary", "bm-desc-summary", label));
  const body = el("div", "bm-desc-body");
  appendParagraphs(body, text);
  details.appendChild(body);
  return details;
}

// Explicit `cover` (URL or local filename) wins; otherwise Open Library by
// ISBN; otherwise "" (placeholder).
function coverSrc(book) {
  const cover = (book.cover || "").trim();
  // Only a URL or something that looks like an image filename counts; stray
  // text in this field (one record has a subtitle there) falls through to the
  // ISBN lookup instead of producing a broken local path.
  if (/^https?:\/\//i.test(cover)) return cover;
  if (/\.(jpe?g|png|gif|webp|avif)$/i.test(cover)) {
    return BOOK_COVER_BASE + cover.replace(/[^a-zA-Z0-9._\-]/g, "");
  }
  const isbn = (book.isbn || "").replace(/[^0-9Xx]/g, "");
  return isbn ? `${OPEN_LIBRARY_COVER_BASE}${isbn}-M.jpg?default=false` : "";
}

function coverElement(book) {
  const wrap = el("div", "bm-cover");
  if (!coverSrc(book)) {
    wrap.classList.add("bm-cover-placeholder");
    wrap.textContent = "📖";
    return wrap;
  }
  const img = document.createElement("img");
  img.alt = `Cover of ${book.title}`;
  img.loading = "lazy";
  img.src = coverSrc(book);
  img.addEventListener("error", () => {
    wrap.classList.add("bm-cover-placeholder");
    wrap.textContent = "📖";
  });
  wrap.appendChild(img);
  return wrap;
}

/**
 * @param {object} book
 * @param {{ publishers?: object, performersLookup?: object, creditIds?: string[], creditPrefix?: string }} [opts]
 *   creditIds: when given, a credit line is shown, prefixed by creditPrefix
 *   (default "by ").
 */
function createBookCard(book, opts = {}) {
  const {
    publishers = {},
    performersLookup = {},
    creditIds = null,
    creditPrefix = "by ",
  } = opts;
  const card = el("article", "bm-card bm-book");
  card.appendChild(coverElement(book));

  const body = el("div", "bm-body");
  body.appendChild(el("h4", "bm-title", book.title));

  const { subtitle, description } = bookSubtitleAndBlurb(book);
  if (subtitle) body.appendChild(el("div", "bm-subtitle", subtitle));
  if (creditIds && creditIds.length) {
    body.appendChild(creditLine(creditPrefix, creditIds, performersLookup));
  }

  const meta = el("div", "bm-meta");
  const publisher = bookPublisherInfo(book, publishers);
  const year = bookYearNumber(book.year);
  const parts = [];
  if (publisher) {
    // Links to the publisher's own page here (which carries their website).
    const span = el("span", "bm-publisher");
    const link = el("a", "bm-publisher-link", publisher.name);
    link.href = publisherPageHref(bookPublisherKey(book, publishers));
    span.appendChild(link);
    parts.push(span);
  }
  if (year) parts.push(el("span", "bm-year", String(year)));
  if (book.isbn) parts.push(el("span", "bm-isbn", `ISBN ${book.isbn}`));
  parts.forEach((part, i) => {
    if (i > 0) meta.appendChild(document.createTextNode(" · "));
    meta.appendChild(part);
  });
  if (parts.length) body.appendChild(meta);

  const dd = descriptionDropdown(description, "About this book");
  if (dd) body.appendChild(dd);

  // buy_url is the shop link; publication_url is the book's page on the
  // publisher's site. Show both when both exist, and never the same URL twice.
  const buyUrl = cleanBuyUrl(book.buy_url);
  const pubUrl = cleanBuyUrl(book.publication_url);
  const links = [];
  if (buyUrl) links.push(buyLink(buyUrl));
  if (pubUrl && pubUrl.replace(/\/+$/, "") !== buyUrl.replace(/\/+$/, "")) {
    links.push(
      buyLink(pubUrl, buyUrl ? "Publisher page →" : "Publisher page / more info →"),
    );
  }
  const shown = links.filter(Boolean);
  if (shown.length) {
    const actions = el("div", "bm-actions");
    shown.forEach((a) => actions.appendChild(a));
    body.appendChild(actions);
  }

  card.appendChild(body);
  return card;
}

/**
 * @param {object} item merch item
 * @param {{ performersLookup?: object, creditIds?: string[], creditPrefix?: string }} [opts]
 *   creditIds: performers to show in a credit line, prefixed by creditPrefix
 *   (default "by ").
 */
function createMerchCard(item, opts = {}) {
  const { performersLookup = {}, creditIds = null, creditPrefix = "by " } = opts;
  const card = el("article", "bm-card bm-merch");

  const icon = el("div", "bm-cover bm-cover-placeholder");
  icon.textContent = /^(cd|vinyl|cassette|download)$/i.test(item.type || "")
    ? "💿"
    : /shirt/i.test(item.type || "")
      ? "👕"
      : "🛍";
  card.appendChild(icon);

  const body = el("div", "bm-body");
  const head = el("div", "bm-title-row");
  head.appendChild(el("h4", "bm-title", item.title));
  head.appendChild(el("span", "bm-type-badge", merchTypeLabel(item.type)));
  body.appendChild(head);

  if (creditIds && creditIds.length) {
    body.appendChild(creditLine(creditPrefix, creditIds, performersLookup));
  }
  const year = bookYearNumber(item.year);
  const metaBits = [merchLabelText(item), year ? String(year) : ""].filter(Boolean);
  if (metaBits.length) body.appendChild(el("div", "bm-meta", metaBits.join(" · ")));

  const dd = descriptionDropdown((item.description || "").trim(), "About this item");
  if (dd) body.appendChild(dd);

  const buy = buyLink(item.buy_url);
  if (buy) {
    const actions = el("div", "bm-actions");
    actions.appendChild(buy);
    body.appendChild(actions);
  }

  card.appendChild(body);
  return card;
}
