// The way back to the furthest chapter reached (see furthestLink in
// reading.js): shown only while your latest spot is in an earlier chapter, it
// opens that chapter at its own saved spot. It is drawn as a details row —
// "Furthest read · Vol. 10 · ch. 2680 ›" — in each surface's own row style
// (Continue card footer, info page table, volume sheet facts), never as a
// second button competing with Continue.
import { furthestLabel } from "./reading.js";
import { openBook } from "./reader.js";

export const FURTHEST_KEY = "Furthest read";

// "Vol. 10 · ch. 2680" (or "ch. 2680" outside a series / with vol: false).
export function furthestValue(f, { vol = true } = {}) {
  const s = furthestLabel(f, { vol });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function openFurthest(f, before) {
  const go = () => openBook(f.book.id, { atHref: f.href });
  if (before) before(go);
  else go();
}
