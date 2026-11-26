import { describe, it, expect } from "vitest";
import {
  dayKey,
  addDays,
  daysBetween,
  weekStart,
  spreadEstimate,
  streamSpans,
  currentStreak,
  longestStreak,
  formatDuration,
  formatHoursShort,
  wordsThrough,
  roundMilestones,
  dayReaching,
} from "../src/lib/stats.js";

const at = (y, m, d, hh = 12) => new Date(y, m - 1, d, hh).getTime();

describe("day keys", () => {
  it("uses the local calendar day", () => {
    expect(dayKey(at(2026, 11, 25, 23))).toBe("2026-11-25");
    expect(dayKey(at(2026, 1, 5, 0))).toBe("2026-01-05");
  });
  it("adds days across month and year ends", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("counts whole days, DST included", () => {
    expect(daysBetween("2026-10-20", "2026-11-05")).toBe(16);
    expect(daysBetween("2026-03-25", "2026-04-05")).toBe(11);
  });
  it("finds the Monday of a week", () => {
    expect(weekStart("2026-11-25")).toBe("2026-11-23"); // a Wednesday
    expect(weekStart("2026-11-23")).toBe("2026-11-23");
    expect(weekStart("2026-11-29")).toBe("2026-11-23"); // Sunday
  });
});

describe("spreadEstimate", () => {
  it("gives each day its share of the span", () => {
    const out = spreadEstimate({
      words: 1000,
      chapters: 10,
      startTs: at(2026, 10, 1, 12),
      endTs: at(2026, 10, 3, 12),
      beforeDay: "2026-11-01",
    });
    expect(out.map((r) => r.day)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(out.map((r) => r.words)).toEqual([250, 500, 250]);
    expect(out.map((r) => r.chapters)).toEqual([2.5, 5, 2.5]);
  });
  it("never reaches the day tracking began", () => {
    const out = spreadEstimate({
      words: 300,
      chapters: 3,
      startTs: at(2026, 11, 8, 0),
      endTs: at(2026, 11, 12),
      beforeDay: "2026-11-10",
    });
    expect(out.map((r) => r.day)).toEqual(["2026-11-08", "2026-11-09"]);
    expect(out.reduce((n, r) => n + r.words, 0)).toBeCloseTo(300);
  });
  it("collapses an empty or backwards span onto its last day", () => {
    const out = spreadEstimate({
      words: 500,
      chapters: 5,
      startTs: at(2026, 11, 5),
      endTs: at(2026, 11, 2),
      beforeDay: "2026-12-01",
    });
    expect(out).toEqual([{ day: "2026-11-02", words: 500, chapters: 5 }]);
  });
  it("collapses a span past the cut-off onto the day before it", () => {
    const out = spreadEstimate({
      words: 9,
      chapters: 1,
      startTs: at(2026, 11, 20),
      endTs: at(2026, 11, 21),
      beforeDay: "2026-11-10",
    });
    expect(out).toEqual([{ day: "2026-11-09", words: 9, chapters: 1 }]);
  });
});

describe("streamSpans", () => {
  it("lays items end to end in proportion to their words", () => {
    const out = streamSpans([{ words: 100 }, { words: 300 }], 0, 400);
    expect(out.map((x) => [x.start, x.end])).toEqual([
      [0, 100],
      [100, 400],
    ]);
  });
  it("copes with nothing to lay out", () => {
    expect(streamSpans([{ words: 0 }], 0, 10)).toEqual([{ words: 0, start: 0, end: 0 }]);
  });
});

describe("streaks", () => {
  const days = new Set(["2026-11-20", "2026-11-21", "2026-11-22", "2026-11-24", "2026-11-25"]);
  it("counts back from today", () => {
    expect(currentStreak(days, "2026-11-25")).toBe(2);
  });
  it("still counts from yesterday before today's reading", () => {
    expect(currentStreak(days, "2026-11-26")).toBe(2);
    expect(currentStreak(days, "2026-11-27")).toBe(0);
  });
  it("finds the longest run", () => {
    expect(longestStreak(days)).toBe(3);
    expect(longestStreak(new Set())).toBe(0);
  });
});

describe("durations", () => {
  it("reads as hours and minutes", () => {
    expect(formatDuration(54 * 60000)).toBe("54 min");
    expect(formatDuration((3 * 60 + 36) * 60000)).toBe("3 h 36");
    expect(formatDuration((3 * 60 + 5) * 60000)).toBe("3 h 05");
    expect(formatDuration(2 * 3600000)).toBe("2 h");
    expect(formatDuration(256.4 * 3600000)).toBe("256 h");
  });
  it("has a short chart form", () => {
    expect(formatHoursShort(0)).toBe("");
    expect(formatHoursShort(19.4 * 3600000)).toBe("19 h");
    expect(formatHoursShort(45 * 60000)).toBe("45 m");
  });
});

describe("milestones", () => {
  it("counts the unread words up to a chapter", () => {
    const ch = [
      { abs: 1, words: 100, frac: 1 },
      { abs: 2, words: 200, frac: 0.5 },
      { abs: 3, words: 300, frac: 0 },
    ];
    expect(wordsThrough(ch, 0)).toBe(0);
    expect(wordsThrough(ch, 1)).toBe(100);
    expect(wordsThrough(ch, 2)).toBe(400);
    expect(wordsThrough(ch, 9)).toBe(400);
    expect(wordsThrough(ch, 2, 2)).toBe(300);
  });
  it("picks round chapters by length", () => {
    expect(roundMilestones(2140, 2789)).toEqual({ behind: 2100, ahead: [2200] });
    expect(roundMilestones(1950, 2789)).toEqual({ behind: 1900, ahead: [2000] });
    expect(roundMilestones(1820, 2789)).toEqual({ behind: 1800, ahead: [1900, 2000] });
    expect(roundMilestones(120, 278)).toEqual({ behind: 100, ahead: [150] });
    expect(roundMilestones(8, 30)).toEqual({ behind: null, ahead: [] });
    // Never the last chapter itself — that has its own milestone.
    expect(roundMilestones(2750, 2800).ahead).toEqual([]);
  });
  it("finds the day a running total reaches a chapter", () => {
    const per = [
      ["2026-11-01", 3],
      ["2026-11-02", 4],
      ["2026-11-03", 2],
    ];
    expect(dayReaching(per, 5)).toBe("2026-11-02");
    expect(dayReaching(per, 9)).toBe("2026-11-03");
    expect(dayReaching(per, 10)).toBe(null);
    expect(dayReaching(per, 10, 100)).toBe("2026-11-01");
  });
});
