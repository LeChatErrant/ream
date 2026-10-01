import { describe, it, expect } from "vitest";
import { markBars, followShift, PERIOD, FOLLOW_MAX_SPEED, FOLLOW_JUMP } from "../src/lib/ream-mark.js";

const FRAME = 1 / 60;
const CAP = FOLLOW_MAX_SPEED * FRAME; // most the stack may move in one frame

// Scroll at `perFrame` lines a frame for `frames` frames, starting with the
// stack drawn at `shown` and the scroll at `target`. Returns each frame's
// { target, shown }.
function scroll(perFrame, frames, shown = 0, target = shown) {
  const out = [];
  for (let i = 0; i < frames; i++) {
    target += perFrame;
    shown = followShift(shown, target, perFrame, FRAME);
    out.push({ target, shown });
  }
  return out;
}
// How far the stack is out of step with the scroll, as the nearest equivalent pose.
const drift = ({ target, shown }) => {
  const d = (target - shown) % PERIOD;
  return d - PERIOD * Math.round(d / PERIOD);
};

describe("markBars", () => {
  it("repeats every PERIOD lines, so a pose PERIOD lines on looks the same", () => {
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
  it("moves exactly with a scroll slower than the cap", () => {
    for (const f of scroll(CAP / 2, 120)) expect(f.shown).toBeCloseTo(f.target, 9);
  });
  it("stops the moment the scroll stops — nothing left to glide", () => {
    expect(followShift(1.23, 5, 0, FRAME)).toBe(1.23);
  });
  it("moves no faster than the cap on a fast scroll, and never against it", () => {
    let prev = 0;
    for (const f of scroll(1.5, 60)) {
      const step = f.shown - prev;
      expect(step).toBeGreaterThanOrEqual(0);
      expect(step).toBeLessThanOrEqual(CAP + 1e-9);
      prev = f.shown;
    }
  });
  it("works off what a fast scroll left behind while you keep scrolling", () => {
    const after = scroll(1.5, 37).at(-1); // a flick: the stack falls out of step
    expect(Math.abs(drift(after))).toBeGreaterThan(0.1);
    const slow = scroll(CAP / 3, 240, after.shown, after.target);
    let prev = after.shown;
    for (const f of slow) {
      const step = f.shown - prev;
      expect(step).toBeGreaterThanOrEqual(0); // never back
      expect(step).toBeLessThanOrEqual(CAP + 1e-9); // never over the cap
      prev = f.shown;
    }
    expect(drift(slow.at(-1))).toBeCloseTo(0, 6);
  });
  it("snaps along with a jump no hand makes (a new chapter, a restored spot)", () => {
    expect(followShift(0.4, 0.4 - FOLLOW_JUMP - 5, -FOLLOW_JUMP - 5, FRAME)).toBe(0.4 - FOLLOW_JUMP - 5);
  });
});
