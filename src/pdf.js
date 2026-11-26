// =========================================================================
// PDF books — import (metadata, cover, chapters), the word count, and the
// reading surface. Loaded on demand (a dynamic import), so PDF.js only ever
// downloads for someone opening a PDF.
//
// The reader (reader.js) is written against epub.js: a Book with a spine and a
// navigation, and a Rendition that displays one chapter document at a time in
// a scroller, runs content hooks on each chapter document, and reports where
// you are through `relocated`. PdfBook / PdfRendition give it that same shape,
// so the chapter drawer, progress, Continue, the end-of-chapter card, the
// reading bars and the stats all work on a PDF unchanged. A PDF "chapter" is a
// run of pages (see lib/pdf.js), drawn as canvases into a chapter document of
// its own — an iframe, like epub.js's — and only near the screen: pages are
// drawn as they approach and dropped once far away, so a long chapter never
// holds more than a handful of page bitmaps.
// =========================================================================
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import {
  pdfChapters, pdfSections, sectionOfPage, pageHref, hrefPage, pdfPos, parsePdfPos, nestByDepth,
  pdfTitle, pdfDate, pdfSubjects,
} from "./lib/pdf.js";
import { baseHref } from "./lib/chapters.js";
import { cleanAuthor } from "./lib/text.js";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// PDF.js hands the bytes to its worker (detaching the buffer), so it always
// gets a copy — the caller still stores the original.
function openDoc(buffer) {
  return pdfjs.getDocument({ data: new Uint8Array(buffer.slice(0)), isEvalSupported: false, enableXfa: false }).promise;
}
// Free a document and its worker (PDF.js 6 closes it through its loading task).
const closeDoc = (doc) => (doc?.loadingTask?.destroy ? doc.loadingTask.destroy() : doc?.destroy?.())?.catch?.(() => {});

// Bookmarks flattened to [{ title, page, depth }]; one that can't be resolved
// to a page just has page null (pdfChapters drops it).
async function outlineOf(doc) {
  const out = [];
  const walk = async (items, depth) => {
    for (const it of items || []) {
      let page = null;
      try {
        let dest = it.dest;
        if (typeof dest === "string") dest = await doc.getDestination(dest);
        if (Array.isArray(dest) && dest[0] != null)
          page = (typeof dest[0] === "object" ? await doc.getPageIndex(dest[0]) : Number(dest[0])) + 1;
      } catch {
        /* unresolvable bookmark */
      }
      out.push({ title: it.title || "", page, depth });
      if (out.length < 2000) await walk(it.items, depth + 1);
    }
  };
  try {
    await walk(await doc.getOutline(), 0);
  } catch {
    /* no outline */
  }
  return out;
}

// Page 1, drawn as the library cover.
async function coverOf(doc) {
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 480 / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport }).promise;
    return await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.85));
  } catch {
    return null;
  }
}

// Import: everything the library and the info page need, in the same shape
// parseEpub gives (import.js), plus the page count.
export async function parsePdf(buffer, filename) {
  const doc = await openDoc(buffer);
  try {
    const meta = await doc.getMetadata().catch(() => ({}));
    const info = meta?.info || {};
    const pageCount = doc.numPages;
    const chapters = pdfChapters(await outlineOf(doc), pageCount);
    return {
      format: "pdf",
      title: pdfTitle(info.Title, filename),
      author: cleanAuthor(info.Author),
      coverBlob: await coverOf(doc),
      chapters,
      spineCount: pdfSections(chapters, pageCount).length,
      pageCount,
      description: (info.Subject || "").trim(),
      language: (info.Language || "").trim(),
      publisher: "",
      published: pdfDate(info.CreationDate),
      subjects: pdfSubjects(info.Keywords),
    };
  } finally {
    closeDoc(doc);
  }
}

// Word count, per chapter document (keyed by href, like an epub's spine) — the
// text the PDF carries, page by page.
export async function pdfWordCounts(book) {
  const doc = await openDoc(await book.fileBlob.arrayBuffer());
  try {
    const chapters = {};
    let total = 0;
    for (const s of pdfSections(book.chapters, doc.numPages)) {
      let n = 0;
      for (let p = s.from; p <= s.to; p++) {
        try {
          const page = await doc.getPage(p);
          const text = (await page.getTextContent()).items.map((i) => i.str || "").join(" ");
          n += (text.match(/\S+/g) || []).length;
          page.cleanup();
        } catch {
          /* unreadable page */
        }
      }
      chapters[s.href] = n;
      total += n;
    }
    return { total, chapters };
  } finally {
    closeDoc(doc);
  }
}

// -------------------------------------------------------------------------
// Reading
// -------------------------------------------------------------------------
export async function openPdfBook(buffer, lib) {
  return new PdfBook(await openDoc(buffer), lib);
}

class PdfBook {
  constructor(doc, lib) {
    this.doc = doc;
    const chapters = lib.chapters?.length ? lib.chapters : pdfChapters([], doc.numPages);
    this.sections = pdfSections(chapters, doc.numPages);
    const items = this.sections.map((s, index) => ({ href: s.href, url: s.href, index, linear: true }));
    this.spine = {
      spineItems: items,
      get: (i) => (typeof i === "number" ? items[i] : items.find((it) => it.href === baseHref(i))) || null,
    };
    this.ready = Promise.resolve(this);
    this.loaded = { navigation: Promise.resolve({ toc: nestByDepth(chapters) }) };
  }
  renderTo(id, opts = {}) {
    return new PdfRendition(this, document.getElementById(id), opts);
  }
  destroy() {
    closeDoc(this.doc);
    this.doc = null;
  }
}

// Page colours. "Dark" redraws the page's text and drawings in the reader's
// own ink on its own paper (PDF.js maps every colour onto that pair by
// lightness); "original" leaves the page as printed.
const DARK_PAGE = { background: "#23262f", foreground: "#c9ced6" };
const MAX_PAGE_W = 920; // a fitted page never grows past this on a big screen
const MAX_PIXELS = 12e6; // per page bitmap
const AHEAD = 2.5; // screens drawn ahead of the viewport…
const BEHIND = 1.5; // …and behind it
const KEEP = 5; // screens away before a drawn page is dropped

class PdfRendition {
  constructor(book, host, { zoom = 1, dark = true } = {}) {
    this.book = book;
    this.zoom = zoom;
    this.dark = dark;
    this.listeners = new Map();
    this.contentHooks = [];
    this.hooks = { content: { register: (fn) => this.contentHooks.push(fn) } };
    this.themes = { default() {} };
    this.location = null;
    this.view = null;
    this.run = 0;
    this.queue = Promise.resolve();
    this.container = document.createElement("div");
    this.container.className = "pdf-container";
    host.appendChild(this.container);
    this.manager = { container: this.container };
    this.onScroll = () => this.scrolled();
    this.container.addEventListener("scroll", this.onScroll, { passive: true });
    this.lastWidth = this.container.clientWidth;
    this.resizeObs = new ResizeObserver(() => this.resized());
    this.resizeObs.observe(this.container);
  }

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  off(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }
  emit(type, ...args) {
    for (const fn of this.listeners.get(type) || []) {
      try {
        fn(...args);
      } catch (err) {
        console.warn(err);
      }
    }
  }

  // display(): nothing (the first chapter), a chapter href ("p12"), or a
  // saved spot ("pdf:12:0.35"). Resolves once the chapter is laid out, its
  // hooks have run and the view sits on the target.
  async display(target) {
    const run = ++this.run;
    const sections = this.book.sections;
    const pos = parsePdfPos(target);
    let section;
    let page = null;
    let frac = 0;
    if (pos) {
      section = sectionOfPage(sections, pos.page);
      page = pos.page;
      frac = pos.frac;
    } else {
      const n = target ? hrefPage(target) : null;
      section = (n != null && sections.find((s) => s.href === pageHref(n))) || (n != null && sectionOfPage(sections, n)) || sections[0];
    }
    if (!section) return;
    if (this.view?.section !== section) {
      await this.load(section, run);
      if (run !== this.run || !this.view) return;
    }
    this.scrollToPage(page, frac);
    this.drawNear();
    this.relocate();
  }

  async load(section, run) {
    const doc = this.book.doc;
    const nums = [];
    for (let n = section.from; n <= section.to; n++) nums.push(n);
    const pages = await Promise.all(nums.map((n) => doc.getPage(n)));
    if (run !== this.run) return;
    this.teardown();

    const frame = document.createElement("iframe");
    frame.setAttribute("scrolling", "no");
    frame.setAttribute("title", "Page");
    frame.style.cssText = "display:block;border:0;width:100%;height:0;";
    frame.srcdoc = '<!doctype html><html class="pdf-doc"><head><meta charset="utf-8"></head><body></body></html>';
    const loaded = new Promise((r) => frame.addEventListener("load", r, { once: true }));
    this.container.appendChild(frame);
    await loaded;
    if (run !== this.run) return frame.remove();
    const cdoc = frame.contentDocument;
    const list = cdoc.createElement("div");
    list.className = "pdf-pages";
    const views = pages.map((page, i) => {
      const box = cdoc.createElement("div");
      box.className = "pdf-page";
      box.dataset.page = String(nums[i]);
      list.appendChild(box);
      const base = page.getViewport({ scale: 1 });
      return { n: nums[i], page, box, ratio: base.height / base.width, baseWidth: base.width, drawn: 0, canvas: null, task: null, top: 0, h: 0 };
    });
    cdoc.body.appendChild(list);
    const index = this.book.sections.indexOf(section);
    this.view = { section, href: section.href, index, frame, doc: cdoc, pages: views };
    cdoc.documentElement.classList.toggle("pdf-dark", this.dark);
    this.layout();

    const contents = { document: cdoc, window: cdoc.defaultView, content: cdoc.body, sectionIndex: index };
    for (const fn of this.contentHooks) {
      try {
        await fn(contents);
      } catch (err) {
        console.warn("Content hook failed:", err);
      }
    }
    if (run !== this.run) return;
    this.contents = contents;
    this.measure();
    // The end-of-chapter card's fonts arrive late; keep the frame fitted.
    const RO = cdoc.defaultView.ResizeObserver || ResizeObserver;
    this.bodyObs = new RO(() => this.measure());
    this.bodyObs.observe(cdoc.body);
  }

  // Size every page box for the current width and zoom.
  layout() {
    const v = this.view;
    if (!v) return;
    const cw = this.container.clientWidth || window.innerWidth;
    const gutter = cw < 640 ? 6 : 24;
    const pageW = Math.round(Math.min(cw - 2 * gutter, MAX_PAGE_W) * this.zoom);
    v.frame.style.width = Math.max(cw, pageW + 2 * gutter) + "px";
    for (const p of v.pages) {
      p.w = pageW;
      p.h = Math.round(pageW * p.ratio);
      p.box.style.width = p.w + "px";
      p.box.style.height = p.h + "px";
    }
    this.measure();
  }

  // Fit the frame to its content and cache each page's top.
  measure() {
    const v = this.view;
    if (!v) return;
    const h = v.doc.documentElement.scrollHeight;
    if (h && v.frame.style.height !== h + "px") v.frame.style.height = h + "px";
    for (const p of v.pages) p.top = p.box.getBoundingClientRect().top;
  }

  scrollToPage(page, frac) {
    const v = this.view;
    if (!v) return;
    const p = page != null ? v.pages.find((x) => x.n === page) : null;
    this.container.scrollTop = p ? Math.round(v.frame.offsetTop + p.top + frac * p.h) : 0;
  }

  // Draw the pages near the viewport, drop the ones far from it.
  drawNear() {
    const v = this.view;
    if (!v) return;
    const c = this.container;
    const top = c.scrollTop - v.frame.offsetTop;
    const vh = c.clientHeight || window.innerHeight;
    const want = [];
    for (const p of v.pages) {
      const near = p.top < top + vh * (1 + AHEAD) && p.top + p.h > top - vh * BEHIND;
      const far = p.top > top + vh * (1 + KEEP) || p.top + p.h < top - vh * KEEP;
      if (near && p.drawn !== this.drawKey(p)) want.push(p);
      else if (far && p.canvas) this.drop(p);
    }
    // Closest to the top of the screen first.
    want.sort((a, b) => Math.abs(a.top - top) - Math.abs(b.top - top));
    for (const p of want) this.enqueue(p);
  }

  drawKey(p) {
    return `${p.w}|${this.dark ? 1 : 0}`;
  }

  enqueue(p) {
    if (p.pending) return;
    p.pending = true;
    const view = this.view;
    this.queue = this.queue
      .then(() => (this.view === view ? this.draw(p) : null))
      .catch((err) => {
        if (err?.name !== "RenderingCancelledException") console.warn("Page draw failed:", err);
      })
      .finally(() => {
        p.pending = false;
      });
  }

  async draw(p) {
    const key = this.drawKey(p);
    if (p.drawn === key) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    let scale = (p.w / p.baseWidth) * dpr;
    const px = p.w * dpr * p.h * dpr;
    if (px > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / px);
    const viewport = p.page.getViewport({ scale });
    // Drawn in the app's own document: PDF.js registers the page's fonts and
    // the dark-colours filter there, so a canvas made inside the chapter frame
    // would come out blank. Its pixels are copied into the frame once drawn.
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    p.task = p.page.render({
      canvas,
      canvasContext: canvas.getContext("2d"),
      viewport,
      ...(this.dark ? { pageColors: DARK_PAGE } : {}),
    });
    await p.task.promise;
    p.task = null;
    if (!p.box.isConnected) return;
    const shown = p.box.ownerDocument.createElement("canvas");
    shown.width = canvas.width;
    shown.height = canvas.height;
    shown.getContext("2d").drawImage(canvas, 0, 0);
    canvas.width = canvas.height = 0;
    // Swapped in only once drawn, so a redraw (zoom, colours) never blanks the page.
    if (p.canvas) {
      p.canvas.width = p.canvas.height = 0;
      p.canvas.remove();
    }
    p.box.appendChild(shown);
    p.canvas = shown;
    p.drawn = key;
  }

  drop(p) {
    p.task?.cancel();
    p.task = null;
    if (p.canvas) {
      p.canvas.width = p.canvas.height = 0;
      p.canvas.remove();
    }
    p.canvas = null;
    p.drawn = 0;
    p.page.cleanup?.();
  }

  scrolled() {
    if (!this.scrollFrame)
      this.scrollFrame = requestAnimationFrame(() => {
        this.scrollFrame = 0;
        this.drawNear();
      });
    // `relocated` at most every 150 ms while scrolling, and once it stops.
    clearTimeout(this.relocTimer);
    const now = performance.now();
    if (now - (this.lastReloc || 0) > 150) this.relocate();
    else this.relocTimer = setTimeout(() => this.relocate(), 160);
  }

  relocate() {
    const loc = this.currentLocation();
    if (!loc) return;
    this.lastReloc = performance.now();
    this.location = loc;
    this.emit("relocated", loc);
  }

  // Where the view is: the page at the top of the screen and how far down it,
  // plus epub.js's screens-through-the-chapter (`displayed`) that the reader
  // turns into a chapter percentage.
  currentLocation() {
    const v = this.view;
    if (!v) return null;
    const c = this.container;
    const top = c.scrollTop - v.frame.offsetTop;
    let at = v.pages[0];
    for (const p of v.pages) {
      if (p.top + p.h > top + 1) {
        at = p;
        break;
      }
      at = p;
    }
    const frac = at.h ? Math.min(1, Math.max(0, (top - at.top) / at.h)) : 0;
    const vh = c.clientHeight || 1;
    const total = Math.max(1, Math.ceil(c.scrollHeight / vh));
    const page = Math.min(total, Math.max(1, Math.ceil((c.scrollTop + vh) / vh)));
    const start = { href: v.href, index: v.index, cfi: pdfPos(at.n, frac), page: at.n, displayed: { page, total } };
    return { start, end: start, atStart: c.scrollTop <= 0, atEnd: c.scrollTop + vh >= c.scrollHeight - 1 };
  }

  getContents() {
    return this.contents && this.view ? [this.contents] : [];
  }

  // Zoom (1 = fit the width) and page colours, keeping your place.
  setPageView({ zoom = this.zoom, dark = this.dark } = {}) {
    if (zoom === this.zoom && dark === this.dark) return;
    const loc = this.currentLocation();
    // Sideways, keep the same share of the overflow — from the left edge when
    // there was none yet, where a line of text starts.
    const c = this.container;
    const hFrac = c.scrollWidth > c.clientWidth ? c.scrollLeft / (c.scrollWidth - c.clientWidth) : 0;
    this.zoom = zoom;
    this.dark = dark;
    if (!this.view) return;
    this.view.doc.documentElement.classList.toggle("pdf-dark", dark);
    this.layout();
    if (loc) {
      const pos = parsePdfPos(loc.start.cfi);
      this.scrollToPage(pos.page, pos.frac);
    }
    const spare = this.container.scrollWidth - this.container.clientWidth;
    this.container.scrollLeft = spare > 0 ? Math.round(spare * hFrac) : 0;
    this.drawNear();
    this.relocate();
  }

  resized() {
    const w = this.container.clientWidth;
    if (!this.view || !w) return;
    if (w !== this.lastWidth) {
      this.lastWidth = w;
      const loc = this.currentLocation();
      this.layout();
      if (loc) {
        const pos = parsePdfPos(loc.start.cfi);
        this.scrollToPage(pos.page, pos.frac);
      }
      this.emit("resized", { width: w, height: this.container.clientHeight });
    }
    this.drawNear();
  }

  teardown() {
    const v = this.view;
    if (!v) return;
    this.bodyObs?.disconnect();
    this.bodyObs = null;
    for (const p of v.pages) this.drop(p);
    v.frame.remove();
    this.view = null;
    this.contents = null;
  }

  destroy() {
    this.run++;
    clearTimeout(this.relocTimer);
    cancelAnimationFrame(this.scrollFrame);
    this.resizeObs.disconnect();
    this.container.removeEventListener("scroll", this.onScroll);
    this.teardown();
    this.container.remove();
    this.listeners.clear();
    this.book.destroy();
  }
}
