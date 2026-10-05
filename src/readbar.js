// =========================================================================
// READING CHROME (phone) — the reader's controls split in two, both floating
// over the text and stepping aside while you read:
//
// - Top bar: where you are (menu · book / chapter) and the chapter's tools
//   (proofreading pill, Soul Sea).
// - Bottom bar: moving through the chapter — ‹ previous · a scrubber over the
//   chapter · time left · next ›.
//
// Both slide away as you scroll down into the text and come back when you
// scroll up a little, tap the text, or reach the top or end of the chapter.
// The scrubber doubles as "go to top / bottom" (drag to either end) and leaves a
// notch where you were, so a peek elsewhere is one tap away from home — and a
// peek never counts as reading (see isAway). The time left is the chapter's
// remaining words at your own measured reading speed.
//
// Wide screens (≥ 640px, wide.css) keep the single top bar: nothing here hides
// or insets anything there.
// =========================================================================
import { el, WIDE } from "./dom.js";
import { ui } from "./state.js";

const app = () => document.getElementById("app");

const HIDE_AFTER = 14; // px of scrolling down before the bars step aside
const SHOW_AFTER = 48; // px of scrolling back up before they return (a deliberate move, not a re-read of a line)
const END_ZONE = 6; // px from the chapter's end that brings them back
const SNAP_PX = 12; // the scrubber's pull towards its ends and the "where you were" notch
const DEFAULT_WPM = 238; // a typical silent-reading pace, until yours is measured

let container = null; // the epub.js scroller of the chapter on screen
let chapterKey = null;
const chapterWords = new Map(); // chapter key → its word count
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
let speed = null; // reading-pace sample: { key, t, words }

// ---- Visibility -----------------------------------------------------------
const phone = () => !WIDE.matches;
export const chromeShown = () => !app().classList.contains("chrome-hidden");
export function setChrome(shown) {
  app().classList.toggle("chrome-hidden", phone() && !shown);
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

// The room the bars take at the top and bottom of the screen. The chapter
// document pads by this so its first and last lines clear them; it doesn't
// change as they hide, so the text never jumps.
export function chromeInsets() {
  if (!phone()) return { top: 0, bottom: 0 };
  return { top: el.topbar.offsetHeight || 52, bottom: el.readbar.offsetHeight || 50 };
}
export function applyChromeInsets(doc) {
  const root = doc?.documentElement;
  if (!root) return;
  const { top, bottom } = chromeInsets();
  root.style.setProperty("--ream-chrome-top", top + "px");
  root.style.setProperty("--ream-chrome-bottom", bottom + "px");
}

// A tap on the text (not on a link, a correction or the chapter-end card)
// shows or hides the bars.
export function chromeTap(e) {
  if (!phone() || e.defaultPrevented) return;
  if (e.target?.closest?.("a, button, input, label, [data-proof], .proof-para, .chapter-end")) return;
  const sel = e.target?.ownerDocument?.getSelection?.();
  if (sel && !sel.isCollapsed) return;
  setChrome(!chromeShown());
}

// ---- Chapter --------------------------------------------------------------
// Counted once per chapter document, before the chapter-end card goes in.
export function noteChapterWords(key, doc) {
  if (!key || !doc?.body) return;
  const m = (doc.body.textContent || "").match(/\S+/g);
  chapterWords.set(key, m ? m.length : 0);
}

// A chapter landed on screen.
export function chromeChapter(c, key) {
  if (key === chapterKey && c === container) return;
  container = c;
  chapterKey = key;
  homeY = null;
  away = null;
  speed = null;
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
  const topZone = chromeInsets().top; // read before paint() restyles, so no forced layout
  paint();
  if (!phone() || dragging || performance.now() < holdUntil) return;
  if (dy > 0) {
    if (away && (away.natural += dy) > c.clientHeight * 1.5) away = null;
    sampleSpeed(c);
  }
  if (homeY != null && Math.abs(y - homeY) < 2) homeY = null;
  const max = c.scrollHeight - c.clientHeight;
  if (y <= topZone || y >= max - END_ZONE) {
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

// Your reading pace, learned from how fast you move through the text: a sample
// every ~20 s of steady reading, folded slowly into a running average. Pauses
// (the phone set down) and skimming are left out.
function sampleSpeed(c) {
  const words = chapterWords.get(chapterKey);
  if (!words || away) return;
  const max = c.scrollHeight - c.clientHeight;
  if (max <= 0) return;
  const now = performance.now();
  const at = (c.scrollTop / max) * words;
  if (!speed || speed.key !== chapterKey) return void (speed = { key: chapterKey, t: now, words: at });
  const minutes = (now - speed.t) / 60000;
  if (minutes < 1 / 3) return;
  const read = at - speed.words;
  speed = { key: chapterKey, t: now, words: at };
  if (minutes > 1.5 || read <= 0) return;
  const wpm = read / minutes;
  if (wpm < 90 || wpm > 900) return;
  ui.readingWpm = Math.round((ui.readingWpm || DEFAULT_WPM) * 0.85 + wpm * 0.15);
  // Saved with the next reading-position save (saveUi runs on every relocate).
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
  const label = dragF != null ? `${Math.round(f * 100)} %` : timeLeft(f);
  if (el.readbarMeta.textContent !== label) el.readbarMeta.textContent = label;
}

function timeLeft(f) {
  const words = chapterWords.get(chapterKey);
  if (!words) return `${Math.round(f * 100)} %`;
  if (f >= 0.995) return "End";
  const min = (words * (1 - f)) / (ui.readingWpm || DEFAULT_WPM);
  return min < 1 ? "< 1 min" : `${Math.round(min)} min left`;
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
    speed = null;
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

  // Rotating into the wide layout brings back the always-on single bar.
  WIDE.addEventListener("change", () => setChrome(true));
}
