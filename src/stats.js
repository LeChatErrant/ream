// =========================================================================
// Reading stats — the tracker and the data behind the stats screens.
//
// Tracked: while the reader is open, every scroll / tap is "activity". Time
// between two activities counts as reading when the gap is short (IDLE_GAP);
// a longer gap means the phone was put down, so it counts nothing and the
// next activity starts a new session. Words are credited as a chapter's
// progress rises (its share of the chapter's own word count), so a jump never
// counts and neither does "Mark as read". Everything lands in one row per book
// per local day in the `stats` store: { id: "day|bookId", day, bookId, ms,
// words, chapters, sessions, best (longest session, ms), hours[24] }.
//
// Estimated: reading done before tracking existed. On the first run a
// baseline snapshots each started book (how much of it was read). At query
// time all of it is laid out as one steady stream from READING_SINCE to when
// tracking began — series volumes in order, each taking time in proportion to
// its words — and turned into time with your measured pace. Per-book dates
// can't place it better: this library was re-imported in October, so import
// dates and "last read" stamps say when files arrived, not when they were
// read. Nothing estimated is stored, so the estimate sharpens on its own as
// word counts and pace come in.
// =========================================================================
import { dbGetAll, dbPut, kvGet, kvSet } from "./db.js";
import { books, progressMap, bookById, seriesById } from "./state.js";
import { readableChapters, baseHref } from "./lib/chapters.js";
import { dayKey, spreadEstimate, streamSpans } from "./lib/stats.js";
import { hasCurrentWordCount } from "./lib/wordcount.js";

const IDLE_GAP = 3 * 60 * 1000; // longer than any screen takes to read
const TAIL_CREDIT = 60 * 1000; // the last screen before leaving, at most
const SESSION_MIN = 60 * 1000; // a session counts once it lasts a minute
const SAVE_DELAY = 20 * 1000;
const DEFAULT_WPM = 250; // until your own pace is measured
const MIN_PACE_MS = 20 * 60 * 1000; // tracked time needed to trust a pace
// Ream's first build (Aug 24, 2026): reading in it can't be older, and this
// library has been read since then.
const READING_SINCE = new Date(2026, 7, 24).getTime();

const rows = new Map(); // id → tracked row
let baseline = null; // { at, books: { [bookId]: { frac, chapters, lastAt, addedAt } } }
const dirty = new Set();
let saveTimer = 0;
let live = null; // the session being timed: { bookId, last, ms, counted }

export async function loadStats() {
  const [stored, base] = await Promise.all([dbGetAll("stats"), kvGet("statsBaseline")]);
  for (const r of stored || []) rows.set(r.id, r);
  baseline = base || null;
  if (!baseline) {
    baseline = snapshotBaseline();
    await kvSet("statsBaseline", baseline);
  }
}

// Fraction of a book read and chapters completed, from the per-chapter map
// (a finished book is whole). Chapter-weighted; the words follow from it.
export function readFraction(book) {
  const p = progressMap[book.id];
  const readable = readableChapters(book.chapters || []);
  if (!p || !readable.length) return { frac: 0, chapters: 0 };
  if (p.finished) return { frac: 1, chapters: readable.length };
  let sum = 0;
  let done = 0;
  for (const e of readable) {
    const c = p.chapters?.[baseHref(e.href)];
    if (!c) continue;
    if (c.done) {
      sum += 1;
      done++;
    } else sum += (c.pct || 0) / 100;
  }
  return { frac: sum / readable.length, chapters: done };
}

function snapshotBaseline() {
  const out = { at: Date.now(), books: {} };
  for (const b of books) {
    const p = progressMap[b.id];
    if (!p) continue;
    const { frac, chapters } = readFraction(b);
    if (frac <= 0) continue;
    out.books[b.id] = { frac, chapters, lastAt: p.updatedAt || out.at, addedAt: b.addedAt || p.updatedAt || out.at };
  }
  return out;
}
export const trackingSince = () => dayKey(baseline?.at || Date.now());

// ---- Tracking --------------------------------------------------------------

function rowFor(bookId, day) {
  const id = day + "|" + bookId;
  let r = rows.get(id);
  if (!r) {
    r = { id, day, bookId, ms: 0, words: 0, chapters: 0, sessions: 0, hours: new Array(24).fill(0) };
    rows.set(id, r);
  }
  dirty.add(id);
  if (!saveTimer) saveTimer = setTimeout(flushStats, SAVE_DELAY);
  return r;
}

function creditTime(ms, now) {
  if (ms <= 0 || !live) return;
  const r = rowFor(live.bookId, dayKey(now));
  r.ms += ms;
  r.hours[new Date(now).getHours()] += ms;
  live.ms += ms;
  if (live.ms > (r.best || 0)) r.best = live.ms; // longest session that day
  if (!live.counted && live.ms >= SESSION_MIN) {
    live.counted = true;
    r.sessions++;
  }
}

/** A scroll or tap in the reader: time since the last one was reading. */
export function noteActivity(bookId) {
  if (!bookId || document.hidden) return;
  const now = Date.now();
  if (live && live.bookId === bookId && now - live.last <= IDLE_GAP) creditTime(now - live.last, now);
  else {
    endSession(false);
    live = { bookId, last: now, ms: 0, counted: false };
  }
  live.last = now;
}

/** Leaving the reader (or the app): credit the last screen, close the session. */
export function endSession(save = true) {
  if (live) {
    const now = Date.now();
    const gap = now - live.last;
    if (gap <= IDLE_GAP) creditTime(Math.min(gap, TAIL_CREDIT), now);
    live = null;
  }
  if (save) flushStats();
}

/**
 * A chapter's progress rose from `fromPct` to `toPct` (and maybe just became
 * done) by reading: credit its share of the chapter's words.
 */
export function creditProgress(book, href, fromPct, toPct, becameDone) {
  if (!book || !href) return;
  const from = Math.min(1, (fromPct || 0) / 100);
  const to = becameDone ? 1 : Math.min(1, (toPct || 0) / 100);
  if (to <= from && !becameDone) return;
  const r = rowFor(book.id, dayKey(Date.now()));
  r.words += Math.max(0, to - from) * chapterWordsFor(book, href);
  if (becameDone) r.chapters++;
}
function chapterWordsFor(book, href) {
  const exact = book.chapterWords?.[baseHref(href)];
  if (exact != null) return exact;
  const n = readableChapters(book.chapters || []).length;
  return book.wordCount && n ? book.wordCount / n : 0;
}

export function flushStats() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  for (const id of dirty) {
    const r = rows.get(id);
    if (r) dbPut("stats", r).catch(() => {});
  }
  dirty.clear();
}

// ---- Queries ---------------------------------------------------------------

/** Words per ms from tracked reading (all books, or the given ones), or null. */
export function trackedPace(bookIds = null) {
  let w = 0;
  let ms = 0;
  for (const r of rows.values()) {
    if (bookIds && !bookIds.has(r.bookId)) continue;
    if (r.words > 0 && r.ms > 0) {
      w += r.words;
      ms += r.ms;
    }
  }
  return ms >= MIN_PACE_MS ? w / ms : null;
}
const estimatePace = () => trackedPace() || DEFAULT_WPM / 60000;

// Where each baselined book's estimated reading sits in time: everything read
// before tracking, end to end from READING_SINCE to the baseline — a series'
// volumes in order, series and books in the order they were last read.
function estimateSpans() {
  const spans = {};
  if (!baseline) return spans;
  const entries = baseline.books;
  const groups = []; // [[{ id, words, chapters, lastAt }]] in reading order
  const placed = new Set();
  const item = (b) => {
    const e = entries[b.id];
    placed.add(b.id);
    return e && b.wordCount ? { id: b.id, words: e.frac * b.wordCount, chapters: e.chapters, lastAt: e.lastAt } : null;
  };
  const seen = new Set();
  for (const b of books) {
    if (!b.seriesId || seen.has(b.seriesId)) continue;
    seen.add(b.seriesId);
    const vols = (seriesById(b.seriesId)?.bookIds || []).map(bookById).filter(Boolean);
    const g = vols.map(item).filter(Boolean);
    if (g.length) groups.push(g);
  }
  for (const b of books) {
    if (placed.has(b.id)) continue;
    const it = item(b);
    if (it) groups.push([it]);
  }
  groups.sort((a, b) => Math.min(...a.map((x) => x.lastAt)) - Math.min(...b.map((x) => x.lastAt)));
  const starts = Object.values(entries).map((e) => e.addedAt || Infinity);
  const from = Math.min(READING_SINCE, ...starts);
  for (const sp of streamSpans(groups.flat(), from, baseline.at)) spans[sp.id] = sp;
  return spans;
}

/**
 * Every row — tracked and estimated — for the given book ids (null: all).
 * Estimated rows carry `est: true`; their time is words ÷ your pace. Books whose
 * word count isn't known yet contribute no estimate (see missingCounts).
 */
export function statRows(bookIds = null) {
  const out = [];
  for (const r of rows.values()) if (!bookIds || bookIds.has(r.bookId)) out.push(r);
  if (!baseline) return out;
  const pace = estimatePace();
  const since = trackingSince();
  const spans = estimateSpans();
  for (const [id, sp] of Object.entries(spans)) {
    if (bookIds && !bookIds.has(id)) continue;
    const parts = spreadEstimate({ words: sp.words, chapters: sp.chapters, startTs: sp.start, endTs: sp.end, beforeDay: since });
    for (const p of parts) out.push({ est: true, day: p.day, bookId: id, words: p.words, chapters: p.chapters, ms: p.words / pace, sessions: 0 });
  }
  return out;
}

/** Books whose estimate or "time left" still waits on a word count. */
export function needsCounting(list) {
  return list.filter((b) => !hasCurrentWordCount(b));
}

export const hasAnyStats = () => rows.size > 0 || Object.keys(baseline?.books || {}).length > 0;

/** Words still to read in a book, from its current progress. */
export function wordsLeft(book) {
  if (!book.wordCount) return 0;
  return Math.max(0, book.wordCount * (1 - readFraction(book).frac));
}
/** Pace to project with: the books' own tracked pace, else yours, else a default. */
export function paceFor(bookIds) {
  return trackedPace(bookIds) || estimatePace();
}
export const isPaceMeasured = (bookIds) => !!(trackedPace(bookIds) || trackedPace());
