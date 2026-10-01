// =========================================================================
// Brand — the live Ream mark, in two places:
//
// - Library header: wired to the shelf's scroll. As the books scroll up, lines
//   scroll up through the mark (one line per LIB_LINE_PX).
// - Reader menu button (in place of a burger): wired to the chapter's scroll by
//   reader.js — one line of the mark per line of text (READER_LINE_PX), so the
//   stack ticks along as you read.
//
// The current line is always lit at the bottom, and at the top of the shelf /
// chapter the mark rests on exactly the logo. Rather than jump with every
// scroll event, each mark glides after the scroll on its own animation frames,
// at a capped speed (followShift, lib/ream-mark.js). Reduced motion keeps both
// still.
// =========================================================================
import { el } from "./dom.js";
import { markBars, followShift, BAR } from "./lib/ream-mark.js";

const LIB_LINE_PX = 48; // shelf scroll per line of the mark
const READER_LINE_PX = 33; // ≈ one line of body text (18.5px × 1.78, reader-theme.css)
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

// Fills an empty mark <svg> with its bars; returns scrollTo(shift), which sets
// where the stack is heading — it glides there on animation frames.
function liveMark(svg) {
  const rects = markBars(0).map(() => {
    const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    r.setAttribute("height", BAR);
    r.setAttribute("rx", BAR / 2);
    return svg.appendChild(r);
  });
  const draw = (shift) => {
    markBars(shift).forEach((b, i) => {
      const r = rects[i];
      r.setAttribute("x", b.x);
      r.setAttribute("y", b.y.toFixed(2));
      r.setAttribute("width", b.w);
      r.setAttribute("fill", b.fill);
      r.setAttribute("opacity", b.opacity.toFixed(3));
    });
  };
  let shown = 0;
  let target = 0;
  let last = 0;
  let frame = 0;
  const tick = (now) => {
    // Clamp the step: a backgrounded tab resumes with a huge gap since the last frame.
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    shown = followShift(shown, target, dt);
    if (Math.abs(target - shown) < 0.001) {
      shown = target;
      frame = 0;
    } else frame = requestAnimationFrame(tick);
    draw(shown);
  };
  draw(0);
  return (shift) => {
    target = reduceMotion.matches ? 0 : shift;
    if (!frame) {
      last = performance.now();
      frame = requestAnimationFrame(tick);
    }
  };
}

let readerMark = () => {};

export function mountBrandMarks() {
  const libMark = liveMark(el.libMark);
  // A negative scrollTop (iOS rubber-band) just runs the stack backwards.
  el.libBody.addEventListener("scroll", () => libMark(el.libBody.scrollTop / LIB_LINE_PX), { passive: true });
  readerMark = liveMark(el.readerMark);
}

// The reader's chapter scroller moved (or a new chapter loaded): `px` is its
// scrollTop. Called by reader.js alongside the chapter-progress line.
export function scrollReaderMark(px) {
  readerMark(px / READER_LINE_PX);
}
