// =========================================================================
// READING CHROME (phone) — the reader's controls split in two:
//
// - Top bar, always there: where you are (menu · book / chapter — the Ream mark
//   scrolling with the text) and the chapter's tools (proofreading pill, Soul Sea).
// - Bottom bar, floating over the text: ‹ Previous · ⤒ top · ⤓ end · Next ›,
//   its top edge a hairline that fills with your progress through the chapter.
//
// The bottom bar slides away as you scroll down into the text and comes back
// when you scroll up a little, tap the text, or reach the top or end of the
// chapter. ⤒ / ⤓ dim where there's nowhere to go. After a jump, the button you
// used becomes "↩ 38 %" — the way back to where you were — until you go back
// or read on from the new spot; and a jump never counts as reading (isAway).
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

const BACK_ICON =
  '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

let container = null; // the epub.js scroller of the chapter on screen
let chapterKey = null;
let lastY = 0;
let upRun = 0;
let downRun = 0;
let holdUntil = 0; // programmatic scrolling (a resume settling, a chapter landing): the bar ignores it
// The way back after a jump: where you were, and which button carries it.
let homeY = null;
let backOn = null; // el.rbTop | el.rbEnd
// After a jump: you're looking, not reading. Until you've read on a while from
// the new spot, the jump must not count as progress (see isAway).
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
const barRoom = () => (phone() ? el.readbar.offsetHeight || 54 : 0);
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
  away = null;
  clearBack();
  lastY = c?.scrollTop || 0;
  upRun = downRun = 0;
  setChrome(true);
  paint();
}

// After a jump, true until you've read on from the new spot: the reader keeps
// where you are (so reopening returns there) but credits no chapter progress —
// peeking at a chapter's end doesn't finish it.
export const isAway = (key) => !!away && away.key === key;

// ---- Scroll ---------------------------------------------------------------
export function chromeScrolled(c) {
  if (c !== container) return;
  const y = c.scrollTop;
  const dy = y - lastY;
  lastY = y;
  if (!phone() || performance.now() < holdUntil) return paint();
  // Read on from the new spot (or scrolled back home by hand): the way back retires.
  if (dy > 0 && away && (away.natural += dy) > c.clientHeight * 1.5) {
    away = null;
    clearBack();
  }
  if (homeY != null && Math.abs(y - homeY) < c.clientHeight * 0.25) clearBack();
  paint();
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
const maxOf = (c) => Math.max(0, c.scrollHeight - c.clientHeight);
const pctOf = (y) => {
  const max = container ? maxOf(container) : 0;
  return max > 0 ? Math.round(Math.min(1, Math.max(0, y / max)) * 100) : 0;
};

// The progress edge, and ⤒ / ⤓ dimmed where there's nowhere to go.
function paint() {
  const c = container;
  if (!c) return;
  const max = maxOf(c);
  const f = max > 0 ? Math.min(1, Math.max(0, c.scrollTop / max)) : 1;
  el.readbar.style.setProperty("--f", f.toFixed(4));
  if (backOn !== el.rbTop) el.rbTop.disabled = c.scrollTop <= 1;
  if (backOn !== el.rbEnd) el.rbEnd.disabled = c.scrollTop >= max - 1;
}

function scrollToY(y) {
  const c = container;
  c.scrollTop = Math.round(y);
  lastY = c.scrollTop;
  upRun = downRun = 0;
  paint();
}

// The way back lives on the button you jumped with.
const JUMP_HTML = new WeakMap();
function showBack(btn) {
  clearBack(false);
  backOn = btn;
  if (!JUMP_HTML.has(btn)) JUMP_HTML.set(btn, { html: btn.innerHTML, label: btn.getAttribute("aria-label") });
  btn.disabled = false;
  btn.classList.add("readbar__jump--back");
  btn.innerHTML = `${BACK_ICON}<span>${pctOf(homeY)} %</span>`;
  btn.setAttribute("aria-label", `Back to where you were, ${pctOf(homeY)} %`);
}
function clearBack(forgetHome = true) {
  if (backOn) {
    const orig = JUMP_HTML.get(backOn);
    backOn.classList.remove("readbar__jump--back");
    backOn.innerHTML = orig.html;
    backOn.setAttribute("aria-label", orig.label);
    backOn = null;
  }
  if (forgetHome) homeY = null;
  if (container) paint();
}

// ⤒ / ⤓: jump to the chapter's top or end — or, carrying the way back, return.
function jump(btn, toEnd) {
  const c = container;
  if (!c) return;
  if (btn === backOn) {
    const y = homeY;
    away = null;
    clearBack();
    return scrollToY(y);
  }
  // Keep the first spot you jumped from: top, then end, still leads back home.
  if (homeY == null) homeY = c.scrollTop;
  away = { key: chapterKey, natural: 0 };
  scrollToY(toEnd ? maxOf(c) : 0);
  showBack(btn);
  setChrome(true);
}

export function mountReadbar({ onStep }) {
  el.rbPrev.addEventListener("click", () => onStep(-1));
  el.rbNext.addEventListener("click", () => onStep(1));
  el.rbTop.addEventListener("click", () => jump(el.rbTop, false));
  el.rbEnd.addEventListener("click", () => jump(el.rbEnd, true));
  // Rotating into the wide layout: no bottom bar to hide there.
  WIDE.addEventListener("change", () => setChrome(true));
}
