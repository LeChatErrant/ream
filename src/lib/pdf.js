// -------------------------------------------------------------------------
// PDF books, the pure part — how a PDF maps onto Ream's chapter model. The
// reader, the chapter list, progress and stats all work in chapters keyed by
// href; a PDF's "chapter" is a run of pages, from one bookmark to the next,
// keyed "p<first page>". The page rendering lives in src/pdf.js; everything
// here is a plain function of plain data, unit-tested in test/pdf.test.js.
// -------------------------------------------------------------------------
import { baseHref } from "./chapters.js";

export const pageHref = (n) => `p${n}`;
export const hrefPage = (href) => {
  const m = /^p(\d+)$/.exec(baseHref(href));
  return m ? Number(m[1]) : null;
};

// Without bookmarks, a short PDF is one chapter; a longer one is cut every
// CHUNK pages, so progress, Continue and the chapter list still have steps.
const SINGLE_MAX = 24;
const CHUNK = 10;
const pagesLabel = (a, b) => (a === b ? `Page ${a}` : `Pages ${a}–${b}`);

// The chapter list for a PDF, from its bookmarks ([{ title, page, depth }],
// page 1-based; entries without a usable page are dropped) and its page count.
// Bookmarks are put in page order; several on one page share that page's
// chapter. Pages before the first bookmark become a chapter of their own — a
// single page is the cover (hidden from the reading flow like an epub's, the
// info page shows it), more are "Pages 1–n".
export function pdfChapters(outline, pageCount) {
  const n = Math.max(1, pageCount | 0);
  const marks = (outline || [])
    .map((e, i) => ({
      label: (e.title || "").replace(/\s+/g, " ").trim(),
      page: e.page,
      depth: e.depth || 0,
      i,
    }))
    .filter((e) => e.label && Number.isInteger(e.page) && e.page >= 1 && e.page <= n)
    .sort((a, b) => a.page - b.page || a.i - b.i);
  if (!marks.length) {
    if (n <= SINGLE_MAX) return [{ label: pagesLabel(1, n), href: pageHref(1), depth: 0 }];
    const out = [];
    for (let a = 1; a <= n; a += CHUNK)
      out.push({ label: pagesLabel(a, Math.min(n, a + CHUNK - 1)), href: pageHref(a), depth: 0 });
    return out;
  }
  const minDepth = Math.min(...marks.map((e) => e.depth));
  const out = marks.map((e) => ({ label: e.label, href: pageHref(e.page), depth: e.depth - minDepth }));
  const first = marks[0].page;
  if (first > 1)
    out.unshift({ label: first === 2 ? "Cover" : pagesLabel(1, first - 1), href: pageHref(1), depth: 0 });
  return out;
}

// The documents the reader steps through — one per distinct first page, in
// page order — each with its page range [from, to].
export function pdfSections(chapters, pageCount) {
  const starts = [...new Set((chapters || []).map((e) => hrefPage(e.href)).filter((p) => p != null))].sort(
    (a, b) => a - b
  );
  if (!starts.length || starts[0] !== 1) starts.unshift(1);
  return starts.map((from, i) => ({
    href: pageHref(from),
    from,
    to: Math.max(from, (starts[i + 1] ?? pageCount + 1) - 1),
  }));
}

// The section holding page `n`.
export function sectionOfPage(sections, n) {
  let hit = sections[0] || null;
  for (const s of sections) if (s.from <= n) hit = s;
  return hit;
}

// A reading spot inside a PDF: a page and how far down it (0–1). Stored where
// an epub keeps its CFI, so it survives a different screen size.
export const pdfPos = (page, frac) =>
  `pdf:${page}:${Math.round(Math.min(1, Math.max(0, frac || 0)) * 10000) / 10000}`;
export function parsePdfPos(s) {
  const m = /^pdf:(\d+):([\d.]+)$/.exec(s || "");
  return m ? { page: Number(m[1]), frac: Math.min(1, Number(m[2]) || 0) } : null;
}

// Rebuild a nested TOC (epub.js's shape: { label, href, subitems }) from a flat
// depth-tagged list, so flatten() gives the same list back.
export function nestByDepth(list) {
  const root = [];
  const stack = [{ depth: -1, subitems: root }];
  for (const e of list || []) {
    const node = { label: e.label, href: e.href, subitems: [] };
    while (stack.length > 1 && stack[stack.length - 1].depth >= (e.depth || 0)) stack.pop();
    stack[stack.length - 1].subitems.push(node);
    stack.push({ depth: e.depth || 0, subitems: node.subitems });
  }
  return root;
}

// A PDF's title field is often an artefact of how it was made ("Microsoft Word
// - report.docx", "untitled", a path); the file name is a better title then.
export function pdfTitle(infoTitle, filename) {
  const t = (infoTitle || "").replace(/\s+/g, " ").trim();
  const junk =
    !t ||
    /^(untitled|title|document|unknown|none)$/i.test(t) ||
    /^microsoft (word|powerpoint|excel)\s*-/i.test(t) ||
    /\.(docx?|pptx?|xlsx?|pdf|indd|tex|odt|pages|key|html?)$/i.test(t) ||
    /[\\/]/.test(t);
  return junk ? (filename || "").replace(/\.pdf$/i, "").trim() || t : t;
}

// A PDF date ("D:20260923170823+02'00'") as an ISO date ("2026-09-23"), or "".
export function pdfDate(s) {
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?/.exec((s || "").trim());
  if (!m) return "";
  return [m[1], m[2], m[3]].filter(Boolean).join("-");
}

// Keywords field → subjects.
export const pdfSubjects = (s) =>
  (s || "")
    .split(/[,;]/)
    .map((k) => k.trim())
    .filter(Boolean);

// -------------------------------------------------------------------------
// Chapters from the pages' own titles, for a PDF whose bookmarks are missing
// or useless (a design tool's leftovers: "…designv2-cover", "…designv2").
// -------------------------------------------------------------------------

// Bookmarks worth using: they split the document into at least three parts
// (or the document is short enough that a couple will do).
export function usefulOutline(outline, pageCount) {
  const pages = new Set(
    (outline || [])
      .filter((e) => (e.title || "").trim() && e.page >= 1 && e.page <= pageCount)
      .map((e) => e.page)
  );
  return pages.size >= 3 || (pageCount <= 12 && pages.size >= 1);
}

// Text items of a page ([{ str, x, y, size }], PDF units, y up) gathered into
// lines, top first: items on one baseline, in reading order.
export function pageLines(items) {
  const rows = [];
  for (const it of items || []) {
    const str = (it.str || "").replace(/\s+/g, " ");
    if (!str.trim()) continue;
    const row = rows.find((r) => Math.abs(r.y - it.y) <= Math.max(2, it.size * 0.25));
    if (row) row.items.push(it);
    else rows.push({ y: it.y, items: [it] });
  }
  return rows
    .map((r) => {
      r.items.sort((a, b) => a.x - b.x);
      return {
        y: r.y,
        size: Math.max(...r.items.map((i) => i.size)),
        text: r.items
          .map((i) => i.str)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim(),
      };
    })
    .sort((a, b) => b.y - a.y);
}

// Bookmark-like entries ([{ title, page, depth }]) from each page's lines
// ([{ n, lines }], lines as pageLines gives them). The body text size is the
// one most characters are set in; a page whose largest line is half again
// bigger opens a chapter named by that line — joined with the lines right
// under it in the same size, for a title set over two lines. A page whose
// title is only a number ("01", a section divider) opens the chapter the
// next page names.
export function headingOutline(pages) {
  const chars = new Map();
  for (const pg of pages)
    for (const l of pg.lines) {
      const k = Math.round(l.size);
      chars.set(k, (chars.get(k) || 0) + l.text.length);
    }
  let body = 0;
  let most = 0;
  for (const [size, n] of chars) if (n > most) [body, most] = [size, n];
  if (!body) return [];
  const min = body * 1.5;
  const titleOf = (lines) => {
    const big = lines.filter((l) => l.size >= min && l.text.length >= 1 && l.text.length <= 90);
    if (!big.length) return null;
    const size = Math.max(...big.map((l) => l.size));
    const first = big.filter((l) => Math.abs(l.size - size) < 0.5).sort((a, b) => b.y - a.y)[0];
    const parts = [first.text];
    let y = first.y;
    for (const l of lines) {
      if (l.y >= y || Math.abs(l.size - size) >= 0.5) continue;
      if (y - l.y > size * 1.7) break;
      parts.push(l.text);
      y = l.y;
    }
    const text = parts.join(" ").replace(/\s+/g, " ").trim();
    return text.length <= 120 ? text : text.slice(0, 117).replace(/\s+\S*$/, "") + "…";
  };
  const out = [];
  let divider = null;
  for (const pg of pages) {
    const title = titleOf(pg.lines);
    if (!title) continue;
    if (/^[\d\s.·—–-]{1,4}$/.test(title)) {
      divider = divider ?? pg.n;
      continue;
    }
    out.push({ title, page: divider ?? pg.n, depth: 0 });
    divider = null;
  }
  return out;
}

// -------------------------------------------------------------------------
// Chapters worked out by an older import. The way a PDF is cut into chapters
// improves now and then (v2: chapters from page titles); a book imported
// before keeps its old cut until it's opened, when the reader redoes it.
// -------------------------------------------------------------------------
export const PDF_CHAPTERS_VERSION = 2;

// A book's reading progress carried over to new chapters: the place you were
// (a page, which no re-cut changes) now falls in some section — the sections
// before it count as read, that one as under way at your spot.
export function remapPdfProgress(prev, sections) {
  if (!prev) return prev;
  const out = { ...prev, chapters: {}, scrollTop: 0, updatedAt: Date.now() };
  const pos = parsePdfPos(prev.cfi);
  const at = pos && sectionOfPage(sections, pos.page);
  for (const s of sections) {
    if (prev.finished || (at && s.to < at.from))
      out.chapters[s.href] = { pct: 100, cfi: s === at ? prev.cfi : null, done: true };
  }
  if (at && !prev.finished) {
    const pct = Math.round(((pos.page - at.from + pos.frac) / (at.to - at.from + 1)) * 100);
    out.chapters[at.href] = { pct: Math.min(99, Math.max(1, pct)), cfi: prev.cfi, scrollTop: 0, done: false };
  }
  out.href = at ? at.href : null;
  out.chapterIndex = at ? sections.indexOf(at) : 0;
  out.chapterLabel = "";
  return out;
}
