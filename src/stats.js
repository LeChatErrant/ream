// =========================================================================
// Reading stats — the tracker and the data behind the stats screens.
//
// While the reader is open, every scroll / tap is "activity". Time between two
// activities counts as reading when the gap is short (IDLE_GAP); a longer gap
// means the phone was put down, so it counts nothing and the next activity
// starts a new session — unless it's the same book within IDLE_GAP of leaving
// (a lock, a glance at a notification): that resumes the session. Words are
// credited as a chapter's progress rises (its share of the chapter's own word
// count), once per chapter, so a jump never counts and neither does "Mark as
// read". Days turn at 4 AM (lib/stats.js readingDay). Everything lands in one
// row per book per reading day in the `stats` store: { id: "day|bookId", day,
// bookId, ms, paceMs (time spent on chapters not yet finished — what the pace
// is measured on, so re-reading doesn't slow it), words, chapters, sessions,
// best (longest session, ms), hours[24] }.
//
// The past: tracking began on Nov 25, 2026, after three months of reading in
// Ream. A baseline snapshot taken then (how much of each book was read) is
// turned ONCE into ordinary rows from Aug 24 on (lib/backfill.js, flagged
// `bf: 1`), after which there is just one kind of data.
// =========================================================================
import { dbGetAll, dbPutMany, dbDeleteMany, kvGet, kvSet } from "./db.js";
import { books, progressMap, bookById, seriesById } from "./state.js";
import { readableChapters, baseHref } from "./lib/chapters.js";
import { readingDay, dayKey, addDays } from "./lib/stats.js";
import { generateBackfill, DEFAULT_HOURS } from "./lib/backfill.js";
import { ensureWordCount, hasCurrentWordCount } from "./lib/wordcount.js";

const IDLE_GAP = 3 * 60 * 1000; // longer than any screen takes to read
const TAIL_CREDIT = 60 * 1000; // the last screen before leaving, at most
const SESSION_MIN = 60 * 1000; // a session counts once it lasts a minute
const SAVE_DELAY = 20 * 1000;
const DEFAULT_WPM = 250; // until your own pace is measured
const MIN_PACE_MS = 20 * 60 * 1000; // tracked time needed to trust a pace
// Ream's first build (Aug 24, 2026): reading in it can't be older.
const READING_SINCE = new Date(2026, 7, 24).getTime();

const rows = new Map(); // id → row
let baseline = null; // { at, books: { [bookId]: { frac, chapters, lastAt, addedAt } } }
const dirty = new Set();
let saveTimer = 0;
let live = null; // the session being timed: { bookId, last, ms, counted }
let paused = null; // the session just left, resumable for IDLE_GAP
let fresh = true; // the chapter on screen isn't finished yet (see setChapterFresh)

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

// ---- One-time backfill -------------------------------------------------------

const BACKFILL_KEY = "statsBackfill";
// v2: realistic days (lib/backfill.js) — replaces v1's rows, which were
// tagged bf: 1 like these.
const BACKFILL_VERSION = 2;

/**
 * Write the reading done before tracking as ordinary rows, once. Needs each
 * baselined book's word count, so it counts what's missing first (one epub at
 * a time). Resolves true when rows were written — the caller re-renders.
 */
export async function runBackfill() {
  const done = await kvGet(BACKFILL_KEY);
  if (!baseline || (done && done.v >= BACKFILL_VERSION)) return false;
  // An earlier version's rows go first (only ever generated ones).
  const old = [...rows.values()].filter((r) => r.bf).map((r) => r.id);
  if (old.length) {
    await dbDeleteMany("stats", old);
    for (const id of old) rows.delete(id);
  }
  const entries = baseline.books;
  // Reading order: a series' volumes in order, series and loose books in the
  // order they were last read.
  const groups = [];
  const placed = new Set();
  const seen = new Set();
  for (const b of books) {
    if (!b.seriesId || seen.has(b.seriesId)) continue;
    seen.add(b.seriesId);
    const vols = (seriesById(b.seriesId)?.bookIds || []).map(bookById).filter((v) => v && entries[v.id]);
    vols.forEach((v) => placed.add(v.id));
    if (vols.length) groups.push(vols);
  }
  for (const b of books) if (!placed.has(b.id) && entries[b.id]) groups.push([b]);
  if (!groups.length) {
    await kvSet(BACKFILL_KEY, { v: BACKFILL_VERSION, at: Date.now(), rows: 0 });
    return old.length > 0;
  }
  for (const g of groups) for (const b of g) if (!hasCurrentWordCount(b)) await ensureWordCount(b).catch(() => {});
  const firstRead = (g) => Math.min(...g.map((b) => entries[b.id].lastAt));
  groups.sort((a, b) => firstRead(a) - firstRead(b));
  const items = groups.flat().map((b) => ({ bookId: b.id, words: entries[b.id].frac * (b.wordCount || 0), chapters: entries[b.id].chapters }));

  // Your measured pace and reading hours, where tracking already knows them.
  const pace = trackedPace() || DEFAULT_WPM / 60000;
  const hours = new Array(24).fill(0);
  for (const r of rows.values()) if (!r.bf && r.hours) r.hours.forEach((ms, i) => (hours[i] += ms));
  const tracked = hours.reduce((a, b) => a + b, 0);
  const hourWeights = tracked >= 30 * 60000 ? hours.map((ms, i) => ms / tracked + DEFAULT_HOURS[i] / 40) : DEFAULT_HOURS;

  const fromDay = dayKey(READING_SINCE);
  const toDay = addDays(readingDay(baseline.at), -1);
  const made = generateBackfill({ items, fromDay, toDay, pace, hourWeights, seed: Math.floor(baseline.at / 1000) });
  const out = [];
  for (const r of made) {
    const had = rows.get(r.id);
    const row = had
      ? { ...had, ms: had.ms + r.ms, paceMs: (had.paceMs ?? had.ms) + r.paceMs, words: had.words + r.words, chapters: had.chapters + r.chapters, sessions: had.sessions + r.sessions, best: Math.max(had.best || 0, r.best), hours: had.hours.map((x, i) => x + r.hours[i]) }
      : r;
    rows.set(row.id, row);
    out.push(row);
  }
  await dbPutMany("stats", out);
  await kvSet(BACKFILL_KEY, { v: BACKFILL_VERSION, at: Date.now(), rows: out.length, fromDay, toDay, wpm: Math.round(pace * 60000) });
  return out.length > 0 || old.length > 0;
}

// ---- Tracking --------------------------------------------------------------

function rowFor(bookId, day) {
  const id = day + "|" + bookId;
  let r = rows.get(id);
  if (!r) {
    r = { id, day, bookId, ms: 0, paceMs: 0, words: 0, chapters: 0, sessions: 0, best: 0, hours: new Array(24).fill(0) };
    rows.set(id, r);
  }
  dirty.add(id);
  if (!saveTimer) saveTimer = setTimeout(flushStats, SAVE_DELAY);
  return r;
}

function creditTime(ms, now) {
  if (ms <= 0 || !live) return;
  const r = rowFor(live.bookId, readingDay(now));
  r.ms += ms;
  if (fresh) r.paceMs = (r.paceMs ?? 0) + ms;
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
    // Back on the same book within a few minutes (a lock, a notification):
    // the same sitting — the time away isn't counted, the session goes on.
    live = paused && paused.bookId === bookId && now - paused.last <= IDLE_GAP ? paused : { bookId, ms: 0, counted: false };
    paused = null;
  }
  live.last = now;
}

/** Leaving the reader (or the app): credit the last screen, pause the session. */
export function endSession(save = true) {
  if (live) {
    const now = Date.now();
    const gap = now - live.last;
    if (gap <= IDLE_GAP) creditTime(Math.min(gap, TAIL_CREDIT), now);
    live.last = now;
    paused = live;
    live = null;
  }
  if (save) flushStats();
}

/** Whether the chapter on screen is still unfinished — only that time measures pace. */
export function setChapterFresh(v) {
  fresh = !!v;
}

/**
 * A chapter's progress rose from `fromPct` to `toPct` (and maybe just became
 * done) by reading: credit its share of the chapter's words. The caller passes
 * 100 as `fromPct` for a chapter already done, so its end is credited once.
 */
export function creditProgress(book, href, fromPct, toPct, becameDone) {
  if (!book || !href) return;
  const from = Math.min(1, (fromPct || 0) / 100);
  const to = becameDone ? 1 : Math.min(1, (toPct || 0) / 100);
  if (to <= from && !becameDone) return;
  const r = rowFor(book.id, readingDay(Date.now()));
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
  const out = [];
  for (const id of dirty) {
    const r = rows.get(id);
    if (r) out.push(r);
  }
  dirty.clear();
  if (out.length) dbPutMany("stats", out).catch(() => {});
}

// ---- Queries ---------------------------------------------------------------

/**
 * Words per ms from tracked reading (all books, or the given ones), or null.
 * Measured on time spent in unfinished chapters; backfilled rows don't count
 * (their time was made from a pace in the first place).
 */
export function trackedPace(bookIds = null) {
  let w = 0;
  let ms = 0;
  for (const r of rows.values()) {
    if (r.bf || (bookIds && !bookIds.has(r.bookId))) continue;
    const t = r.paceMs ?? r.ms;
    if (r.words > 0 && t > 0) {
      w += r.words;
      ms += t;
    }
  }
  return ms >= MIN_PACE_MS ? w / ms : null;
}

/** Every row for the given book ids (null: all). */
export function statRows(bookIds = null) {
  const out = [];
  for (const r of rows.values()) if (!bookIds || bookIds.has(r.bookId)) out.push(r);
  return out;
}

/** Books whose "time left" still waits on a word count. */
export function needsCounting(list) {
  return list.filter((b) => !hasCurrentWordCount(b));
}

export const hasAnyStats = () => rows.size > 0;

/** Words still to read in a book, from its current progress. */
export function wordsLeft(book) {
  if (!book.wordCount) return 0;
  return Math.max(0, book.wordCount * (1 - readFraction(book).frac));
}
/** Pace to project with: the books' own tracked pace, else yours, else a default. */
export function paceFor(bookIds) {
  return trackedPace(bookIds) || trackedPace() || DEFAULT_WPM / 60000;
}
