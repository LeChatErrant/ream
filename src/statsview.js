// =========================================================================
// STATS screen — reading stats for one book or series (pushed from its info
// page) or for the whole library (pushed from the Library's "This week" strip).
// Also builds those two ways in: the info page's "Reading stats" card and the
// Library strip. The data comes from stats.js; striped marks are estimates of
// reading done before tracking began. Averages, records and the calendar use
// tracked days only — the estimate is a flat guess, not days you lived.
// =========================================================================
import { el, h, svg, ICON, coverNode, progressBar } from "./dom.js";
import { books, progressMap, bookById, seriesById } from "./state.js";
import { chapterCount, readableChapters, baseHref, chapterDisplay, chapterOrdinalFor } from "./lib/chapters.js";
import { formatCompactNumber } from "./lib/format.js";
import { ensureWordCount } from "./lib/wordcount.js";
import {
  dayKey, addDays, daysBetween, weekStart, dayDate, currentStreak, longestStreak,
  formatDuration, formatHoursShort, formatDay, monthShort, MONTHS_LONG, wordsThrough, roundMilestones, dayReaching,
} from "./lib/stats.js";
import {
  statRows, needsCounting, wordsLeft, paceFor, trackedPace, trackingSince, hasAnyStats, flushStats,
} from "./stats.js";
import {
  displayTitle, bookPercent, seriesVolumes, seriesPercent, currentVolume, absChapterNum, volumeNumber,
  wordsRead, bookIsStarted, volumeChapterOffset,
} from "./reading.js";
import { go } from "./router.js";

const MIN_DAY_MS = 60 * 1000; // a day counts as "read" from a minute on
const RECENT_DAYS = 14; // the window the finish-date projection averages over
let period = "week"; // the overall screen's Week / Month / Year / All
let offset = 0; // which one: 0 the current, −1 the one before, …
let renderToken = 0;

const STATS_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M5 20v-8M12 20V5M19 20v-5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>';

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

// Per-day totals: { ms, estMs, words, chapters, sessions, trackedMs, trackedChapters }.
function byDay(rows) {
  const m = new Map();
  for (const r of rows) {
    let d = m.get(r.day);
    if (!d) m.set(r.day, (d = { ms: 0, estMs: 0, trackedMs: 0, words: 0, chapters: 0, trackedChapters: 0, sessions: 0 }));
    d.ms += r.ms;
    d.words += r.words;
    d.chapters += r.chapters;
    if (r.est) d.estMs += r.ms;
    else {
      d.trackedMs += r.ms;
      d.trackedChapters += r.chapters;
      d.sessions += r.sessions || 0;
    }
  }
  return m;
}
function sumRange(days, from, to) {
  const out = { ms: 0, estMs: 0, trackedMs: 0, words: 0, chapters: 0 };
  for (const [k, d] of days) {
    if (k < from || k > to) continue;
    out.ms += d.ms;
    out.estMs += d.estMs;
    out.trackedMs += d.trackedMs;
    out.words += d.words;
    out.chapters += d.chapters;
  }
  return out;
}
// The averages (`dayMs`, `dayChapters`) come from tracked days alone: the
// estimate is one flat stream by construction, so it would smear a few minutes
// over every day since Aug 24 and drag "a reading day" down to nothing.
function totals(days) {
  const t = { ms: 0, trackedMs: 0, estMs: 0, chapters: 0, sessions: 0, readDays: 0, dayMs: 0, dayChapters: 0, first: null, firstEst: false };
  let trackedChapters = 0;
  for (const [k, d] of days) {
    t.ms += d.ms;
    t.trackedMs += d.trackedMs;
    t.estMs += d.estMs;
    t.chapters += d.chapters;
    t.sessions += d.sessions;
    if (d.trackedMs >= MIN_DAY_MS) {
      t.readDays++;
      trackedChapters += d.trackedChapters;
    }
    if (d.ms > 0 && (!t.first || k < t.first)) {
      t.first = k;
      t.firstEst = d.trackedMs === 0;
    }
  }
  if (t.readDays) {
    t.dayMs = t.trackedMs / t.readDays;
    t.dayChapters = trackedChapters / t.readDays;
  }
  return t;
}
const trackedDays = (days) => new Set([...days].filter(([, d]) => d.trackedMs >= MIN_DAY_MS).map(([k]) => k));

// Average reading time per calendar day lately — what a finish date projects with.
function recentRate(days, today, first) {
  if (!first) return 0;
  const span = Math.min(RECENT_DAYS, daysBetween(first, today) + 1);
  return sumRange(days, addDays(today, -(span - 1)), today).ms / span;
}

// ---- Shared pieces ------------------------------------------------------------

const label = (text, extra) =>
  h("div", { class: "st-head" }, h("span", { class: "lib-label" }, text), extra ? h("span", { class: "st-head__aside" }, extra) : null);
const row = (k, v) => h("div", { class: "info-trow" }, h("span", { class: "info-trow__k" }, k), h("span", { class: "info-trow__v" }, v));
const tile = (k, v, sub) =>
  h("div", { class: "st-tile" }, h("div", { class: "st-tile__k" }, k), h("div", { class: "st-tile__v" }, v), sub ? h("div", { class: "st-tile__sub" }, sub) : null);
const wpm = (pace) => Math.round(pace * 60000);
const plural = (n, w) => `${n.toLocaleString("en-US")} ${w}${n === 1 ? "" : "s"}`;
// "2.5", "12" — one decimal while it still says something.
const perDayNum = (x) => (x < 10 ? String(Math.round(x * 10) / 10) : String(Math.round(x)));
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dayName = (k, today) => `${DOW[dayDate(k).getDay()]}, ${formatDay(k, today)}`;
// Calendar shade for a day's tracked time.
const level = (ms) => (ms < MIN_DAY_MS ? 0 : ms < 30 * 60000 ? 1 : ms < 90 * 60000 ? 2 : ms < 180 * 60000 ? 3 : 4);

// Bars of reading time, estimated time striped under the tracked time.
// buckets: [{ label, name, ms, estMs, trackedMs, current }]. With `onPick`,
// each bar is a button: tapping one calls onPick(index), tapping it again
// (or another chart redraw) calls onPick(null).
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
    const stack = h("div", { class: "st-bars__stack", style: `height:${px}px` });
    if (b.trackedMs > 0) stack.append(h("div", { class: "st-bars__seg" + (b.current ? " is-current" : ""), style: `flex:${b.trackedMs}` }));
    if (b.estMs > 0) stack.append(h("div", { class: "st-bars__seg st-est", style: `flex:${b.estMs}` }));
    const kids = [values && b.ms > 0 ? h("span", { class: "st-bars__val" }, formatHoursShort(b.ms)) : null, px ? stack : h("div", { class: "st-bars__stub" })];
    const col = onPick
      ? h("button", { type: "button", class: "st-bars__col", "aria-label": `${b.name || b.label}: ${b.ms ? formatDuration(b.ms) : "nothing read"}`, "aria-pressed": "false" }, ...kids)
      : h("div", { class: "st-bars__col" }, ...kids);
    if (onPick)
      col.addEventListener("click", () => {
        picked = picked === i ? null : i;
        chart.classList.toggle("has-pick", picked != null);
        cols.forEach((c, j) => {
          c.classList.toggle("is-picked", j === picked);
          c.setAttribute("aria-pressed", j === picked ? "true" : "false");
        });
        onPick(picked);
      });
    cols.push(col);
    bars.append(col);
    labels.append(h("span", null, b.label || ""));
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

const estNote = () =>
  h(
    "p",
    { class: "st-note" },
    h("span", { class: "st-swatch st-est", "aria-hidden": "true" }),
    `Striped: estimated from your progress before ${formatDay(trackingSince())}, when tracking began.`
  );

// ---- Screen -----------------------------------------------------------------

export function renderStats(kind, id) {
  const root = el.statsScreen;
  const scope = scopeOf(kind, id);
  root.innerHTML = "";
  if (!scope) {
    go({ route: "library" });
    return;
  }
  flushStats(); // the reader may have just closed — show its last minutes
  const token = ++renderToken;
  root.append(bar(scope));
  const content = h("div", { class: "st-content" });
  root.append(content);
  root.scrollTop = 0;

  // Estimates and "time left" need word counts; count what's missing first,
  // one book at a time (each walks a whole epub), then draw.
  const pending = needsCounting(scope.kind === "all" ? scope.books.filter(bookIsStarted) : scope.books);
  if (pending.length) {
    const msg = h("p", { class: "st-empty" }, "Counting words…");
    content.append(msg);
    (async () => {
      for (let i = 0; i < pending.length; i++) {
        if (token !== renderToken) return;
        msg.textContent = `Counting words · ${i + 1} of ${pending.length}`;
        await ensureWordCount(pending[i]).catch(() => {});
      }
      if (token === renderToken && document.getElementById("app").dataset.route === "stats") renderStats(kind, id);
    })();
    return;
  }

  if (scope.kind === "all") renderOverall(content, scope);
  else renderBook(content, scope);
}

// ---- One book / series --------------------------------------------------------

function bookModel(scope) {
  const ids = idsOf(scope);
  const rows = statRows(ids);
  const days = byDay(rows);
  const t = totals(days);
  const today = dayKey(Date.now());
  const pace = paceFor(ids);
  const measured = !!(trackedPace(ids) || trackedPace());
  const left = scope.books.reduce((n, b) => n + wordsLeft(b), 0);
  const leftMs = left / pace;
  const rate = recentRate(days, today, t.first);
  const finishIn = rate > 0 && leftMs > 0 ? Math.ceil(leftMs / rate) : null;
  return { ids, rows, days, t, today, pace, measured, left, leftMs, rate, finishIn };
}

// Chapters finished a day lately (tracked days of the last two weeks, counted
// from when tracking began) and this week so far; null before any tracking.
function chaptersLately(days, today) {
  const since = trackingSince();
  const from = addDays(today, -(RECENT_DAYS - 1)) > since ? addDays(today, -(RECENT_DAYS - 1)) : since;
  let any = false;
  let ch = 0;
  let week = 0;
  const mon = weekStart(today);
  for (const [k, d] of days) {
    if (k < since || k > today || !(d.trackedMs > 0)) continue;
    any = true;
    if (k >= from) ch += d.trackedChapters;
    if (k >= mon) week += d.trackedChapters;
  }
  return any ? { perDay: ch / (daysBetween(from, today) + 1), week: Math.round(week) } : null;
}

function renderBook(content, scope) {
  const m = bookModel(scope);
  const { t, today } = m;

  // Header — cover, title, where you are.
  let where;
  let pct;
  if (scope.kind === "series") {
    const cur = currentVolume(scope.series);
    const total = scope.books.reduce((n, b) => n + chapterCount(b), 0);
    pct = seriesPercent(scope.series);
    const p = cur && progressMap[cur.id];
    where = p ? `Chapter ${absChapterNum(cur, p).toLocaleString("en-US")} of ${total.toLocaleString("en-US")} · ${pct}%` : `${total.toLocaleString("en-US")} chapters`;
  } else {
    const b = scope.books[0];
    const p = progressMap[b.id];
    pct = bookPercent(b);
    where = p ? `Chapter ${absChapterNum(b, p).toLocaleString("en-US")} of ${chapterCount(b).toLocaleString("en-US")} · ${pct}%` : "Not started";
  }
  content.append(
    h(
      "div",
      { class: "st-book" },
      coverNode(scope.coverBook, "st-book__cover"),
      h(
        "div",
        { class: "st-book__text" },
        h("div", { class: "st-book__title" }, scope.title),
        h("div", { class: "st-book__where" }, where),
        progressBar(pct, "card")
      )
    )
  );

  if (!t.ms) {
    content.append(h("p", { class: "st-empty" }, "Nothing read yet. Your reading time shows up here once you start."));
    return;
  }

  // Tiles — time read, time left, chapters a day.
  const finished = m.left <= 0;
  // A series may still be coming out: the end of what you have is "caught up".
  const doneWord = scope.kind === "series" ? "caught up" : "done";
  const leftTile = finished
    ? tile("Time left", "Done", t.first ? (scope.kind === "series" ? "caught up" : "finished") : null)
    : tile("Time left", formatDuration(m.leftMs), m.finishIn != null ? `${doneWord} ~${formatDay(addDays(today, m.finishIn), today)}` : "at your pace");
  const lately = chaptersLately(m.days, today);
  content.append(
    h(
      "div",
      { class: "st-tiles st-tiles--3" },
      tile("Time read", formatDuration(t.ms), t.first ? `since ${t.firstEst ? "~" : ""}${formatDay(t.first, today)}` : null),
      leftTile,
      tile("Chapters a day", lately ? perDayNum(lately.perDay) : "—", lately ? `${lately.week} this week` : "once tracked")
    )
  );

  const miles = milestones(scope, m);
  if (miles) content.append(h("section", { class: "st-section" }, label("Milestones", m.finishIn != null ? "at your recent pace" : null), miles));

  if (scope.kind === "series" && scope.books.length > 1) {
    const tl = volumeTimeline(scope, m);
    if (tl) content.append(h("section", { class: "st-section" }, label("Volumes"), tl));
  }

  // Hours per week, last 8 weeks.
  const thisWeek = weekStart(today);
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
    h(
      "section",
      { class: "st-section" },
      label("Hours per week", "last 8 weeks"),
      barChart(weeks, { height: 118, values: true, aria: "Hours read per week over the last 8 weeks" })
    )
  );

  // Details.
  const read = scope.books.reduce((n, b) => n + wordsRead(b), 0);
  const all = scope.books.reduce((n, b) => n + (b.wordCount || 0), 0);
  const table = h("div", { class: "info-table st-table" });
  if (read) table.append(row("Words read", formatCompactNumber(read) + (all ? ` of ${formatCompactNumber(all)}` : "")));
  // Unmeasured, every estimated hour rests on the assumed pace — say so.
  table.append(row("Pace", m.measured ? `${wpm(m.pace)} words / min` : `≈ ${wpm(m.pace)} words / min · assumed`));
  if (t.readDays) {
    const ch = Math.round(t.dayChapters);
    table.append(row("Average reading day", formatDuration(t.dayMs) + (ch ? ` · ${ch} chapter${ch === 1 ? "" : "s"}` : "")));
  }
  appendTrackedRows(table, m.days, today);
  content.append(h("section", { class: "st-section" }, label("Details"), table));
  if (t.estMs > 0) content.append(estNote());
}

// Rows only tracking can know: days read, streak, sessions.
function appendTrackedRows(table, days, today) {
  const since = trackingSince();
  const span = daysBetween(since, today) + 1;
  const tracked = trackedDays(days);
  table.append(row("Days read", `${tracked.size} of ${span} since tracking`));
  const cur = currentStreak(tracked, today);
  const best = longestStreak(tracked);
  table.append(row("Streak", `${cur} day${cur === 1 ? "" : "s"}` + (best > cur ? ` · best ${best}` : "")));
  let sessions = 0;
  let ms = 0;
  for (const d of days.values()) {
    sessions += d.sessions;
    ms += d.trackedMs;
  }
  if (sessions) table.append(row("Sessions", `${sessions} · ${formatDuration(ms / sessions)} average`));
}

// Every readable chapter of the scope in reading order: { abs, words, frac, book }.
// Word counts are kept per file, and a file can hold several chapters, so a
// file's words are split between its chapters, then scaled to the book's total
// so milestones add up to the same "time left" as the tiles.
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

// Where you are on the road through a book / series: the last round chapter
// behind you (when you got there, estimated before tracking), the chapter
// you're on, and what's ahead — the next round chapters, the end of this
// volume, the last chapter — dated at your recent reading rate.
function milestones(scope, m) {
  const list = chapterList(scope.books);
  if (!list.length || m.left <= 0) return null;
  // "Now" is where the saved position is, as in the header — not the first
  // unfinished chapter, which a skipped one would pin far behind you.
  const book = scope.kind === "series" ? currentVolume(scope.series) : scope.books[0];
  const at = progressMap[book?.id] ? chapterOrdinalFor(book, progressMap[book.id]) - 1 : 0;
  let cur = list.findIndex((c) => c.book === book && c.i === at);
  if (cur < 0) cur = list.findIndex((c) => c.frac < 1);
  if (cur < 0) return null;
  // Per-chapter counts and the tiles' chapter-weighted "time left" differ a
  // little (front matter, uneven chapters): scale so the last milestone lands
  // on the tiles' date. A big gap means unread chapters behind you — leave it.
  const toEnd = wordsThrough(list, list.length - 1, cur);
  const k = toEnd > 0 ? m.left / toEnd : 1;
  const fit = k > 0.75 && k < 1.33 ? k : 1;
  const ahead = (i) => wordsThrough(list, i, cur) * fit;
  const today = m.today;
  const fmt = (n) => n.toLocaleString("en-US");
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
    if (i > cur) targets.set(i, { label: `Chapter ${fmt(list[i].abs)}` });
  }
  if (scope.kind === "series") {
    const vol = list[cur].book;
    let end = cur;
    while (end + 1 < list.length && list[end + 1].book === vol) end++;
    if (end < lastIdx) targets.set(end, { label: `End of Vol. ${volumeNumber(scope.series, vol)}`, sub: `chapter ${fmt(list[end].abs)}` });
  }
  if (lastIdx > cur) targets.set(lastIdx, { label: scope.kind === "series" ? "Caught up" : "The end", sub: `chapter ${fmt(list[lastIdx].abs)}` });

  const rows = [];
  const mile = (kind, text, sub, when, whenSub) =>
    h(
      "div",
      { class: "st-mile is-" + kind },
      h("span", { class: "st-mile__dot", "aria-hidden": "true" }),
      h("span", { class: "st-mile__text" }, h("span", { class: "st-mile__label" }, text), sub ? h("span", { class: "st-mile__sub" }, sub) : null),
      h("span", { class: "st-mile__when" }, when, whenSub ? h("span", { class: "st-mile__sub" }, whenSub) : null)
    );

  // Behind: the day the running count of finished chapters (estimated, then
  // tracked) reached it — anchored so the count today matches where you are.
  const behind = round.behind;
  if (behind != null) {
    const bi = list.findIndex((c) => c.abs >= behind);
    const perDay = [...m.days].filter(([, d]) => d.chapters > 0).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, d]) => [k, d.chapters]);
    const counted = perDay.reduce((n, [, c]) => n + c, 0);
    const shift = cur - counted; // chapters done that no reading explains (marked read, skipped)
    const day = bi >= 0 && bi + 1 > shift ? dayReaching(perDay, bi + 1, shift) : null;
    if (day) {
      const est = day < trackingSince();
      rows.push(mile("past", `Chapter ${fmt(behind)}`, null, `${est ? "~" : ""}${formatDay(day, today)}`, null));
    }
  }
  rows.push(mile("now", `Chapter ${fmt(curAbs)}`, list[cur].frac > 0 ? `${Math.round(list[cur].frac * 100)}% in` : null, "now", null));

  const perDayMs = m.rate;
  for (const [i, tg] of [...targets].sort((a, b) => a[0] - b[0]).slice(0, 4)) {
    if (!(perDayMs > 0)) {
      rows.push(mile("ahead", tg.label, tg.sub, formatDuration(ahead(i) / m.pace), "of reading"));
      continue;
    }
    const days = ahead(i) / m.pace / perDayMs;
    if (days > 3 * 365) continue;
    const n = Math.max(0, Math.ceil(days - 0.05));
    rows.push(mile("ahead", tg.label, tg.sub, n === 0 ? "today" : formatDay(addDays(today, n), today), n === 0 ? null : n === 1 ? "tomorrow" : `in ${plural(n, "day")}`));
  }
  return rows.length > 1 ? h("div", { class: "st-miles" }, rows) : null;
}

// One bar per volume across time: estimated (striped), tracked (solid), still
// ahead at your pace (dashed), and a line for today.
function volumeTimeline(scope, m) {
  const today = m.today;
  const vols = scope.books.map((b) => {
    const r = m.rows.filter((x) => x.bookId === b.id && x.ms > 0);
    const est = r.filter((x) => x.est).map((x) => x.day).sort();
    const tr = r.filter((x) => !x.est).map((x) => x.day).sort();
    const estMs = r.filter((x) => x.est).reduce((n, x) => n + x.ms, 0);
    const trMs = r.filter((x) => !x.est).reduce((n, x) => n + x.ms, 0);
    return { b, est, tr, estMs, trMs };
  });
  const firsts = vols.flatMap((v) => [v.est[0], v.tr[0]]).filter(Boolean).sort();
  if (!firsts.length) return null;
  const start = firsts[0];
  const off = (k) => daysBetween(start, k);
  const todayOff = off(today) + 1;

  // Projection: the unfinished volumes, one after another, at your recent rate.
  let cursor = todayOff;
  for (const v of vols) {
    if (bookPercent(v.b) >= 100 || !m.rate) continue;
    const days = wordsLeft(v.b) / m.pace / m.rate;
    if (!(days > 0) || cursor + days - todayOff > 365) continue;
    v.ahead = [cursor, cursor + days];
    cursor += days;
  }
  const end = Math.max(todayOff, cursor, ...vols.flatMap((v) => [v.est.at(-1), v.tr.at(-1)]).filter(Boolean).map((k) => off(k) + 1));
  const pc = (x) => `${((x / end) * 100).toFixed(2)}%`;
  const seg = (a, b, cls) => h("div", { class: "st-tl__seg " + cls, style: `left:${pc(a)};width:${pc(Math.max(b - a, 0.6))}` });

  const grid = h("div", { class: "st-tl", role: "img", "aria-label": "When each volume was read" });
  const marks = h("div", { class: "st-tl__marks", "aria-hidden": "true" });
  marks.append(h("div", { class: "st-tl__today", style: `left:${pc(todayOff)}` }));
  grid.append(marks);
  const kinds = new Set();
  for (const v of vols) {
    const track = h("div", { class: "st-tl__track" });
    if (v.est.length) {
      track.append(seg(off(v.est[0]), off(v.est.at(-1)) + 1, "st-est"));
      kinds.add("est");
    }
    if (v.tr.length) {
      track.append(seg(off(v.tr[0]), off(v.tr.at(-1)) + 1, "is-tracked"));
      kinds.add("tracked");
    }
    if (v.ahead) {
      track.append(seg(v.ahead[0], v.ahead[1], "is-ahead"));
      kinds.add("ahead");
    }
    const ms = v.estMs + v.trMs;
    grid.append(
      h(
        "div",
        { class: "st-tl__row" },
        h("span", { class: "st-tl__name" }, "Vol. " + volumeNumber(scope.series, v.b)),
        track,
        h("span", { class: "st-tl__time" }, ms ? formatHoursShort(ms) : "")
      )
    );
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
  if (kinds.has("est")) legend.append(item("st-est", "estimated"));
  if (kinds.has("tracked")) legend.append(item("is-tracked", "tracked"));
  if (kinds.has("ahead")) legend.append(item("is-ahead", "at your pace"));
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
function periodBuckets(kind, today, days, off) {
  const make = (from, to, lbl, name) => ({ ...sumRange(days, from, to), from, to, label: lbl, name, current: from === today && to === today });
  const t = dayDate(today);
  if (kind === "week") {
    const mon = addDays(weekStart(today), 7 * off);
    const sun = addDays(mon, 6);
    const names = ["M", "T", "W", "T", "F", "S", "S"];
    const buckets = names.map((n, i) => make(addDays(mon, i), addDays(mon, i), n, dayName(addDays(mon, i), today)));
    const sameMonth = dayDate(mon).getMonth() === dayDate(sun).getMonth();
    const title = off === 0 ? "This week" : off === -1 ? "Last week" : `${formatDay(mon, today)} – ${sameMonth ? dayDate(sun).getDate() : formatDay(sun, today)}`;
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
      buckets.push(make(k, k, [1, 8, 15, 22, 29].includes(i + 1) ? String(i + 1) : "", dayName(k, today)));
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
  const first = [...days.keys()].sort()[0] || today;
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
  return { title: "All time", buckets, from: first, to: today, prevFrom: null };
}

// "12% more than this time last week" / "… than the month before" — tracked
// against tracked only: the estimate is a flat guess, so a comparison with it
// would measure the guess, not you.
function comparison(p, days, today, off) {
  if (!p.prevFrom) return null;
  const end = off === 0 ? today : p.to;
  const cur = sumRange(days, p.from, end);
  const prevEnd = addDays(p.from, -1);
  let prevTo = addDays(p.prevFrom, daysBetween(p.from, end));
  if (prevTo > prevEnd) prevTo = prevEnd;
  const prev = sumRange(days, p.prevFrom, prevTo);
  if (!(prev.ms > 0) || !(cur.ms > 0) || prev.estMs || cur.estMs) return null;
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
  for (const r of rows) {
    if (r.day < from || r.day > to || r.ms <= 0) continue;
    const e = shelfEntry(r.bookId);
    if (!e) continue;
    if (!per.has(e.key)) per.set(e.key, { ...e, ms: 0 });
    per.get(e.key).ms += r.ms;
  }
  return [...per.values()].sort((a, b) => b.ms - a.ms);
}

function renderOverall(content, scope) {
  const rows = statRows(idsOf(scope));
  const days = byDay(rows);
  const today = dayKey(Date.now());
  const all = totals(days);
  const rerender = () => renderStats("all");

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

  // Headline + chart; ‹ › step through earlier periods, a tapped bar takes
  // over the headline until it's tapped again.
  const p = periodBuckets(period, today, days, offset);
  const sum = p.buckets.reduce(
    (a, b) => ({ ms: a.ms + b.ms, estMs: a.estMs + b.estMs, words: a.words + b.words, chapters: a.chapters + b.chapters }),
    { ms: 0, estMs: 0, words: 0, chapters: 0 }
  );
  const bits = [];
  if (sum.words >= 1) bits.push(`${formatCompactNumber(Math.round(sum.words))} words`);
  if (sum.chapters >= 1) bits.push(plural(Math.round(sum.chapters), "chapter"));
  const cmp = comparison(p, days, today, offset);
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
    if (b.estMs > 0 && !b.trackedMs) sub.push("estimated");
    show({ k: b.name, v: b.ms ? (b.estMs > b.trackedMs ? "≈ " : "") + formatDuration(b.ms) : "Nothing read", sub: sub.join(" · ") });
  };
  const firstDay = [...days.keys()].filter((k) => days.get(k).ms > 0).sort()[0];
  const step = (d) => {
    offset += d;
    rerender();
  };
  const nav =
    period === "all"
      ? null
      : h(
          "div",
          { class: "st-hero__nav" },
          h("button", { class: "st-navbtn", "aria-label": `Previous ${p.unit}`, disabled: !(firstDay && firstDay < p.from), onclick: () => step(-1) }, svg(ICON.back)),
          h("button", { class: "st-navbtn st-navbtn--next", "aria-label": `Next ${p.unit}`, disabled: offset >= 0, onclick: () => step(1) }, svg(ICON.back))
        );
  content.append(
    h(
      "section",
      { class: "st-hero" },
      h("div", { class: "st-hero__head" }, kEl, nav),
      vEl,
      subEl,
      barChart(p.buckets, { height: 110, aria: `Reading time, ${p.title}. Tap a bar for its details.`, onPick: pick })
    )
  );

  // Tiles — this period's tracked days.
  content.append(periodTiles(days, p.from, p.to, today));

  content.append(calendarSection(days, today));

  const when = whenYouRead(rows);
  if (when) content.append(when);

  // Books in this period — a series is one entry, like on the shelf.
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
    const name = period === "all" ? "" : offset === 0 ? `this ${p.unit}` : p.unit === "week" && offset === -1 ? "last week" : p.title;
    content.append(h("section", { class: "st-section" }, label(name ? `Books · ${name}` : "Books"), list));
  }

  const rec = records(days, rows, today);
  if (rec) content.append(h("section", { class: "st-section" }, label("Records", "since tracking"), rec));

  // All time.
  const words = books.reduce((n, b) => n + wordsRead(b), 0);
  const pace = trackedPace();
  const table = h("div", { class: "info-table st-table" });
  table.append(row("Time read", formatDuration(all.ms)));
  if (words) table.append(row("Words read", formatCompactNumber(words)));
  table.append(row("Pace", pace ? `${wpm(pace)} words / min` : `≈ ${wpm(paceFor(null))} words / min · assumed`));
  content.append(h("section", { class: "st-section" }, label("All time"), table));
  if (all.estMs > 0) content.append(estNote());
}

// Days read, average day, chapters a day and best day for the tracked part of
// [from, to] (up to today).
function periodTiles(days, from, to, today) {
  const since = trackingSince();
  const start = from > since ? from : since;
  const end = to < today ? to : today;
  if (start > end)
    return h("p", { class: "st-note st-note--tiles" }, `All before tracking began on ${formatDay(since, today)} — the bars above are estimated from your progress.`);
  let n = 0;
  let ms = 0;
  let ch = 0;
  let best = null;
  for (let k = start; k <= end; k = addDays(k, 1)) {
    const d = days.get(k);
    if (!d || d.trackedMs < MIN_DAY_MS) continue;
    n++;
    ms += d.trackedMs;
    ch += d.trackedChapters;
    if (!best || d.trackedMs > best[1]) best = [k, d.trackedMs];
  }
  const span = daysBetween(start, end) + 1;
  return h(
    "div",
    { class: "st-tiles st-tiles--2" },
    tile("Days read", String(n), `of ${plural(span, "day")}${start > from ? " tracked" : ""}`),
    tile("Average day", n ? formatDuration(ms / n) : "—"),
    tile("Chapters a day", n ? perDayNum(ch / n) : "—"),
    tile("Best day", best ? formatDuration(best[1]) : "—", best ? dayName(best[0], today) : null)
  );
}

// Personal bests from tracked reading.
function records(days, rows, today) {
  const tracked = trackedDays(days);
  if (!tracked.size) return null;
  const table = h("div", { class: "info-table st-table" });
  const cur = currentStreak(tracked, today);
  const longest = longestStreak(tracked);
  table.append(row("Streak", plural(cur, "day") + (longest > cur ? ` · best ${longest}` : "")));
  let day = null;
  let chDay = null;
  const weeks = new Map();
  for (const [k, d] of days) {
    if (!(d.trackedMs > 0)) continue;
    if (!day || d.trackedMs > day[1]) day = [k, d.trackedMs];
    if (d.trackedChapters >= 1 && (!chDay || d.trackedChapters > chDay[1])) chDay = [k, d.trackedChapters];
    const w = weekStart(k);
    weeks.set(w, (weeks.get(w) || 0) + d.trackedMs);
  }
  let week = null;
  for (const [w, ms] of weeks) if (!week || ms > week[1]) week = [w, ms];
  let session = null;
  for (const r of rows) if (!r.est && r.best > 0 && (!session || r.best > session[1])) session = [r.day, r.best];
  if (day) table.append(row("Longest day", `${formatDuration(day[1])} · ${formatDay(day[0], today)}`));
  if (week && weeks.size > 1) table.append(row("Best week", `${formatDuration(week[1])} · week of ${formatDay(week[0], today)}`));
  if (chDay) table.append(row("Most chapters in a day", `${Math.round(chDay[1])} · ${formatDay(chDay[0], today)}`));
  if (session) table.append(row("Longest session", `${formatDuration(session[1])} · ${formatDay(session[0], today)}`));
  return table;
}

// Tracked days only — before tracking there's nothing day-by-day to show.
// The first five weeks: month grids (big enough to read a day at a glance);
// after that, the last 20 weeks as a heat map.
function calendarSection(days, today) {
  const since = trackingSince();
  const legend = h(
    "div",
    { class: "st-cal__legend" },
    h("span", { class: "st-cal__since" }, `Tracked since ${formatDay(since, today)}`),
    h("span", null, "Less"),
    [0, 1, 2, 3, 4].map((l) => h("span", { class: "st-cal__day l" + l, "aria-hidden": "true" })),
    h("span", null, "More")
  );
  if (daysBetween(since, today) + 1 < 35) {
    const sec = h("section", { class: "st-section" });
    const s = dayDate(since);
    const t = dayDate(today);
    for (let y = s.getFullYear(), mo = s.getMonth(); y < t.getFullYear() || (y === t.getFullYear() && mo <= t.getMonth()); mo === 11 ? (y++, (mo = 0)) : mo++) {
      sec.append(label(MONTHS_LONG[mo] + (y !== t.getFullYear() ? ` ${y}` : "")), monthGrid(days, today, since, y, mo));
    }
    sec.append(legend);
    return sec;
  }
  return h("section", { class: "st-section" }, label("Last 20 weeks"), heatmap(days, today, since), legend);
}

function dayTitle(k, d, today) {
  return d && d.trackedMs > 0 ? `${formatDay(k, today)} · ${formatDuration(d.trackedMs)}` : formatDay(k, today);
}

function monthGrid(days, today, since, y, mo) {
  const grid = h("div", { class: "st-month", role: "img", "aria-label": `Reading days, ${MONTHS_LONG[mo]} ${y}` });
  for (const n of ["M", "T", "W", "T", "F", "S", "S"]) grid.append(h("span", { class: "st-month__dow", "aria-hidden": "true" }, n));
  const first = new Date(y, mo, 1);
  for (let i = (first.getDay() + 6) % 7; i > 0; i--) grid.append(h("span"));
  const n = new Date(y, mo + 1, 0).getDate();
  for (let i = 1; i <= n; i++) {
    const k = dayKey(new Date(y, mo, i).getTime());
    const d = days.get(k);
    let cls = "st-month__day";
    if (k > today) cls += " is-future";
    else if (k < since) cls += " is-before";
    else cls += " l" + level(d ? d.trackedMs : 0);
    if (k === today) cls += " is-today";
    grid.append(h("span", { class: cls, title: k <= today && k >= since ? dayTitle(k, d, today) : null }, String(i)));
  }
  return grid;
}

// 20 weeks of days, Monday first; days before tracking left blank.
function heatmap(days, today, since) {
  const start = addDays(weekStart(today), -19 * 7);
  const grid = h("div", { class: "st-cal__grid", role: "img", "aria-label": "Reading days over the last 20 weeks" });
  for (let i = 0; i < 140; i++) {
    const k = addDays(start, i);
    const d = days.get(k);
    let cls = "st-cal__day";
    if (k > today) cls += " is-future";
    else if (k < since) cls += " is-before";
    else cls += " l" + level(d ? d.trackedMs : 0);
    if (k === today) cls += " is-today";
    grid.append(h("span", { class: cls, title: k <= today && k >= since ? dayTitle(k, d, today) : null }));
  }
  const dows = h("div", { class: "st-cal__dows", "aria-hidden": "true" }, ["M", "", "W", "", "F", "", "S"].map((x) => h("span", null, x)));
  return h("div", { class: "st-cal" }, h("div", { class: "st-cal__body" }, dows, grid));
}

// Share of tracked reading by hour of day; hidden until there's enough of it.
function whenYouRead(rows) {
  const hours = new Array(24).fill(0);
  for (const r of rows) if (!r.est && r.hours) r.hours.forEach((ms, i) => (hours[i] += ms));
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
 * them (as the recap rows do) and repaints in place.
 */
export function paintStatsCard(host, kind, id) {
  host.innerHTML = "";
  const card = statsCard(kind, id);
  if (!card) return;
  host.append(card);
  const scope = scopeOf(kind, id);
  const pending = needsCounting(scope.books);
  if (pending.length)
    Promise.all(pending.map((b) => ensureWordCount(b).catch(() => {}))).then(() => {
      if (host.isConnected) paintStatsCard(host, kind, id);
    });
}
function statsCard(kind, id) {
  const scope = scopeOf(kind, id);
  if (!scope || !scope.books.some(bookIsStarted)) return null;
  const ids = idsOf(scope);
  const ms = statRows(ids).reduce((n, r) => n + r.ms, 0);
  const left = scope.books.reduce((n, b) => n + wordsLeft(b), 0);
  const counted = !needsCounting(scope.books).length;
  const bits = [];
  if (ms >= MIN_DAY_MS) bits.push(`${formatDuration(ms)} read`);
  if (counted && left > 0 && ms >= MIN_DAY_MS) bits.push(`about ${formatDuration(left / paceFor(ids))} left`);
  else if (counted && left <= 0) bits.push("finished");
  return h(
    "button",
    { class: "st-card", onclick: () => go({ route: "stats", kind, id }) },
    h("span", { class: "st-card__icon" }, svg(STATS_ICON)),
    h(
      "span",
      { class: "st-card__text" },
      h("span", { class: "st-card__title" }, "Reading stats"),
      h("span", { class: "st-card__sub" }, bits.length ? bits.join(" · ") : "Time, pace and time left")
    ),
    h("span", { class: "st-card__chev" }, svg(ICON.chevron))
  );
}

/** The Library's "This week" strip, under Continue. */
export function weekStrip() {
  if (!hasAnyStats()) return null;
  const rows = statRows();
  const days = byDay(rows);
  const today = dayKey(Date.now());
  const mon = weekStart(today);
  const week = [];
  for (let i = 0; i < 7; i++) week.push(days.get(addDays(mon, i))?.ms || 0);
  const total = week.reduce((a, b) => a + b, 0);
  const streak = currentStreak(trackedDays(days), today);
  const max = Math.max(...week, 1);
  const bars = h("span", { class: "st-strip__bars", "aria-hidden": "true" });
  week.forEach((ms, i) => {
    const isToday = addDays(mon, i) === today;
    bars.append(h("span", { class: "st-strip__bar" + (isToday ? " is-today" : ms ? " is-on" : ""), style: `height:${Math.max(2, Math.round((ms / max) * 30))}px` }));
  });
  return h(
    "button",
    { class: "st-strip", onclick: () => go({ route: "stats", kind: "all" }), "aria-label": "Reading stats" },
    h(
      "span",
      { class: "st-strip__text" },
      h("span", { class: "st-strip__k" }, "This week"),
      h(
        "span",
        { class: "st-strip__v" },
        total >= MIN_DAY_MS ? formatDuration(total) : "Not yet",
        streak >= 2 ? h("span", { class: "st-strip__streak" }, ` · ${streak}-day streak`) : null
      )
    ),
    bars,
    h("span", { class: "st-strip__chev" }, svg(ICON.chevron))
  );
}
