// =========================================================================
// Reader settings (EPUBs): an "Aa" button in the reader's top bar opens a
// small panel — text size, line spacing, dark / light. One set of settings
// for every book, kept with the other UI prefs (ui.readerPrefs). The CSS
// itself is built by src/lib/reader-prefs.js; this module injects it into
// each chapter, recolours the reader's bars for the light page, and keeps
// your place in the text while the size or spacing changes under you.
//
// ROLLBACK: READER_SETTINGS = false in src/lib/reader-prefs.js hides the
// button and ignores any stored setting — the reader is exactly as before.
// =========================================================================
import { h, el } from "./dom.js";
import { ui, saveUi } from "./state.js";
import { armOverlay, closeOverlay } from "./router.js";
import {
  READER_SETTINGS,
  DEFAULTS,
  SIZES,
  SPACINGS,
  LIGHT,
  normalizePrefs,
  isDefault,
  stepSize,
  prefsCss,
} from "./lib/reader-prefs.js";

const STYLE_ID = "ream-reader-prefs";
const DARK_PAGE = "#1f2129";

const prefs = () => (READER_SETTINGS ? normalizePrefs(ui.readerPrefs) : { ...DEFAULTS });

let host = null; // { getContainer, getContents, savePosition }
let btn = null;
let panel = null;
let isPdf = false;

// Content hook: the overrides go in after the reading theme (and after the
// rendition's critical-background rule), so they win. Nothing is added for
// the defaults or for a PDF (its pages have their own "Dark pages" switch).
export function injectReaderPrefs(contents) {
  const doc = contents?.document;
  if (!doc || isPdf) return;
  writeStyle(doc, prefsCss(prefs()));
}
function writeStyle(doc, css) {
  let s = doc.getElementById(STYLE_ID);
  if (!css) return s?.remove();
  if (!s) {
    s = doc.createElement("style");
    s.id = STYLE_ID;
  }
  s.textContent = css;
  // (Re-)append so it is always last in <head>, after the theme.
  (doc.head || doc.documentElement).appendChild(s);
}

// Saved reading spots pair a CFI with a pixel offset, and the offset only
// means something in the layout it was measured in: "" for the defaults (so
// every spot saved before these settings existed still matches), else the
// settings themselves. reader.js stores it with each spot and only restores
// the pixel offset when it matches (otherwise the CFI alone places you).
export function readerLayoutKey() {
  const p = prefs();
  return isDefault(p) || isPdf ? "" : `${p.size}|${p.spacing}|${p.theme}`;
}

// The background epub.js paints before the chapter's own styles land.
export const readerPageColor = () => (prefs().theme === "light" && !isPdf ? LIGHT.page : DARK_PAGE);

// Called each time a book opens in the reader.
export function mountReaderPrefs(opts, { pdf }) {
  host = opts;
  isPdf = !!pdf;
  if (READER_SETTINGS && !btn) {
    btn = h(
      "button",
      {
        class: "icon-btn rprefs-btn",
        type: "button",
        "aria-label": "Text and theme",
        title: "Text and theme",
        "aria-haspopup": "dialog",
        onclick: openPanel,
      },
      h("span", { class: "rprefs-btn__a rprefs-btn__a--sm", "aria-hidden": "true" }, "A"),
      h("span", { class: "rprefs-btn__a", "aria-hidden": "true" }, "a")
    );
    el.btnPrev.before(btn);
  }
  if (btn) btn.hidden = isPdf;
  applyChrome();
}

// Leaving the reader: the rest of the app keeps its own colours.
export function unmountReaderPrefs() {
  document.getElementById("app").classList.remove("reader-light");
  setThemeColor(null);
}

function applyChrome() {
  const light = prefs().theme === "light" && !isPdf;
  document.getElementById("app").classList.toggle("reader-light", light);
  setThemeColor(light ? LIGHT.page : null);
}

// The phone's status bar / browser UI colour follows the page while reading.
let themeColorWas = null;
function setThemeColor(color) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  if (themeColorWas === null) themeColorWas = meta.content;
  meta.content = color || themeColorWas;
}

function update(change) {
  const before = prefs();
  const next = normalizePrefs({ ...before, ...change });
  ui.readerPrefs = isDefault(next) ? undefined : next;
  saveUi();
  // Every change reflows the text (the light page also sets a heavier
  // weight, which re-wraps lines), so each one keeps your place.
  keepPlace(
    () => {
      for (const c of host?.getContents?.() || []) injectReaderPrefs(c);
    },
    () => host?.savePosition?.()
  );
  applyChrome();
  renderPanel();
}

// ---- Keeping your place -------------------------------------------------
// A new size or spacing reflows the whole chapter; left alone, the same
// scrollTop would land paragraphs away. So note which line is at the top of
// the screen (an element and how far into it), restyle, then hold that spot
// at the top while epub.js re-measures the view — until the layout settles,
// or the reader scrolls. Then save the spot: the saved resume offset is in
// pixels of the old layout, and holding still fires no fresh save.
const TOP_INSET = 12; // px below the scroller's top edge used as the anchor line
const SETTLE_MS = 300;
const MAX_MS = 1500;
function keepPlace(restyle, settled) {
  const c = host?.getContainer?.();
  const frame = c?.querySelector("iframe");
  const doc = frame?.contentDocument;
  if (!c || !doc?.body) return restyle();
  const frameTop = () => frame.getBoundingClientRect().top - c.getBoundingClientRect().top + c.scrollTop;
  const lineY = c.scrollTop + TOP_INSET - frameTop(); // in the chapter's own coordinates
  let anchor = null;
  let ratio = 0;
  for (const n of doc.body.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, blockquote, img, hr")) {
    const r = n.getBoundingClientRect();
    if (r.height > 0 && r.bottom > lineY) {
      anchor = n;
      ratio = Math.max(0, Math.min(1, (lineY - r.top) / r.height));
      break;
    }
  }
  restyle();
  // At the very top, stay there (once the view has re-measured, save).
  if (!anchor || c.scrollTop <= 0) return void setTimeout(settled, SETTLE_MS * 2);
  let stop = false;
  const quit = () => (stop = true);
  const evs = ["wheel", "touchstart", "pointerdown", "keydown"];
  for (const e of evs) c.addEventListener(e, quit, { passive: true, once: true });
  const t0 = performance.now();
  let lastH = -1;
  let stableSince = t0;
  const pin = () => {
    if (stop || !anchor.isConnected) return done();
    const r = anchor.getBoundingClientRect();
    c.scrollTop = frameTop() + r.top + ratio * r.height - TOP_INSET;
    const now = performance.now();
    if (c.scrollHeight !== lastH) {
      lastH = c.scrollHeight;
      stableSince = now;
    }
    if (now - stableSince > SETTLE_MS || now - t0 > MAX_MS) return done();
    requestAnimationFrame(pin);
  };
  const done = () => {
    for (const e of evs) c.removeEventListener(e, quit);
    settled();
  };
  requestAnimationFrame(pin);
}

// ---- The panel ----------------------------------------------------------
function openPanel() {
  if (!panel) {
    panel = h("div", { class: "rprefs", hidden: true });
    panel.append(
      h("div", { class: "rprefs__catch", onclick: () => closeOverlay() }),
      h("div", { class: "rprefs__card", role: "dialog", "aria-label": "Text and theme" })
    );
    document.getElementById("app").append(panel);
  }
  renderPanel();
  panel.hidden = false;
  // Escape and Back close it like any overlay (main.js / router.js).
  btn?.setAttribute("aria-expanded", "true");
  armOverlay(() => {
    panel.hidden = true;
    btn?.setAttribute("aria-expanded", "false");
  });
}

const SPACING_LABEL = { compact: "Compact", normal: "Normal", relaxed: "Relaxed" };
// Three lines drawn at each spacing's gap.
const spacingIcon = (gap) => {
  const y0 = 12 - gap;
  const lines = [y0, 12, 12 + gap].map((y) => `<path d="M5 ${y}h14" />`).join("");
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">${lines}</svg>`;
};
const SPACING_GAP = { compact: 4, normal: 5.5, relaxed: 7 };

function renderPanel() {
  const card = panel?.querySelector(".rprefs__card");
  if (!card) return;
  const p = prefs();
  const seg = (items, current, pick) =>
    h(
      "div",
      { class: "rprefs__seg", role: "radiogroup" },
      items.map(([value, content, label]) =>
        h(
          "button",
          {
            class: "rprefs__opt" + (value === current ? " is-on" : ""),
            type: "button",
            role: "radio",
            "aria-checked": String(value === current),
            "aria-label": label,
            title: label,
            onclick: () => value !== current && pick(value),
          },
          content
        )
      )
    );

  card.replaceChildren(
    h(
      "div",
      { class: "rprefs__row" },
      h("span", { class: "rprefs__label" }, "Text size"),
      h(
        "div",
        { class: "rprefs__size" },
        h(
          "button",
          {
            class: "rprefs__step",
            type: "button",
            "aria-label": "Smaller text",
            disabled: p.size === SIZES[0],
            onclick: () => update({ size: stepSize(p.size, -1) }),
          },
          h("span", { class: "rprefs__a rprefs__a--sm" }, "A")
        ),
        h("span", { class: "rprefs__val", "aria-live": "polite" }, `${p.size} %`),
        h(
          "button",
          {
            class: "rprefs__step",
            type: "button",
            "aria-label": "Larger text",
            disabled: p.size === SIZES.at(-1),
            onclick: () => update({ size: stepSize(p.size, 1) }),
          },
          h("span", { class: "rprefs__a rprefs__a--lg" }, "A")
        )
      )
    ),
    h(
      "div",
      { class: "rprefs__row" },
      h("span", { class: "rprefs__label" }, "Line spacing"),
      seg(
        Object.keys(SPACINGS).map((k) => [k, h("span", { html: spacingIcon(SPACING_GAP[k]), "aria-hidden": "true" }), SPACING_LABEL[k]]),
        p.spacing,
        (spacing) => update({ spacing })
      )
    ),
    h(
      "div",
      { class: "rprefs__row" },
      h("span", { class: "rprefs__label" }, "Theme"),
      seg(
        [
          ["dark", [h("span", { class: "rprefs__swatch rprefs__swatch--dark" }), "Dark"], "Dark"],
          ["light", [h("span", { class: "rprefs__swatch rprefs__swatch--light" }), "Light"], "Light"],
        ],
        p.theme,
        (theme) => update({ theme })
      )
    ),
    h(
      "button",
      {
        class: "rprefs__reset",
        type: "button",
        hidden: isDefault(p),
        onclick: () => update({ ...DEFAULTS }),
      },
      "Reset to default"
    )
  );
}
