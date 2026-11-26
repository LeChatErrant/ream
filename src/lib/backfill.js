// -------------------------------------------------------------------------
// One-time history backfill — pure, so it can be unit-tested.
//
// Reading stats began on Nov 25, 2026, but the library had been read in Ream
// since Aug 24. Rather than keep an "estimated" mode around forever, the app
// writes that past once as ordinary day rows (see stats.js): the words and
// chapters each book had been read up to on the day tracking began, laid out
// day by day in reading order at your pace. Days vary like real ones — some
// off, weekends longer, sessions in the evening — but the totals are exact.
// -------------------------------------------------------------------------
import { addDays, dayDate } from "./stats.js";

const MAX_DAY_MS = 9 * 3600000; // nobody reads more than this in a day
const SESSION_MS = 50 * 60000; // a typical sitting
// When people read, by clock hour, when you haven't been tracked long enough
// to say: mornings and lunch a little, evenings a lot, a bit past midnight.
export const DEFAULT_HOURS = [
  0.7, 0.3, 0.1, 0, 0, 0, 0.1, 0.5, 0.6, 0.2, 0.1, 0.2, 0.7, 0.6, 0.2, 0.2, 0.3, 0.4, 0.5, 0.8, 1.3, 2, 2.2, 1.6,
];

// Small seeded PRNG (mulberry32): the same input always backfills the same way.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick(weights, r) {
  const total = weights.reduce((a, b) => a + b, 0);
  let x = r * total;
  for (let i = 0; i < weights.length; i++) if ((x -= weights[i]) < 0) return i;
  return weights.length - 1;
}

// Per-day share of the reading: ~1 day in 10 off, weekends a bit longer, the
// rest log-normal-ish around the mean — modestly, so your real days set the
// records — capped at MAX_DAY_MS, the excess spread over the other days.
function dayWeights(days, rand, capShare) {
  const w = days.map((d) => {
    if (rand() < 0.1) return 0;
    const dow = dayDate(d).getDay();
    const weekend = dow === 0 || dow === 6 ? 1.3 : 1;
    return weekend * Math.exp((rand() + rand() + rand() - 1.5) * 0.55);
  });
  if (!w.some((x) => x > 0)) w[w.length - 1] = 1;
  let sum = w.reduce((a, b) => a + b, 0);
  let share = w.map((x) => x / sum);
  for (let round = 0; round < 8; round++) {
    let excess = 0;
    let free = 0;
    share = share.map((x) => {
      if (x > capShare) {
        excess += x - capShare;
        return capShare;
      }
      return x;
    });
    if (excess < 1e-9) break;
    share.forEach((x, i) => {
      if (w[i] > 0 && x < capShare) free += x;
    });
    if (free <= 0) break;
    share = share.map((x, i) => (w[i] > 0 && x < capShare ? x + (excess * x) / free : x));
  }
  sum = share.reduce((a, b) => a + b, 0);
  return share.map((x) => x / sum);
}

// Clock hours of one sitting of `ms` starting at hour `h` (a random minute in).
function spreadHours(hours, h, ms, rand) {
  let t = ms;
  let room = (1 - rand() * 0.8) * 3600000;
  while (t > 0) {
    const take = Math.min(t, room);
    hours[h % 24] += take;
    t -= take;
    h++;
    room = 3600000;
  }
}

/**
 * items: [{ bookId, words, chapters }] in reading order; fromDay / toDay:
 * inclusive day keys; pace: words per ms; hourWeights: 24 numbers.
 * Returns stats rows ({ id, day, bookId, ms, paceMs, words, chapters,
 * sessions, best, hours, bf: 1 }) whose words and chapters add up exactly.
 */
export function generateBackfill({ items, fromDay, toDay, pace, hourWeights = DEFAULT_HOURS, seed = 1 }) {
  const list = items.filter((it) => it.words > 0);
  const total = list.reduce((n, it) => n + it.words, 0);
  if (!total || !(pace > 0) || fromDay > toDay) return [];
  const days = [];
  for (let d = fromDay; d <= toDay; d = addDays(d, 1)) days.push(d);
  const rand = rng(seed);
  const shares = dayWeights(days, rand, Math.max(1 / days.length, (MAX_DAY_MS * pace) / total));

  const out = [];
  let idx = 0;
  let usedW = 0;
  let usedCh = 0;
  days.forEach((day, i) => {
    const dayWords = total * shares[i];
    if (dayWords <= 0 || idx >= list.length) return;
    // This day's words, book by book in reading order; chapters follow the
    // words, whole ones only, and each book ends on its exact count.
    const parts = [];
    let left = dayWords;
    while (left > 1e-6 && idx < list.length) {
      const it = list[idx];
      const take = Math.min(it.words - usedW, left);
      usedW += take;
      left -= take;
      const part = { bookId: it.bookId, words: take, chapters: 0 };
      const ch = Math.floor((it.chapters * usedW) / it.words + 1e-9) - usedCh;
      part.chapters = ch;
      usedCh += ch;
      if (it.words - usedW <= 1e-6) {
        part.chapters += it.chapters - usedCh;
        idx++;
        usedW = 0;
        usedCh = 0;
      }
      parts.push(part);
    }
    const ms = dayWords / pace;
    const sessions = Math.max(1, Math.round((ms / SESSION_MS) * (0.7 + rand() * 0.6)));
    // One or two sittings at likely hours.
    const hours = new Array(24).fill(0);
    if (sessions > 1 && ms > 90 * 60000) {
      const first = ms * (0.25 + rand() * 0.2);
      spreadHours(hours, pick(hourWeights, rand()), first, rand);
      spreadHours(hours, pick(hourWeights, rand()), ms - first, rand);
    } else spreadHours(hours, pick(hourWeights, rand()), ms, rand);
    const longest = Math.min(ms, (ms / sessions) * (1.1 + rand() * 0.4));
    for (const p of parts) {
      const share = p.words / dayWords;
      const rowMs = ms * share;
      out.push({
        id: `${day}|${p.bookId}`,
        day,
        bookId: p.bookId,
        ms: rowMs,
        paceMs: rowMs,
        words: p.words,
        chapters: p.chapters,
        sessions: Math.max(1, Math.round(sessions * share)),
        best: Math.min(rowMs, longest),
        hours: hours.map((x) => x * share),
        bf: 1,
      });
    }
  });
  return out;
}
