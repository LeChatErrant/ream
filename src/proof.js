// =========================================================================
// PROOFREADING MODE — an opt-in tool for working through suggested corrections
// while reading. Everything revolves around one *proofreading file*: every
// suggested correction plus the decisions taken on it. It's made by the dev
// tooling (scripts/proofread), imported here, and exported again with the
// latest decisions — the same file goes back and forth between devices, and
// importing always merges (per correction, the newest decision wins). It all
// works offline; no server is involved.
//
// Switched on from the reader drawer, each chapter's open suggestions are
// marked in the text, accepted ones are shown applied and discarded ones are
// left alone; tapping a mark opens a sheet to accept / edit / discard.
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
const PKG_KEY = "proof-package"; // kv: the imported proofreading file
const LOCAL_KEY = "proof-decisions"; // kv: decisions taken on this device { decisions: { id: { status, replacement?, at } }, exportedAt }
const PACKAGE_FORMAT = "ream-proofreading";
const DECISIONS_FORMAT = "ream-proofreading-decisions"; // older decisions-only exports

let enabled = false;
try {
  enabled = localStorage.getItem(KEY) === "1";
} catch (_) {
  /* storage blocked: stays off */
}
let pkg = null; // the imported proofreading file, if any
let byFile = new Map(); // "page-12.html" → that file's suggestions (across every book)
let local = { decisions: {}, exportedAt: null };
const bookOfLib = new Map(); // library book id → book key in the file, learned from matches
let bookPending = null; // open suggestions left in the current book
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());

// Load the file + this device's decisions once, at startup.
export const proofReady = (async () => {
  try {
    // kvGet hands back the raw request for a missing key, so check the shape.
    const p = await kvGet(PKG_KEY);
    pkg = p?.format === PACKAGE_FORMAT && Array.isArray(p.findings) ? p : null;
    const l = await kvGet(LOCAL_KEY);
    if (l?.decisions && typeof l.decisions === "object") local = l;
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
export const proofState = () => ({
  enabled,
  hasFile: !!pkg,
  bookPending,
  chapterLoaded: chapters.size > 0,
  chapterPending: pendingMarks().length,
  chapterTotal: [...chapters.values()].reduce((n, c) => n + c.findings.length, 0),
  fileDate: pkg?.createdAt || null,
  toExport: unexported(),
});
export const onProofChange = (fn) => listeners.add(fn);

export function setProofEnabled(on) {
  enabled = on;
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch (_) {
    /* best effort */
  }
  if (!on) for (const c of chapters.values()) unmarkChapter(c);
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
    bookOfLib.clear();
    bookPending = null;
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
  bookOfLib.clear();
  bookPending = null;
  await kvDelete(PKG_KEY);
  await kvDelete(LOCAL_KEY);
  await linkFile(null);
  for (const c of chapters.values()) unmarkChapter(c);
  notify();
}

// ---- the chapters currently on screen --------------------------------------
// doc → { doc, paras, heading, findings }
const chapters = new Map();

const slugify = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/\.epub$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

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
const pendingInBook = (key) => (pkg?.findings || []).filter((f) => f.book === key && !isDecided(decisionOf(f.id, pkg.decisions))).length;

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
  const matched = candidates.filter((f) => fits(f, paras, heading));
  if (lib) {
    if (matched[0]) bookOfLib.set(lib.id, matched[0].book);
    const key = bookOfLib.get(lib.id) || (pkg.books && slugify(lib.fileName) in pkg.books ? slugify(lib.fileName) : null);
    bookPending = key ? pendingInBook(key) : null;
  }

  const c = { doc, paras, heading, headingText: heading?.textContent ?? "", findings: [], base, joins: new Map() };
  chapters.set(doc, c);
  doc.defaultView.addEventListener("unload", () => {
    chapters.delete(doc);
    notify();
  });
  injectStyle(doc);
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
      const m = e.target.closest?.("[data-proof]");
      if (!m) return;
      e.preventDefault();
      e.stopPropagation();
      const f = c.findings.find((x) => x.id === m.dataset.proof);
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

// Decided findings leave no visible trace, only an invisible anchor
// (data-proof-ref) so the corrections list can jump back to them.
const anchor = (node, f) => node && (node.dataset.proofRef = f.id);

/** Show the corrected text in the rendered chapter. */
function applyFix(c, f) {
  if (f.op === "title") {
    if (c.heading) c.heading.textContent = f.replacement;
    return anchor(c.heading, f);
  }
  if (f.op === "delete-paras") {
    for (const p of parasOf(c, f)) {
      hide(p);
      anchor(p, f);
    }
    return;
  }
  const p = c.paras[f.para];
  if (f.op === "split-para") {
    p.replaceChildren(...f.replacement.split("\n\n").map((t) => h("span", { class: "proof-split" }, t)));
    return anchor(p, f);
  }
  if (isJoin(f)) {
    c.joins.set(f.para, f.alsoDelete);
    layoutJoins(c);
    return anchor(p, f);
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
  span.dataset.proofRef = f.id;
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
    if (n.classList.contains("proof-done")) {
      if (applied) n.replaceWith(c.doc.createTextNode(f.original));
      else n.replaceWith(...n.childNodes);
    } else if (n === c.heading) {
      if (applied) n.textContent = c.headingText;
    } else {
      n.style.removeProperty("display");
      if (applied && f.op === "split-para") n.textContent = f.original;
    }
  }
  if (applied && isJoin(f) && c.joins.delete(f.para)) layoutJoins(c);
  c.doc.body.normalize();
}

const pendingMarks = () => {
  const out = [];
  for (const c of chapters.values())
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

/** The chapter's corrections — to review, accepted and discarded — as a list sheet. */
export function openCorrections(container) {
  const rows = [];
  for (const c of chapters.values())
    for (const f of c.findings) rows.push({ c, f, order: f.op === "title" ? -1 : (f.para ?? 0) });
  rows.sort((a, b) => a.order - b.order);
  const n = (st) => rows.filter((r) => r.f.status === st).length;
  const root = sheetEl();
  const card = root.querySelector(".proof-card");
  const summary = [n("pending") && `${n("pending")} to review`, n("accepted") && `${n("accepted")} accepted`, n("discarded") && `${n("discarded")} discarded`]
    .filter(Boolean)
    .join(" · ");
  // Native replaceChildren would print a null slot as "null" — drop the empty ones.
  card.replaceChildren(...[
    h("h2", { class: "sheet-title" }, "Corrections in this chapter"),
    h("p", { class: "proof-list__summary" }, rows.length ? summary : "No corrections in this chapter."),
    n("pending") ? h("button", { class: "pill-btn proof-list__next", onclick: () => closeOverlay(() => nextSuggestion(container)) }, "Review next") : null,
    h(
      "div",
      { class: "proof-list" },
      ...rows.map(({ c, f }) =>
        h(
          "button",
          { class: "proof-item", type: "button", onclick: () => closeOverlay(() => focusFinding(container, c, f)) },
          h("span", { class: `proof-status proof-status--${f.status}` }, STATUS_LABEL[f.status]),
          h("span", { class: "proof-item__body" }, h("span", { class: "proof-item__kind" }, KIND_LABEL[f.kind] || f.kind), h("span", { class: "proof-item__text" }, summaryOf(f)))
        )
      )
    )
  ].filter(Boolean));
  root.hidden = false;
  armOverlay(() => (root.hidden = true));
}

/** One line describing a finding's change. */
function summaryOf(f) {
  const short = (t, n = 70) => (t.length > n ? t.slice(0, n) + "…" : t);
  if (f.op === "delete-paras") return `Remove: ${short(f.original.replace(/\s+/g, " "))}`;
  if (f.op === "split-para") return "Split into separate paragraphs";
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
  const error = h("p", { class: "proof-error", hidden: true }, "Couldn't save the decision on this device.");
  const canEdit = (f.op === "replace" && !isJoin(f)) || f.op === "title";

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
    if (bookPending != null && (was === "pending") !== (status === "pending")) bookPending = Math.max(0, bookPending + (status === "pending" ? 1 : -1));
    closeOverlay();
    notify();
  };

  card.replaceChildren(
    h(
      "div",
      { class: "proof-head" },
      h("span", { class: "proof-kind" }, KIND_LABEL[f.kind] || f.kind),
      f.confidence ? h("span", { class: "proof-conf" }, `${f.confidence} confidence`) : null,
      h("span", { class: "proof-src" }, f.source === "auto" ? "automatic" : "claude"),
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
