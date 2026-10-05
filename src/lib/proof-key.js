// Fingerprint of a paragraph's text, shared by the proofreading scripts (Node)
// and the reader's proofreading mode. A finding carries the fingerprint of the
// paragraph(s) it was made for, and the reader only applies it where the text
// on screen has the same fingerprint — so findings are matched by content, not
// by file name or library id (separate volumes, a grouped series, a renamed
// file all work), and a fix never lands on a different or already-corrected
// paragraph. Whitespace and invisible characters are ignored, since the DOM's
// textContent and the scripts' extracted text differ only there.
export function textKey(text) {
  const t = String(text ?? "").replace(/[\s\u00a0\u200b-\u200d\u2060\ufeff]+/g, "");
  let h = 0x811c9dc5; // FNV-1a, 32-bit
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36) + "." + t.length.toString(36);
}

// A paragraph's similarity signature: 12 one-byte MinHashes of its letter 4-grams
// (case, spacing and punctuation ignored). Two signatures agreeing on most bytes
// come from nearly the same text — the same paragraph with a typo fixed — while
// carrying none of it. Used where a reference should survive small edits (the
// Soul Sea's rune sheets); an exact match still goes by textKey.
const SIG_N = 12;
export function textSig(text) {
  const t = String(text ?? "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const min = new Array(SIG_N).fill(0xffffffff);
  for (let i = 0; i + 4 <= Math.max(t.length, 4); i++) {
    const g = t.slice(i, i + 4);
    for (let k = 0; k < SIG_N; k++) {
      let h = (0x811c9dc5 ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0;
      for (let j = 0; j < g.length; j++) {
        h ^= g.charCodeAt(j);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      h ^= h >>> 15;
      h = Math.imul(h, 0x2c1b3c6d) >>> 0;
      h ^= h >>> 12;
      if (h < min[k]) min[k] = h;
    }
  }
  return min.map((h) => (h & 0xff).toString(16).padStart(2, "0")).join("");
}
/** The share of two signatures' bytes that agree (0–1). */
export function sigSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let same = 0;
  for (let i = 0; i < a.length; i += 2) if (a.slice(i, i + 2) === b.slice(i, i + 2)) same++;
  return same / (a.length / 2);
}
