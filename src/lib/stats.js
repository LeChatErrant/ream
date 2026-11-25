// -------------------------------------------------------------------------
// Reading-stats arithmetic — pure helpers with no DOM or storage, so they can be
// unit-tested: local calendar days, spreading an estimate over a span of days,
// streaks, and the duration / date wording the stats screens use.
// -------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, "0");

// "2026-11-25" — the LOCAL calendar day of a timestamp. Reading late at night
// belongs to the day you're living in, not to UTC's.
export function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
// Local midnight of a day key, as a Date.
export function dayDate(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(key, n) {
  const d = dayDate(key);
  d.setDate(d.getDate() + n);
  return dayKey(d.getTime());
}
// Whole days from `a` to `b` (b − a); DST-safe since both are local midnights.
export function daysBetween(a, b) {
  return Math.round((dayDate(b) - dayDate(a)) / 86400000);
}
// Monday of the week holding `key`.
export function weekStart(key) {
  const dow = (dayDate(key).getDay() + 6) % 7; // Mon = 0
  return addDays(key, -dow);
}

// Spread `words` and `chapters` over the time from `startTs` to `endTs`, each
// local day getting its share of the overlap — so back-to-back spans add up to a
// steady pace instead of doubling up on the day they meet. Nothing lands on
// `beforeDay` or later (that's when real tracking took over); a span that is
// empty, backwards or entirely past the cut-off collapses onto its last allowed
// day. Returns [{ day, words, chapters }].
export function spreadEstimate({ words, chapters, startTs, endTs, beforeDay }) {
  const cutoff = dayDate(beforeDay).getTime();
  const end = Math.min(endTs, cutoff);
  const start = Math.min(startTs, end);
  if (end - start <= 0) return [{ day: dayKey(Math.min(end, cutoff - 1)), words, chapters }];
  const out = [];
  for (let day = dayKey(start); dayDate(day).getTime() < end; day = addDays(day, 1)) {
    const from = Math.max(start, dayDate(day).getTime());
    const to = Math.min(end, dayDate(addDays(day, 1)).getTime());
    const share = (to - from) / (end - start);
    if (share > 0) out.push({ day, words: words * share, chapters: chapters * share });
  }
  return out;
}

// Lay `items` ({ words }) end to end between `startTs` and `endTs`, each taking
// time in proportion to its words — one steady reading pace across them all.
// Returns the items with `start` / `end` added.
export function streamSpans(items, startTs, endTs) {
  const total = items.reduce((n, it) => n + it.words, 0);
  const span = Math.max(0, endTs - startTs);
  let t = startTs;
  return items.map((it) => {
    const d = total ? (span * it.words) / total : 0;
    const out = { ...it, start: t, end: t + d };
    t += d;
    return out;
  });
}

// Consecutive reading days ending today — or yesterday, so a streak isn't
// "broken" in the morning before you've read. `days` is a Set of day keys.
export function currentStreak(days, today) {
  let d = days.has(today) ? today : addDays(today, -1);
  let n = 0;
  while (days.has(d)) {
    n++;
    d = addDays(d, -1);
  }
  return n;
}
export function longestStreak(days) {
  let best = 0;
  for (const d of days) {
    if (days.has(addDays(d, -1))) continue; // not the start of a run
    let n = 0;
    let x = d;
    while (days.has(x)) {
      n++;
      x = addDays(x, 1);
    }
    best = Math.max(best, n);
  }
  return best;
}

// "3 h 36", "54 min", "256 h" — hours and minutes, the minutes dropped once
// the hours alone say enough.
export function formatDuration(ms) {
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${totalMin} min`;
  const hrs = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  if (hrs >= 100) return `${Math.round(ms / 3600000).toLocaleString("en-US")} h`;
  return min ? `${hrs} h ${pad(min)}` : `${hrs} h`;
}
// Short form for chart labels: "19 h", "45 m".
export function formatHoursShort(ms) {
  if (ms <= 0) return "";
  const h = ms / 3600000;
  if (h >= 1) return `${Math.round(h)} h`;
  return `${Math.max(1, Math.round(ms / 60000))} m`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
export const monthShort = (i) => MONTHS[i];
// "Nov 16" — or "Nov 16, 2025" when it isn't this year.
export function formatDay(key, today) {
  const d = dayDate(key);
  const s = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return today && d.getFullYear() !== dayDate(today).getFullYear() ? `${s}, ${d.getFullYear()}` : s;
}
