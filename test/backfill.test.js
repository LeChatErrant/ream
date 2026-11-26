import { describe, it, expect } from "vitest";
import { generateBackfill } from "../src/lib/backfill.js";

const items = [
  { bookId: "v1", words: 300000, chapters: 120 },
  { bookId: "v2", words: 250000, chapters: 100 },
  { bookId: "v3", words: 90000, chapters: 37 },
  { bookId: "none", words: 0, chapters: 0 },
];
const run = (o = {}) => generateBackfill({ items, fromDay: "2026-08-24", toDay: "2026-11-24", pace: 250 / 60000, ...o });

describe("generateBackfill", () => {
  it("adds up to exactly what had been read, book by book", () => {
    const rows = run();
    for (const it of items.slice(0, 3)) {
      const mine = rows.filter((r) => r.bookId === it.bookId);
      expect(mine.reduce((n, r) => n + r.words, 0)).toBeCloseTo(it.words, 3);
      expect(mine.reduce((n, r) => n + r.chapters, 0)).toBe(it.chapters);
      for (const r of mine) expect(Number.isInteger(r.chapters) && r.chapters >= 0).toBe(true);
    }
    expect(rows.some((r) => r.bookId === "none")).toBe(false);
  });
  it("turns words into time at the given pace, inside the span, in reading order", () => {
    const rows = run();
    const ms = rows.reduce((n, r) => n + r.ms, 0);
    expect(ms).toBeCloseTo(640000 / (250 / 60000), 0);
    expect(rows.every((r) => r.day >= "2026-08-24" && r.day <= "2026-11-24")).toBe(true);
    const lastV1 = rows.filter((r) => r.bookId === "v1").at(-1).day;
    const firstV2 = rows.find((r) => r.bookId === "v2").day;
    expect(firstV2 >= lastV1).toBe(true);
    for (const r of rows) expect(r.hours.reduce((a, b) => a + b, 0)).toBeCloseTo(r.ms, 0);
  });
  it("varies days like real reading, never past 9 h", () => {
    const rows = run();
    const perDay = new Map();
    for (const r of rows) perDay.set(r.day, (perDay.get(r.day) || 0) + r.ms);
    const v = [...perDay.values()];
    expect(perDay.size).toBeLessThan(93); // some days off
    expect(perDay.size).toBeGreaterThan(60);
    expect(Math.max(...v)).toBeLessThanOrEqual(9 * 3600000 + 1);
    expect(Math.max(...v)).toBeGreaterThan(1.5 * Math.min(...v));
  });
  it("is deterministic and copes with nothing to place", () => {
    expect(run()).toEqual(run());
    expect(run({ items: [] })).toEqual([]);
    expect(run({ fromDay: "2026-12-01" })).toEqual([]);
  });
});
