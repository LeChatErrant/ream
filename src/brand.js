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
// chapter the mark rests on exactly the logo. Reduced motion keeps both still.
// =========================================================================
import { el } from "./dom.js";
import { markBars, BAR } from "./lib/ream-mark.js";

const LIB_LINE_PX = 48; // shelf scroll per line of the mark
const READER_LINE_PX = 33; // ≈ one line of body text (18.5px × 1.78, reader-theme.css)
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

// Fills an empty mark <svg> with its bars; returns paint(shift) to scroll it.
function liveMark(svg) {
  const rects = markBars(0).map(() => {
    const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    r.setAttribute("height", BAR);
    r.setAttribute("rx", BAR / 2);
    return svg.appendChild(r);
  });
  const paint = (shift) => {
    markBars(reduceMotion.matches ? 0 : shift).forEach((b, i) => {
      const r = rects[i];
      r.setAttribute("x", b.x);
      r.setAttribute("y", b.y.toFixed(2));
      r.setAttribute("width", b.w);
      r.setAttribute("fill", b.fill);
      r.setAttribute("opacity", b.opacity.toFixed(3));
    });
  };
  paint(0);
  return paint;
}

let paintReader = () => {};

export function mountBrandMarks() {
  const paintLib = liveMark(el.libMark);
  // Scroll events already arrive at most once per frame — paint directly.
  // A negative scrollTop (iOS rubber-band) just runs the stack backwards.
  el.libBody.addEventListener("scroll", () => paintLib(el.libBody.scrollTop / LIB_LINE_PX), { passive: true });
  paintReader = liveMark(el.readerMark);
}

// The reader's chapter scroller moved (or a new chapter loaded): `px` is its
// scrollTop. Called by reader.js alongside the chapter-progress line.
export function scrollReaderMark(px) {
  paintReader(px / READER_LINE_PX);
}
