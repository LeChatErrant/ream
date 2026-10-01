// =========================================================================
// Ream's mark — five lines of text stacked like a ream of paper, ragged like
// the reading column, the current (bottom) line lit. Pure geometry, shared by
// the live marks (src/brand.js: the Library header, where the stack scrolls
// with the shelf, and the reader's menu button, where it scrolls with the
// chapter) and the generated home-screen icons (scripts/icons.mjs).
// =========================================================================

// Mark box in viewBox units: five bars of BAR height on a PITCH rhythm.
export const MARK_W = 120;
export const BAR = 14;
export const PITCH = 24;
export const MARK_H = 4 * PITCH + BAR; // 110

// [left inset, right inset] of each line, top → bottom. The first five are the
// logo at rest; the last two only ever scroll into view. Scrolling cycles
// through all seven, so the rest pose recurs every LINES.length lines.
const LINES = [[0, 0], [8, 0], [0, 4], [12, 0], [0, 0], [4, 0], [0, 10]];
export const PERIOD = LINES.length; // markBars(s + PERIOD) draws exactly markBars(s)

// Shade by vertical position: top (oldest line, dimmest) → bottom (current).
const SHADES = ["#343c48", "#454e5c", "#5b6472", "#8f98a6", "#eff1f5"];

const SLOTS = 6; // five visible lines + the one scrolling in

function shade(pos) {
  const t = Math.max(0, Math.min(1, pos)) * (SHADES.length - 1);
  const i = Math.min(SHADES.length - 2, Math.floor(t));
  const a = SHADES[i], b = SHADES[i + 1], f = t - i;
  const ch = (hex, k) => parseInt(hex.slice(1 + 2 * k, 3 + 2 * k), 16);
  return "#" + [0, 1, 2].map((k) => Math.round(ch(a, k) + (ch(b, k) - ch(a, k)) * f).toString(16).padStart(2, "0")).join("");
}

// The stack scrolled by `shift` lines (fractional and negative are fine):
// always SLOTS bars, top → bottom. Lines slide up through the box, fading out
// past the top edge and in past the bottom one; whatever spills outside the
// MARK_W × MARK_H box is meant to be clipped by the viewBox.
export function markBars(shift = 0) {
  const whole = Math.floor(shift);
  const frac = shift - whole;
  const n = LINES.length;
  const bars = [];
  for (let k = 0; k < SLOTS; k++) {
    const y = (k - frac) * PITCH;
    const pos = y / (4 * PITCH); // 0 = top slot, 1 = bottom slot
    const edge = pos < 0 ? 1 + pos * 4 : pos > 1 ? 1 - (pos - 1) * 4 : 1;
    const [l, r] = LINES[(((k + whole) % n) + n) % n];
    bars.push({ x: l, y, w: MARK_W - l - r, fill: shade(pos), opacity: Math.max(0, Math.min(1, edge)) });
  }
  return bars;
}

// The live marks move with the scroll, frame by frame: each animation frame
// the stack moves as far as the scroll did, never faster than
// FOLLOW_MAX_SPEED lines a second, and it stops the moment the scroll stops
// (no easing, no catching up afterwards). Tied straight to the scroll
// position, a flick spun the stack faster than a line per frame, which strobes
// rather than moves.
//
// Capping a fast scroll leaves the stack out of step with the scroll. Since it
// repeats every PERIOD lines, that's at most half a period, and it's worked off
// only while you scroll: the stack moves up to FOLLOW_DRIFT_GAIN faster or
// slower than the scroll (same direction, within the cap) until it's back in
// step, so the top of the shelf / chapter still shows the exact logo. A jump of
// more than FOLLOW_JUMP lines in one frame isn't a hand on the screen (a new
// chapter, a restored position): the stack snaps along with the content.
export const FOLLOW_MAX_SPEED = 6; // lines / s
export const FOLLOW_DRIFT_GAIN = 0.5; // × the scroll's own motion
export const FOLLOW_JUMP = 3 * PERIOD; // lines in one frame

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// One frame of that: the shift to draw after `shown`, now that the scroll has
// moved `moved` lines (to `target`) over `dt` seconds.
export function followShift(shown, target, moved, dt) {
  if (Math.abs(moved) > FOLLOW_JUMP) return target;
  if (!moved) return shown;
  const cap = FOLLOW_MAX_SPEED * dt;
  let step = clamp(moved, -cap, cap);
  // How far out of step that leaves the stack, as the nearest equivalent pose.
  let drift = (target - shown - step) % PERIOD;
  drift -= PERIOD * Math.round(drift / PERIOD);
  const room = FOLLOW_DRIFT_GAIN * Math.abs(moved);
  step += clamp(drift, -room, room);
  // Never against the scroll, never over the cap.
  if (Math.sign(step) === -Math.sign(moved)) step = 0;
  return shown + clamp(step, -cap, cap);
}

// The mark at rest as SVG markup (bare <rect>s in MARK_W × MARK_H units).
export function markSvg() {
  return markBars(0)
    .filter((b) => b.opacity > 0)
    .map((b) => `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${BAR}" rx="${BAR / 2}" fill="${b.fill}"/>`)
    .join("");
}
