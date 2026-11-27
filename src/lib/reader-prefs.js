// =========================================================================
// Reader settings — text size, line spacing and a light theme for EPUBs.
// Pure: turns the stored settings into the CSS that overrides
// reader-theme.css inside each chapter document (src/readerprefs.js injects
// it, after the theme, so these rules win).
//
// The DEFAULTS are today's reading look exactly, and they produce NO CSS at
// all — a reader who never opens the panel gets the untouched theme. To roll
// the feature back, set READER_SETTINGS to false: the Aa button disappears
// and every stored setting is ignored (or `git revert` the commit).
// =========================================================================

export const READER_SETTINGS = true;

export const DEFAULTS = Object.freeze({ size: 100, spacing: "normal", theme: "dark" });

// Text size steps, in % of the theme's size (18.5px phone / 20px wide).
export const SIZES = [80, 90, 100, 110, 120, 135, 150, 170];

// Line height for each spacing; "normal" is the theme's own 1.78.
export const SPACINGS = { compact: 1.55, normal: 1.78, relaxed: 2.05 };

export const THEMES = ["dark", "light"];

// Stored settings, cleaned: anything unknown falls back to the default, so a
// bad or stale record never breaks the reader.
export function normalizePrefs(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  return {
    size: SIZES.includes(p.size) ? p.size : DEFAULTS.size,
    spacing: Object.hasOwn(SPACINGS, p.spacing) ? p.spacing : DEFAULTS.spacing,
    theme: THEMES.includes(p.theme) ? p.theme : DEFAULTS.theme,
  };
}

export const isDefault = (p) =>
  p.size === DEFAULTS.size && p.spacing === DEFAULTS.spacing && p.theme === DEFAULTS.theme;

// One step up (+1) or down (-1) the size ladder, held at its ends.
export function stepSize(size, dir) {
  const i = SIZES.indexOf(size);
  const at = i < 0 ? SIZES.indexOf(DEFAULTS.size) : i;
  return SIZES[Math.max(0, Math.min(SIZES.length - 1, at + dir))];
}

// The light page. Warm paper, near-black ink; the accents keep the dark
// theme's blue-grey family, darkened to read on white.
export const LIGHT = Object.freeze({
  page: "#f7f5f0",
  text: "#2d2f35",
  heading: "#15171c",
  link: "#4a5d94",
  rule: "#dcd8ce",
  selection: "#d5dcef",
  label: "#8b8f98",
  cardBorder: "#dedad0",
  cardHover: "#efece5",
  kicker: "#80848e",
  num: "#7a7f89",
  chev: "#9a9ca5",
  lead: "#6b6f78",
});

const px = (n) => `${Math.round(n * 100) / 100}px`;

// The override stylesheet for these settings ("" for the defaults).
export function prefsCss(prefs) {
  const p = normalizePrefs(prefs);
  const out = [];

  if (p.size !== DEFAULTS.size) {
    const f = p.size / 100;
    // Every size the theme sets in px, scaled — phone first, then the wide
    // step (mirrors reader-theme.css's own @media block).
    out.push(
      `body { font-size: ${px(18.5 * f)} !important; }`,
      `p { margin-bottom: ${px(20 * f)} !important; }`,
      `h1, h2, p.ream-heading { font-size: ${px(22 * f)} !important; }`,
      `h3 { font-size: ${px(19 * f)} !important; }`,
      `h4, h5, h6 { font-size: ${px(17 * f)} !important; }`,
      `@media (min-width: 768px) {`,
      `  body { font-size: ${px(20 * f)} !important; }`,
      `  p { margin-bottom: 1.1em !important; }`,
      `  h1, h2, p.ream-heading { font-size: ${px(30 * f)} !important; }`,
      `  h3 { font-size: ${px(23 * f)} !important; }`,
      `  h4, h5, h6 { font-size: ${px(19 * f)} !important; }`,
      `}`
    );
  }

  if (p.spacing !== DEFAULTS.spacing) {
    const lh = SPACINGS[p.spacing];
    out.push(`body, p, div, span, li, td, th, blockquote { line-height: ${lh} !important; }`);
  }

  if (p.theme === "light") {
    const c = LIGHT;
    out.push(
      // `html:root` outranks the rendition's critical dark background rule.
      `html:root, html:root body { background: ${c.page} !important; }`,
      `body, p, div, span, li, td, th, blockquote { color: ${c.text} !important; }`,
      // Dark ink on paper reads thinner than light on dark: one weight up.
      `body, p { font-weight: 400 !important; }`,
      `h1, h2, h3, h4, h5, h6, p.ream-heading { color: ${c.heading} !important; }`,
      `a { color: ${c.link} !important; }`,
      `hr { border-top-color: ${c.rule} !important; }`,
      `::selection { background: ${c.selection}; color: ${c.heading}; }`,
      `.chapter-end__label { color: ${c.label} !important; }`,
      `.chapter-end__label::before, .chapter-end__label::after { background: ${c.rule} !important; }`,
      `.chapter-end .cn-card { border-color: ${c.cardBorder} !important; }`,
      `.chapter-end .cn-card:hover { background: ${c.cardHover} !important; border-color: ${c.rule} !important; }`,
      `.chapter-end .cn-card:active { background: ${c.cardHover} !important; }`,
      `.chapter-end .cn-card__kicker { color: ${c.kicker} !important; }`,
      `.chapter-end .cn-card__num { color: ${c.num} !important; }`,
      `.chapter-end .cn-card__title { color: ${c.heading} !important; }`,
      `.chapter-end .cn-card__chev { color: ${c.chev} !important; }`,
      `.chapter-end .cn-card:hover .cn-card__chev { color: ${c.link} !important; }`,
      `.chapter-end .vol-boundary__lead, .chapter-end .vol-boundary__back { color: ${c.lead} !important; }`,
      `.chapter-end .vol-boundary__back:hover { color: ${c.heading} !important; }`,
      `.chapter-end .vol-boundary__go, .chapter-end .vol-boundary__go:hover { background: ${c.link} !important; color: #fff !important; }`
    );
  }

  return out.join("\n");
}
