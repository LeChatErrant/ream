import { describe, it, expect } from "vitest";
import {
  dayKey,
  addDays,
  daysBetween,
  weekStart,
  readingDay,
  formatDay,
  formatDuration,
  formatHoursShort,
  wordsThrough,
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

describe("reading day", () => {
  it("turns at 4 AM, not midnight", () => {
    expect(readingDay(at(2026, 11, 26, 23))).toBe("2026-11-26");
    expect(readingDay(at(2026, 11, 27, 1))).toBe("2026-11-26");
    expect(readingDay(at(2026, 11, 27, 3))).toBe("2026-11-26");
    expect(readingDay(at(2026, 11, 27, 4))).toBe("2026-11-27");
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

describe("words left", () => {
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
});

describe("formatDay", () => {
  it("adds the year only for dates about a year off", () => {
    expect(formatDay("2026-11-16", "2026-11-26")).toBe("Nov 16");
    expect(formatDay("2026-12-21", "2027-01-12")).toBe("Dec 21");
    expect(formatDay("2025-11-16", "2027-01-12")).toBe("Nov 16, 2025");
  });
});
