// =========================================================================
// PROOFREADING MODE — an opt-in maintainer tool for working through the
// corrections found by scripts/proofread while reading. When switched on (in the
// reader drawer), each chapter asks the local proofreading server on this
// computer (`npm run proofread` → scripts/proofread/review.mjs) for its findings:
// pending ones are marked in the text, already-accepted ones are shown applied,
// discarded ones are left alone. Tapping a mark opens a sheet to accept / edit /
// discard; the decision goes straight into the server's decisions.json — the
// same file the review page uses — and the epubs are rewritten from there.
//
// Nothing here touches the stored book: marks and fixes live only in the
// rendered chapter. Paragraphs are hidden rather than removed so epub.js CFIs
// (reading positions) keep pointing at the same elements.
// =========================================================================
import { h } from "./dom.js";
import { armOverlay, closeOverlay } from "./router.js";

const SERVER = "http://localhost:5180";
const KEY = "ream-proofread";

let enabled = false;
try {
  enabled = localStorage.getItem(KEY) === "1";
} catch (_) {
  /* storage blocked: stays off */
}
let connection = "off"; // off | connecting | connected | offline
let bookPending = null; // pending findings left in the current book (from the server)
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());

export const proofEnabled = () => enabled;
export const proofState = () => ({ enabled, connection, bookPending, chapterPending: pendingMarks().length });
export const onProofChange = (fn) => listeners.add(fn);

export function setProofEnabled(on) {
  enabled = on;
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch (_) {
    /* best effort */
  }
  connection = on ? "connecting" : "off";
  if (!on) for (const c of chapters.values()) unmarkChapter(c);
  notify();
}

// ---- the chapters currently on screen --------------------------------------
// doc → { doc, paras, findings }
const chapters = new Map();

const slugify = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/\.epub$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const squash = (s) => String(s ?? "").replace(/[\s\u00a0\u200b-\u200d\ufeff]+/g, "");

async function api(path, init) {
  const res = await fetch(SERVER + path, { ...init, signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Content hook (registered before the chapter-end card is injected): fetch this
 * chapter's findings and mark them. `lib` is the library book, `href` this
 * document's spine href.
 */
export async function proofChapter(contents, lib, href) {
  const doc = contents?.document;
  if (!enabled || !doc?.body || !lib?.fileName || !href) return;
  // Snapshot the story paragraphs now, before other hooks append their own.
  const paras = [...doc.body.querySelectorAll("p")];
  const heading = doc.body.querySelector("h1, h2, h3");
  let data;
  try {
    data = await api(`/api/proof/chapter?book=${encodeURIComponent(slugify(lib.fileName))}&href=${encodeURIComponent(href)}`);
    connection = "connected";
  } catch (_) {
    connection = "offline";
    notify();
    return;
  }
  if (!doc.defaultView) return; // chapter already gone
  bookPending = data.bookPending ?? bookPending;
  const c = { doc, paras, heading, findings: [] };
  chapters.set(doc, c);
  doc.defaultView.addEventListener("unload", () => {
    chapters.delete(doc);
    notify();
  });
  injectStyle(doc);
  for (const f of data.findings) {
    // Only act on the exact text the finding was made for — never on a book
    // that has since been corrected or differs from the proofread copy.
    if (!Object.entries(f.expect).every(([i, t]) => paras[i] && squash(paras[i].textContent) === squash(t))) continue;
    c.findings.push(f);
    if (f.status === "accepted") applyFix(c, f);
    else if (f.status === "pending") mark(c, f);
  }
  doc.addEventListener("click", (e) => {
    const m = e.target.closest?.("[data-proof]");
    if (!m) return;
    e.preventDefault();
    e.stopPropagation();
    const f = c.findings.find((x) => x.id === m.dataset.proof);
    if (f) openSheet(c, f);
  }, true);
  notify();
}

function injectStyle(doc) {
  if (doc.getElementById("ream-proof")) return;
  const s = doc.createElement("style");
  s.id = "ream-proof";
  s.textContent = `
    .proof-mark { background: rgba(143, 179, 255, 0.12); border-bottom: 1.5px dotted rgba(143, 179, 255, 0.85); border-radius: 2px; cursor: pointer; }
    .proof-mark:hover, .proof-mark.is-active { background: rgba(143, 179, 255, 0.26); }
    .proof-mark--empty { display: inline-block; min-width: 0.6em; }
    .proof-para { background: rgba(143, 179, 255, 0.07); box-shadow: -8px 0 0 -5px rgba(143, 179, 255, 0.75); border-radius: 3px; cursor: pointer; }
    .proof-para:hover, .proof-para.is-active { background: rgba(143, 179, 255, 0.16); }
    .proof-para--del { text-decoration: line-through rgba(217, 112, 102, 0.55); }
    .proof-split { display: block; margin-bottom: 1em; }
  `;
  (doc.head || doc.documentElement).append(s);
}

// ---- locating text inside a paragraph ---------------------------------------

/** A DOM Range over `needle` inside element `p` (across text nodes), or null. */
function findRange(p, needle) {
  if (!needle) return null;
  const doc = p.ownerDocument;
  const walker = doc.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let text = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ n, at: text.length });
    text += n.data;
  }
  const loose = (s) => s.replace(/\u00a0/g, " ");
  const at = loose(text).indexOf(loose(needle));
  if (at < 0) return null;
  const end = at + needle.length;
  const pos = (i, isEnd) => {
    for (let k = nodes.length - 1; k >= 0; k--) {
      const { n, at: a } = nodes[k];
      if (isEnd ? a < i || (i === 0 && a === 0) : a <= i) return [n, i - a];
    }
    return [nodes[0].n, 0];
  };
  const r = doc.createRange();
  r.setStart(...pos(at, false));
  r.setEnd(...pos(end, true));
  return r;
}

// ---- marking & applying -----------------------------------------------------

const parasOf = (c, f) => {
  if (f.op === "title") return [];
  const last = f.op === "delete-paras" ? f.paraEnd : f.para;
  return c.paras.slice(f.para, last + 1);
};

function mark(c, f) {
  if (f.op === "title") {
    if (c.heading) tag(c.heading, f, "proof-mark");
    return;
  }
  if (f.op === "delete-paras") return parasOf(c, f).forEach((p) => tag(p, f, "proof-para proof-para--del"));
  if (f.op === "split-para") return tag(c.paras[f.para], f, "proof-para");
  // replace (optionally joining the next paragraph back in)
  const p = c.paras[f.para];
  const r = findRange(p, f.original);
  if (!r) return tag(p, f, "proof-para");
  const span = c.doc.createElement("span");
  span.className = "proof-mark" + (f.original.trim() ? "" : " proof-mark--empty");
  span.dataset.proof = f.id;
  span.append(r.extractContents());
  r.insertNode(span);
  if (f.alsoDelete != null && c.paras[f.alsoDelete]) tag(c.paras[f.alsoDelete], f, "proof-para proof-para--del");
}

function tag(node, f, cls) {
  node.dataset.proof = f.id;
  for (const k of cls.split(" ")) node.classList.add(k);
}

/** Remove a finding's marks, restoring the text as it was. */
function unmark(c, f) {
  for (const n of [...c.doc.querySelectorAll(`[data-proof="${CSS.escape(f.id)}"]`)]) {
    if (n.tagName === "SPAN") {
      n.replaceWith(...n.childNodes);
    } else {
      delete n.dataset.proof;
      n.classList.remove("proof-mark", "proof-para", "proof-para--del", "is-active");
    }
  }
  c.doc.body.normalize();
}

function unmarkChapter(c) {
  for (const f of c.findings) unmark(c, f);
}

// Hidden, not removed: CFIs count element positions, so reading spots stay put.
const hide = (p) => p.style.setProperty("display", "none", "important");

/** Show the corrected text in the rendered chapter. */
function applyFix(c, f) {
  if (f.op === "title") {
    if (c.heading) c.heading.textContent = f.replacement;
    return;
  }
  if (f.op === "delete-paras") return parasOf(c, f).forEach(hide);
  const p = c.paras[f.para];
  if (f.op === "split-para") {
    p.replaceChildren(...f.replacement.split("\n\n").map((t) => h("span", { class: "proof-split" }, t)));
    return;
  }
  if (f.alsoDelete != null && c.paras[f.alsoDelete]) hide(c.paras[f.alsoDelete]);
  const r = findRange(p, f.original);
  if (!r) return;
  r.deleteContents();
  r.insertNode(c.doc.createTextNode(f.replacement));
  p.normalize();
}

const pendingMarks = () => {
  const out = [];
  for (const c of chapters.values())
    for (const f of c.findings) if (f.status === "pending") out.push({ c, f });
  return out;
};

// ---- jump to the next suggestion -------------------------------------------

/** Scroll the reader to the next pending suggestion below the current view and open it. */
export function nextSuggestion(container) {
  const list = pendingMarks();
  if (!list.length) return false;
  const topOf = ({ c, f }) => {
    const n = c.doc.querySelector(`[data-proof="${CSS.escape(f.id)}"]`);
    const frame = c.doc.defaultView?.frameElement;
    if (!n || !frame) return null;
    return frame.offsetTop + n.getBoundingClientRect().top;
  };
  const view = (container?.scrollTop ?? 0) + 140;
  const placed = list.map((x) => ({ ...x, top: topOf(x) })).filter((x) => x.top != null).sort((a, b) => a.top - b.top);
  const next = placed.find((x) => x.top > view) || placed[0];
  if (!next) return false;
  container?.scrollTo({ top: Math.max(0, next.top - container.clientHeight / 3), behavior: "smooth" });
  openSheet(next.c, next.f);
  return true;
}

// ---- the decision sheet -----------------------------------------------------

let sheet = null;
function sheetEl() {
  if (sheet) return sheet;
  sheet = h(
    "div",
    { class: "sheet proof-sheet", hidden: true },
    h("div", { class: "sheet-scrim", onclick: () => closeOverlay() }),
    h("div", { class: "sheet-card proof-card", role: "dialog", "aria-modal": "true" })
  );
  document.body.append(sheet);
  return sheet;
}

const KIND_LABEL = {
  typo: "Typo",
  "wrong-word": "Wrong word",
  "missing-word": "Missing word",
  punctuation: "Punctuation",
  duplicate: "Doubled text",
  misplaced: "Misplaced text",
  junk: "Website junk",
  garbled: "Garbled text",
  homoglyph: "Look-alike letters",
  encoding: "Broken encoding",
  invisible: "Invisible characters",
  format: "Paragraphs",
  title: "Chapter title",
  name: "Name",
};

/** original/replacement with only the changed middle highlighted. */
function diffView(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  // Widen to whole words — "~~ever~~ even" reads better than "eve~~r~~n".
  const word = /[\p{L}\p{N}'’]/u;
  while (i > 0 && word.test(a[i - 1])) i--;
  while (j > 0 && word.test(a[a.length - j])) j--;
  const cut = (s, max) => (s.length > max ? "…" + s.slice(-max) : s);
  const cutEnd = (s, max) => (s.length > max ? s.slice(0, max) + "…" : s);
  return h(
    "p",
    { class: "proof-diff" },
    cut(a.slice(0, i), 120),
    a.slice(i, a.length - j) ? h("del", null, a.slice(i, a.length - j)) : null,
    b.slice(i, b.length - j) ? h("ins", null, b.slice(i, b.length - j)) : null,
    cutEnd(a.slice(a.length - j), 120)
  );
}

function openSheet(c, f) {
  const root = sheetEl();
  const card = root.querySelector(".proof-card");
  const marks = [...c.doc.querySelectorAll(`[data-proof="${CSS.escape(f.id)}"]`)];
  marks.forEach((m) => m.classList.add("is-active"));

  let body;
  if (f.op === "delete-paras") {
    const text = parasOf(c, f).map((p) => p.textContent).join(" ");
    body = h("p", { class: "proof-diff" }, h("del", null, text.length > 600 ? text.slice(0, 600) + "…" : text));
  } else if (f.op === "split-para") {
    body = h("div", { class: "proof-diff" }, ...f.replacement.split("\n\n").map((t) => h("p", null, t)));
  } else {
    body = diffView(f.original, f.replacement);
  }
  const editBox = h("textarea", { class: "name-input proof-edit", rows: 3, hidden: true });
  const error = h("p", { class: "proof-error", hidden: true }, "Couldn't reach the proofreading server — is it still running?");
  const canEdit = f.op === "replace" || f.op === "title";

  const decide = async (status, extra = {}) => {
    try {
      await api("/api/decisions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [f.id]: { status, ...extra, from: "reader" } }),
      });
    } catch (_) {
      error.hidden = false;
      return;
    }
    unmark(c, f);
    if (extra.replacement !== undefined) f.replacement = extra.replacement;
    if (status === "accepted") applyFix(c, f);
    f.status = status;
    if (bookPending != null) bookPending = Math.max(0, bookPending - 1);
    closeOverlay();
    notify();
  };

  card.replaceChildren(
    h(
      "div",
      { class: "proof-head" },
      h("span", { class: "proof-kind" }, KIND_LABEL[f.kind] || f.kind),
      f.confidence ? h("span", { class: "proof-conf" }, `${f.confidence} confidence`) : null,
      h("span", { class: "proof-src" }, f.source === "auto" ? "automatic" : "claude")
    ),
    h("p", { class: "proof-note" }, f.note),
    body,
    editBox,
    error,
    h(
      "div",
      { class: "proof-actions" },
      h("button", { class: "pill-btn proof-accept", onclick: () => (editBox.hidden ? decide("accepted") : decide("accepted", { replacement: editBox.value })) }, "Accept"),
      canEdit
        ? h("button", {
            class: "text-btn",
            onclick: (e) => {
              editBox.hidden = false;
              editBox.value = f.replacement;
              editBox.focus();
              e.currentTarget.hidden = true;
            },
          }, "Edit")
        : null,
      h("button", { class: "text-btn text-btn--danger", onclick: () => decide("discarded") }, "Discard"),
      h("button", { class: "text-btn proof-later", onclick: () => closeOverlay() }, "Later")
    )
  );

  const onKey = (e) => {
    if (e.target === editBox) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) decide("accepted", { replacement: editBox.value });
      if (e.key === "Escape") closeOverlay();
      return;
    }
    const k = e.key.toLowerCase();
    if (k === "a" || k === "enter") decide("accepted");
    else if (k === "d") decide("discarded");
    else if (k === "escape") closeOverlay();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  root.hidden = false;
  document.addEventListener("keydown", onKey, true);
  armOverlay(() => {
    root.hidden = true;
    document.removeEventListener("keydown", onKey, true);
    marks.forEach((m) => m.classList.remove("is-active"));
  });
}
