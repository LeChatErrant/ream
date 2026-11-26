// =========================================================================
// STATS screen — reading stats for one book or series (pushed from its info
// page) or for the whole library (pushed from the Library's "This week" strip).
// Also builds those two ways in: the info page's "Reading stats" card and the
// Library strip. The data comes from stats.js: one row per book per reading
// day (days turn at 4 AM).
// =========================================================================
import { el, h, svg, ICON, coverNode, progressBar } from "./dom.js";
import { books, progressMap, bookById, seriesById } from "./state.js";
import { chapterCount, readableChapters, baseHref, chapterDisplay, chapterOrdinalFor } from "./lib/chapters.js";
import { formatCompactNumber } from "./lib/format.js";
import { ensureWordCount, hasCurrentWordCount } from "./lib/wordcount.js";
import {
  readingDay, dayKey, addDays, daysBetween, weekStart, dayDate, currentStreak, longestStreak,
  formatDuration, formatHoursShort, formatDay, monthShort, MONTHS_LONG, wordsThrough, roundMilestones, dayReaching,
} from "./lib/stats.js";
import { statRows, needsCounting, paceFor, trackedPace, hasAnyStats, flushStats } from "./stats.js";
import {
  displayTitle, bookPercent, seriesVolumes, seriesPercent, currentVolume, absChapterNum, volumeNumber,
  wordsRead, bookIsStarted, volumeChapterOffset,
} from "./reading.js";
import { go } from "./router.js";

const MIN_DAY_MS = 60 * 1000; // a day counts as "read" from a minute on
const RECENT_DAYS = 14; // "lately": what finish dates and chapters a day use
let period = "week"; // the overall screen's Week / Month / Year / All
let offset = 0; // which one: 0 the current, −1 the one before, …
let renderToken = 0;
let shown = null; // { kind, id } on screen, for refreshStats
const countFailed = new Set(); // books whose word count can't be had (don't retry forever)

const STATS_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M5 20v-8M12 20V5M19 20v-5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>';

const today = () => readingDay(Date.now());

// ---- Scope & aggregation ----------------------------------------------------

function scopeOf(kind, id) {
  if (kind === "series") {
    const s = seriesById(id);
    if (!s) return null;
    const vols = seriesVolumes(s);
    return { kind, id, series: s, books: vols, title: s.name, coverBook: currentVolume(s) || vols[0] };
  }
  if (kind === "book") {
    const b = bookById(id);
    return b ? { kind, id, books: [b], title: displayTitle(b), coverBook: b } : null;
  }
  return { kind: "all", books: books.slice(), title: "Reading" };
}
const idsOf = (scope) => new Set(scope.books.map((b) => b.id));

// Per-day totals: { ms, words, chapters, sessions }.
function byDay(rows) {
  const m = new Map();
  for (const r of rows) {
    let d = m.get(r.day);
    if (!d) m.set(r.day, (d = { ms: 0, words: 0, chapters: 0, sessions: 0 }));
    d.ms += r.ms;
    d.words += r.words;
    d.chapters += r.chapters;
    d.sessions += r.sessions || 0;
  }
  return m;
}
function sumRange(days, from, to) {
  const out = { ms: 0, words: 0, chapters: 0 };
  for (const [k, d] of days) {
    if (k < from || k > to) continue;
    out.ms += d.ms;
    out.words += d.words;
    out.chapters += d.chapters;
  }
  return out;
}
// Totals, plus the averages over READING days (a minute or more) — "a day"
// everywhere in these screens means a day you read.
function totals(days) {
  const t = { ms: 0, chapters: 0, sessions: 0, readDays: 0, dayMs: 0, dayChapters: 0, first: null, last: null };
  let rdMs = 0;
  let rdCh = 0;
  for (const [k, d] of days) {
    t.ms += d.ms;
    t.chapters += d.chapters;
    t.sessions += d.sessions;
    if (d.ms >= MIN_DAY_MS) {
      t.readDays++;
      rdMs += d.ms;
      rdCh += d.chapters;
    }
    if (d.ms > 0 && (!t.first || k < t.first)) t.first = k;
    if (d.ms > 0 && (!t.last || k > t.last)) t.last = k;
  }
  if (t.readDays) {
    t.dayMs = rdMs / t.readDays;
    t.dayChapters = rdCh / t.readDays;
  }
  return t;
}
const readDaySet = (days) => new Set([...days].filter(([, d]) => d.ms >= MIN_DAY_MS).map(([k]) => k));
const firstDayOf = (days) => [...days].filter(([, d]) => d.ms > 0).map(([k]) => k).sort()[0] || null;

// Average reading time per calendar day lately — what a finish date projects with.
function recentRate(days, day, first) {
  if (!first) return 0;
  const span = Math.min(RECENT_DAYS, daysBetween(first, day) + 1);
  return sumRange(days, addDays(day, -(span - 1)), day).ms / span;
}

// ---- Shared pieces ------------------------------------------------------------

const label = (text, extra) =>
  h("div", { class: "st-head" }, h("span", { class: "lib-label" }, text), extra ? h("span", { class: "st-head__aside" }, extra) : null);
const row = (k, v) => h("div", { class: "info-trow" }, h("span", { class: "info-trow__k" }, k), h("span", { class: "info-trow__v" }, v));
const tile = (k, v, sub) =>
  h("div", { class: "st-tile" }, h("div", { class: "st-tile__k" }, k), h("div", { class: "st-tile__v" }, v), sub ? h("div", { class: "st-tile__sub" }, sub) : null);
const wpm = (pace) => Math.round(pace * 60000);
const plural = (n, w) => `${n.toLocaleString("en-US")} ${w}${n === 1 ? "" : "s"}`;
const fmtN = (n) => n.toLocaleString("en-US");
// "2.5", "12" — one decimal while it still says something.
const perDayNum = (x) => (x < 10 ? String(Math.round(x * 10) / 10) : String(Math.round(x)));
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dayName = (k, day) => `${DOW[dayDate(k).getDay()]}, ${formatDay(k, day)}`;
// Calendar shade for a day's reading time.
const level = (ms) => (ms < MIN_DAY_MS ? 0 : ms < 30 * 60000 ? 1 : ms < 90 * 60000 ? 2 : ms < 180 * 60000 ? 3 : 4);
// One day, in words: "1 h 20 · 9 chapters".
function dayLine(d) {
  if (!d || d.ms < MIN_DAY_MS) return "nothing read";
  const ch = Math.round(d.chapters);
  return formatDuration(d.ms) + (ch ? ` · ${plural(ch, "chapter")}` : "");
}

// Bars of reading time. buckets: [{ label, name, ms, current, future }].
// With `onPick`, each past bar is a button: tapping one calls onPick(index),
// tapping it again calls onPick(null). Future bars are inert dotted stubs.
function barChart(buckets, { height = 110, values = false, aria = "", onPick = null } = {}) {
  const max = Math.max(1, ...buckets.map((b) => b.ms));
  const room = values ? height - 16 : height;
  const bars = h("div", { class: "st-bars", style: `height:${height}px`, role: onPick ? "group" : "img", "aria-label": aria });
  const labels = h("div", { class: "st-bars__labels" });
  const chart = h("div", { class: "st-chart" + (onPick ? " is-pickable" : "") }, bars, labels);
  const cols = [];
  let picked = null;
  buckets.forEach((b, i) => {
    const px = b.ms > 0 ? Math.max(2, Math.round((b.ms / max) * room)) : 0;
    const kids = [
      values && b.ms > 0 ? h("span", { class: "st-bars__val" }, formatHoursShort(b.ms)) : null,
      px
        ? h("div", { class: "st-bars__stack", style: `height:${px}px` }, h("div", { class: "st-bars__seg" + (b.current ? " is-current" : ""), style: "flex:1" }))
        : h("div", { class: "st-bars__stub" + (b.future ? " is-future" : "") }),
    ];
    const lbl = h("span", null, b.label || "");
    labels.append(lbl);
    if (!onPick || b.future) {
      const col = h("div", { class: "st-bars__col" }, ...kids);
      cols.push(col);
      bars.append(col);
      return;
    }
    const col = h("button", { type: "button", class: "st-bars__col", "aria-label": `${b.name || b.label}: ${b.ms ? formatDuration(b.ms) : "nothing read"}`, "aria-pressed": "false" }, ...kids);
    col.addEventListener("click", () => {
      picked = picked === i ? null : i;
      chart.classList.toggle("has-pick", picked != null);
      cols.forEach((c, j) => {
        c.classList.toggle("is-picked", j === picked);
        if (c.tagName === "BUTTON") c.setAttribute("aria-pressed", j === picked ? "true" : "false");
        labels.children[j].classList.toggle("is-picked", j === picked);
      });
      onPick(picked);
    });
    cols.push(col);
    bars.append(col);
  });
  return chart;
}

function bar(scope) {
  // Back goes where the phone's Back gesture goes (router structuralParent).
  const parent = scope.kind === "all" ? { route: "library" } : { route: "info", kind: scope.kind, id: scope.id };
  const title = scope.kind === "all" ? "Reading" : "Reading stats";
  return h(
    "div",
    { class: "st-bar" },
    h("button", { class: "sbar__icon", "aria-label": "Back", onclick: () => go(parent) }, svg(ICON.back)),
    h("div", { class: "st-bar__title" }, title),
    h("div", { style: "width:34px" })
  );
}

// Word counts still missing for these books (minus any that can't be had).
const uncounted = (list) => needsCounting(list).filter((b) => !countFailed.has(b.id));
async function countWords(b) {
  await ensureWordCount(b).catch(() => {});
  if (!hasCurrentWordCount(b)) countFailed.add(b.id);
}

// ---- Screen -----------------------------------------------------------------

/**
 * Draw the stats screen. Opening it (from the router) starts the overall
 * screen on this week; `keep` redraws in place (tab / ‹ › / a refresh).
 */
export function renderStats(kind, id, { keep = false } = {}) {
  const root = el.statsScreen;
  const scope = scopeOf(kind, id);
  const scroll = root.scrollTop;
  root.innerHTML = "";
  if (!scope) {
    go({ route: "library" });
    return;
  }
  if (!keep) {
    period = "week";
    offset = 0;
  }
  shown = { kind, id };
  flushStats(); // the reader may have just closed — show its last minutes
  const token = ++renderToken;
  root.append(bar(scope));
  const content = h("div", { class: "st-content" });
  root.append(content);

  // "Time left" needs word counts; count what's missing first, one book at a
  // time (each walks a whole epub), then draw.
  const pending = uncounted(scope.kind === "all" ? scope.books.filter(bookIsStarted) : scope.books);
  if (pending.length) {
    root.scrollTop = 0;
    const msg = h("p", { class: "st-empty" }, "Counting words…");
    content.append(msg);
    (async () => {
      for (let i = 0; i < pending.length; i++) {
        if (token !== renderToken) return;
        msg.textContent = `Counting words · ${i + 1} of ${pending.length}`;
        await countWords(pending[i]);
      }
      if (token === renderToken && document.getElementById("app").dataset.route === "stats") renderStats(kind, id, { keep: true });
    })();
    return;
  }

  if (scope.kind === "all") renderOverall(content, scope);
  else renderBook(content, scope);
  root.scrollTop = keep ? scroll : 0;
}

/** Redraw the stats screen on show (new data, or back from the background). */
export function refreshStats() {
  if (shown) renderStats(shown.kind, shown.id, { keep: true });
}

// ---- Where you are ------------------------------------------------------------

// Every readable chapter of the scope in reading order: { abs, words, frac, book, i }.
// Word counts are kept per file, and a file can hold several chapters, so a
// file's words are split between its chapters, then scaled to the book's total.
function chapterList(list) {
  const out = [];
  for (const b of list) {
    const p = progressMap[b.id];
    const readable = readableChapters(b.chapters || []);
    const off = volumeChapterOffset(b);
    const perFile = new Map();
    for (const e of readable) perFile.set(baseHref(e.href), (perFile.get(baseHref(e.href)) || 0) + 1);
    const raw = readable.map((e) => {
      const key = baseHref(e.href);
      const w = b.chapterWords?.[key];
      return w != null ? w / perFile.get(key) : null;
    });
    const known = raw.reduce((n, w) => n + (w || 0), 0);
    const even = b.wordCount && readable.length ? b.wordCount / readable.length : 0;
    const scale = known > 0 && b.wordCount ? b.wordCount / known : 1;
    readable.forEach((e, i) => {
      const c = p?.chapters?.[baseHref(e.href)];
      const frac = p?.finished || c?.done ? 1 : (c?.pct || 0) / 100;
      out.push({ abs: chapterDisplay(e, i + 1 + off).num, words: known > 0 ? (raw[i] || 0) * scale : even, frac, book: b, i });
    });
  }
  return out;
}

/**
 * Where you are in a book / series and what's left from there — the one
 * reckoning the tiles, milestones, volume timeline and info card all share.
 * { list, cur (index of the chapter you're on; list.length once at the end),
 *   leftWords (from there to the end), behind (unread chapters before it) }.
 */
function positionOf(scope) {
  const list = chapterList(scope.books);
  const book = scope.kind === "series" ? currentVolume(scope.series) : scope.books[0];
  const p = book && progressMap[book.id];
  let cur = p ? list.findIndex((c) => c.book === book && c.i === chapterOrdinalFor(book, p) - 1) : 0;
  if (cur < 0) cur = list.findIndex((c) => c.frac < 1);
  if (cur < 0) cur = list.length;
  // On a chapter you've finished: you're on to the next one.
  while (cur < list.length && list[cur].frac >= 1) cur++;
  let behind = 0;
  for (let i = 0; i < cur; i++) if (list[i].frac < 1) behind++;
  return { list, cur, leftWords: wordsThrough(list, list.length - 1, cur), behind };
}

// ---- One book / series --------------------------------------------------------

function bookModel(scope) {
  const ids = idsOf(scope);
  const rows = statRows(ids);
  const days = byDay(rows);
  const t = totals(days);
  const day = today();
  const pace = paceFor(ids);
  const measured = !!trackedPace(ids) || !!trackedPace();
  const pos = positionOf(scope);
  const leftMs = pos.leftWords / pace;
  const rate = recentRate(days, day, t.first);
  const finishIn = rate > 0 && leftMs > 0 ? Math.ceil(leftMs / rate) : null;
  return { ids, rows, days, t, today: day, pace, measured, pos, leftMs, rate, finishIn };
}

// Chapters per reading day over the last two weeks, and this week's so far;
// null when nothing was read in that time.
function chaptersLately(days, day) {
  const from = addDays(day, -(RECENT_DAYS - 1));
  const mon = weekStart(day);
  let n = 0;
  let ch = 0;
  let week = 0;
  for (const [k, d] of days) {
    if (k < from || k > day || d.ms < MIN_DAY_MS) continue;
    n++;
    ch += d.chapters;
    if (k >= mon) week += d.chapters;
  }
  return n ? { perDay: ch / n, week: Math.round(week) } : null;
}

function renderBook(content, scope) {
  const m = bookModel(scope);
  const { t, today: day } = m;

  // Header — cover, title, where you are.
  let where;
  let pct;
  if (scope.kind === "series") {
    const cur = currentVolume(scope.series);
    const total = scope.books.reduce((n, b) => n + chapterCount(b), 0);
    pct = seriesPercent(scope.series);
    const p = cur && progressMap[cur.id];
    where = p ? `Chapter ${fmtN(absChapterNum(cur, p))} of ${fmtN(total)} · ${pct}%` : `${fmtN(total)} chapters`;
  } else {
    const b = scope.books[0];
    const p = progressMap[b.id];
    pct = bookPercent(b);
    where = p ? `Chapter ${fmtN(absChapterNum(b, p))} of ${fmtN(chapterCount(b))} · ${pct}%` : "Not started";
  }
  content.append(
    h(
      "div",
      { class: "st-book" },
      coverNode(scope.coverBook, "st-book__cover"),
      h("div", { class: "st-book__text" }, h("div", { class: "st-book__title" }, scope.title), h("div", { class: "st-book__where" }, where), progressBar(pct, "card"))
    )
  );

  if (!t.ms) {
    content.append(h("p", { class: "st-empty" }, "Nothing read yet. Your reading time shows up here once you start."));
    return;
  }

  // Tiles — time read, time left, and chapters a day (or, for a book set
  // aside, when you last read it).
  const done = m.pos.leftWords <= 0;
  const endWord = scope.kind === "series" ? "caught up" : "done";
  const leftTile = done
    ? tile("Time left", "Done", endWord === "done" ? "finished" : "caught up")
    : tile("Time left", formatDuration(m.leftMs), m.finishIn != null ? `${endWord} ~${formatDay(addDays(day, m.finishIn), day)}` : "at your pace");
  const lately = chaptersLately(m.days, day);
  const third = lately
    ? tile("Chapters a day", perDayNum(lately.perDay), `${plural(lately.week, "chapter")} this week`)
    : tile("Last read", formatDay(t.last, day), plural(daysBetween(t.last, day), "day") + " ago");
  content.append(h("div", { class: "st-tiles st-tiles--3" }, tile("Time read", formatDuration(t.ms), `since ${formatDay(t.first, day)}`), leftTile, third));

  const miles = milestones(scope, m);
  if (miles) content.append(h("section", { class: "st-section" }, label("Milestones", m.finishIn != null ? "at your recent pace" : null), miles));

  if (scope.kind === "series" && scope.books.length > 1) {
    const tl = volumeTimeline(scope, m);
    if (tl) content.append(h("section", { class: "st-section" }, label("Volumes"), tl));
  }

  // Hours per week, last 8 weeks.
  const thisWeek = weekStart(day);
  const weeks = [];
  for (let i = 7; i >= 0; i--) {
    const from = addDays(thisWeek, -7 * i);
    const s = sumRange(m.days, from, addDays(from, 6));
    const d = dayDate(from);
    const prev = dayDate(addDays(from, -7));
    const lbl = i === 7 || d.getMonth() !== prev.getMonth() ? `${monthShort(d.getMonth())} ${d.getDate()}` : String(d.getDate());
    weeks.push({ ...s, label: lbl, current: i === 0 });
  }
  content.append(
    h("section", { class: "st-section" }, label("Hours per week", "last 8 weeks"), barChart(weeks, { height: 118, values: true, aria: "Hours read per week over the last 8 weeks" }))
  );

  // Details.
  const read = scope.books.reduce((n, b) => n + wordsRead(b), 0);
  const all = scope.books.reduce((n, b) => n + (b.wordCount || 0), 0);
  const table = h("div", { class: "info-table st-table" });
  if (read) table.append(row("Words read", formatCompactNumber(read) + (all ? ` of ${formatCompactNumber(all)}` : "")));
  // Unmeasured, every hour above rests on the assumed pace — say so.
  table.append(row("Pace", m.measured ? `${wpm(m.pace)} words / min` : `≈ ${wpm(m.pace)} words / min · assumed`));
  if (t.readDays) table.append(row("Average reading day", formatDuration(t.dayMs)));
  table.append(row("Days read", `${t.readDays} of ${daysBetween(t.first, day) + 1}`));
  const rd = readDaySet(m.days);
  const cur = currentStreak(rd, day);
  const best = longestStreak(rd);
  table.append(row("Streak", plural(cur, "day") + (best > cur ? ` · best ${best}` : "")));
  if (t.sessions) table.append(row("Sessions", `${fmtN(t.sessions)} · ${formatDuration(t.ms / t.sessions)} average`));
  content.append(h("section", { class: "st-section" }, label("Details"), table));
}

// Where you are on the road through a book / series: the last round chapter
// behind you (and the day you got there), the chapter you're on, and what's
// ahead — the next round chapters, the end of this volume, the end — dated at
// your recent reading rate, from the same words-left as the "Time left" tile.
function milestones(scope, m) {
  const { list, cur, behind: unreadBehind } = m.pos;
  if (cur >= list.length) return null;
  const day = m.today;
  const curAbs = list[cur].abs;
  const lastIdx = list.length - 1;
  const atOrAfter = (n) => {
    for (let i = cur; i < list.length; i++) if (list[i].abs >= n) return i;
    return -1;
  };
  const round = roundMilestones(curAbs, list[lastIdx].abs);

  // Ahead — by chapter index, so an odd label number can't misplace them.
  const targets = new Map(); // idx → { label, sub }
  for (const n of round.ahead) {
    const i = atOrAfter(n);
    if (i > cur) targets.set(i, { label: `Chapter ${fmtN(list[i].abs)}` });
  }
  if (scope.kind === "series") {
    const vol = list[cur].book;
    let end = cur;
    while (end + 1 < list.length && list[end + 1].book === vol) end++;
    if (end < lastIdx) targets.set(end, { label: `End of Vol. ${volumeNumber(scope.series, vol)}`, sub: `chapter ${fmtN(list[end].abs)}` });
  }
  if (lastIdx > cur) targets.set(lastIdx, scope.kind === "series" ? { label: "Caught up", sub: `chapter ${fmtN(list[lastIdx].abs)}` } : { label: "The end" });

  const rows = [];
  const mile = (kind, text, sub, when, whenSub) =>
    h(
      "div",
      { class: "st-mile is-" + kind },
      h("span", { class: "st-mile__dot", "aria-hidden": "true" }),
      h("span", { class: "st-mile__text" }, h("span", { class: "st-mile__label" }, text), sub ? h("span", { class: "st-mile__sub" }, sub) : null),
      h("span", { class: "st-mile__when" }, when, whenSub ? h("span", { class: "st-mile__sub" }, whenSub) : null)
    );

  // Behind: the day the running count of finished chapters reached it —
  // anchored so the count today matches where you are.
  if (round.behind != null) {
    const bi = list.findIndex((c) => c.abs >= round.behind);
    const perDay = [...m.days].filter(([, d]) => d.chapters > 0).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, d]) => [k, d.chapters]);
    const counted = perDay.reduce((n, [, c]) => n + c, 0);
    const shift = cur - counted; // chapters done that no reading explains (marked read, skipped)
    const reached = bi >= 0 && bi + 1 > shift ? dayReaching(perDay, bi + 1, shift) : null;
    if (reached) rows.push(mile("past", `Chapter ${fmtN(round.behind)}`, null, formatDay(reached, day), null));
  }
  rows.push(mile("now", `Chapter ${fmtN(curAbs)}`, list[cur].frac > 0 ? `${Math.round(list[cur].frac * 100)}% in` : null, "now", null));

  for (const [i, tg] of [...targets].sort((a, b) => a[0] - b[0]).slice(0, 4)) {
    const words = wordsThrough(list, i, cur);
    if (!(m.rate > 0)) {
      rows.push(mile("ahead", tg.label, tg.sub, formatDuration(words / m.pace), "of reading"));
      continue;
    }
    const days = words / m.pace / m.rate;
    if (days > 3 * 365) continue;
    const n = Math.max(0, Math.ceil(days - 0.05));
    rows.push(mile("ahead", tg.label, tg.sub, n === 0 ? "today" : formatDay(addDays(day, n), day), n === 0 ? null : n === 1 ? "tomorrow" : `in ${plural(n, "day")}`));
  }
  if (rows.length < 2) return null;
  const out = h("div", { class: "st-miles" }, rows);
  if (unreadBehind)
    return h("div", null, out, h("p", { class: "st-note" }, `${plural(unreadBehind, "earlier chapter")} still unread — not counted in the time left.`));
  return out;
}

// One bar per volume across time: read (solid) and still ahead at your pace
// (dashed), and a line for today. A long series folds into a few rows: the
// volumes finished long ago as one, the recent and current ones, and the
// rest ahead as one.
function volumeTimeline(scope, m) {
  const day = m.today;
  const { list, cur } = m.pos;
  const curBook = list[cur]?.book || null;
  const vols = scope.books.map((b, vi) => {
    const r = m.rows.filter((x) => x.bookId === b.id && x.ms > 0).map((x) => x.day).sort();
    const ms = m.rows.reduce((n, x) => n + (x.bookId === b.id ? x.ms : 0), 0);
    const left = list.reduce((n, c, i) => n + (c.book === b && i >= cur ? c.words * (1 - Math.min(1, c.frac)) : 0), 0);
    return { b, vi, first: r[0], last: r.at(-1), ms, left, num: volumeNumber(scope.series, b) };
  });
  const firsts = vols.map((v) => v.first).filter(Boolean).sort();
  if (!firsts.length) return null;
  const start = firsts[0];
  const off = (k) => daysBetween(start, k);
  const todayOff = off(day) + 1;

  // Projection: what's left, volume after volume, at your recent rate.
  let cursor = todayOff;
  for (const v of vols) {
    if (!(v.left > 0) || !m.rate) continue;
    const days = v.left / m.pace / m.rate;
    if (cursor + days - todayOff > 365) continue;
    v.ahead = [cursor, cursor + days];
    cursor += days;
  }

  // Fold a long series.
  const curVi = curBook ? scope.books.indexOf(curBook) : vols.findLastIndex((v) => v.first);
  let shownRows = vols.map((v) => ({ ...v, name: `Vol. ${v.num}` }));
  if (vols.length > 8) {
    const pastEnd = Math.max(0, curVi - 2); // volumes before this fold into one
    const aheadStart = Math.min(vols.length, curVi + 3); // and from this one on
    const group = (vs) => {
      if (vs.length < 2) return vs.map((v) => ({ ...v, name: `Vol. ${v.num}` }));
      const fs = vs.map((v) => v.first).filter(Boolean).sort();
      const ls = vs.map((v) => v.last).filter(Boolean).sort();
      const ah = vs.map((v) => v.ahead).filter(Boolean);
      return [
        {
          name: `Vol. ${vs[0].num}–${vs.at(-1).num}`,
          first: fs[0],
          last: ls.at(-1),
          ms: vs.reduce((n, v) => n + v.ms, 0),
          left: vs.reduce((n, v) => n + v.left, 0),
          ahead: ah.length ? [ah[0][0], ah.at(-1)[1]] : null,
        },
      ];
    };
    shownRows = [...group(vols.slice(0, pastEnd)), ...vols.slice(pastEnd, aheadStart).map((v) => ({ ...v, name: `Vol. ${v.num}` })), ...group(vols.slice(aheadStart))];
  }

  const end = Math.max(todayOff, cursor, ...vols.map((v) => v.last).filter(Boolean).map((k) => off(k) + 1));
  const pc = (x) => `${((x / end) * 100).toFixed(2)}%`;
  const seg = (a, b, cls) => h("div", { class: "st-tl__seg " + cls, style: `left:${pc(a)};width:${pc(Math.max(b - a, 0.6))}` });
  const wide = shownRows.some((r) => r.name.includes("–"));

  const grid = h("div", { class: "st-tl" + (wide ? " st-tl--wide" : ""), role: "img", "aria-label": "When each volume was read" });
  const marks = h("div", { class: "st-tl__marks", "aria-hidden": "true" });
  marks.append(h("div", { class: "st-tl__today", style: `left:${pc(todayOff)}` }));
  grid.append(marks);
  let anyAhead = false;
  for (const v of shownRows) {
    const track = h("div", { class: "st-tl__track" });
    if (v.first) track.append(seg(off(v.first), off(v.last) + 1, "is-tracked"));
    if (v.ahead) {
      track.append(seg(v.ahead[0], v.ahead[1], "is-ahead"));
      anyAhead = true;
    }
    const time = v.ms >= MIN_DAY_MS ? formatHoursShort(v.ms) : v.left > 0 ? `+${formatHoursShort(v.left / m.pace)}` : "";
    grid.append(h("div", { class: "st-tl__row" }, h("span", { class: "st-tl__name" }, v.name), track, h("span", { class: "st-tl__time" + (v.ms >= MIN_DAY_MS ? "" : " is-ahead") }, time)));
  }
  // Month ticks along the bottom.
  const ticks = h("div", { class: "st-tl__ticks", "aria-hidden": "true" });
  const d = dayDate(start);
  d.setDate(1);
  const monthStarts = [];
  for (let i = 0; i < 24; i++) {
    const k = dayKey(d.getTime());
    const x = off(k);
    if (x > end) break;
    if (x >= 0) monthStarts.push({ x, name: monthShort(d.getMonth()) });
    d.setMonth(d.getMonth() + 1);
  }
  const every = monthStarts.length > 6 ? 2 : 1;
  monthStarts.forEach((ms, i) => {
    if (i % every === 0) ticks.append(h("span", { style: `left:${pc(ms.x)}` }, ms.name));
  });
  grid.append(h("div", { class: "st-tl__row st-tl__row--ticks" }, h("span"), ticks, h("span")));

  const legend = h("div", { class: "st-legend" });
  const item = (cls, text) => h("span", null, h("span", { class: "st-legend__key " + cls, "aria-hidden": "true" }), text);
  legend.append(item("is-tracked", "read"));
  if (anyAhead) legend.append(item("is-ahead", "ahead, at your pace"));
  legend.append(item("is-today", "today"));
  return h("div", null, grid, legend);
}

// ---- Everything ------------------------------------------------------------------

const PERIODS = [
  ["week", "Week"],
  ["month", "Month"],
  ["year", "Year"],
  ["all", "All"],
];

// The chart buckets and headline for a period `off` steps back from the
// current one, with where the period before it starts.
function periodBuckets(kind, day, days, off) {
  const make = (from, to, lbl, name) => ({ ...sumRange(days, from, to), from, to, label: lbl, name, current: from === day && to === day, future: from > day });
  const t = dayDate(day);
  if (kind === "week") {
    const mon = addDays(weekStart(day), 7 * off);
    const sun = addDays(mon, 6);
    const names = ["M", "T", "W", "T", "F", "S", "S"];
    const buckets = names.map((n, i) => make(addDays(mon, i), addDays(mon, i), n, dayName(addDays(mon, i), day)));
    const sameMonth = dayDate(mon).getMonth() === dayDate(sun).getMonth();
    const title = off === 0 ? "This week" : off === -1 ? "Last week" : `${formatDay(mon, day)} – ${sameMonth ? dayDate(sun).getDate() : formatDay(sun, day)}`;
    return { title, buckets, from: mon, to: sun, prevFrom: addDays(mon, -7), unit: "week" };
  }
  const monthBucket = (y, mo, lbl) => {
    const from = dayKey(new Date(y, mo, 1).getTime());
    const to = dayKey(new Date(y, mo + 1, 0).getTime());
    const b = make(from, to, lbl, `${MONTHS_LONG[mo]} ${y}`);
    b.current = y === t.getFullYear() && mo === t.getMonth();
    return b;
  };
  if (kind === "month") {
    const first = new Date(t.getFullYear(), t.getMonth() + off, 1);
    const y = first.getFullYear();
    const mo = first.getMonth();
    const n = new Date(y, mo + 1, 0).getDate();
    const fk = dayKey(first.getTime());
    const buckets = [];
    for (let i = 0; i < n; i++) {
      const k = addDays(fk, i);
      buckets.push(make(k, k, [1, 8, 15, 22, 29].includes(i + 1) ? String(i + 1) : "", dayName(k, day)));
    }
    const title = MONTHS_LONG[mo] + (y !== t.getFullYear() ? ` ${y}` : "");
    return { title, buckets, from: fk, to: addDays(fk, n - 1), prevFrom: dayKey(new Date(y, mo - 1, 1).getTime()), unit: "month" };
  }
  if (kind === "year") {
    const y = t.getFullYear() + off;
    const buckets = [];
    for (let mo = 0; mo < 12; mo++) buckets.push(monthBucket(y, mo, monthShort(mo)[0]));
    return { title: String(y), buckets, from: `${y}-01-01`, to: `${y}-12-31`, prevFrom: `${y - 1}-01-01`, unit: "year" };
  }
  // All time: one bar per month since the first reading.
  const first = firstDayOf(days) || day;
  const f = dayDate(first);
  const buckets = [];
  let y = f.getFullYear();
  let mo = f.getMonth();
  while (y < t.getFullYear() || (y === t.getFullYear() && mo <= t.getMonth())) {
    buckets.push(monthBucket(y, mo, mo === 0 && buckets.length ? `${monthShort(mo)} ’${String(y).slice(2)}` : monthShort(mo)));
    if (++mo > 11) {
      mo = 0;
      y++;
    }
  }
  return { title: "All time", buckets, from: first, to: day, prevFrom: null };
}

// "12% more than this time last week" / "… than the week before".
function comparison(p, days, day, off) {
  if (!p.prevFrom) return null;
  const end = off === 0 ? day : p.to;
  const cur = sumRange(days, p.from, end);
  const prevEnd = addDays(p.from, -1);
  let prevTo = addDays(p.prevFrom, daysBetween(p.from, end));
  if (prevTo > prevEnd) prevTo = prevEnd;
  const prev = sumRange(days, p.prevFrom, prevTo);
  if (!(prev.ms > 0) || !(cur.ms > 0)) return null;
  const d = Math.round(((cur.ms - prev.ms) / prev.ms) * 100);
  const than = off === 0 ? `this time last ${p.unit}` : `the ${p.unit} before`;
  return d === 0 ? `same as ${than}` : `${Math.abs(d)}% ${d > 0 ? "more" : "less"} than ${than}`;
}

// The series / book a row belongs to, as one shelf entry.
function shelfEntry(bookId) {
  const b = bookById(bookId);
  if (!b) return null;
  const s = b.seriesId && seriesById(b.seriesId);
  return s
    ? { key: "s:" + s.id, kind: "series", id: s.id, title: s.name, cover: currentVolume(s) || b }
    : { key: "b:" + b.id, kind: "book", id: b.id, title: displayTitle(b), cover: b };
}
function perShelf(rows, from, to) {
  const per = new Map();
  const memo = new Map();
  for (const r of rows) {
    if (r.day < from || r.day > to || r.ms <= 0) continue;
    if (!memo.has(r.bookId)) memo.set(r.bookId, shelfEntry(r.bookId));
    const e = memo.get(r.bookId);
    if (!e) continue;
    if (!per.has(e.key)) per.set(e.key, { ...e, ms: 0 });
    per.get(e.key).ms += r.ms;
  }
  return [...per.values()].sort((a, b) => b.ms - a.ms);
}

function renderOverall(content, scope) {
  const rows = statRows(idsOf(scope));
  const days = byDay(rows);
  const day = today();
  const all = totals(days);
  const rerender = () => renderStats("all", undefined, { keep: true });

  // Period switch.
  const tabs = h("div", { class: "st-tabs", role: "tablist", "aria-label": "Period" });
  for (const [key, name] of PERIODS) {
    tabs.append(
      h(
        "button",
        {
          class: "st-tab" + (period === key ? " is-on" : ""),
          role: "tab",
          "aria-selected": period === key ? "true" : "false",
          onclick: () => {
            period = key;
            offset = 0;
            rerender();
          },
        },
        name
      )
    );
  }
  content.append(tabs);

  if (!all.ms) {
    content.append(h("p", { class: "st-empty" }, "Nothing read yet. Your reading time shows up here once you start."));
    return;
  }

  // Headline + chart; ‹ › (or a swipe on the chart) step through periods, a
  // tapped bar takes over the headline until it's tapped again.
  const p = periodBuckets(period, day, days, offset);
  const sum = sumRange(days, p.from, p.to);
  const bits = [];
  if (sum.words >= 1) bits.push(`${formatCompactNumber(Math.round(sum.words))} words`);
  if (sum.chapters >= 1) bits.push(plural(Math.round(sum.chapters), "chapter"));
  const cmp = comparison(p, days, day, offset);
  if (cmp) bits.push(cmp);
  const total = { k: p.title, v: sum.ms ? formatDuration(sum.ms) : "0 min", sub: bits.join(" · ") };

  const kEl = h("div", { class: "st-hero__k" });
  const vEl = h("div", { class: "st-hero__v" });
  const subEl = h("div", { class: "st-hero__sub" });
  const show = (x) => {
    kEl.textContent = x.k;
    vEl.textContent = x.v;
    subEl.textContent = x.sub || " ";
  };
  show(total);
  const pick = (i) => {
    if (i == null) return show(total);
    const b = p.buckets[i];
    const sub = [];
    if (b.chapters >= 1) sub.push(plural(Math.round(b.chapters), "chapter"));
    const top = perShelf(rows, b.from, b.to);
    if (top.length) sub.push(top.length > 1 ? `${top[0].title} +${top.length - 1}` : top[0].title);
    show({ k: b.name, v: b.ms ? formatDuration(b.ms) : "Nothing read", sub: sub.join(" · ") });
  };
  const firstDay = firstDayOf(days);
  const canPrev = period !== "all" && !!firstDay && firstDay < p.from;
  const canNext = period !== "all" && offset < 0;
  const step = (d) => {
    if ((d < 0 && !canPrev) || (d > 0 && !canNext)) return;
    offset += d;
    rerender();
  };
  const nav =
    period === "all"
      ? null
      : h(
          "div",
          { class: "st-hero__nav" },
          h("button", { class: "st-navbtn", "aria-label": `Previous ${p.unit}`, disabled: !canPrev, onclick: () => step(-1) }, svg(ICON.back)),
          h("button", { class: "st-navbtn st-navbtn--next", "aria-label": `Next ${p.unit}`, disabled: !canNext, onclick: () => step(1) }, svg(ICON.back))
        );
  const chart = barChart(p.buckets, { height: 110, aria: `Reading time, ${p.title}. Tap a bar for its details.`, onPick: pick });
  // Swipe the chart: right for earlier, left for later.
  let touch = null;
  chart.addEventListener("touchstart", (e) => (touch = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null), { passive: true });
  chart.addEventListener("touchend", (e) => {
    if (!touch) return;
    const dx = e.changedTouches[0].clientX - touch.x;
    const dy = e.changedTouches[0].clientY - touch.y;
    touch = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > 2 * Math.abs(dy)) step(dx > 0 ? -1 : 1);
  });
  content.append(h("section", { class: "st-hero" }, h("div", { class: "st-hero__head" }, kEl, nav), vEl, subEl, chart));

  // This period: its days, then its books.
  content.append(periodTiles(days, p.from, p.to, day));
  const ranked = perShelf(rows, p.from, p.to).slice(0, 8);
  if (ranked.length) {
    const list = h("div", { class: "st-books" });
    const top = ranked[0].ms;
    for (const e of ranked) {
      list.append(
        h(
          "button",
          { class: "st-bookrow", onclick: () => go({ route: "stats", kind: e.kind, id: e.id }) },
          coverNode(e.cover, "st-bookrow__cover"),
          h(
            "span",
            { class: "st-bookrow__text" },
            h("span", { class: "st-bookrow__line" }, h("span", { class: "st-bookrow__title" }, e.title), h("span", { class: "st-bookrow__time" }, formatDuration(e.ms))),
            h("span", { class: "st-bookrow__track" }, h("span", { style: `width:${Math.round((e.ms / top) * 100)}%` }))
          )
        )
      );
    }
    content.append(h("section", { class: "st-section" }, label("Books", p.title === "All time" ? null : p.title), list));
  }

  // Everything else is about you overall, whatever the tab.
  content.append(h("div", { class: "st-divider" }, h("span", null, `Since ${formatDay(firstDay, day)}`)));
  content.append(heatmapSection(days, day, firstDay));
  const when = whenYouRead(rows);
  if (when) content.append(when);
  content.append(h("section", { class: "st-section" }, label("Records"), records(days, rows, day)));
}

// Days read, average day, chapters a day and best day for [from, to] (up to today).
function periodTiles(days, from, to, day) {
  const end = to < day ? to : day;
  let n = 0;
  let ms = 0;
  let ch = 0;
  let best = null;
  for (const [k, d] of days) {
    if (k < from || k > end || d.ms < MIN_DAY_MS) continue;
    n++;
    ms += d.ms;
    ch += d.chapters;
    if (!best || d.ms > best[1]) best = [k, d.ms];
  }
  const span = Math.max(1, daysBetween(from, end) + 1);
  return h(
    "div",
    { class: "st-tiles st-tiles--2" },
    tile("Days read", String(n), `of ${plural(span, "day")}`),
    tile("Average day", n ? formatDuration(ms / n) : "—"),
    tile("Chapters a day", n ? perDayNum(ch / n) : "—"),
    tile("Best day", best ? formatDuration(best[1]) : "—", best ? dayName(best[0], day) : null)
  );
}

// Personal bests, plus your pace.
function records(days, rows, day) {
  const table = h("div", { class: "info-table st-table" });
  const rd = readDaySet(days);
  const cur = currentStreak(rd, day);
  const longest = longestStreak(rd);
  table.append(row("Streak", plural(cur, "day") + (longest > cur ? ` · best ${longest}` : "")));
  let top = null;
  let chDay = null;
  const weeks = new Map();
  for (const [k, d] of days) {
    if (!(d.ms > 0)) continue;
    if (!top || d.ms > top[1]) top = [k, d.ms];
    if (d.chapters >= 1 && (!chDay || d.chapters > chDay[1])) chDay = [k, d.chapters];
    const w = weekStart(k);
    weeks.set(w, (weeks.get(w) || 0) + d.ms);
  }
  let week = null;
  for (const [w, ms] of weeks) if (!week || ms > week[1]) week = [w, ms];
  let session = null;
  for (const r of rows) if (r.best > 0 && (!session || r.best > session[1])) session = [r.day, r.best];
  if (top) table.append(row("Longest day", `${formatDuration(top[1])} · ${formatDay(top[0], day)}`));
  if (week && weeks.size > 1) table.append(row("Best week", `${formatDuration(week[1])} · week of ${formatDay(week[0], day)}`));
  if (chDay) table.append(row("Most chapters in a day", `${Math.round(chDay[1])} · ${formatDay(chDay[0], day)}`));
  if (session) table.append(row("Longest session", `${formatDuration(session[1])} · ${formatDay(session[0], day)}`));
  const pace = trackedPace();
  table.append(row("Pace", pace ? `${wpm(pace)} words / min` : `≈ ${wpm(paceFor(null))} words / min · assumed`));
  return table;
}

// The last 20 weeks (or since your first day), Monday first, month names on
// top; tapping a day shows it underneath.
function heatmapSection(days, day, firstDay) {
  const back = addDays(weekStart(day), -19 * 7);
  const firstWeek = firstDay ? weekStart(firstDay) : back;
  const start = firstWeek > back ? firstWeek : back;
  const weeksN = daysBetween(start, weekStart(day)) / 7 + 1;
  const grid = h("div", { class: "st-cal__grid", role: "group", "aria-label": "Reading days" });
  const months = h("div", { class: "st-cal__months", "aria-hidden": "true" });
  const readout = h("div", { class: "st-cal__readout" }, "Tap a day");
  let sel = null;
  for (let i = 0; i < weeksN * 7; i++) {
    const k = addDays(start, i);
    const d = days.get(k);
    if (i % 7 === 0) {
      // A month name over the week that holds its 1st.
      for (let j = 0; j < 7; j++) {
        const kk = addDays(k, j);
        if (dayDate(kk).getDate() === 1) months.append(h("span", { style: `left:${(i / 7) * 16}px` }, monthShort(dayDate(kk).getMonth())));
      }
    }
    if (k > day) {
      grid.append(h("span", { class: "st-cal__day is-future" }));
      continue;
    }
    const cell = h("button", { type: "button", class: `st-cal__day l${level(d ? d.ms : 0)}${k === day ? " is-today" : ""}`, "aria-label": `${dayName(k, day)}: ${dayLine(d)}` });
    cell.addEventListener("click", () => {
      if (sel) sel.classList.remove("is-sel");
      if (sel === cell) {
        sel = null;
        readout.textContent = "Tap a day";
        readout.classList.remove("is-on");
        return;
      }
      sel = cell;
      cell.classList.add("is-sel");
      readout.textContent = `${dayName(k, day)} · ${dayLine(d)}`;
      readout.classList.add("is-on");
    });
    grid.append(cell);
  }
  const dows = h("div", { class: "st-cal__dows", "aria-hidden": "true" }, ["M", "", "W", "", "F", "", "S"].map((x) => h("span", null, x)));
  const legend = h(
    "div",
    { class: "st-cal__legend" },
    h("span", { class: "st-cal__spacer" }),
    h("span", null, "Less"),
    [0, 1, 2, 3, 4].map((l) => h("span", { class: "st-cal__day l" + l, "aria-hidden": "true" })),
    h("span", null, "More")
  );
  return h(
    "section",
    { class: "st-section" },
    label(weeksN >= 20 ? "Last 20 weeks" : "Reading days"),
    h("div", { class: "st-cal" }, h("div", { class: "st-cal__body" }, h("div", { class: "st-cal__side" }, h("span", { class: "st-cal__mspacer" }), dows), h("div", null, months, grid))),
    readout,
    legend
  );
}

// Share of reading by hour of day; hidden until there's enough of it.
function whenYouRead(rows) {
  const hours = new Array(24).fill(0);
  for (const r of rows) if (r.hours) r.hours.forEach((ms, i) => (hours[i] += ms));
  const total = hours.reduce((a, b) => a + b, 0);
  if (total < 30 * 60000) return null;
  // The busiest three-hour stretch, wrapping past midnight.
  let best = 0;
  let at = 0;
  for (let i = 0; i < 24; i++) {
    const s = hours[i] + hours[(i + 1) % 24] + hours[(i + 2) % 24];
    if (s > best) {
      best = s;
      at = i;
    }
  }
  const hh = (n) => String(n % 24).padStart(2, "0") + ":00";
  const max = Math.max(...hours);
  const bars = h("div", { class: "st-hours", role: "img", "aria-label": `Reading by hour of day, mostly ${hh(at)} to ${hh(at + 3)}` });
  hours.forEach((ms, i) => {
    const inPeak = (i - at + 24) % 24 < 3;
    bars.append(h("div", { class: "st-hours__bar" + (inPeak ? " is-peak" : ""), style: `height:${Math.max(1, Math.round((ms / max) * 60))}px` }));
  });
  const labels = h("div", { class: "st-bars__labels st-hours__labels" }, ["00", "06", "12", "18", "24"].map((x) => h("span", null, x)));
  return h("section", { class: "st-section" }, label("When you read", `mostly ${hh(at)} – ${hh(at + 3)}`), bars, labels);
}

// ---- Ways in --------------------------------------------------------------------

/**
 * The info page's "Reading stats" card, once any of it has been read, painted
 * into `host`. Its summary needs word counts; while any are missing it counts
 * them and repaints in place.
 */
export function paintStatsCard(host, kind, id) {
  host.innerHTML = "";
  const card = statsCard(kind, id);
  if (!card) return;
  host.append(card);
  const scope = scopeOf(kind, id);
  const pending = uncounted(scope.books);
  if (pending.length)
    (async () => {
      for (const b of pending) await countWords(b);
      if (host.isConnected) paintStatsCard(host, kind, id);
    })();
}
function statsCard(kind, id) {
  const scope = scopeOf(kind, id);
  if (!scope || !scope.books.some(bookIsStarted)) return null;
  const ids = idsOf(scope);
  const ms = statRows(ids).reduce((n, r) => n + r.ms, 0);
  const counted = !needsCounting(scope.books).length;
  const bits = [];
  if (ms >= MIN_DAY_MS) bits.push(`${formatDuration(ms)} read`);
  if (counted) {
    const left = positionOf(scope).leftWords;
    if (left > 0 && ms >= MIN_DAY_MS) bits.push(`about ${formatDuration(left / paceFor(ids))} left`);
    else if (left <= 0) bits.push(kind === "series" ? "caught up" : "finished");
  }
  return h(
    "button",
    { class: "st-card", onclick: () => go({ route: "stats", kind, id }) },
    h("span", { class: "st-card__icon" }, svg(STATS_ICON)),
    h("span", { class: "st-card__text" }, h("span", { class: "st-card__title" }, "Reading stats"), h("span", { class: "st-card__sub" }, bits.length ? bits.join(" · ") : "Time, pace and time left")),
    h("span", { class: "st-card__chev" }, svg(ICON.chevron))
  );
}

/** The Library's "This week" strip, under Continue. */
export function weekStrip() {
  if (!hasAnyStats()) return null;
  const days = byDay(statRows());
  const day = today();
  const mon = weekStart(day);
  const week = [];
  for (let i = 0; i < 7; i++) week.push(days.get(addDays(mon, i))?.ms || 0);
  const total = week.reduce((a, b) => a + b, 0);
  const streak = currentStreak(readDaySet(days), day);
  const max = Math.max(...week, 1);
  const bars = h("span", { class: "st-strip__bars", "aria-hidden": "true" });
  week.forEach((ms, i) => {
    const k = addDays(mon, i);
    const cls = k === day ? " is-today" : k > day ? " is-future" : ms ? " is-on" : "";
    bars.append(h("span", { class: "st-strip__bar" + cls, style: `height:${k > day ? 2 : Math.max(2, Math.round((ms / max) * 30))}px` }));
  });
  return h(
    "button",
    { class: "st-strip", onclick: () => go({ route: "stats", kind: "all" }), "aria-label": "Reading stats" },
    h(
      "span",
      { class: "st-strip__text" },
      h("span", { class: "st-strip__k" }, "This week"),
      h("span", { class: "st-strip__v" }, total >= MIN_DAY_MS ? formatDuration(total) : "Not yet", streak >= 2 ? h("span", { class: "st-strip__streak" }, ` · ${streak}-day streak`) : null)
    ),
    bars,
    h("span", { class: "st-strip__chev" }, svg(ICON.chevron))
  );
}
