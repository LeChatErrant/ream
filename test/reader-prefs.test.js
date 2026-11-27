import { describe, it, expect } from "vitest";
import { DEFAULTS, SIZES, normalizePrefs, isDefault, stepSize, prefsCss } from "../src/lib/reader-prefs.js";

describe("reader prefs", () => {
  it("defaults are today's look and add no CSS at all", () => {
    expect(prefsCss(DEFAULTS)).toBe("");
    expect(prefsCss(undefined)).toBe("");
    expect(isDefault(normalizePrefs(undefined))).toBe(true);
  });

  it("cleans unknown or stale values back to the defaults", () => {
    expect(normalizePrefs({ size: 103, spacing: "huge", theme: "sepia" })).toEqual(DEFAULTS);
    expect(normalizePrefs({ size: 120, spacing: "relaxed", theme: "light" })).toEqual({
      size: 120,
      spacing: "relaxed",
      theme: "light",
    });
  });

  it("steps the size ladder and holds at its ends", () => {
    expect(stepSize(100, 1)).toBe(110);
    expect(stepSize(100, -1)).toBe(90);
    expect(stepSize(SIZES[0], -1)).toBe(SIZES[0]);
    expect(stepSize(SIZES.at(-1), 1)).toBe(SIZES.at(-1));
    expect(stepSize(7, 1)).toBe(110); // unknown → from the default
  });

  it("scales the theme's px sizes, phone and wide", () => {
    const css = prefsCss({ ...DEFAULTS, size: 120 });
    expect(css).toContain("body { font-size: 22.2px !important; }");
    expect(css).toContain("body { font-size: 24px !important; }");
    expect(css).not.toContain("line-height");
    expect(css).not.toContain("background");
  });

  it("only spacing → only line-height", () => {
    const css = prefsCss({ ...DEFAULTS, spacing: "compact" });
    expect(css).toBe("body, p, div, span, li, td, th, blockquote { line-height: 1.55 !important; }");
  });

  it("light theme recolours the page", () => {
    const css = prefsCss({ ...DEFAULTS, theme: "light" });
    expect(css).toContain("background: #f7f5f0");
    expect(css).not.toContain("font-size");
  });
});
