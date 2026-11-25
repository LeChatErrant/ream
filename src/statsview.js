// =========================================================================
// STATS screen — reading stats for one book or series (pushed from its info
// page) or for the whole library (pushed from the Library's "This week" strip).
// Also builds those two ways in: the info page's "Reading stats" card and the
// Library strip. The data comes from stats.js; striped marks are estimates of
// reading done before tracking began.
// =========================================================================
import { el, h, svg, ICON, coverNode, progressBar } from "./dom.js";
import { books, progressMap, bookById, seriesById } from "./state.js";
import { chapterCount } from "./lib/chapters.js";
import { formatCompactNumber } from "./lib/format.js";
import { bestComparison, formatMultiplier, refShortTitle } from "./lib/comparisons.js";
import { ensureWordCount } from "./lib/wordcount.js";
import {
  dayKey, addDays, daysBetween, weekStart, dayDate, currentStreak, longestStreak,
  formatDuration, formatHoursShort, formatDay, monthShort, MONTHS_LONG,
} from "./lib/stats.js";
import {
  statRows, needsCounting, wordsLeft, paceFor, trackedPace, trackingSince, hasAnyStats, flushStats,
} from "./stats.js";
import {
  displayTitle, bookPercent, seriesVolumes, seriesPercent, currentVolume, absChapterNum, volumeNumber,
  wordsRead, bookIsStarted,
} from "./reading.js";
import { go } from "./router.js";

const MIN_DAY_MS = 60 * 1000; // a day counts as "read" from a minute on
const RECENT_DAYS = 14; // the window the finish-date projection averages over
let period = "week"; // the overall screen's Week / Month / Year / All
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

// Per-day totals: { ms, estMs, words, chapters, sessions, trackedMs }.
function byDay(rows) {
  const m = new Map();
  for (const r of rows) {
    let d = m.get(r.day);
    if (!d) m.set(r.day, (d = { ms: 0, estMs: 0, trackedMs: 0, words: 0, chapters: 0, sessions: 0 }));
    d.ms += r.ms;
    d.words += r.words;
    d.chapters += r.chapters;
    if (r.est) d.estMs += r.ms;
    else {
      d.trackedMs += r.ms;
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
function totals(days) {
  const t = { ms: 0, trackedMs: 0, estMs: 0, chapters: 0, sessions: 0, readDays: 0, first: null, firstEst: false };
  for (const [k, d] of days) {
    t.ms += d.ms;
    t.trackedMs += d.trackedMs;
    t.estMs += d.estMs;
    t.chapters += d.chapters;
    t.sessions += d.sessions;
    if (d.ms >= MIN_DAY_MS) t.readDays++;
    if (d.ms > 0 && (!t.first || k < t.first)) {
      t.first = k;
      t.firstEst = d.trackedMs === 0;
    }
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

// Bars of reading time, estimated time striped under the tracked time.
// buckets: [{ label, ms, estMs, trackedMs, current }]
function barChart(buckets, { height = 110, values = false, aria = "" } = {}) {
  const max = Math.max(1, ...buckets.map((b) => b.ms));
  const room = values ? height - 16 : height;
  const bars = h("div", { class: "st-bars", style: `height:${height}px`, role: "img", "aria-label": aria });
  const labels = h("div", { class: "st-bars__labels" });
  for (const b of buckets) {
    const px = b.ms > 0 ? Math.max(2, Math.round((b.ms / max) * room)) : 0;
    const stack = h("div", { class: "st-bars__stack", style: `height:${px}px` });
    if (b.trackedMs > 0) stack.append(h("div", { class: "st-bars__seg" + (b.current ? " is-current" : ""), style: `flex:${b.trackedMs}` }));
    if (b.estMs > 0) stack.append(h("div", { class: "st-bars__seg st-est", style: `flex:${b.estMs}` }));
    bars.append(
      h(
        "div",
        { class: "st-bars__col" },
        values && b.ms > 0 ? h("span", { class: "st-bars__val" }, formatHoursShort(b.ms)) : null,
        px ? stack : h("div", { class: "st-bars__stub" })
      )
    );
    labels.append(h("span", null, b.label || ""));
  }
  return h("div", { class: "st-chart" }, bars, labels);
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

  // Tiles — time read, time left, pace.
  const finished = m.left <= 0;
  const leftTile = finished
    ? tile("Time left", "Done", t.first ? "finished" : null)
    : tile("Time left", formatDuration(m.leftMs), m.finishIn != null ? `done ~${formatDay(addDays(today, m.finishIn), today)}` : "at your pace");
  content.append(
    h(
      "div",
      { class: "st-tiles st-tiles--3" },
      tile("Time read", formatDuration(t.ms), t.first ? `since ${t.firstEst ? "~" : ""}${formatDay(t.first, today)}` : null),
      leftTile,
      // Unmeasured, every estimated hour rests on the assumed pace — say so.
      tile("Your pace", (m.measured ? "" : "≈ ") + wpm(m.pace), m.measured ? "words / min" : "assumed for now")
    )
  );

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
  if (read) {
    table.append(row("Words read", formatCompactNumber(read) + (all ? ` of ${formatCompactNumber(all)}` : "")));
    const best = bestComparison(read);
    if (best) table.append(row("Like reading", `${formatMultiplier(best.ratio)} ${refShortTitle(best.ref)}`));
  }
  if (t.readDays) {
    const perDay = t.ms / t.readDays;
    const ch = Math.round(t.chapters / t.readDays);
    table.append(row("Average reading day", formatDuration(perDay) + (ch ? ` · ${ch} chapter${ch === 1 ? "" : "s"}` : "")));
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

// The chart buckets and headline for a period, plus the period before it.
function periodBuckets(kind, today, days) {
  const make = (from, to, lbl, current) => ({ ...sumRange(days, from, to), from, to, label: lbl, current });
  const t = dayDate(today);
  if (kind === "week") {
    const mon = weekStart(today);
    const names = ["M", "T", "W", "T", "F", "S", "S"];
    const buckets = names.map((n, i) => make(addDays(mon, i), addDays(mon, i), n, addDays(mon, i) === today));
    return { title: "This week", buckets, prevFrom: addDays(mon, -7), prevName: "last week" };
  }
  if (kind === "month") {
    const first = dayKey(new Date(t.getFullYear(), t.getMonth(), 1).getTime());
    const n = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
    const buckets = [];
    for (let i = 0; i < n; i++) {
      const k = addDays(first, i);
      buckets.push(make(k, k, [1, 8, 15, 22, 29].includes(i + 1) ? String(i + 1) : "", k === today));
    }
    const prevFirst = dayKey(new Date(t.getFullYear(), t.getMonth() - 1, 1).getTime());
    return { title: MONTHS_LONG[t.getMonth()], buckets, prevFrom: prevFirst, prevName: "last month" };
  }
  const monthBucket = (y, mo, lbl) => {
    const from = dayKey(new Date(y, mo, 1).getTime());
    const to = dayKey(new Date(y, mo + 1, 0).getTime());
    return make(from, to, lbl, y === t.getFullYear() && mo === t.getMonth());
  };
  if (kind === "year") {
    const y = t.getFullYear();
    const buckets = [];
    for (let mo = 0; mo < 12; mo++) buckets.push(monthBucket(y, mo, monthShort(mo)[0]));
    return { title: String(y), buckets, prevFrom: `${y - 1}-01-01`, prevName: "last year" };
  }
  // All time: one bar per month since the first reading.
  const first = [...days.keys()].sort()[0] || today;
  const f = dayDate(first);
  const buckets = [];
  let y = f.getFullYear();
  let mo = f.getMonth();
  while (y < t.getFullYear() || (y === t.getFullYear() && mo <= t.getMonth())) {
    buckets.push(monthBucket(y, mo, mo === 0 || !buckets.length ? `${monthShort(mo)}${mo === 0 && buckets.length ? " " + String(y).slice(2) : ""}` : monthShort(mo)));
    if (++mo > 11) {
      mo = 0;
      y++;
    }
  }
  return { title: "All time", buckets, prevFrom: null };
}

function renderOverall(content, scope) {
  const rows = statRows(idsOf(scope));
  const days = byDay(rows);
  const today = dayKey(Date.now());
  const all = totals(days);

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
            renderStats("all");
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

  // Headline + chart.
  const p = periodBuckets(period, today, days);
  const sum = p.buckets.reduce(
    (a, b) => ({ ms: a.ms + b.ms, words: a.words + b.words, chapters: a.chapters + b.chapters }),
    { ms: 0, words: 0, chapters: 0 }
  );
  const bits = [];
  if (sum.words >= 1) bits.push(`${formatCompactNumber(Math.round(sum.words))} words`);
  if (sum.chapters >= 1) bits.push(`${Math.round(sum.chapters).toLocaleString("en-US")} chapters`);
  if (p.prevFrom) {
    // Against the same stretch of the previous period (Monday to today's
    // weekday last week, …), so a half-done week isn't "less" than a whole one.
    const elapsed = daysBetween(p.buckets[0].from, today);
    const prev = sumRange(days, p.prevFrom, addDays(p.prevFrom, elapsed)).ms;
    if (prev > 0 && sum.ms > 0) {
      const d = Math.round(((sum.ms - prev) / prev) * 100);
      bits.push(d === 0 ? `same as this time ${p.prevName}` : `${Math.abs(d)}% ${d > 0 ? "more" : "less"} than this time ${p.prevName}`);
    }
  }
  content.append(
    h(
      "section",
      { class: "st-hero" },
      h("div", { class: "st-hero__k" }, p.title),
      h("div", { class: "st-hero__v" }, sum.ms ? formatDuration(sum.ms) : "0 min"),
      bits.length ? h("div", { class: "st-hero__sub" }, bits.join(" · ")) : null,
      barChart(p.buckets, { height: 110, aria: `Reading time, ${p.title}` })
    )
  );

  // Tiles.
  const tracked = trackedDays(days);
  const streak = currentStreak(tracked, today);
  const pace = trackedPace();
  content.append(
    h(
      "div",
      { class: "st-tiles st-tiles--2" },
      tile("Streak", `${streak} day${streak === 1 ? "" : "s"}`),
      tile("Average reading day", all.readDays ? formatDuration(all.ms / all.readDays) : "—"),
      tile("Pace", pace ? `${wpm(pace)} wpm` : `≈ ${wpm(paceFor(null))} wpm`, pace ? null : "assumed for now"),
      tile("Chapters a day", all.readDays ? String(Math.round(all.chapters / all.readDays)) : "—")
    )
  );

  content.append(h("section", { class: "st-section" }, label("Last 20 weeks"), calendar(days, today)));

  const when = whenYouRead(rows);
  if (when) content.append(when);

  // Books in this period.
  const from = p.buckets[0].from;
  const to = p.buckets.at(-1).to;
  // A series is one entry (its volumes summed), like it is on the shelf.
  const per = new Map(); // key → { ms, kind, id, title, cover }
  for (const r of rows) {
    if (r.day < from || r.day > to || r.ms <= 0) continue;
    const b = bookById(r.bookId);
    if (!b) continue;
    const s = b.seriesId && seriesById(b.seriesId);
    const key = s ? "s:" + s.id : "b:" + b.id;
    let e = per.get(key);
    if (!e) {
      e = s
        ? { ms: 0, kind: "series", id: s.id, title: s.name, cover: currentVolume(s) || b }
        : { ms: 0, kind: "book", id: b.id, title: displayTitle(b), cover: b };
      per.set(key, e);
    }
    e.ms += r.ms;
  }
  const ranked = [...per.values()].sort((a, b) => b.ms - a.ms).slice(0, 8);
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
    const name = { week: "this week", month: "this month", year: "this year", all: "" }[period];
    content.append(h("section", { class: "st-section" }, label(name ? `Books ${name}` : "Books"), list));
  }

  // All time.
  const words = books.reduce((n, b) => n + wordsRead(b), 0);
  const table = h("div", { class: "info-table st-table" });
  table.append(row("Time read", formatDuration(all.ms)));
  if (words) {
    table.append(row("Words read", formatCompactNumber(words)));
    const best = bestComparison(words);
    if (best) table.append(row("Like reading", `${formatMultiplier(best.ratio)} ${refShortTitle(best.ref)}`));
  }
  const finished = books.filter((b) => progressMap[b.id]?.finished || bookPercent(b) >= 100).length;
  table.append(row("Books finished", String(finished)));
  let longest = null;
  for (const [k, d] of days) if (d.trackedMs > 0 && (!longest || d.trackedMs > longest[1])) longest = [k, d.trackedMs];
  if (longest) table.append(row("Longest day", `${formatDuration(longest[1])} · ${formatDay(longest[0], today)}`));
  content.append(h("section", { class: "st-section" }, label("All time"), table));
  if (all.estMs > 0) content.append(estNote());
}

// 20 weeks of days, Monday first; estimated days striped.
function calendar(days, today) {
  const start = addDays(weekStart(today), -19 * 7);
  const level = (ms) => (ms < MIN_DAY_MS ? 0 : ms < 30 * 60000 ? 1 : ms < 90 * 60000 ? 2 : ms < 180 * 60000 ? 3 : 4);
  const grid = h("div", { class: "st-cal__grid", role: "img", "aria-label": "Reading days over the last 20 weeks" });
  for (let i = 0; i < 140; i++) {
    const k = addDays(start, i);
    const d = days.get(k);
    let cls = "st-cal__day";
    if (k > today) cls += " is-future";
    else if (d && d.trackedMs < MIN_DAY_MS && d.estMs > 0) cls += " st-est";
    else cls += " l" + level(d ? d.trackedMs : 0);
    grid.append(h("span", { class: cls, title: d && k <= today ? `${formatDay(k, today)} · ${formatDuration(d.ms)}` : null }));
  }
  const dows = h("div", { class: "st-cal__dows", "aria-hidden": "true" }, ["M", "", "W", "", "F", "", "S"].map((x) => h("span", null, x)));
  const legend = h(
    "div",
    { class: "st-cal__legend" },
    h("span", { class: "st-cal__est" }, h("span", { class: "st-cal__day st-est", "aria-hidden": "true" }), "estimated"),
    h("span", null, "Less"),
    [0, 1, 2, 3, 4].map((l) => h("span", { class: "st-cal__day l" + l, "aria-hidden": "true" })),
    h("span", null, "More")
  );
  return h("div", { class: "st-cal" }, h("div", { class: "st-cal__body" }, dows, grid), legend);
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
