// =========================================================================
// READING CHROME (phone) — the reader's controls split in two:
//
// - Top bar, always there: where you are (menu · book / chapter — the Ream mark
//   scrolling with the text) and the chapter's tools (proofreading pill, Soul Sea).
// - Bottom bar, floating over the text: moving through the chapter —
//   ‹ previous · a scrubber over the chapter · next ›.
//
// The bottom bar slides away as you scroll down into the text and comes back
// when you scroll up a little, tap the text, or reach the top or end of the
// chapter. The scrubber doubles as "go to top / bottom" (drag to either end)
// and leaves a notch where you were, so a peek elsewhere is one tap away from
// home — and a peek never counts as reading (see isAway).
//
// Wide screens (≥ 640px, wide.css) keep the single top bar: nothing here hides
// or insets anything there.
// =========================================================================
import { el, WIDE } from "./dom.js";

const app = () => document.getElementById("app");

const HIDE_AFTER = 14; // px of scrolling down before the bar steps aside
const SHOW_AFTER = 48; // px of scrolling back up before it returns (a deliberate move, not a re-read of a line)
const TOP_ZONE = 24; // px from the chapter's top…
const END_ZONE = 6; // …or end that bring it back
const SNAP_PX = 12; // the scrubber's pull towards its ends and the "where you were" notch

let container = null; // the epub.js scroller of the chapter on screen
let chapterKey = null;
let lastY = 0;
let upRun = 0;
let downRun = 0;
let holdUntil = 0; // programmatic scrolling (a resume settling, a chapter landing): the bars ignore it
let dragging = false;
let lastSnap = null;
// The scrollTop you scrubbed away from: drawn as a notch on the track, snapped
// to while dragging, cleared once you're back there or in another chapter.
let homeY = null;
// After a scrub jump: you're looking, not reading. Until you've read on a while
// from the new spot, the jump must not count as progress (see isAway).
let away = null; // { key, natural: px scrolled down by hand since }

// ---- Visibility -----------------------------------------------------------
const phone = () => !WIDE.matches;
export const chromeShown = () => !app().classList.contains("readbar-hidden");
export function setChrome(shown) {
  app().classList.toggle("readbar-hidden", phone() && !shown);
}
// Ignore scroll events for a while (a scroll we're making, not the reader).
export function holdChrome(ms) {
  holdUntil = performance.now() + ms;
}
export function releaseChrome() {
  holdUntil = 0;
  if (container) lastY = container.scrollTop;
  upRun = downRun = 0;
}

// The room the bottom bar takes. The chapter document pads its end by this so
// the last lines and the chapter-end card clear it; it doesn't change as the bar
// hides, so the text never jumps.
const barRoom = () => (phone() ? el.readbar.offsetHeight || 50 : 0);
export function applyChromeInsets(doc) {
  doc?.documentElement?.style.setProperty("--ream-chrome-bottom", barRoom() + "px");
}

// A tap on the text (not on a link, a correction or the chapter-end card)
// shows or hides the bottom bar.
export function chromeTap(e) {
  if (!phone() || e.defaultPrevented) return;
  if (e.target?.closest?.("a, button, input, label, [data-proof], .proof-para, .chapter-end")) return;
  const sel = e.target?.ownerDocument?.getSelection?.();
  if (sel && !sel.isCollapsed) return;
  setChrome(!chromeShown());
}

// ---- Chapter --------------------------------------------------------------
// A chapter landed on screen.
export function chromeChapter(c, key) {
  if (key === chapterKey && c === container) return;
  container = c;
  chapterKey = key;
  homeY = null;
  away = null;
  lastY = c?.scrollTop || 0;
  upRun = downRun = 0;
  setChrome(true);
  paint();
}

// After a scrub jump, true until you've read on from the new spot: the reader
// keeps where you are (so reopening returns there) but credits no chapter
// progress — peeking at a chapter's end doesn't finish it.
export const isAway = (key) => !!away && away.key === key;

// ---- Scroll ---------------------------------------------------------------
export function chromeScrolled(c) {
  if (c !== container) return;
  const y = c.scrollTop;
  const dy = y - lastY;
  lastY = y;
  paint();
  if (!phone() || dragging || performance.now() < holdUntil) return;
  if (dy > 0 && away && (away.natural += dy) > c.clientHeight * 1.5) away = null;
  if (homeY != null && Math.abs(y - homeY) < 2) homeY = null;
  const max = c.scrollHeight - c.clientHeight;
  if (y <= TOP_ZONE || y >= max - END_ZONE) {
    upRun = downRun = 0;
    return setChrome(true);
  }
  if (dy > 0) {
    downRun += dy;
    upRun = 0;
    if (downRun > HIDE_AFTER) setChrome(false);
  } else if (dy < 0) {
    upRun -= dy;
    downRun = 0;
    if (upRun > SHOW_AFTER) setChrome(true);
  }
}

// ---- Bottom bar -----------------------------------------------------------
const clamp01 = (f) => Math.min(1, Math.max(0, f));

function paint(dragF = null) {
  const c = container;
  if (!c || !el.scrub) return;
  const max = c.scrollHeight - c.clientHeight;
  const f = dragF ?? (max > 0 ? clamp01(c.scrollTop / max) : 1);
  el.scrub.style.setProperty("--f", f.toFixed(4));
  el.scrub.setAttribute("aria-valuenow", String(Math.round(f * 100)));
  const markF = homeY != null && max > 0 ? clamp01(homeY / max) : null;
  el.scrubMark.hidden = markF == null;
  if (markF != null) el.scrub.style.setProperty("--m", markF.toFixed(4));
  // The % only shows while dragging, in a bubble over the thumb.
  if (dragF != null) el.scrubTip.textContent = `${Math.round(f * 100)} %`;
}

// Track position → chapter fraction, pulled onto the ends and the notch when close.
function scrubFraction(clientX) {
  const r = el.scrubTrack.getBoundingClientRect();
  const f = clamp01((clientX - r.left) / r.width);
  const max = container.scrollHeight - container.clientHeight;
  const targets = [0, 1];
  if (homeY != null && max > 0) targets.push(clamp01(homeY / max));
  let best = null;
  for (const t of targets) if (Math.abs(t - f) * r.width <= SNAP_PX && (best == null || Math.abs(t - f) < Math.abs(best - f))) best = t;
  if (best !== lastSnap) {
    if (best != null && dragging) navigator.vibrate?.(6);
    lastSnap = best;
  }
  return best ?? f;
}

function scrubTo(f) {
  const c = container;
  const max = c.scrollHeight - c.clientHeight;
  c.scrollTop = Math.round(f * max);
  lastY = c.scrollTop;
  paint(f);
}

export function mountReadbar({ onStep }) {
  el.rbPrev.addEventListener("click", () => onStep(-1));
  el.rbNext.addEventListener("click", () => onStep(1));

  const s = el.scrub;
  s.addEventListener("pointerdown", (e) => {
    if (!container || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.preventDefault();
    s.setPointerCapture(e.pointerId);
    dragging = true;
    lastSnap = null;
    if (homeY == null) homeY = container.scrollTop;
    away = { key: chapterKey, natural: 0 };
    el.readbar.classList.add("is-scrubbing");
    scrubTo(scrubFraction(e.clientX));
  });
  s.addEventListener("pointermove", (e) => {
    if (dragging) scrubTo(scrubFraction(e.clientX));
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    el.readbar.classList.remove("is-scrubbing");
    const c = container;
    // Barely moved (or back home): nothing to come back to.
    if (homeY != null && Math.abs(c.scrollTop - homeY) < c.clientHeight * 0.5) {
      homeY = null;
      away = null;
    }
    releaseChrome();
    paint();
  };
  s.addEventListener("pointerup", end);
  s.addEventListener("pointercancel", end);
  s.addEventListener("lostpointercapture", end);
  // Keyboard: the slider steps by a twentieth, Home / End to the ends.
  s.addEventListener("keydown", (e) => {
    if (!container) return;
    const max = container.scrollHeight - container.clientHeight;
    const f = max > 0 ? container.scrollTop / max : 0;
    const to = { ArrowLeft: f - 0.05, ArrowDown: f - 0.05, ArrowRight: f + 0.05, ArrowUp: f + 0.05, Home: 0, End: 1 }[e.key];
    if (to == null) return;
    e.preventDefault();
    e.stopPropagation();
    scrubTo(clamp01(to));
  });

  // Rotating into the wide layout: no bottom bar to hide there.
  WIDE.addEventListener("change", () => setChrome(true));
}
