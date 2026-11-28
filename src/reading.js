// -------------------------------------------------------------------------
// Derived reading state — completion percentages, chapter ordinals, series /
// volume math and the display title. These read the in-memory state (progress
// map, books, series) but never mutate it. Completion is measured from the
// per-chapter progress map, so jumping back never un-reads a chapter and merely
// opening one never completes it.
// -------------------------------------------------------------------------
import { books, progressMap, ui, bookById, seriesById } from "./state.js";
import { chapterCount, chapterOrdinalFor, chapterDisplay, readableChapters, baseHref } from "./lib/chapters.js";
import { parseChapterLabel } from "./lib/text.js";

// The per-chapter progress entry for one chapter: { pct, cfi, done } or null.
export function chapterProgress(book, href) {
  const p = progressMap[book?.id];
  const h = baseHref(href);
  return p && p.chapters && h ? p.chapters[h] || null : null;
}

// Number of readable chapters completed in this book.
export function doneCount(book) {
  const p = progressMap[book?.id];
  if (!p || !p.chapters) return 0;
  let n = 0;
  for (const e of readableChapters(book.chapters || [])) if (p.chapters[baseHref(e.href)]?.done) n++;
  return n;
}
export function bookPercent(book) {
  const p = progressMap[book.id];
  if (!p) return 0;
  if (p.finished) return 100;
  const total = chapterCount(book);
  if (!total) return 0;
  return Math.min(100, Math.round((doneCount(book) / total) * 100));
}
export function bookIsStarted(book) {
  return !!progressMap[book.id];
}

// Words read so far, from the book's cached total word count (see
// lib/wordcount.js) scaled by its completion percentage — the same
// chapter-based fraction the rest of the app already shows, so this never
// disagrees with the % on screen.
export function wordsRead(book) {
  if (!book.wordCount) return 0;
  return Math.round(book.wordCount * (bookPercent(book) / 100));
}
export function seriesWordsRead(s) {
  return seriesVolumes(s).reduce((n, b) => n + wordsRead(b), 0);
}

export function seriesVolumes(s) {
  return (s.bookIds || []).map(bookById).filter(Boolean);
}
export function seriesPercent(s) {
  let num = 0,
    den = 0;
  for (const b of seriesVolumes(s)) {
    const c = chapterCount(b);
    num += (bookPercent(b) / 100) * c;
    den += c;
  }
  return den ? Math.round((num / den) * 100) : 0;
}
// A finished volume you've gone back into: your latest spot is on a chapter
// before its last one. Finished is sticky, so without this a re-read would be
// skipped as "done" and Continue would jump to some later volume. A spot left
// over from before "Mark as read" doesn't count (finishedAt, set there, is
// dropped by the next real save), nor does one on a notes page after the end.
export function isRereading(book) {
  const p = progressMap[book?.id];
  if (!p?.finished || !p.href) return false;
  if (p.finishedAt != null && p.finishedAt >= p.updatedAt) return false;
  const r = readableChapters(book.chapters || []);
  const i = r.findIndex((e) => baseHref(e.href) === baseHref(p.href));
  return i >= 0 && i < r.length - 1;
}
// A book Continue can point at: started and not finished, or being re-read.
function inProgress(book) {
  const p = progressMap[book.id];
  return !!p && (!p.finished || isRereading(book));
}

// The volume the reader is "on": the most recently read unfinished (or
// re-read) volume, else the first unfinished, else the first.
export function currentVolume(s) {
  const vols = seriesVolumes(s);
  let best = null,
    bestT = -1;
  for (const b of vols) {
    const p = progressMap[b.id];
    if (inProgress(b) && p.updatedAt > bestT) {
      bestT = p.updatedAt;
      best = b;
    }
  }
  if (best) return best;
  return vols.find((b) => bookPercent(b) < 100) || vols[0] || null;
}
export function volumeNumber(s, book) {
  if (book.volumeIndex) return book.volumeIndex;
  return seriesVolumes(s).indexOf(book) + 1;
}
export function nextVolume(book) {
  if (!book.seriesId) return null;
  const s = seriesById(book.seriesId);
  if (!s) return null;
  const vols = seriesVolumes(s);
  const i = vols.indexOf(book);
  return i >= 0 ? vols[i + 1] || null : null;
}
// Absolute chapter offset of a volume within its series (sum of earlier
// volumes' chapter counts), so "Ch. 351" in vol. 2 stays "Ch. 351".
export function volumeChapterOffset(book) {
  if (!book.seriesId) return 0;
  const s = seriesById(book.seriesId);
  if (!s) return 0;
  let offset = 0;
  for (const b of seriesVolumes(s)) {
    if (b.id === book.id) break;
    offset += chapterCount(b);
  }
  return offset;
}
// The absolute chapter number to DISPLAY for a saved position. Prefers the
// number the book states in the chapter's own TOC label, which is authoritative
// and self-correcting across volumes: a missing volume, a stray page, or a
// trailing notes page never shifts it. Falls back to the positional ordinal +
// volume offset for books whose labels carry no number.
export function absChapterNum(book, p) {
  const embedded = parseChapterLabel(p?.chapterLabel).num;
  return embedded != null ? embedded : chapterOrdinalFor(book, p) + volumeChapterOffset(book);
}
// First / last absolute chapter number of a volume, read from its own labels
// (embedded number preferred), for the reader header's "n of total".
export function volumeFirstAbs(book) {
  const r = readableChapters(book.chapters || []);
  return r.length ? chapterDisplay(r[0], 1 + volumeChapterOffset(book)).num : 1 + volumeChapterOffset(book);
}
export function volumeLastAbs(book) {
  const r = readableChapters(book.chapters || []);
  return r.length ? chapterDisplay(r[r.length - 1], r.length + volumeChapterOffset(book)).num : chapterCount(book) + volumeChapterOffset(book);
}
// -------------------------------------------------------------------------
// Furthest read. While you re-read (or peek back), "where you are" and "how
// far you got" differ; the furthest one gets a ⚑ link back to it. It is the
// last chapter, across the scope's volumes, holding a real reading position —
// chapters completed by "Mark as read" or by skipping past them have none, so
// they never count. Compared by chapter, not %: scrolling back inside one
// chapter isn't a re-read.
// -------------------------------------------------------------------------
// The volumes a book's furthest point is looked for in: its series, or itself.
export function scopeVolumes(book) {
  const s = book?.seriesId ? seriesById(book.seriesId) : null;
  return s ? seriesVolumes(s) : book ? [book] : [];
}
export function furthestSpot(vols) {
  for (let v = vols.length - 1; v >= 0; v--) {
    const b = vols[v];
    const p = progressMap[b.id];
    if (!p?.chapters) continue;
    const r = readableChapters(b.chapters || []);
    for (let i = r.length - 1; i >= 0; i--) {
      const st = p.chapters[baseHref(r[i].href)];
      if (st?.cfi) return { book: b, vi: v, i, href: r[i].href, entry: r[i], st, last: v === vols.length - 1 && i === r.length - 1 };
    }
  }
  return null;
}
// The furthest spot when your latest one (in `latest`, one of `vols`) is in an
// earlier chapter — else null. Nothing once the whole scope is read: the last
// chapter is the furthest and it is done, so there is nowhere further to go.
export function furthestLink(vols, latest) {
  const f = furthestSpot(vols);
  if (!f || (f.last && f.st.done)) return null;
  const p = progressMap[latest?.id];
  const v = vols.indexOf(latest);
  if (!p?.href || v < 0) return null;
  const i = readableChapters(latest.chapters || []).findIndex((e) => baseHref(e.href) === baseHref(p.href));
  if (i < 0 || v > f.vi || (v === f.vi && i >= f.i)) return null;
  return f;
}
// "Vol. 2 · ch. 200" (or "ch. 200" outside a series) for a furthest spot.
export function furthestLabel(f, { vol = true } = {}) {
  const num = chapterDisplay(f.entry, volumeChapterOffset(f.book) + f.i + 1).num;
  const s = f.book.seriesId ? seriesById(f.book.seriesId) : null;
  return (vol && s ? `vol. ${volumeNumber(s, f.book)} · ` : "") + `ch. ${num}`;
}

export function continueTarget() {
  let best = null,
    bestT = -1;
  for (const b of books) {
    const p = progressMap[b.id];
    if (inProgress(b) && p.updatedAt > bestT) {
      bestT = p.updatedAt;
      best = b;
    }
  }
  return best || (ui.lastReadBookId ? bookById(ui.lastReadBookId) : null);
}
// "Vol. 2 · Chapter 214 · The Sanctuary"
export function continueSubtitle(book) {
  const p = progressMap[book.id];
  const abs = absChapterNum(book, p);
  const parts = [];
  if (book.seriesId && book.volumeIndex) parts.push("Vol. " + book.volumeIndex);
  parts.push("Chapter " + abs);
  // Append only the clean title, not the raw label — otherwise the embedded
  // number repeats the "Chapter N" we just pushed ("Chapter 118 · Chapter 118:
  // The Title"). chapterDisplay strips the "Chapter N" prefix; a bare-title
  // chapter keeps its label, a numbered-but-titleless one adds nothing.
  const { title } = chapterDisplay({ label: p?.chapterLabel }, abs);
  if (title) parts.push(title);
  return parts.join(" · ");
}

// A typed override, if the user entered one (empty means "no override").
export function overrideOf(obj, field) {
  const v = obj?.overrides?.[field];
  return typeof v === "string" && v.trim() ? v.trim() : "";
}
// The title to show for a book everywhere (shelf, reader, drawer, volume rows):
// an Edit-details override wins over the .epub's own title.
export function displayTitle(book) {
  return (book && (overrideOf(book, "title") || book.title)) || "";
}
