// -------------------------------------------------------------------------
// Reading-stats arithmetic — pure helpers with no DOM or storage, so they can be
// unit-tested: local calendar days (and the 4 AM reading day), streaks, and the
// duration / date wording the stats screens use.
// -------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, "0");

// "2026-11-25" — the LOCAL calendar day of a timestamp. Reading late at night
// belongs to the day you're living in, not to UTC's.
export function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
// The READING day a moment belongs to: days turn at 4 AM, not midnight, so a
// session from 23:00 to 01:00 is one evening's reading, not two days'.
export const DAY_START_HOUR = 4;
export function readingDay(ts) {
  return dayKey(ts - DAY_START_HOUR * 3600000);
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
// "Nov 16" — or "Nov 16, 2025" when it's in another year and far enough off
// (about a year) that the month alone could be misread.
export function formatDay(key, today) {
  const d = dayDate(key);
  const s = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  if (!today || d.getFullYear() === dayDate(today).getFullYear()) return s;
  return Math.abs(daysBetween(key, today)) > 300 ? `${s}, ${d.getFullYear()}` : s;
}

// Words still to read from the chapter at `from` through the one at `idx`
// (inclusive), over a reading-order list of chapters [{ words, frac }] (frac:
// share already read).
export function wordsThrough(chapters, idx, from = 0) {
  let w = 0;
  for (let i = from; i <= idx && i < chapters.length; i++) w += chapters[i].words * (1 - Math.min(1, chapters[i].frac));
  return w;
}

// The round chapter numbers worth a milestone, ahead of `cur` (the chapter
// being read) and up to `last`: the next hundred (fifty in shorter books, none
// under 150 chapters) and the next thousand in very long ones. Plus the last
// round number already behind you. Returns { behind, ahead: [n…] }.
export function roundMilestones(cur, last) {
  const step = last >= 500 ? 100 : last >= 150 ? 50 : 0;
  if (!step) return { behind: null, ahead: [] };
  const ahead = new Set();
  const next = Math.ceil(cur / step) * step;
  if (next < last) ahead.add(next);
  if (last >= 2000) {
    const k = Math.ceil(cur / 1000) * 1000;
    if (k < last) ahead.add(k);
  }
  const prev = Math.floor((cur - 1) / step) * step;
  return { behind: prev > 0 ? prev : null, ahead: [...ahead].sort((a, b) => a - b) };
}

// The first day the running total of `perDay` ([[day, chapters]] in day order),
// shifted by `offset`, reaches `n` — when chapter n was finished — or null.
export function dayReaching(perDay, n, offset = 0) {
  let sum = offset;
  for (const [day, ch] of perDay) {
    sum += ch;
    if (sum >= n - 1e-6) return day;
  }
  return null;
}
