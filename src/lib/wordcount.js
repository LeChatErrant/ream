// -------------------------------------------------------------------------
// Word count for a book — the whole book, plus each chapter's share. The total
// feeds the info page's recap comparison and the stats' "time left"; the
// per-chapter counts let reading stats credit the words you actually scrolled
// through. Not computed at import time — it means opening the epub and walking
// its whole spine, which is wasted work for a book that's never opened.
// Computed once, lazily (info page, stats, or opening the book in the reader),
// then cached on the book record so it's never redone.
// -------------------------------------------------------------------------
import { openEpub } from "../epub.js";
import { stripHtml } from "./format.js";
import { baseHref } from "./chapters.js";
import { dbPut } from "../db.js";

// Bump this whenever extractWordCount's logic changes, so a book whose count
// was cached under an older (possibly wrong) version gets recomputed instead
// of keeping a stale number forever. v1 shipped with a bug (raw spine .href
// instead of the resolved .url) that made most books count next to nothing.
// v3 adds the per-chapter counts (`chapterWords`).
const WORD_COUNT_VERSION = 3;

function countWords(text) {
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
}

// Total words across every spine item (front/back matter included — it's a
// negligible sliver of a whole novel, and we're comparing whole books), and
// each spine item's own count keyed by its base href — the same key the
// per-chapter progress map uses (epub.js reports a location's href as the
// spine item's href).
//
// Spine items carry both `.href` (the raw path from the manifest, relative to
// the package document) and `.url` (that path resolved to the absolute,
// archive-ready form — what epub.js's own Section.load() actually requests
// when rendering a chapter). archive.getText() expects the resolved form: it
// blindly strips a leading "/" assuming one is already there. Pass `.href`
// instead and it silently mangles the path, `zip.file()` finds nothing, and
// getText() returns undefined rather than throwing — so every chapter must
// use `.url`, or the count silently collapses to next to nothing.
async function extractWordCount(book) {
  const chapters = {};
  if (!book.fileBlob) return { total: 0, chapters };
  // A PDF counts the text on its pages, per run of pages (src/pdf.js).
  if (book.format === "pdf") return (await import("../pdf.js")).pdfWordCounts(book);
  const buffer = await book.fileBlob.arrayBuffer();
  const b = await openEpub(buffer);
  try {
    const items = b.spine?.spineItems || [];
    let total = 0;
    for (const item of items) {
      try {
        const html = await b.archive.getText(item.url || item.href);
        const n = html ? countWords(stripHtml(html)) : 0;
        total += n;
        const key = baseHref(item.href);
        if (key) chapters[key] = (chapters[key] || 0) + n;
      } catch {
        /* unreadable spine item — skip it */
      }
    }
    return { total, chapters };
  } finally {
    try {
      b.destroy();
    } catch {
      /* ignore */
    }
  }
}

// True once a book's word count is cached under the current logic version —
// false for a book that's never been counted, or was counted under an older,
// since-fixed version and needs redoing.
export function hasCurrentWordCount(book) {
  return book.wordCount != null && book.wordCountVersion === WORD_COUNT_VERSION;
}

// One count per book at a time: the info page, the stats screen and the reader
// can all ask for the same book at once.
const inFlight = new Map();

// Resolves the book's word count, (re)computing and persisting it if it's
// missing or was cached under an older, since-fixed version of the logic.
export function ensureWordCount(book) {
  if (hasCurrentWordCount(book)) return Promise.resolve(book.wordCount);
  if (inFlight.has(book.id)) return inFlight.get(book.id);
  const run = (async () => {
    const { total, chapters } = await extractWordCount(book);
    book.wordCount = total;
    book.chapterWords = chapters;
    book.wordCountVersion = WORD_COUNT_VERSION;
    await dbPut("books", book);
    return book.wordCount;
  })().finally(() => inFlight.delete(book.id));
  inFlight.set(book.id, run);
  return run;
}
