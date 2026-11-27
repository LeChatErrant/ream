// =========================================================================
// STATS screen — reading stats for one book or series (pushed from its info
// page) or for the whole library (pushed from the Library's "This week" strip).
// Also builds those two ways in: the info page's "Reading stats" card and the
// Library strip. The data comes from stats.js: one row per book per reading
// day (days turn at 4 AM). Time is the unit throughout; chapters only say
// where you are. "Your usual" — the yardstick every number is set against —
// is the average of your last full weeks (or months).
// =========================================================================
import { el, h, svg, ICON, coverNode, progressBar } from "./dom.js";
import { books, progressMap, bookById, seriesById } from "./state.js";
import { chapterCount, readableChapters, baseHref, chapterDisplay, chapterOrdinalFor } from "./lib/chapters.js";
import { formatCompactNumber } from "./lib/format.js";
import { ensureWordCount, hasCurrentWordCount } from "./lib/wordcount.js";
import { readingDay, dayKey, addDays, daysBetween, weekStart, dayDate, formatDuration, formatHoursShort, formatDay, monthShort, MONTHS_LONG, wordsThrough } from "./lib/stats.js";
import { statRows, needsCounting, paceFor, trackedPace, hasAnyStats, flushStats } from "./stats.js";
import { displayTitle, bookPercent, seriesVolumes, seriesPercent, currentVolume, absChapterNum, volumeNumber, wordsRead, bookIsStarted, volumeChapterOffset } from "./reading.js";
import { go } from "./router.js";

const MIN_DAY_MS = 60 * 1000; // a day counts as "read" from a minute on
const RECENT_DAYS = 14; // what finish dates project with
const USUAL_WEEKS = 6; // "your usual week": the average of this many full weeks
const USUAL_MONTHS = 6; // … and of up to this many full months
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
// Total time, and the first and last day read.
function totals(days) {
  const t = { ms: 0, first: null, last: null };
  for (const [k, d] of days) {
    t.ms += d.ms;
    if (d.ms > 0 && (!t.first || k < t.first)) t.first = k;
    if (d.ms > 0 && (!t.last || k > t.last)) t.last = k;
  }
  return t;
}
const firstDayOf = (days) => [...days].filter(([, d]) => d.ms > 0).map(([k]) => k).sort()[0] || null;
// Days of [from, to] read (a minute or more).
function daysRead(days, from, to) {
  let n = 0;
  for (const [k, d] of days) if (k >= from && k <= to && d.ms >= MIN_DAY_MS) n++;
  return n;
}

// Average reading time per calendar day lately — what a finish date projects with.
function recentRate(days, day, first) {
  if (!first) return 0;
  const span = Math.min(RECENT_DAYS, daysBetween(first, day) + 1);
  return sumRange(days, addDays(day, -(span - 1)), day).ms / span;
}

// ---- Your usual ---------------------------------------------------------------

const monthFrom = (y, mo) => dayKey(new Date(y, mo, 1).getTime());
const monthTo = (y, mo) => dayKey(new Date(y, mo + 1, 0).getTime());

// The average of the last full weeks before this one (up to USUAL_WEEKS, and
// none from before you started): { ms, n } or null.
function usualWeek(days, day) {
  const first = firstDayOf(days);
  if (!first) return null;
  const mon = weekStart(day);
  let ms = 0;
  let n = 0;
  for (let i = 1; i <= USUAL_WEEKS; i++) {
    const from = addDays(mon, -7 * i);
    if (from < first) break;
    ms += sumRange(days, from, addDays(from, 6)).ms;
    n++;
  }
  return n ? { ms: ms / n, n } : null;
}
// The same over full months.
function usualMonth(days, day) {
  const first = firstDayOf(days);
  if (!first) return null;
  const t = dayDate(day);
  let ms = 0;
  let n = 0;
  for (let i = 1; i <= USUAL_MONTHS; i++) {
    const d = new Date(t.getFullYear(), t.getMonth() - i, 1);
    const from = monthFrom(d.getFullYear(), d.getMonth());
    if (from < first) break;
    ms += sumRange(days, from, monthTo(d.getFullYear(), d.getMonth())).ms;
    n++;
  }
  return n ? { ms: ms / n, n } : null;
}
// Best calendar week / month: { from, ms } or null.
function bestOf(days, keyOf) {
  const per = new Map();
  for (const [k, d] of days) if (d.ms > 0) per.set(keyOf(k), (per.get(keyOf(k)) || 0) + d.ms);
  let best = null;
  for (const [from, ms] of per) if (!best || ms > best.ms) best = { from, ms };
  return best;
}
const monthKeyOf = (k) => k.slice(0, 8) + "01";

// ---- Shared pieces ------------------------------------------------------------

const label = (text, extra) =>
  h("div", { class: "st-head" }, h("span", { class: "lib-label" }, text), extra ? h("span", { class: "st-head__aside" }, extra) : null);
const row = (k, v) => h("div", { class: "info-trow" }, h("span", { class: "info-trow__k" }, k), h("span", { class: "info-trow__v" }, v));
const tile = (k, v, sub) =>
  h("div", { class: "st-tile" }, h("div", { class: "st-tile__k" }, k), h("div", { class: "st-tile__v" }, v), sub ? h("div", { class: "st-tile__sub" }, sub) : null);
const wpm = (pace) => Math.round(pace * 60000);
const plural = (n, w) => `${n.toLocaleString("en-US")} ${w}${n === 1 ? "" : "s"}`;
const fmtN = (n) => n.toLocaleString("en-US");
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DOW_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const dayName = (k, day) => `${DOW[dayDate(k).getDay()]}, ${formatDay(k, day)}`;
// "Jan 4 – 10", "Dec 28 – Jan 3".
function weekRange(mon, day) {
  const sun = addDays(mon, 6);
  const same = dayDate(mon).getMonth() === dayDate(sun).getMonth();
  return `${formatDay(mon, day)} – ${same ? dayDate(sun).getDate() : formatDay(sun, day)}`;
}
// "December", or "December 2025" in another year.
function monthName(k, day) {
  const d = dayDate(k);
  return MONTHS_LONG[d.getMonth()] + (d.getFullYear() !== dayDate(day).getFullYear() ? ` ${d.getFullYear()}` : "");
}
const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");

// Bars of reading time. buckets: [{ label, name, ms, current, future }].
// With `onPick`, each past bar is a button: tapping one calls onPick(index),
// tapping it again calls onPick(null). Future bars are inert dotted stubs.
// `line` ({ ms, label }) draws your usual as a dashed line across. `values`
// (true, or a formatter) writes each bar's time above it; the line's label then
// goes under the chart, where it can't sit on top of a bar's number.
function barChart(buckets, { height = 110, values = false, aria = "", onPick = null, line = null } = {}) {
  const fmt = typeof values === "function" ? values : formatHoursShort;
  const max = Math.max(1, ...buckets.map((b) => b.ms), line ? line.ms * 1.08 : 0);
  const room = values ? height - 16 : height;
  const bars = h("div", { class: "st-bars", style: `height:${height}px`, role: onPick ? "group" : "img", "aria-label": aria });
  const labels = h("div", { class: "st-bars__labels" });
  const chart = h("div", { class: "st-chart" + (onPick ? " is-pickable" : "") }, bars, labels);
  const cols = [];
  let picked = null;
  buckets.forEach((b, i) => {
    const px = b.ms > 0 ? Math.max(2, Math.round((b.ms / max) * room)) : 0;
    const kids = [
      values && b.ms >= MIN_DAY_MS ? h("span", { class: "st-bars__val" }, fmt(b.ms)) : null,
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
  if (line && line.ms > 0) {
    const note = line.label && values;
    bars.append(h("div", { class: "st-bars__line", style: `bottom:${Math.round((line.ms / max) * room)}px`, "aria-hidden": "true" }, line.label && !note ? h("span", null, line.label) : null));
    if (note) chart.append(h("div", { class: "st-chart__note", "aria-hidden": "true" }, `dashed: ${line.label}`));
  }
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

  // Tiles — time left (and when), time a week lately (or, for a book set
  // aside, when you last read it), time read.
  const done = m.pos.leftWords <= 0;
  const endWord = scope.kind === "series" ? "caught up" : "done";
  const leftTile = done
    ? tile("Time left", "Done", endWord === "done" ? "finished" : "caught up")
    : tile("Time left", formatDuration(m.leftMs), m.finishIn != null ? `${endWord} ~${formatDay(addDays(day, m.finishIn), day)}` : "at your pace");
  const from = addDays(day, -27);
  const start = t.first > from ? t.first : from;
  const lateMs = sumRange(m.days, start, day).ms;
  const span = daysBetween(start, day) + 1;
  const lately =
    lateMs >= MIN_DAY_MS
      ? tile("Lately", formatDuration(lateMs / Math.max(1, span / 7)), span >= 28 ? "a week, last 4 weeks" : "a week so far")
      : tile("Last read", formatDay(t.last, day), plural(daysBetween(t.last, day), "day") + " ago");
  content.append(h("div", { class: "st-tiles st-tiles--3" }, leftTile, lately, tile("Time read", formatDuration(t.ms), `since ${formatDay(t.first, day)}`)));

  const curve = progressCurve(scope, m);
  if (curve) content.append(h("section", { class: "st-section" }, label("Progress", curve.ahead ? "dashed: at your recent pace" : null), curve.node));
  if (m.pos.behind)
    content.append(h("p", { class: "st-note" }, `${plural(m.pos.behind, "earlier chapter")} still unread — not counted in the time left.`));

  // Reading time — the same Week / Month / Year / All chart as the overall
  // screen, on this book (series) alone, then its reading days.
  const rerender = () => renderStats(scope.kind, scope.id, { keep: true });
  const hero = periodHero(m.days, day, rerender, workDetail);
  content.append(h("section", { class: "st-section" }, label("Reading time"), periodTabs(rerender), hero.node));
  content.append(heatmapSection(m.days, day, hero.firstDay, (k) => workDetail(m.days.get(k))));

  // Details.
  const read = scope.books.reduce((n, b) => n + wordsRead(b), 0);
  const all = scope.books.reduce((n, b) => n + (b.wordCount || 0), 0);
  const table = h("div", { class: "info-table st-table" });
  if (read) table.append(row("Words read", formatCompactNumber(read) + (all ? ` of ${formatCompactNumber(all)}` : "")));
  // Unmeasured, every hour above rests on the assumed pace — say so.
  table.append(row("Pace", m.measured ? `${wpm(m.pace)} words / min` : `≈ ${wpm(m.pace)} words / min · assumed`));
  table.append(row("Started", formatDay(t.first, day)));
  content.append(h("section", { class: "st-section" }, label("Details"), table));
}

// How far through the book / series you were, day by day, from the first day
// read to today — then dashed to the end at your recent pace. Volumes (or the
// book) are the unit: each counts as 1, filled by the share of its words read.
// Worked backwards from where you are today, undoing each day's words, so it
// ends exactly at your position and whatever was read before tracking (or
// marked read) shows as the starting height. { node, ahead } or null.
function progressCurve(scope, m) {
  const { list, cur } = m.pos;
  const day = m.today;
  const first = m.t.first;
  if (!first || !list.length) return null;
  const vols = new Map(); // bookId → { w: total words, f: share read now }
  for (const c of list) {
    let v = vols.get(c.book.id);
    if (!v) vols.set(c.book.id, (v = { w: 0, r: 0 }));
    v.w += c.words;
    v.r += c.words * Math.min(1, c.frac);
  }
  for (const v of vols.values()) v.f = v.w > 0 ? v.r / v.w : 0;
  const perDay = new Map(); // day → [[bookId, words]]
  const credited = new Map(); // bookId → words credited in all
  for (const r of m.rows) {
    if (!(r.words > 0)) continue;
    (perDay.get(r.day) || perDay.set(r.day, []).get(r.day)).push([r.bookId, r.words]);
    credited.set(r.bookId, (credited.get(r.bookId) || 0) + r.words);
  }
  // More words credited than you're through (re-reading, a chapter counted
  // long): share what you are through among those days instead.
  for (const [id, v] of vols) {
    const c = credited.get(id) || 0;
    v.scale = c > v.r && c > 0 ? v.r / c : 1;
  }
  const n = daysBetween(first, day); // ys[i]: at the start of day first+i; ys[n+1]: now
  const ys = new Array(n + 2);
  const level = () => [...vols.values()].reduce((a, v) => a + v.f, 0);
  ys[n + 1] = level();
  for (let i = n; i >= 0; i--) {
    for (const [id, w] of perDay.get(addDays(first, i)) || []) {
      const v = vols.get(id);
      if (v && v.w > 0) v.f = Math.max(0, v.f - (w * v.scale) / v.w);
    }
    ys[i] = level();
  }
  // Ahead: what's left, in the same units, over the days it'll take.
  let leftUnits = 0;
  for (let i = cur; i < list.length; i++) {
    const v = vols.get(list[i].book.id);
    if (v.w > 0) leftUnits += (list[i].words * (1 - Math.min(1, list[i].frac))) / v.w;
  }
  const ahead = m.finishIn != null && m.finishIn <= 730 && leftUnits > 0 ? m.finishIn : null;

  const units = scope.books.length;
  const asVolumes = scope.kind === "series" && units > 1;
  const W = Math.round(Math.min(600, Math.max(280, (el.statsScreen?.clientWidth || 375) - 40)));
  const H = 180;
  const L = asVolumes ? 48 : 36;
  const R = 8;
  const T = 10;
  const B = 20;
  const span = Math.max(7, n + 1 + (ahead || 0));
  const X = (i) => L + (i / span) * (W - L - R);
  const Y = (v) => T + (1 - v / units) * (H - T - B);
  const f1 = (x) => x.toFixed(1);

  const parts = [];
  // Rows: one line per volume (or 0 / 50 / 100 %), labelled on the left.
  if (asVolumes) {
    const step = Math.ceil(units / 4);
    const lineStep = units <= 40 ? 1 : step;
    for (let v = 0; v <= units; v += lineStep) parts.push(`<line class="st-curve__grid" x1="${L}" x2="${W - R}" y1="${f1(Y(v))}" y2="${f1(Y(v))}"/>`);
    for (let v = 1; v <= units; v += step)
      parts.push(`<text class="st-curve__axis" x="${L - 6}" y="${f1(Y(v - 0.5) + 3)}" text-anchor="end">Vol. ${volumeNumber(scope.series, scope.books[v - 1])}</text>`);
  } else {
    // Words, not the chapter % on the header — so no % on the side either.
    for (const v of [0, 0.5, 1]) parts.push(`<line class="st-curve__grid" x1="${L}" x2="${W - R}" y1="${f1(Y(v * units))}" y2="${f1(Y(v * units))}"/>`);
    parts.push(`<text class="st-curve__axis" x="${L - 6}" y="${f1(Y(0) + 3)}" text-anchor="end">start</text>`);
    parts.push(`<text class="st-curve__axis" x="${L - 6}" y="${f1(Y(units) + 3)}" text-anchor="end">end</text>`);
  }
  // Month names along the bottom.
  const d = dayDate(first);
  const months = d.getDate() <= 10 ? [[0, monthShort(d.getMonth())]] : [];
  d.setDate(1);
  for (let i = 0; i < 40; i++) {
    d.setMonth(d.getMonth() + 1);
    const x = daysBetween(first, dayKey(d.getTime()));
    if (x > span) break;
    months.push([x, monthShort(d.getMonth())]);
  }
  const every = Math.ceil(months.length / 7) || 1;
  months.forEach(([x, name], i) => {
    if (i % every === 0) parts.push(`<text class="st-curve__axis" x="${f1(X(x) + 2)}" y="${H - 4}">${name}</text>`);
  });
  // The road so far, then ahead.
  const pts = ys.map((v, i) => `${f1(X(i))} ${f1(Y(v))}`);
  parts.push(`<path class="st-curve__area" d="M${pts.join(" L")} L${f1(X(n + 1))} ${f1(Y(0))} L${f1(X(0))} ${f1(Y(0))} Z"/>`);
  parts.push(`<path class="st-curve__line" d="M${pts.join(" L")}"/>`);
  const nowX = X(n + 1);
  const nowY = Y(ys[n + 1]);
  if (ahead != null) {
    const endX = X(n + 1 + ahead);
    const endY = Y(ys[n + 1] + leftUnits);
    const word = scope.kind === "series" ? "caught up" : "done";
    parts.push(`<line class="st-curve__line st-curve__ahead" x1="${f1(nowX)}" y1="${f1(nowY)}" x2="${f1(endX)}" y2="${f1(endY)}"/>`);
    parts.push(`<circle class="st-curve__end" cx="${f1(endX)}" cy="${f1(endY)}" r="3.5"/>`);
    parts.push(`<text class="st-curve__lbl" x="${f1(endX - 8)}" y="${f1(endY + 4)}" text-anchor="end">${word} ~${formatDay(addDays(day, ahead), day)}</text>`);
  }
  parts.push(`<circle class="st-curve__dot" cx="${f1(nowX)}" cy="${f1(nowY)}" r="4"/>`);
  // Above-left of today is always clear (the road so far only climbs);
  // right at the top, below-right instead.
  const high = nowY < T + 16;
  parts.push(`<text class="st-curve__lbl" x="${f1(high ? nowX + 8 : nowX - 8)}" y="${f1(high ? nowY + 15 : nowY - 9)}" text-anchor="${high ? "start" : "end"}">today</text>`);

  const node = h("div", { class: "st-curve" });
  node.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="How far through you were over time${ahead != null ? ", and when you'll reach the end" : ""}">${parts.join("")}</svg>`;
  return { node, ahead: ahead != null };
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
    const title = off === 0 ? "This week" : off === -1 ? "Last week" : weekRange(mon, day);
    return { title, buckets, from: mon, to: sun, unit: "week" };
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
    return { title, buckets, from: fk, to: addDays(fk, n - 1), unit: "month" };
  }
  if (kind === "year") {
    const y = t.getFullYear() + off;
    const buckets = [];
    for (let mo = 0; mo < 12; mo++) buckets.push(monthBucket(y, mo, monthShort(mo)[0]));
    return { title: String(y), buckets, from: `${y}-01-01`, to: `${y}-12-31`, unit: "year" };
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
  return { title: "All time", buckets, from: first, to: day, unit: "all" };
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

// Week / Month / Year / All — switching starts the new tab on its current period.
function periodTabs(rerender) {
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
  return tabs;
}

// The headline and chart for the current tab, over the given rows (the whole
// library, or one book / series). ‹ › (or a swipe on the chart) step through
// periods; a tapped bar takes over the headline until it's tapped again, its
// second line from `detail(bucket)`. In the Week tab every day's time is
// written over its bar, so the last few days read at a glance.
function periodHero(days, day, rerender, detail) {
  const p = periodBuckets(period, day, days, offset);
  const uw = usualWeek(days, day);
  const um = usualMonth(days, day);
  const end = p.to < day ? p.to : day;
  const span = daysBetween(p.from, end) + 1;
  const sum = sumRange(days, p.from, end);
  const sub = `${period === "all" ? `since ${formatDay(p.from, day)} · ` : ""}${daysRead(days, p.from, end)} of ${plural(span, "day")} · ${formatDuration(sum.ms / span)} a day`;
  const total = { k: p.title, v: sum.ms ? formatDuration(sum.ms) : "0 min", sub };

  const kEl = h("div", { class: "st-hero__k" });
  const vEl = h("div", { class: "st-hero__v" });
  const subEl = h("div", { class: "st-hero__sub" });
  const cmpEl = versusUsual(p, sum.ms, day, uw, um);
  const show = (x) => {
    kEl.textContent = x.k;
    vEl.textContent = x.v;
    subEl.textContent = x.sub || " ";
    if (cmpEl) cmpEl.hidden = x !== total;
  };
  show(total);
  const pick = (i) => {
    if (i == null) return show(total);
    const b = p.buckets[i];
    show({ k: b.name, v: b.ms ? formatDuration(b.ms) : "Nothing read", sub: b.ms ? detail(b) : "" });
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
  // The dashed line: your usual day under daily bars, your usual month under monthly ones.
  const daily = period === "week" || period === "month";
  const line = daily ? uw && { ms: uw.ms / 7, label: `usual day ${formatDuration(uw.ms / 7)}` } : um && { ms: um.ms, label: `usual month ${formatHoursShort(um.ms)}` };
  const week = period === "week";
  const chart = barChart(p.buckets, { height: week ? 126 : 110, values: week ? formatDuration : false, aria: `Reading time, ${p.title}. Tap a bar for its details.`, onPick: pick, line });
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
  const node = h("section", { class: "st-hero" }, h("div", { class: "st-hero__head" }, kEl, nav), vEl, subEl, cmpEl, chart);
  return { node, p, uw, um, firstDay };
}

// What a day (or any span) of one book / series held: "3 chapters · 12.4K words".
function workDetail(s) {
  const bits = [];
  if (s.chapters) bits.push(plural(s.chapters, "chapter"));
  if (s.words >= 1) bits.push(`${formatCompactNumber(Math.round(s.words))} words`);
  return bits.join(" · ");
}
// The books of a span across the library: "Shadow Slave +2".
function shelfDetail(rows, from, to) {
  const top = perShelf(rows, from, to);
  return top.length ? (top.length > 1 ? `${top[0].title} +${top.length - 1}` : top[0].title) : "";
}

function renderOverall(content, scope) {
  const rows = statRows(idsOf(scope));
  const days = byDay(rows);
  const day = today();
  const all = totals(days);
  const rerender = () => renderStats("all", undefined, { keep: true });

  content.append(periodTabs(rerender));

  if (!all.ms) {
    content.append(h("p", { class: "st-empty" }, "Nothing read yet. Your reading time shows up here once you start."));
    return;
  }

  const { node, p, uw, um, firstDay } = periodHero(days, day, rerender, (b) => shelfDetail(rows, b.from, b.to));
  content.append(node);

  // Last · usual · best.
  content.append(h("div", { class: "st-tiles st-tiles--3" }, ...yardsticks(days, day, uw, um)));

  // The period's books, with how far you got in each.
  const ranked = perShelf(rows, p.from, p.to).slice(0, 8);
  if (ranked.length) {
    const list = h("div", { class: "st-books" });
    for (const e of ranked) list.append(bookRow(e, rows, p.from, p.to, day));
    content.append(h("section", { class: "st-section" }, label("Books", p.title === "All time" ? null : p.title), list));
  }

  // Everything else is about you overall, whatever the tab.
  content.append(h("div", { class: "st-divider" }, h("span", null, `Since ${formatDay(firstDay, day)}`)));
  content.append(heatmapSection(days, day, firstDay, (k) => shelfDetail(rows, k, k)));
  content.append(youSection(days, rows, day, uw));
  const rec = records(days, rows, day);
  if (rec) content.append(h("section", { class: "st-section" }, label("Records"), rec));
}

// The hero's second line: this week (month) against your usual, at the same
// point of it — "▲ 2 h 30 more than your usual by Tuesday (2 h 24)".
function versusUsual(p, ms, day, uw, um) {
  const usual = p.unit === "week" ? uw : p.unit === "month" ? um : null;
  if (!usual) return null;
  const len = daysBetween(p.from, p.to) + 1;
  const elapsed = p.to > day ? daysBetween(p.from, day) + 1 : len;
  const expected = (usual.ms * elapsed) / len;
  const when = elapsed < len ? (p.unit === "week" ? ` by ${DOW_LONG[dayDate(day).getDay()]}` : ` by the ${ordinal(dayDate(day).getDate())}`) : ` ${p.unit}`;
  const diff = ms - expected;
  const out = h("div", { class: "st-hero__cmp" });
  if (Math.abs(diff) < 5 * 60000) out.append(`About your usual${when} (${formatDuration(expected)})`);
  else
    out.append(
      h("span", { class: diff > 0 ? "st-up" : "st-down", "aria-hidden": "true" }, diff > 0 ? "▲" : "▼"),
      ` ${formatDuration(Math.abs(diff))} ${diff > 0 ? "more" : "less"} than your usual${when} (${formatDuration(expected)})`
    );
  return out;
}

// Three tiles under the hero: last, usual and best for the tab's unit (weeks
// for Week, months for Month, both for Year and All).
function yardsticks(days, day, uw, um) {
  const usualW = tile("Usual week", uw ? formatDuration(uw.ms) : "—", uw ? (uw.n > 1 ? `last ${uw.n} weeks` : "1 full week so far") : "after a full week");
  const usualM = tile("Usual month", um ? formatDuration(um.ms) : "—", um ? (um.n > 1 ? `last ${um.n} months` : "1 full month so far") : "after a full month");
  const bm = bestOf(days, monthKeyOf);
  const bestM = tile("Best month", bm ? formatDuration(bm.ms) : "—", bm ? monthName(bm.from, day) : null);
  if (period === "week") {
    const lw = addDays(weekStart(day), -7);
    const last = sumRange(days, lw, addDays(lw, 6)).ms;
    const bw = bestOf(days, weekStart);
    return [tile("Last week", formatDuration(last), weekRange(lw, day)), usualW, tile("Best week", bw ? formatDuration(bw.ms) : "—", bw ? weekRange(bw.from, day) : null)];
  }
  if (period === "month") {
    const t = dayDate(day);
    const lm = new Date(t.getFullYear(), t.getMonth() - 1, 1);
    const from = monthFrom(lm.getFullYear(), lm.getMonth());
    const last = sumRange(days, from, monthTo(lm.getFullYear(), lm.getMonth())).ms;
    return [tile("Last month", formatDuration(last), monthName(from, day)), usualM, bestM];
  }
  return [usualW, usualM, bestM];
}

// One shelf entry for the Books list: its time in the period, and a bar of how
// far through it you are, the stretch read in the period lit up — worked out
// from the words read since, so a past period shows where you were then.
function bookRow(e, rows, from, to, day) {
  const vols = e.kind === "series" ? seriesVolumes(seriesById(e.id)) : [bookById(e.id)];
  const ids = new Set(vols.map((b) => b.id));
  const counted = vols.filter((b) => b.wordCount);
  const avg = counted.length ? counted.reduce((n, b) => n + b.wordCount, 0) / counted.length : 0;
  const total = vols.reduce((n, b) => n + (b.wordCount || avg), 0);
  let inPeriod = 0;
  let after = 0;
  const lastDay = new Map(); // bookId → last day with words
  for (const r of rows) {
    if (!ids.has(r.bookId) || !(r.words > 0)) continue;
    if (r.day >= from && r.day <= to) inPeriod += r.words;
    else if (r.day > to && r.day <= day) after += r.words;
    if (!lastDay.has(r.bookId) || r.day > lastDay.get(r.bookId)) lastDay.set(r.bookId, r.day);
  }
  const nowFrac = total ? vols.reduce((n, b) => n + wordsRead(b), 0) / total : 0;
  const endFrac = Math.max(0, Math.min(1, nowFrac - after / total || 0));
  const startFrac = Math.max(0, endFrac - (total ? inPeriod / total : 0));
  const pc = (x) => `${(x * 100).toFixed(2)}%`;

  // Volumes finished in the period: done now, last read in it.
  const finished = vols.filter((b) => bookPercent(b) >= 100 && lastDay.get(b.id) >= from && lastDay.get(b.id) <= to);
  let left;
  if (finished.length) {
    const s = e.kind === "series" && seriesById(e.id);
    left = h(
      "span",
      { class: "st-bookrow__done" },
      !s ? "✓ Finished" : finished.length > 2 ? `✓ Finished ${finished.length} volumes` : `✓ Finished ${finished.map((b) => "Vol. " + volumeNumber(s, b)).join(", ")}`
    );
  } else if (e.kind === "series") {
    const s = seriesById(e.id);
    const cur = currentVolume(s);
    left = cur ? `Vol. ${volumeNumber(s, cur)} · ${bookPercent(cur)}%` : "";
  } else left = `${bookPercent(vols[0])}% read`;
  const d = (endFrac - startFrac) * 100;
  const right = d >= 1 ? `+${Math.round(d)}%` : d >= 0.1 ? `+${d.toFixed(1)}%` : "";

  return h(
    "button",
    { class: "st-bookrow", onclick: () => go({ route: "stats", kind: e.kind, id: e.id }) },
    coverNode(e.cover, "st-bookrow__cover"),
    h(
      "span",
      { class: "st-bookrow__text" },
      h("span", { class: "st-bookrow__line" }, h("span", { class: "st-bookrow__title" }, e.title), h("span", { class: "st-bookrow__time" }, formatDuration(e.ms))),
      h(
        "span",
        { class: "st-bookrow__track" },
        h("span", { class: "st-bookrow__was", style: `width:${pc(startFrac)}` }),
        h("span", { class: "st-bookrow__now", style: `left:${pc(startFrac)};width:${pc(Math.max(endFrac - startFrac, 0.004))}` })
      ),
      h("span", { class: "st-bookrow__sub" }, h("span", null, left), h("span", null, right))
    )
  );
}

// Personal bests.
function records(days, rows, day) {
  const table = h("div", { class: "info-table st-table" });
  let top = null;
  for (const [k, d] of days) if (d.ms > 0 && (!top || d.ms > top[1])) top = [k, d.ms];
  let sitting = null;
  for (const r of rows) if (r.best > 0 && (!sitting || r.best > sitting[1])) sitting = [r.day, r.best];
  const bm = bestOf(days, monthKeyOf);
  if (top) table.append(row("Longest day", `${formatDuration(top[1])} · ${formatDay(top[0], day)}`));
  if (sitting) table.append(row("Longest sitting", `${formatDuration(sitting[1])} · ${formatDay(sitting[0], day)}`));
  if (bm) table.append(row("Best month", `${formatDuration(bm.ms)} · ${monthName(bm.from, day)}`));
  return table.children.length ? table : null;
}

// Pace, your usual day, days read this month, and when in the day you read.
function youSection(days, rows, day, uw) {
  const table = h("div", { class: "info-table st-table" });
  const pace = trackedPace();
  table.append(row("Pace", pace ? `${wpm(pace)} words / min` : `≈ ${wpm(paceFor(null))} words / min · assumed`));
  if (uw) table.append(row("Usual day", formatDuration(uw.ms / 7)));
  const t = dayDate(day);
  const from = monthFrom(t.getFullYear(), t.getMonth());
  table.append(row("Days read this month", `${daysRead(days, from, day)} of ${daysBetween(from, day) + 1}`));
  return h("section", { class: "st-section" }, label("You"), table, whenYouRead(rows));
}

// The last 20 weeks (or since your first day), Monday first, month names on
// top; the line underneath shows a day's time and `detail(day)` — today's to
// begin with, then whichever day is tapped. Shades follow your own days — the
// quarters of your range — so a long day stands out from a usual one however
// much you read.
function heatmapSection(days, day, firstDay, detail) {
  const back = addDays(weekStart(day), -19 * 7);
  const firstWeek = firstDay ? weekStart(firstDay) : back;
  const start = firstWeek > back ? firstWeek : back;
  const weeksN = daysBetween(start, weekStart(day)) / 7 + 1;
  const vals = [];
  for (const [k, d] of days) if (k >= start && k <= day && d.ms >= MIN_DAY_MS) vals.push(d.ms);
  vals.sort((a, b) => a - b);
  const q = (f) => vals[Math.floor(f * (vals.length - 1))] ?? 0;
  const [q1, q2, q3] = [q(0.25), q(0.5), q(0.75)];
  const level = (ms) => (ms < MIN_DAY_MS ? 0 : ms <= q1 ? 1 : ms <= q2 ? 2 : ms <= q3 ? 3 : 4);
  const grid = h("div", { class: "st-cal__grid", role: "group", "aria-label": "Reading days" });
  const months = h("div", { class: "st-cal__months", "aria-hidden": "true" });
  const readout = h("div", { class: "st-cal__readout" }, "Tap a day");
  const line = (k) => {
    const d = days.get(k);
    if (!d || d.ms < MIN_DAY_MS) return "nothing read";
    const more = detail(k);
    return formatDuration(d.ms) + (more ? ` · ${more}` : "");
  };
  let sel = null;
  const select = (cell, k) => {
    if (sel) sel.classList.remove("is-sel");
    if (sel === cell) {
      sel = null;
      readout.textContent = "Tap a day";
      readout.classList.remove("is-on");
      return;
    }
    sel = cell;
    cell.classList.add("is-sel");
    readout.textContent = `${dayName(k, day)} · ${line(k)}`;
    readout.classList.add("is-on");
  };
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
    const cell = h("button", { type: "button", class: `st-cal__day l${level(d ? d.ms : 0)}${k === day ? " is-today" : ""}`, "aria-label": `${dayName(k, day)}: ${line(k)}` });
    cell.addEventListener("click", () => select(cell, k));
    grid.append(cell);
    if (k === day) select(cell, k);
  }
  const dows = h("div", { class: "st-cal__dows", "aria-hidden": "true" }, ["M", "", "W", "", "F", "", "S"].map((x) => h("span", null, x)));
  const legend = h(
    "div",
    { class: "st-cal__legend" },
    h("span", { class: "st-cal__spacer" }, vals.length >= 4 ? `${formatDuration(q1)} or less` : ""),
    h("span", null, "Less"),
    [0, 1, 2, 3, 4].map((l) => h("span", { class: "st-cal__day l" + l, "aria-hidden": "true" })),
    h("span", null, "More"),
    h("span", { class: "st-cal__spacer2" }, vals.length >= 4 ? `over ${formatDuration(q3)}` : "")
  );
  return h(
    "section",
    { class: "st-section" },
    label(weeksN >= 20 ? "Last 20 weeks" : "Reading days", "shades follow your own days"),
    h("div", { class: "st-cal" }, h("div", { class: "st-cal__body" }, h("div", { class: "st-cal__side" }, h("span", { class: "st-cal__mspacer" }), dows), h("div", null, months, grid))),
    readout,
    legend
  );
}

// Share of reading by hour of day, small; hidden until there's enough of it.
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
    bars.append(h("div", { class: "st-hours__bar" + (inPeak ? " is-peak" : ""), style: `height:${Math.max(1, Math.round((ms / max) * 40))}px` }));
  });
  const labels = h("div", { class: "st-bars__labels st-hours__labels" }, ["00", "06", "12", "18", "24"].map((x) => h("span", null, x)));
  return h(
    "div",
    { class: "st-when" },
    h("div", { class: "st-when__head" }, h("span", null, "When you read"), h("span", { class: "st-head__aside" }, `mostly ${hh(at)} – ${hh(at + 3)}`)),
    bars,
    labels
  );
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

/** The Library's "This week" strip, under Continue: this week, and last week beside it. */
export function weekStrip() {
  if (!hasAnyStats()) return null;
  const days = byDay(statRows());
  const day = today();
  const mon = weekStart(day);
  const week = [];
  for (let i = 0; i < 7; i++) week.push(days.get(addDays(mon, i))?.ms || 0);
  const total = week.reduce((a, b) => a + b, 0);
  const lw = addDays(mon, -7);
  const last = sumRange(days, lw, addDays(lw, 6)).ms;
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
      h("span", { class: "st-strip__v" }, total >= MIN_DAY_MS ? formatDuration(total) : "Not yet", last >= MIN_DAY_MS ? h("span", { class: "st-strip__ref" }, ` · last week ${formatDuration(last)}`) : null)
    ),
    bars,
    h("span", { class: "st-strip__chev" }, svg(ICON.chevron))
  );
}
