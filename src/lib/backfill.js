// -------------------------------------------------------------------------
// One-time history backfill — pure, so it can be unit-tested.
//
// Reading stats began on Nov 25, 2026, but the library had been read in Ream
// since Aug 24. Rather than keep an "estimated" mode around forever, the app
// writes that past once as ordinary day rows (see stats.js): the words and
// chapters each book had been read up to on the day tracking began, laid out
// day by day in reading order. The totals are exact; the days are made to
// read like a real reader's, not noise around a mean:
//   - momentum: good and bad stretches (an AR(1) mood carried day to day)
//   - the week: Fridays a little more, weekends more
//   - breaks: the odd day off, and now and then a few in a row
//   - binges: some days you just don't stop
//   - sittings: one to four a day, at your usual hours (mornings, lunch,
//     evenings, past midnight), of uneven lengths
//   - pace: a little faster or slower from one day to the next
// -------------------------------------------------------------------------
import { addDays, dayDate } from "./stats.js";

const MAX_DAY_MS = 9 * 3600000; // nobody reads more than this in a day
const MIN_SITTING = 8 * 60000;
// When people read, by clock hour, when you haven't been tracked long enough
// to say: mornings and lunch a little, evenings a lot, a bit past midnight.
export const DEFAULT_HOURS = [
  0.7, 0.3, 0.1, 0, 0, 0, 0.1, 0.5, 0.6, 0.2, 0.1, 0.2, 0.7, 0.6, 0.2, 0.2, 0.3, 0.4, 0.5, 0.8, 1.3, 2, 2.2, 1.6,
];
const WEEKDAY = [1.25, 0.95, 1, 0.95, 1, 1.1, 1.35]; // Sun … Sat

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
// A standard normal draw (Box–Muller).
const gauss = (rand) => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
function pick(weights, r) {
  const total = weights.reduce((a, b) => a + b, 0);
  let x = r * total;
  for (let i = 0; i < weights.length; i++) if ((x -= weights[i]) < 0) return i;
  return weights.length - 1;
}

// How much each day reads, relative to the others (0 = a day off).
// Breaks keep their distance from each other, and the last days before
// tracking began are read (you were mid-book when it did).
function dayIntensity(days, rand) {
  let mood = 0;
  let breakLeft = 0;
  let sinceBreak = 10;
  return days.map((d, i) => {
    mood = 0.75 * mood + 0.32 * gauss(rand); // carries over: good weeks, slow weeks
    const nearEnd = i >= days.length - 3;
    if (breakLeft > 0 && !nearEnd) {
      breakLeft--;
      return 0;
    }
    breakLeft = 0;
    sinceBreak++;
    if (!nearEnd && sinceBreak > 14 && i < days.length - 6 && rand() < 0.02) {
      breakLeft = 1 + Math.floor(rand() * 3); // a few days away
      sinceBreak = 0;
      return 0;
    }
    if (!nearEnd && rand() < 0.06) return 0; // just not today
    const dow = dayDate(d).getDay();
    const binge = rand() < (dow === 0 || dow === 6 ? 0.09 : 0.04) ? 1.8 + rand() * 0.9 : 1;
    return WEEKDAY[dow] * Math.exp(mood) * binge;
  });
}

// Shares summing to 1, none above `cap` (the excess goes to the days that
// read, in proportion).
function capShares(w, cap) {
  const sum = w.reduce((a, b) => a + b, 0);
  let share = w.map((x) => x / sum);
  for (let round = 0; round < 10; round++) {
    let excess = 0;
    share = share.map((x) => {
      if (x > cap) {
        excess += x - cap;
        return cap;
      }
      return x;
    });
    if (excess < 1e-12) break;
    const free = share.reduce((n, x, i) => n + (w[i] > 0 && x < cap ? x : 0), 0);
    if (free <= 0) break;
    share = share.map((x, i) => (w[i] > 0 && x < cap ? x + (excess * x) / free : x));
  }
  return share;
}

// A day's reading as sittings: [{ start (minutes after midnight, may pass 24 h),
// ms }], in time order, not overlapping.
function sittings(ms, hourWeights, rand) {
  let n = ms < 35 * 60000 ? 1 : ms < 90 * 60000 ? 1 + (rand() < 0.5 ? 1 : 0) : ms < 4 * 3600000 ? 2 + Math.floor(rand() * 2) : 3 + Math.floor(rand() * 2);
  n = Math.max(1, Math.min(n, Math.floor(ms / MIN_SITTING)));
  // Uneven lengths: one main sitting, shorter ones around it.
  const parts = Array.from({ length: n }, (_, i) => (i === 0 ? 1.6 : 0.4) + rand());
  const tot = parts.reduce((a, b) => a + b, 0);
  // Hours 0–3 belong to the evening before (days turn at 4 AM): as minutes,
  // they sit after 24:00.
  const out = parts.map((p) => {
    const h = pick(hourWeights, rand());
    return { start: (h < 4 ? h + 24 : h) * 60 + Math.floor(rand() * 60), ms: (ms * p) / tot };
  });
  out.sort((a, b) => a.start - b.start);
  for (let i = 1; i < out.length; i++) {
    const end = out[i - 1].start + out[i - 1].ms / 60000 + 15;
    if (out[i].start < end) out[i].start = end;
  }
  return out;
}

/**
 * items: [{ bookId, words, chapters }] in reading order; fromDay / toDay:
 * inclusive day keys; pace: words per ms (the total time is words ÷ pace);
 * hourWeights: 24 numbers. Returns stats rows ({ id, day, bookId, ms, paceMs,
 * words, chapters, sessions, best, hours, bf: 1 }) whose words and chapters
 * add up exactly.
 */
export function generateBackfill({ items, fromDay, toDay, pace, hourWeights = DEFAULT_HOURS, seed = 1 }) {
  const list = items.filter((it) => it.words > 0);
  const total = list.reduce((n, it) => n + it.words, 0);
  if (!total || !(pace > 0) || fromDay > toDay) return [];
  const days = [];
  for (let d = fromDay; d <= toDay; d = addDays(d, 1)) days.push(d);
  const rand = rng(seed);
  let w = dayIntensity(days, rand);
  if (!w.some((x) => x > 0)) w = w.map((_, i) => (i === w.length - 1 ? 1 : 0));
  // Words per day; time per day at a pace that drifts a little day to day,
  // rescaled so the whole still takes words ÷ pace.
  const capShare = Math.max(1 / days.length, (MAX_DAY_MS * pace * 0.85) / total);
  const shares = capShares(w, capShare);
  const dayPace = days.map(() => pace * Math.exp(0.08 * gauss(rand)));
  const rawMs = shares.map((s, i) => (total * s) / dayPace[i]);
  const k = total / pace / rawMs.reduce((a, b) => a + b, 0);

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
      const ch = Math.floor((it.chapters * usedW) / it.words + 1e-9) - usedCh;
      const part = { bookId: it.bookId, words: take, chapters: ch };
      usedCh += ch;
      if (it.words - usedW <= 1e-6) {
        part.chapters += it.chapters - usedCh;
        idx++;
        usedW = 0;
        usedCh = 0;
      }
      parts.push(part);
    }
    const ms = rawMs[i] * k;
    const sit = sittings(ms, hourWeights, rand);
    const hours = new Array(24).fill(0);
    for (const s of sit) {
      let t = s.start;
      let rem = s.ms;
      while (rem > 0) {
        const take = Math.min(rem, (60 - (t % 60)) * 60000);
        hours[Math.floor(t / 60) % 24] += take;
        rem -= take;
        t = Math.floor(t / 60) * 60 + 60;
      }
    }
    const longest = Math.max(...sit.map((s) => s.ms));
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
        sessions: Math.max(1, Math.round(sit.length * share)),
        best: Math.min(rowMs, longest),
        hours: hours.map((x) => x * share),
        bf: 1,
      });
    }
  });
  return out;
}
