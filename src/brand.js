// =========================================================================
// Brand — the Ream mark in the Library header. The stack is wired to the
// shelf's scroll: as the books scroll up, lines scroll up through the mark
// (one line per LINE_PX), the current line always lit at the bottom. At the
// top of the shelf it rests on exactly the logo. Reduced motion keeps it still.
// =========================================================================
import { el } from "./dom.js";
import { markBars, BAR } from "./lib/ream-mark.js";

const LINE_PX = 48; // shelf scroll per line of the mark
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
let rects = [];

function paint(shift) {
  markBars(shift).forEach((b, i) => {
    const r = rects[i];
    r.setAttribute("x", b.x);
    r.setAttribute("y", b.y.toFixed(2));
    r.setAttribute("width", b.w);
    r.setAttribute("fill", b.fill);
    r.setAttribute("opacity", b.opacity.toFixed(3));
  });
}

export function mountBrandMark() {
  const mark = el.libMark;
  rects = markBars(0).map(() => {
    const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    r.setAttribute("height", BAR);
    r.setAttribute("rx", BAR / 2);
    return mark.appendChild(r);
  });
  paint(0);
  // Scroll events already arrive at most once per frame — paint directly.
  // A negative scrollTop (iOS rubber-band) just runs the stack backwards.
  el.libBody.addEventListener(
    "scroll",
    () => paint(reduceMotion.matches ? 0 : el.libBody.scrollTop / LINE_PX),
    { passive: true }
  );
}
