import { describe, it, expect } from "vitest";
import { markBars, followShift, PERIOD, FOLLOW_MAX_SPEED } from "../src/lib/ream-mark.js";

const FRAME = 1 / 60;

// Run the follower frame by frame; returns every shift it drew.
function follow(from, target, frames) {
  const drawn = [];
  let shown = from;
  for (let i = 0; i < frames; i++) drawn.push((shown = followShift(shown, target, FRAME)));
  return drawn;
}

describe("markBars", () => {
  it("repeats every PERIOD lines, so dropping whole periods is invisible", () => {
    for (const s of [0, 0.3, 2.75, -1.4]) {
      const a = markBars(s + PERIOD);
      markBars(s).forEach((b, i) => {
        expect(a[i].x).toBe(b.x);
        expect(a[i].w).toBe(b.w);
        expect(a[i].y).toBeCloseTo(b.y, 6);
        expect(a[i].opacity).toBeCloseTo(b.opacity, 6);
      });
    }
  });
});

describe("followShift", () => {
  it("eases onto the target and stays there", () => {
    const drawn = follow(0, 2.5, 120);
    expect(drawn.at(-1)).toBeCloseTo(2.5, 3);
    expect(drawn[0]).toBeGreaterThan(0);
    expect(drawn[0]).toBeLessThan(2.5);
  });
  it("never moves faster than the speed cap, however far the scroll jumped", () => {
    let shown = 0;
    for (let i = 0; i < 200; i++) {
      const next = followShift(shown, 900.4, FRAME);
      // Whole periods dropped at the start of the step don't count as motion.
      const moved = Math.abs(((((next - shown) % PERIOD) + PERIOD + PERIOD / 2) % PERIOD) - PERIOD / 2);
      expect(moved).toBeLessThanOrEqual(FOLLOW_MAX_SPEED * FRAME + 1e-9);
      shown = next;
    }
  });
  it("only travels the last part of a long jump, and settles within a second and a half", () => {
    const drawn = follow(0, 900.4, 90);
    expect(900.4 - drawn[0]).toBeLessThan(PERIOD);
    expect(drawn.at(-1)).toBeCloseTo(900.4, 2);
  });
  it("keeps going the way the scroll went (no turning back mid-flick)", () => {
    const fwd = follow(0, 900.4, 30);
    for (let i = 1; i < fwd.length; i++) expect(fwd[i]).toBeGreaterThanOrEqual(fwd[i - 1]);
    const back = follow(900.4, 0, 30);
    for (let i = 1; i < back.length; i++) expect(back[i]).toBeLessThanOrEqual(back[i - 1]);
  });
});
