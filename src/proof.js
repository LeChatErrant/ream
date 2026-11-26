// =========================================================================
// PROOFREADING MODE — an opt-in tool for working through suggested corrections
// while reading. Everything revolves around one *proofreading file*: every
// suggested correction plus the decisions taken on it. It's made by the dev
// tooling (scripts/proofread), imported here, and exported again with the
// latest decisions — the same file goes back and forth between devices, and
// importing always merges (per correction, the newest decision wins). It all
// works offline; no server is involved.
//
// Switched on from the proofreading panel (the reader drawer's Proofreading
// row opens it), each chapter's open suggestions are
// marked in the text, accepted ones are shown applied and discarded ones are
// left alone; tapping a mark opens a sheet to accept / edit / discard.
// Switched off, the book reads exactly as the epub has it — no marks and no
// accepted fixes either (the Soul Sea included), so the uncorrected text is
// always one tap away.
//
// What was accepted stays findable: the chapter's and the whole book's
// corrections lists, and an optional sage underline on every applied fix
// (tap it to see what it changed, or undo it).
//
// Suggestions are matched by the fingerprint of the paragraph text they were
// made for (lib/proof-key.js), never by file name or library id — so separate
// volumes, a grouped series or a renamed file all work, and a fix never lands
// on a different or already-corrected paragraph.
//
// Nothing here touches the stored book: marks and fixes live only in the
// rendered chapter. Paragraphs are hidden rather than removed so epub.js CFIs
// (reading positions) keep pointing at the same elements.
// =========================================================================
import { h } from "./dom.js";
import { armOverlay, closeOverlay } from "./router.js";
import { kvGet, kvSet, kvDelete } from "./db.js";
import { textKey } from "./lib/proof-key.js";

const KEY = "ream-proofread"; // localStorage: the on/off switch
const SHOW_KEY = "ream-proof-show"; // localStorage: highlight the accepted corrections in the text
const BOOKS_KEY = "proof-book-of-lib"; // kv: library book id → its book key in the file, learned from matches
const PKG_KEY = "proof-package"; // kv: the imported proofreading file
const LOCAL_KEY = "proof-decisions"; // kv: decisions taken on this device { decisions: { id: { status, replacement?, at } }, exportedAt }
const PACKAGE_FORMAT = "ream-proofreading";
const DECISIONS_FORMAT = "ream-proofreading-decisions"; // older decisions-only exports

let enabled = false;
let showApplied = false;
try {
  enabled = localStorage.getItem(KEY) === "1";
  showApplied = localStorage.getItem(SHOW_KEY) === "1";
} catch (_) {
  /* storage blocked: stays off */
}
let pkg = null; // the imported proofreading file, if any
let byFile = new Map(); // "page-12.html" → that file's suggestions (across every book)
let local = { decisions: {}, exportedAt: null };
let bookOfLib = new Map(); // library book id → book key in the file, learned from matches
let currentLib = null; // the library book the reader has open
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());

// Load the file + this device's decisions once, at startup.
export const proofReady = (async () => {
  try {
    // Check the shape: an older or foreign record is ignored.
    const p = await kvGet(PKG_KEY);
    pkg = p?.format === PACKAGE_FORMAT && Array.isArray(p.findings) ? p : null;
    const l = await kvGet(LOCAL_KEY);
    if (l?.decisions && typeof l.decisions === "object") local = l;
    const b = await kvGet(BOOKS_KEY);
    if (b && typeof b === "object") bookOfLib = new Map(Object.entries(b));
  } catch (_) {
    /* no IndexedDB: proofreading unavailable */
  }
  indexPackage();
  notify();
})();

function indexPackage() {
  byFile = new Map();
  for (const f of pkg?.findings || []) {
    const k = f.href.split("/").pop();
    (byFile.get(k) || byFile.set(k, []).get(k)).push(f);
  }
}

const unexported = () => Object.values(local.decisions).filter((d) => !local.exportedAt || d.at > local.exportedAt).length;

export const proofEnabled = () => enabled;
export function proofState() {
  const shown = onScreen().flatMap((c) => c.findings);
  const book = bookCounts(bookKeyFor(currentLib));
  return {
    enabled,
    hasFile: !!pkg,
    bookPending: book?.pending ?? null,
    bookAccepted: book?.accepted ?? null,
    bookDiscarded: book?.discarded ?? null,
    bookTotal: book?.total ?? null,
    bookName: (pkg?.books || {})[bookKeyFor(currentLib)] || null,
    chapterLoaded: onScreen().length > 0,
    chapterPending: shown.filter((f) => f.status === "pending").length,
    chapterAccepted: shown.filter((f) => f.status === "accepted").length,
    chapterTotal: shown.length,
    fileDate: pkg?.createdAt || null,
    toExport: unexported(),
  };
}
export const onProofChange = (fn) => listeners.add(fn);

// Accepted corrections read like the rest of the text unless this is on: then
// each one is underlined (sage green, where the marks to review are blue) and can be
// tapped to see what it changed — or to undo it.
export const proofShowApplied = () => showApplied;
export function setProofShowApplied(on) {
  showApplied = on;
  try {
    localStorage.setItem(SHOW_KEY, on ? "1" : "0");
  } catch (_) {
    /* best effort */
  }
  for (const c of onScreen()) c.doc.body.classList.toggle("proof-show-applied", on);
  notify();
}

export function setProofEnabled(on) {
  enabled = on;
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch (_) {
    /* best effort */
  }
  // Off reads the epub as it is: marks and accepted fixes both go. A chapter
  // already matched keeps its findings, so switching back on redraws it here
  // (proofChapter would skip it).
  for (const c of onScreen()) (on ? showChapter : hideChapter)(c);
  notify();
}

// ---- import / export ----------------------------------------------------------

/** Newest of two decisions (by their `at` timestamps). */
const newer = (a, b) => (!a ? b : !b ? a : (a.at || "") >= (b.at || "") ? a : b);

async function readProofFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (err) {
    throw new Error("That file isn't a proofreading file.", { cause: err });
  }
  if (data?.format === PACKAGE_FORMAT && Array.isArray(data.findings)) return data;
  if (data?.format === DECISIONS_FORMAT && data.decisions && typeof data.decisions === "object") return data;
  throw new Error("That file isn't a proofreading file.");
}

/**
 * Import a proofreading file (from the dev tooling or another device). Its
 * suggestions become this device's, and its decisions merge with the ones
 * already here — per suggestion, the newest wins. Returns a short summary.
 */
export async function importProofreading(file) {
  const data = await readProofFile(file);
  const incoming = data.decisions || {};
  if (data.format === PACKAGE_FORMAT) {
    const merged = { ...(pkg?.decisions || {}) };
    for (const [id, d] of Object.entries(incoming)) merged[id] = newer(merged[id], d);
    pkg = { ...data, decisions: merged };
    indexPackage();
    await kvSet(PKG_KEY, pkg);
    setProofEnabled(true);
    const pending = pkg.findings.filter((f) => !isDecided(decisionOf(f.id, pkg.decisions))).length;
    return `Proofreading imported — ${pending.toLocaleString()} of ${pkg.findings.length.toLocaleString()} to review`;
  }
  // An older decisions-only export: fold it into the file already here.
  if (!pkg) throw new Error("Import a full proofreading file first.");
  let taken = 0;
  for (const [id, d] of Object.entries(incoming)) {
    if (!d || !["accepted", "discarded", "pending"].includes(d.status)) continue;
    const mine = decisionOf(id, pkg.decisions);
    if (mine !== d && newer(mine, d) === d) {
      pkg.decisions[id] = d;
      taken++;
    }
  }
  await kvSet(PKG_KEY, pkg);
  notify();
  return `Merged — ${taken} decision${taken === 1 ? "" : "s"} taken`;
}

// ---- the linked file ----------------------------------------------------------
// One fixed name everywhere, so re-exporting replaces the file rather than piling
// up copies. Where the browser can write to a chosen file (Chrome / Edge on a
// computer), the first export asks where to save and every later one overwrites
// that same file; "Export to another file…" changes it. Importing never changes
// where exports go — with several same-named copies around (the dev tool's, the
// one you send to the phone) that would silently write to the wrong one.
export const FILE_NAME = "ream-proofreading.json";
const HANDLE_KEY = "proof-export-handle"; // kv: FileSystemFileHandle of the export target
// (The previous key also remembered the *imported* file; it's dropped so the next export asks.)
kvDelete("proof-file-handle").catch(() => {});
const FILE_TYPES = [{ description: "Ream proofreading", accept: { "application/json": [".json"] } }];
const canWriteFiles = () => typeof window.showSaveFilePicker === "function" && !matchMedia("(pointer: coarse)").matches;
export const canPickFiles = () => typeof window.showOpenFilePicker === "function" && !matchMedia("(pointer: coarse)").matches;

let linked = null; // the linked file's handle (kept in memory, and in IndexedDB across launches)
let linkedName = null; // its name, for the menu
async function linkedHandle() {
  if (linked) return linked;
  try {
    const hnd = await kvGet(HANDLE_KEY);
    linked = hnd?.kind === "file" && typeof hnd.createWritable === "function" ? hnd : null;
  } catch (_) {
    linked = null;
  }
  return linked;
}
proofReady.then(async () => {
  linkedName = (await linkedHandle())?.name || null;
  notify();
});
async function linkFile(handle) {
  linked = handle || null;
  linkedName = handle?.name || null;
  try {
    if (handle) await kvSet(HANDLE_KEY, handle);
    else await kvDelete(HANDLE_KEY);
  } catch (_) {
    /* the browser can't store handles: exports just ask each time */
  }
}
export const linkedFileName = () => linkedName;

/** Pick a proofreading file through the browser's file picker (computer, Chrome / Edge). */
export async function pickAndImport() {
  let handle;
  try {
    [handle] = await window.showOpenFilePicker({ types: FILE_TYPES, multiple: false });
  } catch (e) {
    if (e?.name === "AbortError") return null;
    throw e;
  }
  return importProofreading(await handle.getFile());
}

// The export file is built ahead of time (when the menu opens): a phone only opens
// the share sheet while the tap is still being handled, and serialising a few MB
// of suggestions inside the tap can be slow enough for the browser to refuse.
let prepared = null; // { file, stamp } — stamp = decision count + exportedAt, to know it's still current
const exportStamp = () => `${Object.keys(local.decisions).length}|${JSON.stringify(local.decisions).length}|${pkg?.createdAt}`;

function buildExportFile() {
  const decisions = { ...(pkg.decisions || {}) };
  for (const [id, d] of Object.entries(local.decisions)) decisions[id] = newer(decisions[id], d);
  const data = { ...pkg, createdAt: new Date().toISOString(), decisions };
  return new File([JSON.stringify(data)], FILE_NAME, { type: "application/json" });
}

/** Build the export file now so a later Export tap only has to hand it over. */
export function prepareExport() {
  if (!pkg) return;
  const stamp = exportStamp();
  if (prepared?.stamp !== stamp) prepared = { file: buildExportFile(), stamp };
}
function exportFile() {
  prepareExport();
  return prepared.file;
}

/** Record that this device's decisions went out. */
export async function markExported() {
  local.exportedAt = new Date().toISOString();
  await kvSet(LOCAL_KEY, local);
  notify();
}

function download(file) {
  const a = h("a", { href: URL.createObjectURL(file), download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

/** How the last export went out: "file" (overwrote a file), "share" or "download". */
let lastExportVia = null;
export const exportVia = () => lastExportVia;

/**
 * Export the proofreading file with every decision known here. Overwrites the
 * file last exported to when the browser allows it (asking where to save the
 * first time, or always with `saveAs`); otherwise the share sheet on a phone, a
 * download elsewhere — both under the same fixed name. A phone that won't share
 * the file (Chrome on Android only shares images, PDFs, plain text… and answers
 * "Permission denied" for JSON) gets a download into Downloads instead. Returns
 * the file name, or null when cancelled.
 */
export async function exportProofreading({ saveAs = false } = {}) {
  if (!pkg) throw new Error("Nothing to export yet — import a proofreading file first.");
  const file = exportFile(); // before any await: keeps the tap's user activation for the share sheet
  let savedAs = FILE_NAME;
  try {
    if (canWriteFiles()) {
      let handle = saveAs ? null : await linkedHandle();
      if (handle && (await handle.queryPermission({ mode: "readwrite" })) !== "granted")
        if ((await handle.requestPermission({ mode: "readwrite" })) !== "granted") handle = null;
      if (!handle) handle = await window.showSaveFilePicker({ suggestedName: linkedName || FILE_NAME, types: FILE_TYPES });
      const w = await handle.createWritable();
      await w.write(file);
      await w.close();
      await linkFile(handle);
      savedAs = handle.name;
      lastExportVia = "file";
    } else if (matchMedia("(pointer: coarse)").matches && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "Ream proofreading" });
        lastExportVia = "share";
      } catch (e) {
        if (e?.name !== "NotAllowedError") throw e;
        download(file);
        lastExportVia = "download";
      }
    } else {
      download(file);
      lastExportVia = "download";
    }
  } catch (e) {
    if (e?.name === "AbortError") return null;
    throw e;
  }
  await markExported();
  return savedAs;
}

/** Forget the proofreading file and this device's decisions. */
export async function removePackage() {
  pkg = null;
  indexPackage();
  local = { decisions: {}, exportedAt: null };
  bookOfLib = new Map();
  await kvDelete(PKG_KEY);
  await kvDelete(LOCAL_KEY);
  await kvDelete(BOOKS_KEY);
  await linkFile(null);
  for (const c of onScreen()) hideChapter(c);
  chapters.clear();
  notify();
}

/**
 * A chapter's paragraphs (`texts`, every <p> of the spine file at `href`) as this
 * device's copy reads once an accepted "replace chapter" fix is in: the real
 * chapter instead of the rewritten one. For what reads the book outside the
 * reader (the Soul Sea). Like the reader, it follows the switch: with
 * proofreading off the book reads uncorrected. Null when no accepted fix fits.
 */
export async function realChapter(href, texts) {
  await proofReady;
  if (!enabled || !pkg) return null;
  const f = (byFile.get(href.split("/").pop()) || []).find(
    (f) =>
      f.op === "replace-chapter" &&
      (f.href === href || f.href.endsWith("/" + href) || href.endsWith("/" + f.href)) &&
      Object.entries(f.check || {}).every(([i, k]) => texts[i] != null && textKey(texts[i]) === k)
  );
  if (!f) return null;
  const v = withDecision(f, decisionOf(f.id, pkg.decisions));
  if (v.status !== "accepted") return null;
  return [...texts.slice(0, f.para), ...v.replacement.split("\n\n"), ...texts.slice(f.paraEnd + 1)];
}

// ---- the chapters currently on screen --------------------------------------
// doc → { doc, paras, heading, findings }
const chapters = new Map();

/**
 * The chapters still on screen. A chapter left behind is dropped here too, not
 * only on its frame's pagehide / unload: Chrome no longer reliably fires those
 * when epub.js removes the iframe, and a stale chapter would keep its
 * corrections in the list (repeated on every visit). A removed frame's
 * document has no window.
 */
function onScreen() {
  for (const doc of chapters.keys()) if (!doc.defaultView) chapters.delete(doc);
  return [...chapters.values()];
}

const slugify = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/\.epub$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// Text outside paragraphs (the title repeated as an <h3>, ads, watermarks in
// made-up tags, story text that lost its <p>): found by the fingerprint of its text.
const isBlockOp = (f) => f.op === "delete-block" || f.op === "wrap-text";
function locateBlock(doc, f, taken) {
  if (f.op === "delete-block") {
    for (const el of doc.body.getElementsByTagName(f.block.tag)) {
      if (taken.has(el) || el.closest("p, .chapter-title-wrap")) continue;
      if (textKey(el.textContent) === f.block.key) return el;
    }
    return null;
  }
  const w = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (taken.has(n) || n.parentElement?.closest("p, h1, h2, h3, h4, h5, h6, li, a, script, style")) continue;
    if (textKey(n.data) === f.block.key) return n;
  }
  return null;
}
/** The block a finding addresses — remembered, or found again after its text node was swapped. */
function blockNode(c, f) {
  const known = c.blocks.get(f.id);
  if (known?.isConnected) return known;
  const n = locateBlock(c.doc, f, new Set());
  c.blocks.set(f.id, n);
  return n;
}

/** Does this suggestion belong to the text on screen? (fingerprints of every paragraph it touches) */
function fits(f, paras, heading) {
  if (f.op === "title") return !!heading && textKey(heading.textContent) === f.titleKey;
  return Object.entries(f.check || {}).every(([i, k]) => paras[i] && textKey(paras[i].textContent) === k);
}

/** The suggestion as it should show, with its decision (and any edit / "other copy" choice) folded in. */
function withDecision(f, d) {
  const v = { ...f, base: f, status: d?.status || "pending" };
  if (d?.replacement !== undefined && f.op !== "delete-paras") v.replacement = d.replacement;
  if (d?.choice === "other" && f.dupOf) Object.assign(v, { para: f.dupOf.para, paraEnd: f.dupOf.paraEnd });
  return v;
}

// An undone decision is recorded as { status: "pending" } so it still wins over an
// older accept / discard (from the file or another device) when merging.
const decisionOf = (id, base) => newer(local.decisions[id], base?.[id]);
const isDecided = (d) => !!d && d.status !== "pending";

// ---- the open book ------------------------------------------------------------

const looseName = (s) => slugify(String(s || "").replace(/\.(epub|pdf)$/i, ""));

/**
 * The book key (in the file) of a library book: the one learned from a chapter
 * that matched, else the one named like its file, else the one titled like it.
 */
function bookKeyFor(lib) {
  if (!lib || !pkg) return null;
  const books = pkg.books || {};
  const known = bookOfLib.get(lib.id);
  if (known && (known in books || pkg.findings.some((f) => f.book === known))) return known;
  const slug = slugify(lib.fileName);
  if (slug in books) return slug;
  const title = looseName(lib.title);
  for (const [k, name] of Object.entries(books)) if (title && (looseName(name) === title || looseName(k) === title)) return k;
  return null;
}
function learnBook(lib, key) {
  if (!lib?.id || !key || bookOfLib.get(lib.id) === key) return;
  bookOfLib.set(lib.id, key);
  kvSet(BOOKS_KEY, Object.fromEntries(bookOfLib)).catch(() => {});
}

/** A book's suggestions as they stand here (each with its decision folded in). */
function bookFindings(key) {
  if (!key || !pkg) return [];
  return pkg.findings.filter((f) => f.book === key).map((f) => withDecision(f, decisionOf(f.id, pkg.decisions)));
}
function bookCounts(key) {
  if (!key || !pkg) return null;
  const n = { pending: 0, accepted: 0, discarded: 0, total: 0 };
  for (const f of pkg.findings) {
    if (f.book !== key) continue;
    n[decisionOf(f.id, pkg.decisions)?.status || "pending"]++;
    n.total++;
  }
  return n;
}

/**
 * Content hook (registered before the chapter-end card is injected): find this
 * chapter's suggestions and mark them. `lib` is the library book, `href` this
 * document's spine href.
 */
export async function proofChapter(contents, lib, href) {
  const doc = contents?.document;
  if (!enabled || !doc?.body || !href) return;
  // Snapshot the story paragraphs now, before other hooks append their own.
  const paras = [...doc.body.querySelectorAll("p")];
  const heading = doc.body.querySelector("h1, h2, h3");
  await proofReady;
  if (!enabled || !pkg || chapters.has(doc) || !doc.defaultView) return;

  // Same file name in every volume ("page-12.html"): the fingerprints decide.
  const candidates = (byFile.get(href.split("/").pop()) || []).filter(
    (f) => f.href === href || f.href.endsWith("/" + href) || href.endsWith("/" + f.href)
  );
  const base = pkg.decisions || {};

  // Match first, change after: applying a fix alters the paragraph's fingerprint.
  const blocks = new Map();
  const taken = new Set();
  const matched = candidates.filter((f) => {
    if (!isBlockOp(f)) return fits(f, paras, heading);
    const n = locateBlock(doc, f, taken);
    if (!n) return false;
    taken.add(n);
    blocks.set(f.id, n);
    return true;
  });
  if (lib) {
    currentLib = lib;
    if (matched[0]) learnBook(lib, matched[0].book);
  }

  const c = { doc, paras, heading, headingText: heading?.textContent ?? "", findings: [], base, joins: new Map(), blocks, shown: true };
  chapters.set(doc, c);
  const gone = () => chapters.delete(doc) && notify();
  doc.defaultView.addEventListener("pagehide", gone);
  doc.defaultView.addEventListener("unload", gone);
  injectStyle(doc);
  doc.body.classList.toggle("proof-show-applied", showApplied);
  for (const f of matched) {
    const v = withDecision(f, decisionOf(f.id, base));
    c.findings.push(v);
    if (v.status === "accepted") applyFix(c, v);
    else if (v.status === "pending") mark(c, v);
    else anchorOriginal(c, v);
  }
  doc.addEventListener(
    "click",
    (e) => {
      const m = e.target.closest?.("[data-proof]") || (showApplied ? e.target.closest?.(".proof-applied, .proof-applied-block") : null);
      if (!m) return;
      e.preventDefault();
      e.stopPropagation();
      const id = m.dataset.proof || m.dataset.proofRef;
      const f = c.findings.find((x) => x.id === id);
      if (f) openSheet(c, f);
    },
    true
  );
  notify();
}

/** Record a decision on this device. */
async function saveDecision(f, status, extra) {
  local.decisions[f.id] = { status, ...extra, at: new Date().toISOString(), from: "reader" };
  await kvSet(LOCAL_KEY, local);
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
    .proof-joined { display: inline !important; }
    .proof-joined + .proof-joined::before { content: " "; }
    .proof-join-head::before { content: ""; display: block; height: var(--proof-gap-top, 0); }
    .proof-show-applied .proof-applied { background: rgba(127, 183, 164, 0.1); border-bottom: 1.5px dotted rgba(127, 183, 164, 0.8); border-radius: 2px; cursor: pointer; }
    .proof-show-applied .proof-applied:empty { display: inline-block; min-width: 0.5em; }
    .proof-show-applied .proof-applied-block { background: rgba(127, 183, 164, 0.06); box-shadow: -8px 0 0 -5px rgba(127, 183, 164, 0.7); border-radius: 3px; cursor: pointer; }
    .proof-show-applied .proof-applied.is-active, .proof-show-applied .proof-applied-block.is-active { background: rgba(127, 183, 164, 0.22); }
    .proof-flash { animation: proof-flash 1.8s ease-out; border-radius: 3px; }
    @keyframes proof-flash { 0%, 35% { background: rgba(143, 179, 255, 0.34); } 100% { background: transparent; } }
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
  const last = f.op === "delete-paras" || f.op === "replace-chapter" ? f.paraEnd : f.para;
  return c.paras.slice(f.para, last + 1);
};

function mark(c, f) {
  if (f.op === "delete-block") return tag(blockNode(c, f), f, "proof-para proof-para--del");
  if (f.op === "wrap-text") {
    const n = blockNode(c, f);
    const span = c.doc.createElement("span");
    span.className = "proof-mark";
    span.dataset.proof = f.id;
    n.replaceWith(span);
    span.append(n);
    return;
  }
  if (f.op === "title") {
    if (c.heading) tag(c.heading, f, "proof-mark");
    return;
  }
  if (f.op === "delete-paras") return parasOf(c, f).forEach((p) => tag(p, f, "proof-para proof-para--del"));
  if (f.op === "replace-chapter") return parasOf(c, f).forEach((p) => tag(p, f, "proof-para"));
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

/** Proofreading off: the chapter as the epub has it (marks gone, fixes undone, last first). */
function hideChapter(c) {
  if (!c.shown) return;
  c.shown = false;
  for (const f of [...c.findings].reverse()) (f.status === "pending" ? unmark : revert)(c, f);
}

/** Proofreading back on: marks and decisions shown again, as proofChapter first drew them. */
function showChapter(c) {
  if (c.shown) return;
  c.shown = true;
  for (const f of c.findings) {
    if (f.status === "accepted") applyFix(c, f);
    else if (f.status === "pending") mark(c, f);
    else anchorOriginal(c, f);
  }
}

// Hidden, not removed: CFIs count element positions, so reading spots stay put.
const hide = (p) => p.style.setProperty("display", "none", "important");

// Decided findings leave no visible trace, only an invisible anchor
// (data-proof-ref) so the corrections list can jump back to them.
const anchor = (node, f) => node && (node.dataset.proofRef = f.id);
// An accepted fix that shows in the text: anchored, and underlined (a span) or
// barred (a block) while "highlight corrections" is on.
const applied = (node, f, block = node?.tagName !== "SPAN") => {
  if (!node) return;
  anchor(node, f);
  node.classList.add(block ? "proof-applied-block" : "proof-applied");
};

/** Show the corrected text in the rendered chapter. */
function applyFix(c, f) {
  if (f.op === "delete-block") {
    const el = blockNode(c, f);
    hide(el);
    return anchor(el, f);
  }
  if (f.op === "wrap-text") {
    // Shown as a paragraph of its own (spaced like the story's), corrected.
    const n = blockNode(c, f);
    const ref = c.paras.find((p) => p.isConnected);
    const gap = ref ? c.doc.defaultView.getComputedStyle(ref).marginBottom : "1em";
    const span = c.doc.createElement("span");
    span.className = "proof-done";
    applied(span, f, true);
    span.textContent = f.replacement;
    span.style.cssText = `display: block; margin: ${gap} 0`;
    if (!f.replacement.trim()) hide(span);
    n.replaceWith(span);
    // The <br> that ended this loose line would add an empty line on top of the
    // paragraph spacing: hidden while the fix is in (revert shows it again).
    let next = span.nextSibling;
    while (next?.nodeType === Node.TEXT_NODE && !next.data.trim()) next = next.nextSibling;
    if (next?.nodeName === "BR") {
      next.dataset.proofRef = f.id;
      hide(next);
    }
    return;
  }
  if (f.op === "title") {
    if (c.heading) c.heading.textContent = f.replacement;
    return applied(c.heading, f, true);
  }
  if (f.op === "delete-paras" || f.op === "replace-chapter") {
    for (const p of parasOf(c, f)) {
      hide(p);
      anchor(p, f);
    }
    if (f.op === "replace-chapter") {
      // The real chapter, after the hidden copy (so reading spots before it stay put).
      const box = c.doc.createElement("div");
      box.className = "proof-done proof-chapter";
      applied(box, f, true);
      const cls = c.paras[f.para].getAttribute("class") || null; // styled like the book's paragraphs
      for (const t of f.replacement.split("\n\n")) box.append(h("p", { class: cls }, t));
      c.paras[f.paraEnd].after(box);
    }
    return;
  }
  const p = c.paras[f.para];
  if (f.op === "split-para" && f.breaks) {
    // Paragraphs run together: a break before each new paragraph's opening words,
    // leaving the text (and any fix inside it) as it is.
    const gap = c.doc.defaultView.getComputedStyle(p).marginBottom || "1em";
    for (const b of f.breaks) {
      const r = findRange(p, b) || findRange(p, b.slice(0, 12));
      if (!r) continue;
      r.collapse(true);
      const br = c.doc.createElement("span");
      br.className = "proof-break";
      br.dataset.proofRef = f.id;
      br.style.cssText = `display: block; height: ${gap}`;
      r.insertNode(br);
    }
    return applied(p, f, true);
  }
  if (f.op === "split-para") {
    p.replaceChildren(...f.replacement.split("\n\n").map((t) => h("span", { class: "proof-split" }, t)));
    return applied(p, f, true);
  }
  if (isJoin(f)) {
    c.joins.set(f.para, f.alsoDelete);
    layoutJoins(c);
    return applied(p, f, true);
  }
  if (f.alsoDelete != null && c.paras[f.alsoDelete]) {
    hide(c.paras[f.alsoDelete]);
    anchor(c.paras[f.alsoDelete], f);
  }
  const r = findRange(p, f.original);
  if (!r) return anchor(p, f);
  r.deleteContents();
  const span = c.doc.createElement("span");
  span.className = "proof-done";
  applied(span, f, false);
  span.textContent = f.replacement;
  r.insertNode(span);
}

// A sentence split across paragraphs is joined by showing the paragraphs inline,
// one after the other — not by moving the text — so a chain of joins (¶37 ← ¶38
// ← ¶39…) and the other fixes inside the joined paragraphs all keep working, in
// any order, and each one can be undone on its own.
const isJoin = (f) => f.op === "replace" && f.join && f.alsoDelete != null;

/**
 * Lay out the accepted joins: each run of joined paragraphs reads as one. Inline
 * paragraphs lose their margins, so the run's spacing is put back around it: on
 * the element after it, and (if the paragraph before leaves less) on top.
 */
function layoutJoins(c) {
  for (const p of c.paras) {
    p.classList.remove("proof-joined", "proof-join-head");
    p.style.removeProperty("--proof-gap-top");
  }
  for (const n of c.joinGaps || []) n.style.removeProperty("margin-top");
  c.joinGaps = [];
  const win = c.doc.defaultView;
  const px = (n, prop) => (n ? parseFloat(win.getComputedStyle(n)[prop]) || 0 : 0);
  const into = new Set(c.joins.values());
  const runs = [];
  for (const [head] of c.joins) {
    if (into.has(head) || !c.paras[head]) continue; // not the start of a run
    let tail = head;
    while (c.joins.has(tail) && c.paras[c.joins.get(tail)]) tail = c.joins.get(tail);
    runs.push({ first: c.paras[head], last: c.paras[tail], top: px(c.paras[head], "marginTop"), bottom: px(c.paras[head], "marginBottom") });
    for (let k = head; k <= tail; k++) c.paras[k].classList.add("proof-joined");
  }
  for (const { first, last, top, bottom } of runs) {
    first.classList.add("proof-join-head");
    // Space above: what the element before doesn't already give (an inline run before gives nothing).
    const prev = first.previousElementSibling;
    const given = prev && !prev.classList.contains("proof-joined") ? px(prev, "marginBottom") : 0;
    const before = prev?.classList.contains("proof-joined") ? Math.max(top, bottom) : top;
    first.style.setProperty("--proof-gap-top", `${Math.max(0, before - given)}px`);
    // Space below: on the element after (unless it's another run, which spaces itself).
    const after = last.nextElementSibling;
    if (after && !after.classList.contains("proof-joined") && px(after, "marginTop") < bottom) {
      after.style.setProperty("margin-top", `${bottom}px`);
      c.joinGaps.push(after);
    }
  }
}

/** A discarded finding: the text stays as it was, with an anchor around it. */
function anchorOriginal(c, f) {
  if (f.op === "delete-block") return anchor(blockNode(c, f), f);
  if (f.op === "wrap-text") {
    const n = blockNode(c, f);
    const span = c.doc.createElement("span");
    span.className = "proof-done";
    span.dataset.proofRef = f.id;
    n.replaceWith(span);
    span.append(n);
    return;
  }
  if (f.op === "title") return anchor(c.heading, f);
  if (f.op !== "replace") return parasOf(c, f).forEach((p) => anchor(p, f));
  const p = c.paras[f.para];
  const r = findRange(p, f.original);
  if (!r) return anchor(p, f);
  const span = c.doc.createElement("span");
  span.className = "proof-done";
  span.dataset.proofRef = f.id;
  span.append(r.extractContents());
  r.insertNode(span);
}

/** Undo how a decided finding is shown (before showing another decision). */
function revert(c, f) {
  const applied = f.status === "accepted";
  for (const n of [...c.doc.querySelectorAll(`[data-proof-ref="${CSS.escape(f.id)}"]`)]) {
    delete n.dataset.proofRef;
    n.classList.remove("proof-applied", "proof-applied-block", "is-active");
    if (n.classList.contains("proof-chapter") || n.classList.contains("proof-break")) {
      n.remove();
    } else if (n.classList.contains("proof-done")) {
      if (applied) n.replaceWith(c.doc.createTextNode(f.original));
      else n.replaceWith(...n.childNodes);
    } else if (n === c.heading) {
      if (applied) n.textContent = c.headingText;
    } else {
      n.style.removeProperty("display");
      if (applied && f.op === "split-para" && !f.breaks) n.textContent = f.original;
    }
  }
  if (applied && isJoin(f) && c.joins.delete(f.para)) layoutJoins(c);
  c.doc.body.normalize();
}

const pendingMarks = () => {
  const out = [];
  for (const c of onScreen())
    for (const f of c.findings) if (f.status === "pending") out.push({ c, f });
  return out;
};

// ---- jump to the next suggestion -------------------------------------------

/** Where a finding sits in the chapter: its mark, or the anchor of a decided one (a hidden paragraph → the one before it). */
function nodeOf(c, f) {
  let n = c.doc.querySelector(`[data-proof="${CSS.escape(f.id)}"]`) || c.doc.querySelector(`[data-proof-ref="${CSS.escape(f.id)}"]`);
  while (n && n.style?.display === "none") n = n.previousElementSibling;
  return n || c.heading;
}
const topOf = (c, f) => {
  const n = nodeOf(c, f);
  const frame = c.doc.defaultView?.frameElement;
  return n && frame ? frame.offsetTop + n.getBoundingClientRect().top : null;
};

/** Scroll to a finding, flash it, and open its sheet. */
function focusFinding(container, c, f) {
  const top = topOf(c, f);
  if (top != null) container?.scrollTo({ top: Math.max(0, top - container.clientHeight / 3), behavior: "smooth" });
  const n = nodeOf(c, f);
  if (n) {
    n.classList.remove("proof-flash");
    void n.offsetWidth; // restart the animation
    n.classList.add("proof-flash");
  }
  openSheet(c, f);
}

/** Scroll the reader to the next pending suggestion below the current view and open it. */
export function nextSuggestion(container) {
  const view = (container?.scrollTop ?? 0) + 140;
  const placed = pendingMarks()
    .map((x) => ({ ...x, top: topOf(x.c, x.f) }))
    .filter((x) => x.top != null)
    .sort((a, b) => a.top - b.top);
  const next = placed.find((x) => x.top > view) || placed[0];
  if (!next) return false;
  focusFinding(container, next.c, next.f);
  return true;
}

/** "12 to review · 340 accepted · 3 discarded" */
const countsLine = (n) =>
  [n.pending && `${n.pending.toLocaleString()} to review`, n.accepted && `${n.accepted.toLocaleString()} accepted`, n.discarded && `${n.discarded.toLocaleString()} discarded`]
    .filter(Boolean)
    .join(" · ");
const tally = (list) => {
  const n = { pending: 0, accepted: 0, discarded: 0 };
  for (const f of list) n[f.status]++;
  return n;
};
const orderOf = (f) => (f.op === "title" ? -1 : (f.para ?? f.pos ?? 0));

/** One row of a corrections list. */
const itemRow = (f, onclick) =>
  h(
    "button",
    { class: "proof-item", type: "button", onclick },
    h("span", { class: `proof-status proof-status--${f.status}` }, STATUS_LABEL[f.status]),
    h("span", { class: "proof-item__body" }, h("span", { class: "proof-item__kind" }, KIND_LABEL[f.kind] || f.kind), h("span", { class: "proof-item__text" }, summaryOf(f)))
  );

function showList(children) {
  const root = sheetEl();
  // Native replaceChildren would print a null slot as "null" — drop the empty ones.
  root.querySelector(".proof-card").replaceChildren(...children.filter(Boolean));
  root.hidden = false;
  armOverlay(() => (root.hidden = true));
}

// ---- the proofreading panel -------------------------------------------------
// What the drawer's Proofreading row opens: where this book stands (a bar split
// into accepted / discarded / to review), the way into its corrections, and the
// file itself — import, export, remove. Without a file it's an empty state whose
// one action is the import. The reader supplies the actions (`act`): import and
// export run inside the tap itself (a file picker or share sheet must open from
// a user gesture — iOS refuses it once the sheet has closed).

const PANEL_ICON = {
  list: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M9 6.5h10M9 12h10M9 17.5h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M4.6 6.5l.9.9 1.7-1.9M4.6 12l.9.9 1.7-1.9M4.6 17.5l.9.9 1.7-1.9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  import: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 4v10.5M7.5 10l4.5 4.5 4.5-4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.5 15v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  export: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 14.5V4M7.5 8.5L12 4l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.5 15v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  saveAs: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M13.5 4H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9.5L13.5 4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M13.5 4v5.5H19M12 12.5v5M9.5 15h5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  file: '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M13.5 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9l-5.5-5.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M13.5 3.5V9H19M8.5 13.5h4M8.5 16.5h7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  pen: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M4.5 19.5h4L18.6 9.4a2.1 2.1 0 0 0-3-3L5.5 16.5v3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M14 8l3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  underline: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M7.5 4.5V11a4.5 4.5 0 0 0 9 0V4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M5.5 19.5h13" fill="none" stroke="#7fb7a4" stroke-width="1.8" stroke-linecap="round"/></svg>',
};
export const PROOF_ICON = PANEL_ICON;
const icon = (name, cls) => h("span", { class: cls, "aria-hidden": "true", html: PANEL_ICON[name] });
const plural = (n, one, many = one + "s") => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const shortDate = (iso) => {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d)) return null;
  const opts = { month: "short", day: "numeric" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
};

/** One tappable row of the panel: icon · label over a quiet detail line · chevron. */
function panelRow({ glyph, label, detail, onclick, chevron = false, accent = null }) {
  return h(
    "button",
    { class: "proof-panel__row", type: "button", onclick },
    icon(glyph, "proof-panel__icon"),
    h("span", { class: "proof-panel__rtext" }, h("span", { class: "proof-panel__rlabel" }, label), detail ? h("span", { class: "proof-panel__rdetail" + (accent ? ` is-${accent}` : "") }, detail) : null),
    chevron ? icon("chevron", "proof-panel__chev") : null
  );
}

/** A switch row of the panel: icon · label over its detail · the switch. */
function switchRow({ glyph, label, detail, on, disabled = false, onclick }) {
  return h(
    "button",
    { class: "proof-panel__row" + (disabled ? " is-disabled" : ""), type: "button", role: "switch", "aria-checked": String(on), disabled, onclick },
    icon(glyph, "proof-panel__icon"),
    h("span", { class: "proof-panel__rtext" }, h("span", { class: "proof-panel__rlabel" }, label), h("span", { class: "proof-panel__rdetail" }, detail)),
    h("span", { class: "proof-switch" + (on ? " proof-switch--on" : ""), "aria-hidden": "true" })
  );
}

/**
 * `act`: { title, setEnabled(on), corrections(), importFile(), exportFile(), exportAs(), remove() }
 * — `title` is the open book's, for when the file names it differently or not at all.
 * The two switches repaint the panel in place; every other action closes it.
 */
export function openProofPanel(act) {
  const repaint = () => sheetEl().querySelector(".proof-card").replaceChildren(...panelContent(act, repaint).filter(Boolean));
  showList(panelContent(act, repaint));
  sheetEl().querySelector(".proof-card").scrollTop = 0;
}

function panelContent(act, repaint) {
  const s = proofState();
  const now = (fn) => () => {
    fn();
    closeOverlay();
  };
  const head = (title, sub) =>
    h("div", { class: "proof-panel__head" }, h("div", { class: "lib-label" }, "Proofreading"), h("h2", { class: "proof-panel__title" }, title), sub ? h("div", { class: "proof-panel__sub" }, sub) : null);

  if (!s.hasFile) {
    return [
      h("div", { class: "vsheet__handle" }),
      h(
        "div",
        { class: "proof-panel proof-panel--empty" },
        icon("file", "proof-panel__empty-icon"),
        h("h2", { class: "proof-panel__title" }, "No proofreading file"),
        h(
          "p",
          { class: "proof-panel__lead" },
          "Import the file made by the review tool to see its suggested corrections marked in the text — accept, edit or discard them as you read."
        ),
        h("button", { class: "pill-btn proof-panel__primary", type: "button", onclick: now(act.importFile) }, "Import proofreading file…")
      ),
    ];
  }

  const total = s.bookTotal || 0;
  const linked = linkedFileName();
  const made = shortDate(s.fileDate);
  const sub = total ? [plural(total, "suggestion"), made && `file from ${made}`].filter(Boolean).join(" · ") : made ? `File from ${made}` : null;

  // Where this book stands: one bar, three parts, and their legend.
  let standing;
  if (total) {
    const parts = [
      ["accepted", s.bookAccepted, "accepted"],
      ["discarded", s.bookDiscarded, "discarded"],
      ["pending", s.bookPending, "to review"],
    ];
    standing = h(
      "div",
      { class: "proof-panel__standing" + (s.enabled ? "" : " is-off") },
      h(
        "div",
        { class: "proof-panel__bar", role: "img", "aria-label": parts.map(([, n, l]) => `${n} ${l}`).join(", ") },
        ...parts.filter(([, n]) => n).map(([k, n]) => h("span", { class: `proof-panel__seg is-${k}`, style: `flex-grow: ${n}` }))
      ),
      h(
        "div",
        { class: "proof-panel__legend" },
        ...parts.map(([k, n, l]) =>
          h("span", { class: `proof-panel__key is-${k}` + (n ? "" : " is-zero") }, h("span", { class: "proof-panel__dot" }), h("b", null, n.toLocaleString()), ` ${l}`)
        )
      )
    );
  } else {
    standing = h("p", { class: "proof-panel__lead proof-panel__lead--quiet" }, "This book has no suggestions in the proofreading file.");
  }

  const exportDetail = [
    s.toExport ? `${plural(s.toExport, "new decision")} to send` : "Up to date",
    linked && `saves over ${linked}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return [
    h("div", { class: "vsheet__handle" }),
    h(
      "div",
      { class: "proof-panel" },
      head(s.bookName || act.title || "This book", sub),
      standing,
      // Reviewing needs the marks on screen, so the way in only shows while it's on.
      total && s.enabled
        ? h(
            "button",
            { class: "pill-btn proof-panel__primary", type: "button", onclick: () => closeOverlay(act.corrections) },
            s.bookPending ? "Review corrections" : "See corrections"
          )
        : null,
      h("div", { class: "lib-label proof-panel__section" }, "In the text"),
      h(
        "div",
        { class: "proof-panel__rows" },
        switchRow({
          glyph: "pen",
          label: "Show corrections",
          detail: s.enabled ? "Marks to review, fixes applied" : "Off — the book's original text",
          on: s.enabled,
          onclick: () => {
            act.setEnabled(!s.enabled);
            repaint();
          },
        }),
        switchRow({
          glyph: "underline",
          label: "Underline accepted",
          detail: "Tap one to see what it changed",
          on: s.enabled && showApplied,
          disabled: !s.enabled,
          onclick: () => {
            setProofShowApplied(!showApplied);
            repaint();
          },
        })
      ),
      h("div", { class: "lib-label proof-panel__section" }, "Proofreading file"),
      h(
        "div",
        { class: "proof-panel__rows" },
        panelRow({ glyph: "export", label: "Export", detail: exportDetail, accent: s.toExport ? "due" : null, onclick: now(act.exportFile) }),
        linked ? panelRow({ glyph: "saveAs", label: "Export to another file…", detail: "Pick where the next exports go", onclick: now(act.exportAs) }) : null,
        panelRow({ glyph: "import", label: "Import…", detail: "Merge decisions from another device", onclick: now(act.importFile) })
      ),
      h(
        "div",
        { class: "proof-panel__foot" },
        h("button", { class: "text-btn text-btn--danger", type: "button", onclick: () => closeOverlay(act.remove) }, "Remove proofreading file")
      )
    ),
  ];
}

/**
 * The chapter's corrections — to review, accepted and discarded — as a list sheet.
 * `nav` (from the reader) lets it switch to the whole book's list.
 */
export function openCorrections(container, nav) {
  const rows = [];
  for (const c of onScreen()) for (const f of c.findings) rows.push({ c, f });
  rows.sort((a, b) => orderOf(a.f) - orderOf(b.f));
  const n = tally(rows.map((r) => r.f));
  const hasBook = !!nav && !!bookKeyFor(currentLib);
  showList([
    h(
      "div",
      { class: "proof-list__head" },
      h("h2", { class: "sheet-title" }, "Corrections in this chapter"),
      hasBook ? h("button", { class: "text-btn", type: "button", onclick: () => closeOverlay(() => openBookCorrections(container, nav)) }, "Whole book ›") : null
    ),
    h("p", { class: "proof-list__summary" }, rows.length ? countsLine(n) : "No corrections in this chapter."),
    n.pending ? h("button", { class: "pill-btn proof-list__next", onclick: () => closeOverlay(() => nextSuggestion(container)) }, "Review next") : null,
    h("div", { class: "proof-list" }, ...rows.map(({ c, f }) => itemRow(f, () => closeOverlay(() => focusFinding(container, c, f))))),
  ]);
}

const FILTERS = [
  ["accepted", "Accepted"],
  ["pending", "To review"],
  ["discarded", "Discarded"],
  ["all", "All"],
];
let bookFilter = null; // the list's last filter, kept while the app is open

/**
 * Every correction in the open book, chapter by chapter, filtered by status.
 * `nav.locate(href)` → { href, index, label } of that spine document (null when
 * the book has none such); `nav.open(href)` shows it in the reader.
 */
export function openBookCorrections(container, nav) {
  const key = bookKeyFor(currentLib);
  const all = bookFindings(key);
  const n = tally(all);
  let filter = bookFilter && (bookFilter === "all" || n[bookFilter]) ? bookFilter : n.accepted ? "accepted" : n.pending ? "pending" : "all";

  // Group by chapter (in reading order); suggestions for documents this copy
  // doesn't have go last.
  const groups = new Map();
  for (const f of all) {
    const at = nav.locate(f.href);
    const k = at ? at.href : "";
    if (!groups.has(k)) groups.set(k, { at, label: at ? at.label || `Section ${at.index + 1}` : "Not in this copy", list: [] });
    groups.get(k).list.push(f);
  }
  const ordered = [...groups.values()].sort((a, b) => (a.at ? a.at.index : 1e9) - (b.at ? b.at.index : 1e9));
  for (const g of ordered) g.list.sort((a, b) => orderOf(a) - orderOf(b));

  const go = (g, f) =>
    closeOverlay(async () => {
      if (!g.at) return;
      await nav.open(g.at.href);
      if (!(await focusWhenShown(container, f.id))) nav.missing?.();
    });

  const listBox = h("div", { class: "proof-list proof-list--book" });
  const chips = h("div", { class: "proof-filters", role: "tablist" });
  const render = () => {
    chips.replaceChildren(
      ...FILTERS.filter(([k]) => k === "all" || n[k]).map(([k, label]) =>
        h(
          "button",
          {
            class: "proof-filter" + (k === filter ? " is-on" : ""),
            type: "button",
            role: "tab",
            "aria-selected": String(k === filter),
            onclick: () => {
              filter = bookFilter = k;
              render();
            },
          },
          `${label} ${(k === "all" ? all.length : n[k]).toLocaleString()}`
        )
      )
    );
    const out = [];
    for (const g of ordered) {
      const list = filter === "all" ? g.list : g.list.filter((f) => f.status === filter);
      if (!list.length) continue;
      out.push(h("div", { class: "proof-group" }, h("span", { class: "proof-group__label" }, g.label), h("span", { class: "proof-group__count" }, list.length.toLocaleString())));
      for (const f of list) out.push(itemRow(f, () => go(g, f)));
    }
    listBox.replaceChildren(...out);
  };
  render();

  showList([
    h("h2", { class: "sheet-title" }, "Corrections in this book"),
    h("p", { class: "proof-list__summary" }, all.length ? countsLine(n) : "No corrections for this book in the proofreading file."),
    all.length ? chips : null,
    listBox,
  ]);
  sheetEl().querySelector(".proof-card").scrollTop = 0;
}

/**
 * Focus a suggestion once its chapter is on screen and matched (after the reader
 * was sent there). False when it never shows — this copy's text differs.
 */
async function focusWhenShown(container, id) {
  for (let t = 0; t < 60; t++) {
    for (const c of onScreen()) {
      const f = c.findings.find((x) => x.id === id);
      if (f && topOf(c, f) != null) {
        await new Promise((r) => setTimeout(r, 120)); // let the chapter settle where it landed
        focusFinding(container, c, f);
        return true;
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** One line describing a finding's change. */
function summaryOf(f) {
  const short = (t, n = 70) => (t.length > n ? t.slice(0, n) + "…" : t);
  if (f.op === "delete-paras" || f.op === "delete-block") return `Remove: ${short(f.original.replace(/\s+/g, " ")) || "(empty paragraph)"}`;
  if (f.op === "wrap-text" && f.replacement === f.original) return `Make a paragraph: ${short(f.original)}`;
  if (f.op === "split-para") return "Split into separate paragraphs";
  if (f.op === "replace-chapter") return `Replace with the real chapter (${f.replacement.split("\n\n").length} paragraphs)`;
  if (f.op === "title") return short(f.replacement);
  return `${short(f.original.trim(), 40) || "∅"} → ${short(f.replacement.trim(), 40) || "∅"}`;
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

const SOURCE_LABEL = { auto: "automatic", claude: "claude", manual: "real text" };

const STATUS_LABEL = { pending: "To review", accepted: "Accepted", discarded: "Discarded" };

const KIND_LABEL = {
  typo: "Typo",
  "wrong-word": "Wrong word",
  "missing-word": "Missing word",
  punctuation: "Punctuation",
  quotes: "Quotes",
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
  rewrite: "Rewritten chapter",
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
  const id = CSS.escape(f.id);
  const marks = [...c.doc.querySelectorAll(`[data-proof="${id}"], .proof-applied[data-proof-ref="${id}"], .proof-applied-block[data-proof-ref="${id}"]`)];
  marks.forEach((m) => m.classList.add("is-active"));

  let body;
  if (f.op === "delete-block") {
    body = h("p", { class: "proof-diff" }, h("del", null, f.original));
  } else if (f.op === "wrap-text") {
    body = f.replacement === f.original ? h("p", { class: "proof-diff" }, f.original) : diffView(f.original, f.replacement);
  } else if (f.op === "delete-paras") {
    const text = parasOf(c, f).map((p) => p.textContent).join(" ") || "(empty paragraph)";
    body = h("p", { class: "proof-diff" }, h("del", null, text.length > 600 ? text.slice(0, 600) + "…" : text));
  } else if (f.op === "split-para") {
    body = h("div", { class: "proof-diff" }, ...f.replacement.split("\n\n").map((t) => h("p", null, t)));
  } else if (f.op === "replace-chapter") {
    const ps = f.replacement.split("\n\n");
    body = h(
      "div",
      { class: "proof-diff" },
      ...ps.slice(0, 2).map((t) => h("p", null, h("ins", null, t))),
      ps.length > 2 ? h("p", null, `…and ${ps.length - 2} more paragraphs.`) : null
    );
  } else {
    body = diffView(f.original, f.replacement);
  }
  const editBox = h("textarea", { class: "name-input proof-edit", rows: 3, hidden: true });
  const error = h("p", { class: "proof-error", hidden: true }, "Couldn't save the decision on this device.");
  const canEdit = (f.op === "replace" && !isJoin(f)) || f.op === "title" || f.op === "wrap-text";

  const decide = async (status, extra = {}) => {
    try {
      await saveDecision(f, status, extra);
    } catch (_) {
      error.hidden = false;
      return;
    }
    const was = f.status;
    if (was === "pending") unmark(c, f);
    else revert(c, f);
    if (status === "pending") Object.assign(f, withDecision(f.base, null)); // undo: back to the suggestion as made
    if (extra.replacement !== undefined) f.replacement = extra.replacement;
    f.status = status;
    if (status === "accepted") applyFix(c, f);
    else if (status === "pending") mark(c, f);
    else anchorOriginal(c, f);
    closeOverlay();
    notify();
  };

  card.replaceChildren(
    h(
      "div",
      { class: "proof-head" },
      h("span", { class: "proof-kind" }, KIND_LABEL[f.kind] || f.kind),
      f.confidence ? h("span", { class: "proof-conf" }, `${f.confidence} confidence`) : null,
      h("span", { class: "proof-src" }, SOURCE_LABEL[f.source] || "claude"),
      h("span", { class: `proof-status proof-status--${f.status}` }, STATUS_LABEL[f.status])
    ),
    h("p", { class: "proof-note" }, f.note),
    body,
    editBox,
    error,
    h(
      "div",
      { class: "proof-actions" },
      h(
        "button",
        { class: "pill-btn proof-accept", onclick: () => (editBox.hidden ? (f.status === "accepted" ? closeOverlay() : decide("accepted")) : decide("accepted", { replacement: editBox.value })) },
        f.status === "accepted" ? "Accepted ✓" : "Accept"
      ),
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
      h("button", { class: "text-btn text-btn--danger", onclick: () => (f.status === "discarded" ? closeOverlay() : decide("discarded")) }, f.status === "discarded" ? "Discarded ✓" : "Discard"),
      f.status === "pending"
        ? h("button", { class: "text-btn proof-later", onclick: () => closeOverlay() }, "Later")
        : h("button", { class: "text-btn proof-later", title: "Put it back to review", onclick: () => decide("pending") }, "Undo")
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
    else if (k === "u" && f.status !== "pending") decide("pending");
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
