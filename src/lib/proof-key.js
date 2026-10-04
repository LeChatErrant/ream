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
