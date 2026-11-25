// -------------------------------------------------------------------------
// Title / text parsing — volume extraction, series-key normalization, roman
// numerals and chapter-label parsing. All pure functions of their string (or
// plain-object) inputs, unit-tested in test/text.test.js.
// -------------------------------------------------------------------------

export const normalize = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// Pull a volume number out of a title or filename ("vol 2", "v2", "part 2").
export function parseVolumeIndex(text) {
  if (!text) return null;
  const m = text.match(/\b(?:vol(?:ume)?\.?|v|part|book)\s*(\d{1,3})\b/i) || text.match(/\b(\d{1,3})\b\s*$/);
  return m ? parseInt(m[1], 10) : null;
}

// Title with any volume marker stripped, for series naming + duplicate keys.
export function stripVolume(title) {
  return (title || "")
    .replace(/\b(?:vol(?:ume)?\.?|v|part|book)\s*\d{1,3}\b/gi, "")
    .replace(/[\s\-–—:·|]+$/g, "")
    .trim();
}

// Series identity key: title-without-volume + author, both normalized. Two books
// with the same key are look-alikes eligible for grouping.
export const seriesKey = (book) => normalize(stripVolume(book.title)) + "|" + normalize(book.author);

// Roman numeral for the title-collision cue (11c). Volume indexes are small, so
// the full 1–3999 converter is overkill but harmless.
export function toRoman(n) {
  if (!n || n < 1) return "";
  const map = [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ];
  let out = "",
    r = n;
  for (const [v, sym] of map)
    while (r >= v) {
      out += sym;
      r -= v;
    }
  return out;
}

// Split a TOC label into its own embedded chapter number (if any) and a clean
// title. Many books label chapters "Chapter 230: Precarious Alliance" (or
// "Ch. 230 - ...", "230. ..."); the embedded number is the one the reader sees
// in the top bar, and it can differ from the positional ordinal when the book
// carries front matter. Bare-title books ("Ashen Barrens") return num: null so
// callers can fall back to the positional ordinal.
export function parseChapterLabel(label) {
  const s = (label || "").trim();
  let m = s.match(/^(?:chapters?|chap|ch|episodes?|ep|parts?|vol(?:ume)?)\.?\s*(\d+)\s*[:.\-–—)]*\s*(.*)$/i);
  if (m) return { num: parseInt(m[1], 10), title: m[2].trim() };
  if (/^\d+$/.test(s)) return { num: parseInt(s, 10), title: "" };
  m = s.match(/^(\d+)\s*[:.\-–—)]\s*(.*)$/);
  if (m) return { num: parseInt(m[1], 10), title: m[2].trim() };
  return { num: null, title: s };
}

// The longest shared (case-insensitive) title prefix across a set of books, used
// to prefill the "Name this series" sheet when grouping look-alikes.
export function longestCommonName(titles) {
  if (!titles.length) return "";
  let prefix = titles[0];
  for (const t of titles.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < t.length && prefix[i].toLowerCase() === t[i].toLowerCase()) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix.replace(/[\s\-–—:·|]+$/g, "").trim();
}

// Title as stored in a sloppy epub: a converter or CMS asset id glued to the
// front ("6aba736348bdf4f08183f463 AI Native…") and a browser's duplicate-
// download suffix (" (1)") on the end are dropped. Underscores between words
// read as spaces.
export function cleanTitle(title) {
  const t = (title || "")
    .replace(/_/g, " ")
    .replace(/^[0-9a-f]{16,}(?:[\s-]+|$)/i, "")
    .replace(/\s+\(\d{1,2}\)$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return t || (title || "").trim();
}

// A placeholder author ("Unknown", calibre's default) means no author.
export const cleanAuthor = (author) => {
  const a = (author || "").trim();
  return /^(unknown|unknown author|n\/?a|none)$/i.test(a) ? "" : a;
};

// Type sizes in converted books. PDF conversions set type as a patchwork of
// spans at arbitrary sizes — "Cla|u|de C|o|de", the size switching mid-word —
// often with the whole text scaled up through those spans, past the reader's
// own size. A chapter's runs of text are [{ size, text }] (px, in order).

// Characters per size, and the size most of them are set in.
function sizeShares(runs) {
  const chars = new Map();
  for (const r of runs) {
    const n = r.text.replace(/\s+/g, "").length;
    if (n) chars.set(r.size, (chars.get(r.size) || 0) + n);
  }
  let dominant = null;
  let most = 0;
  for (const [size, n] of chars) if (n > most) [dominant, most] = [size, n];
  return dominant;
}

// The chapter's text size: the size most of its paragraph text is set in.
export const chapterTextSize = (paragraphs) => sizeShares(paragraphs.flat());

const near = (a, b) => Math.abs(a - b) <= Math.max(a, b) * 0.05;

// What to do with one paragraph, given the chapter's text size and the
// reader's body size: "heading" — short display type (1.3× the text size or
// more), a title the converter left as a <p>; "even" — set at one size,
// because it's display type too long to be a title, or its size switches
// mid-word twice or more (a drop cap or small-caps lead-in switches once, so
// real typography is left alone), or it's ordinary text the book scaled away
// from the reader's size through spans; null — leave it as it is.
export function paragraphSizing(runs, { text, base }) {
  const dominant = sizeShares(runs);
  if (dominant == null || !text || !base) return null;
  if (dominant >= text * 1.3) {
    const length = runs
      .map((r) => r.text)
      .join("")
      .replace(/\s+/g, " ")
      .trim().length;
    return length <= 80 ? "heading" : "even";
  }
  let switches = 0;
  for (let i = 1; i < runs.length; i++) {
    const [a, b] = [runs[i - 1], runs[i]];
    if (!near(a.size, b.size) && /\S$/.test(a.text) && /^\S/.test(b.text)) switches++;
  }
  if (switches >= 2) return "even";
  if (near(dominant, text) && !near(text, base)) return "even";
  return null;
}
