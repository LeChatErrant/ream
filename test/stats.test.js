import { describe, it, expect } from "vitest";
import {
  dayKey,
  addDays,
  daysBetween,
  weekStart,
  spreadEstimate,
  currentStreak,
  longestStreak,
  formatDuration,
  formatHoursShort,
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
  it("spreads evenly over the span, inclusive", () => {
    const out = spreadEstimate({
      words: 1000,
      chapters: 10,
      startTs: at(2026, 10, 1),
      endTs: at(2026, 10, 4),
      beforeDay: "2026-11-01",
    });
    expect(out.map((r) => r.day)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
    expect(out.every((r) => r.words === 250 && r.chapters === 2.5)).toBe(true);
  });
  it("never reaches the day tracking began", () => {
    const out = spreadEstimate({
      words: 300,
      chapters: 3,
      startTs: at(2026, 11, 8),
      endTs: at(2026, 11, 12),
      beforeDay: "2026-11-10",
    });
    expect(out.map((r) => r.day)).toEqual(["2026-11-08", "2026-11-09"]);
    expect(out.reduce((n, r) => n + r.words, 0)).toBe(300);
  });
  it("collapses a backwards span onto its last day", () => {
    const out = spreadEstimate({
      words: 500,
      chapters: 5,
      startTs: at(2026, 11, 5),
      endTs: at(2026, 11, 2),
      beforeDay: "2026-12-01",
    });
    expect(out).toEqual([{ day: "2026-11-02", words: 500, chapters: 5 }]);
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
