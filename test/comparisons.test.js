import { describe, it, expect } from "vitest";
import { COMPARISON_BOOKS, refTitle, refShortTitle, formatMultiplier, bestComparison } from "../src/lib/comparisons.js";

describe("refShortTitle", () => {
  it("uses the short name when there is one, the full title otherwise", () => {
    const lotr = COMPARISON_BOOKS.find((r) => r.title === "The Lord of the Rings");
    expect(refTitle(lotr)).toBe("The Lord of the Rings (all 3 books)");
    expect(refShortTitle(lotr)).toBe("Lord of the Rings trilogy");
    const hobbit = COMPARISON_BOOKS.find((r) => r.title === "The Hobbit");
    expect(refShortTitle(hobbit)).toBe("The Hobbit");
  });
  // With its multiplier ("0.95× "), a 25-character name still fits beside
  // "Like reading" on a 360px-wide phone, with room to spare for wider fonts.
  it("keeps every row name short enough for one line on a phone", () => {
    for (const ref of COMPARISON_BOOKS) expect(refShortTitle(ref).length).toBeLessThanOrEqual(25);
  });
});

describe("bestComparison", () => {
  it("picks the closest reference on a log scale", () => {
    expect(bestComparison(95000).ref.title).toBe("The Hobbit");
  });
  it("measures very long reads against The Lord of the Rings, the biggest reference", () => {
    const best = bestComparison(1_700_000);
    expect(best.ref.title).toBe("The Lord of the Rings");
    expect(formatMultiplier(best.ratio)).toBe("3.6×");
  });
  it("returns null when there is nothing worth comparing", () => {
    expect(bestComparison(0)).toBe(null);
    expect(bestComparison(100)).toBe(null);
  });
});
