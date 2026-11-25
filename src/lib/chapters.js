// -------------------------------------------------------------------------
// Chapter derivation — front-matter detection, the readable-chapter view,
// chapter counting/numbering and the per-chapter progress helpers that are pure
// over a book object (they never read app-global state). This is the trickiest,
// most regression-prone logic in the app, so it lives here and is unit-tested in
// test/chapters.test.js.
// -------------------------------------------------------------------------
import { parseChapterLabel } from "./text.js";

// A chapter is "read" once you reach its end. We can't count on the very last
// pixel scrolling into view (trailing whitespace, the injected end-of-chapter
// card), so anything at or past this fraction counts as complete.
export const CHAPTER_DONE_PCT = 92;
// Opening a chapter must not, by itself, register progress or completion — the
// reader has to actually move this far past where the chapter opened before it
// counts as started. Keeps a stray tap off the "reading"/done state and off the
// resume chip.
export const MIN_SCROLL_PCT = 5;

// Strip the fragment from an href so a spine section and its TOC anchor share a
// key. The per-chapter progress map is keyed by it.
export const baseHref = (href) => (href || "").split("#")[0];

// Web-novel epubs bundle non-chapter pages around the real chapters: leading
// front matter (the metadata/synopsis page we render as our own info page, an
// in-book contents page that duplicates our chapter drawer) and trailing back
// matter (an "author's notes" page many scrapers append after the last
// chapter — every Shadow Slave volume ends with one). We hide all of these from
// the reader flow, the chapter menu and the chapter counts/numbers. The label
// is matched *whole* (anchored), so a real chapter like "Chapter 5: Notes" is
// never caught — only a page whose entire label is boilerplate.
const FRONT_MATTER_RE =
  /^(informations?|table of contents|contents|toc|cover|title\s*page|copyright|colophon|notes?|author'?s?\s+notes?|translator'?s?\s+notes?|afterword|foreword|acknowledge?ments?|about the author)$/i;
// Public-domain epubs (e.g. Project Gutenberg) tack a licence / boilerplate
// page onto the spine and TOC; it is never a real chapter, so hide it too.
export const isFrontMatter = (label) => {
  const t = (label || "").trim();
  return FRONT_MATTER_RE.test(t) || /project gutenberg/i.test(t) || /\blicen[sc]e$/i.test(t);
};

// Never hide everything: if a whole TOC somehow matched, fall back to the
// original so the reader is never left empty.
export function readableChapters(entries) {
  const kept = (entries || []).filter((e) => !isFrontMatter(e.label));
  return kept.length ? kept : entries || [];
}

// Total boilerplate entries anywhere in the book (front or back matter).
export const frontMatterCount = (book) => (book?.chapters || []).filter((e) => isFrontMatter(e.label)).length;

// The boilerplate entries themselves (cover, contents, notes, afterword…), in
// spine order. Hidden from the reader flow and counts, but still real pages in
// the epub — the Chapters screen surfaces them in an "extras" group so every
// page stays reachable.
export const frontMatterEntries = (book) => (book?.chapters || []).filter((e) => isFrontMatter(e.label));

// Boilerplate entries that *lead* the TOC (sit before the first real chapter).
// This — not the total — is the offset for turning a spine index into a
// readable-TOC ordinal, so a trailing notes page never shifts the count.
export function leadingFrontMatterCount(book) {
  let n = 0;
  for (const e of book?.chapters || []) {
    if (isFrontMatter(e.label)) n++;
    else break;
  }
  return n;
}

// Count the readable chapters, not spine items: the spine can carry extra
// front matter (e.g. an untracked cover page) the TOC never lists, so the
// readable TOC is the honest basis for counts and numbering.
export function chapterCount(book) {
  return readableChapters(book.chapters || []).length || book.spineCount || 1;
}

// Which chapter (1-based, within its volume) a saved position sits on, counted
// over the readable TOC by label so leading front matter never inflates it.
export function chapterOrdinalFor(book, p) {
  if (!p) return 1;
  const readable = readableChapters(book.chapters || []);
  const i = readable.findIndex((e) => e.label && e.label === p.chapterLabel);
  if (i >= 0) return i + 1;
  return Math.max(1, (p.chapterIndex ?? 0) + 1 - leadingFrontMatterCount(book));
}

// Split a TOC entry into the number to show in its badge and the title beside
// it. Prefer the number the label itself states ("Chapter 96: Exile" -> 96 /
// "Exile") — that is authoritative and, once the "Chapter N" prefix is stripped,
// keeps a numbered row from reading "96 · Chapter 96: Exile". `posNum` is the
// positional fallback (this chapter's absolute position) for books whose labels
// carry no number, e.g. "Prologue" or "Ashen Barrens"; those keep their raw
// label as the title.
export function chapterDisplay(entry, posNum) {
  const parsed = parseChapterLabel(entry?.label);
  return {
    num: parsed.num ?? posNum,
    title: parsed.num != null ? parsed.title : (entry?.label || "").trim(),
  };
}

// Chapter skipping: mark every readable chapter before `href` complete, in place
// on a chapters map. Finishing a chapter implies the ones before it are read.
export function markEarlierDone(book, href, chapters) {
  const readable = readableChapters(book.chapters || []);
  const idx = readable.findIndex((e) => baseHref(e.href) === baseHref(href));
  for (let i = 0; i < idx; i++) {
    const k = baseHref(readable[i].href);
    if (!k || chapters[k]?.done) continue;
    chapters[k] = { pct: 100, cfi: chapters[k]?.cfi || null, done: true };
  }
}

// The entry `delta` documents away from `href` in an ordered entry list, or
// null past either end. The reader shows a whole spine document at a time, so
// stepping moves by document, not by entry: a document holding several entries
// (a Gutenberg file with the title, contents, preface and Book I's start) is
// one step — stepping to the next *entry* there just reopened the same page.
// The entry returned is the first one in its document. `href` outside the list
// steps from its start.
export function stepEntry(list, href, delta) {
  const first = new Map();
  for (const e of list || []) {
    const k = baseHref(e.href);
    if (!first.has(k)) first.set(k, e);
  }
  const docs = [...first.keys()];
  const i = docs.indexOf(baseHref(href));
  const k = docs[(i < 0 ? 0 : i) + delta];
  return k == null ? null : first.get(k);
}

// Flatten a nested epub.js TOC into a depth-tagged list.
export function flatten(items, depth = 0, out = []) {
  for (const item of items || []) {
    out.push({ label: (item.label || "").trim(), href: item.href, depth });
    if (item.subitems?.length) flatten(item.subitems, depth + 1, out);
  }
  return out;
}

// The five rows a chapter preview shows: an unopened book shows chapters 1–5; a
// book in progress shows two before the anchor chapter, the anchor, and two
// after (clamped to the ends). Five or fewer chapters show them all. `anchorAbs`
// is the row to centre on — the current (resume) chapter if there is one, else
// the last-read chapter, so a finished book previews where you left off instead
// of falling back to 1–5.
export function previewWindow(items, anchorAbs) {
  if (items.length <= 5) return items;
  let cur = anchorAbs != null ? items.findIndex((it) => it.absNum === anchorAbs) : -1;
  if (cur < 0) cur = items.findIndex((it) => it.state === "current");
  if (cur < 0) return items.slice(0, 5);
  const start = Math.max(0, Math.min(cur - 2, items.length - 5));
  return items.slice(start, start + 5);
}

// Absolute number of the row the Chapters screen should open scrolled to: the
// current (resume) chapter if there is one, else the last-read chapter (the
// resume ordinal in the current volume, even though it is now marked "read"),
// else null (an unopened book stays at the top).
export function scrollAnchorFor(items, curItem, curBookId, curLocal) {
  if (curItem) return curItem.absNum;
  if (curBookId && curLocal >= 0) {
    const anchor = items.find((it) => it.bookId === curBookId && it.localIndex === curLocal);
    if (anchor) return anchor.absNum;
  }
  return null;
}

// -------------------------------------------------------------------------
// Spine gaps — pages the TOC never lists. The reader moves chapter by chapter
// through the TOC, so a spine document no TOC entry points at can't be
// reached: no row in the chapter list, and Next skips straight over it. That's
// the norm in converted books (a calibre conversion splits a long chapter
// into several files but lists only the first; a PDF conversion often ships a
// one-entry TOC over the whole book), and it silently drops the rest. So every
// unlisted spine document after the first listed one becomes an entry of its
// own, slotted in spine order. Documents *before* the first listed one stay
// out: that's the cover/title page our info page already stands in for. A book
// with no TOC at all gets every spine document.
// -------------------------------------------------------------------------

// Indexes of the spine items the TOC misses (non-linear items excluded).
// `spine` is [{ href, linear }], linear false meaning `linear="no"`.
export function spineGaps(toc, spine) {
  const listed = new Set((toc || []).map((e) => baseHref(e.href)).filter(Boolean));
  const keys = (spine || []).map((s) => baseHref(s.href));
  const first = listed.size ? keys.findIndex((k) => listed.has(k)) : 0;
  if (first < 0) return [];
  const gaps = [];
  for (let i = first + 1; i < keys.length; i++) {
    if (keys[i] && !listed.has(keys[i]) && spine[i].linear !== false) gaps.push(i);
  }
  if (!listed.size && spine.length && spine[0].linear !== false) gaps.unshift(0);
  return gaps;
}

// The TOC with an entry added for each spine gap. `spine` is [{ href, linear,
// title }], `title` being the gap document's own heading (see sectionTitle);
// a gap with none — typically a chapter's spill-over file, which opens
// mid-paragraph — is named after the entry it continues. Each one lands right
// after the last entry that sits earlier in the spine, at that entry's depth,
// and is tagged `spine: true`. A TOC with no gaps is returned as is.
export function fillSpineGaps(toc, spine) {
  const gaps = spineGaps(toc, spine);
  const out = (toc || []).slice();
  if (!gaps.length) return out;
  const pos = new Map((spine || []).map((s, i) => [baseHref(s.href), i]));
  const spineIdx = (e) => (pos.has(baseHref(e.href)) ? pos.get(baseHref(e.href)) : -1);
  for (const i of gaps) {
    let at = -1;
    for (let j = 0; j < out.length; j++) {
      const k = spineIdx(out[j]);
      if (k >= 0 && k < i) at = j;
    }
    const prev = at >= 0 ? out[at] : null;
    const title = (spine[i].title || "").trim();
    const label =
      title ||
      (prev?.label ? `${prev.label.replace(/\s*\(continued\)$/, "")} (continued)` : `Section ${i + 1}`);
    out.splice(at + 1, 0, { label, href: spine[i].href, depth: prev?.depth || 0, spine: true });
  }
  return out;
}

// A gap document's name, from the text of its first block (heading or
// paragraph) — or "" when that doesn't read as a title (too long: a
// paragraph carried over from the previous file). PDF conversions letter-space
// display type ("S T AG E   3   ·   B U I L D", words split by runs of spaces;
// "C LO S I N G"), which is closed back up; an all-caps result is set in title case.
export function sectionTitle(raw) {
  let s = (raw || "").replace(/[\u00a0\t\r\n]/g, " ");
  const tokens = s.trim().split(/ +/).filter(Boolean);
  const letters = tokens.filter((t) => t.length === 1).length;
  if (tokens.length >= 4 && letters / tokens.length >= 0.6) {
    // Words are split by the wider gaps; a single spaced-out word has none.
    const words = / {2,}/.test(s.trim()) ? s.trim().split(/ {2,}/) : [s];
    s = words.map((w) => w.replace(/ /g, "")).join(" ");
  }
  s = s.replace(/\s+/g, " ").trim();
  if (!s || s.length > 80) return "";
  if (/[A-Z]/.test(s) && s === s.toUpperCase()) {
    s = s.toLowerCase().replace(/(^|[\s·:—–-])(\p{L})/gu, (_, a, c) => a + c.toUpperCase());
  }
  return s;
}
