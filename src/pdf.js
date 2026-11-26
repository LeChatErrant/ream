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
  pdfTitle, pdfDate, pdfSubjects, usefulOutline, pageLines, headingOutline,
} from "./lib/pdf.js";
import { baseHref } from "./lib/chapters.js";
import { cleanAuthor, cleanTitle } from "./lib/text.js";

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

// Without useful bookmarks, the pages' own titles stand in for them (see
// headingOutline). Reads every page's text, so it's skipped for a huge PDF.
const TITLE_SCAN_MAX = 600;
async function titlesOf(doc) {
  if (doc.numPages > TITLE_SCAN_MAX) return [];
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    try {
      const page = await doc.getPage(n);
      const items = (await page.getTextContent()).items.map((i) => ({
        str: i.str || "",
        x: i.transform[4],
        y: i.transform[5],
        size: Math.hypot(i.transform[2], i.transform[3]),
      }));
      pages.push({ n, lines: pageLines(items) });
      page.cleanup();
    } catch {
      pages.push({ n, lines: [] });
    }
  }
  const found = headingOutline(pages);
  return found.length >= 2 ? found : [];
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
    let outline = await outlineOf(doc);
    if (!usefulOutline(outline, pageCount)) outline = await titlesOf(doc);
    const chapters = pdfChapters(outline, pageCount);
    return {
      format: "pdf",
      title: cleanTitle(pdfTitle(info.Title, filename)),
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

// Page colours. Pages show as printed; "dark pages" (opt-in) redraws the
// page's text and drawings in the reader's own ink on its own paper (PDF.js
// maps every colour onto that pair by lightness).
const DARK_PAGE = { background: "#23262f", foreground: "#c9ced6" };
const MAX_PAGE_W = 920; // a fitted page never grows past this on a big screen
const MAX_PIXELS = 12e6; // per page bitmap
const AHEAD = 2.5; // screens drawn ahead of the viewport…
const BEHIND = 1.5; // …and behind it
const KEEP = 5; // screens away before a drawn page is dropped
export const MIN_ZOOM = 1; // fit the width
export const MAX_ZOOM = 4;
const clampZoom = (z) => {
  const c = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
  return c < 1.04 ? 1 : Math.round(c * 100) / 100;
};

// The pages live in the app's own document, in the scroller itself: a pinch
// or a pan lands on the scroller directly (inside a frame, sideways panning
// never reached it), and PDF.js draws with the fonts and filters it registers
// here. Below them, a small frame is the "chapter document" the reader's
// content hooks expect — the end-of-chapter card and its styles live there,
// held in view (sticky) however far a zoomed page is panned.
class PdfRendition {
  constructor(book, host, { zoom = 1, dark = false } = {}) {
    this.book = book;
    this.zoom = clampZoom(zoom);
    this.dark = dark;
    this.listeners = new Map();
    this.contentHooks = [];
    this.hooks = { content: { register: (fn) => this.contentHooks.push(fn) } };
    this.themes = { default() {} };
    this.location = null;
    this.view = null;
    this.run = 0;
    this.queue = Promise.resolve();
    const c = (this.container = document.createElement("div"));
    c.className = "pdf-container" + (dark ? " pdf-dark" : "");
    c.tabIndex = -1;
    host.appendChild(c);
    this.manager = { container: c };
    this.onScroll = () => this.scrolled();
    c.addEventListener("scroll", this.onScroll, { passive: true });
    // A tap on a page is a tap on the text: hand it to the chapter document,
    // where the reader listens (bars, wake lock, stats).
    c.addEventListener("click", (e) => {
      if (e.target.closest?.(".pdf-end, a")) return;
      this.view?.doc?.body?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    this.gestures();
    this.lastWidth = c.clientWidth;
    this.resizeObs = new ResizeObserver(() => this.resized());
    this.resizeObs.observe(c);
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
    if (page == null) this.container.scrollLeft = 0;
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

    const list = document.createElement("div");
    list.className = "pdf-pages";
    const views = pages.map((page, i) => {
      const box = document.createElement("div");
      box.className = "pdf-page";
      box.dataset.page = String(nums[i]);
      list.appendChild(box);
      const base = page.getViewport({ scale: 1 });
      return { n: nums[i], page, box, ratio: base.height / base.width, baseWidth: base.width, drawn: 0, canvas: null, task: null, top: 0, left: 0, w: 0, h: 0 };
    });
    const frame = document.createElement("iframe");
    frame.className = "pdf-end";
    frame.setAttribute("scrolling", "no");
    frame.setAttribute("title", "End of chapter");
    frame.srcdoc = '<!doctype html><html class="pdf-doc"><head><meta charset="utf-8"></head><body></body></html>';
    const loaded = new Promise((r) => frame.addEventListener("load", r, { once: true }));
    this.container.append(list, frame);
    const index = this.book.sections.indexOf(section);
    this.view = { section, href: section.href, index, list, frame, doc: null, pages: views };
    this.layout();
    for (const p of views) this.addLinks(p);
    await loaded;
    if (run !== this.run || !this.view) return;
    const cdoc = frame.contentDocument;
    this.view.doc = cdoc;

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
    this.fitFrame();
    // The end-of-chapter card's fonts arrive late; keep the frame fitted.
    const RO = cdoc.defaultView.ResizeObserver || ResizeObserver;
    this.bodyObs = new RO(() => this.fitFrame());
    this.bodyObs.observe(cdoc.body);
  }

  // The page's links, as tappable areas over the drawing: a web link opens in
  // a new tab, a link to another page of the PDF goes there. Placed in
  // percentages of the page, so they hold at any zoom.
  async addLinks(p) {
    let anns;
    try {
      anns = await p.page.getAnnotations({ intent: "display" });
    } catch {
      return;
    }
    const base = p.page.getViewport({ scale: 1 });
    for (const a of anns) {
      if (a.subtype !== "Link" || !a.rect) continue;
      const url = a.url || a.unsafeUrl || "";
      const web = /^(https?:|mailto:)/i.test(url);
      if (!web && !a.dest) continue;
      const [x1, y1] = base.convertToViewportPoint(a.rect[0], a.rect[1]);
      const [x2, y2] = base.convertToViewportPoint(a.rect[2], a.rect[3]);
      const link = document.createElement("a");
      link.className = "pdf-link";
      Object.assign(link.style, {
        left: (Math.min(x1, x2) / base.width) * 100 + "%",
        top: (Math.min(y1, y2) / base.height) * 100 + "%",
        width: (Math.abs(x2 - x1) / base.width) * 100 + "%",
        height: (Math.abs(y2 - y1) / base.height) * 100 + "%",
      });
      if (web) {
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.title = url.replace(/^mailto:/i, "");
      } else {
        link.href = "#";
        link.addEventListener("click", async (e) => {
          e.preventDefault();
          try {
            let dest = a.dest;
            if (typeof dest === "string") dest = await this.book.doc.getDestination(dest);
            const n = typeof dest?.[0] === "object" ? (await this.book.doc.getPageIndex(dest[0])) + 1 : Number(dest?.[0]) + 1;
            if (n >= 1) this.display(pdfPos(n, 0));
          } catch {
            /* a link to nowhere */
          }
        });
      }
      p.box.appendChild(link);
    }
  }

  // Size every page for the current width and zoom. Fitted, a page keeps a
  // small gutter; zoomed, it runs edge to edge, so the scroll stops exactly
  // at the page's edges.
  layout() {
    const v = this.view;
    if (!v) return;
    const cw = this.container.clientWidth || window.innerWidth;
    const gutter = cw < 640 ? 6 : 24;
    const fit = Math.min(cw - 2 * gutter, MAX_PAGE_W);
    const pageW = Math.round(fit * this.zoom);
    v.list.style.width = Math.max(cw, pageW) + "px";
    v.frame.style.width = cw + "px";
    for (const p of v.pages) {
      p.w = pageW;
      p.h = Math.round(pageW * p.ratio);
      p.box.style.width = p.w + "px";
      p.box.style.height = p.h + "px";
    }
    this.measure();
  }

  // Each page's place in the scroller's content.
  measure() {
    const v = this.view;
    if (!v) return;
    const lt = v.list.offsetTop;
    const ll = v.list.offsetLeft;
    for (const p of v.pages) {
      p.top = lt + p.box.offsetTop;
      p.left = ll + p.box.offsetLeft;
    }
  }

  fitFrame() {
    const v = this.view;
    if (!v?.doc) return;
    const h = v.doc.documentElement.scrollHeight;
    if (h && v.frame.style.height !== h + "px") v.frame.style.height = h + "px";
  }

  scrollToPage(page, frac) {
    const v = this.view;
    if (!v) return;
    const p = page != null ? v.pages.find((x) => x.n === page) : null;
    this.container.scrollTop = p ? Math.round(p.top + frac * p.h) : 0;
  }

  // The page under a point of the screen (client coordinates), and where on
  // it — so a zoom can keep that spot under the fingers.
  spotAt(clientX, clientY) {
    const v = this.view;
    const c = this.container;
    const r = c.getBoundingClientRect();
    const x = c.scrollLeft + clientX - r.left;
    const y = c.scrollTop + clientY - r.top;
    let at = v.pages[0];
    for (const p of v.pages) if (p.top <= y) at = p;
    return { p: at, fx: (x - at.left) / at.w, fy: (y - at.top) / at.h, sx: clientX - r.left, sy: clientY - r.top };
  }

  // Zoom to `zoom`, keeping the spot under (clientX, clientY) where it is.
  zoomAt(zoom, clientX, clientY) {
    const v = this.view;
    const z = clampZoom(zoom);
    if (!v || z === this.zoom) return;
    const c = this.container;
    const r = c.getBoundingClientRect();
    const spot = this.spotAt(clientX ?? r.left + c.clientWidth / 2, clientY ?? r.top + c.clientHeight / 2);
    this.zoom = z;
    this.layout();
    c.scrollLeft = Math.round(spot.p.left + spot.fx * spot.p.w - spot.sx);
    c.scrollTop = Math.round(spot.p.top + spot.fy * spot.p.h - spot.sy);
    this.drawNear();
    this.relocate();
    this.emit("zoomed", z);
  }
  zoomBy(factor) {
    this.zoomAt(this.zoom * factor);
  }
  get zoomLevel() {
    return this.zoom;
  }

  // Pinch (touch), trackpad pinch / Ctrl-or-⌘ + scroll (computer). While the
  // fingers move, the pages are only stretched (a CSS transform, cheap); when
  // they lift, the pages are laid out and redrawn at the new size.
  gestures() {
    const c = this.container;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const mid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
    let pinch = null;
    const end = () => {
      if (!pinch) return;
      const g = pinch;
      pinch = null;
      const v = this.view;
      if (v) v.list.style.transform = "";
      if (!v || !g.moved) return;
      const z = clampZoom(g.zoom * g.scale);
      const r = c.getBoundingClientRect();
      this.zoom = z;
      this.layout();
      c.scrollLeft = Math.round(g.spot.p.left + g.spot.fx * g.spot.p.w - (g.mx - r.left));
      c.scrollTop = Math.round(g.spot.p.top + g.spot.fy * g.spot.p.h - (g.my - r.top));
      this.drawNear();
      this.relocate();
      this.emit("zoomed", z);
    };
    c.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length !== 2 || !this.view) return;
        e.preventDefault();
        const m = mid(e.touches);
        const v = this.view;
        const r = c.getBoundingClientRect();
        const ox = c.scrollLeft + m.x - r.left - v.list.offsetLeft;
        const oy = c.scrollTop + m.y - r.top - v.list.offsetTop;
        v.list.style.transformOrigin = `${ox}px ${oy}px`;
        pinch = { d: dist(e.touches), zoom: this.zoom, scale: 1, x: m.x, y: m.y, mx: m.x, my: m.y, spot: this.spotAt(m.x, m.y), moved: false };
      },
      { passive: false }
    );
    c.addEventListener(
      "touchmove",
      (e) => {
        if (!pinch || e.touches.length !== 2) return;
        e.preventDefault();
        const m = mid(e.touches);
        pinch.scale = clampZoom(pinch.zoom * (dist(e.touches) / pinch.d)) / pinch.zoom;
        pinch.mx = m.x;
        pinch.my = m.y;
        pinch.moved = true;
        if (this.view) this.view.list.style.transform = `translate(${m.x - pinch.x}px, ${m.y - pinch.y}px) scale(${pinch.scale})`;
      },
      { passive: false }
    );
    c.addEventListener("touchend", (e) => e.touches.length < 2 && end());
    c.addEventListener("touchcancel", end);
    // Safari zooms the whole app on a pinch, whatever the viewport says.
    for (const t of ["gesturestart", "gesturechange"]) c.addEventListener(t, (e) => e.preventDefault(), { passive: false });
    let wheel = null;
    c.addEventListener(
      "wheel",
      (e) => {
        if (!(e.ctrlKey || e.metaKey) || !this.view) return;
        e.preventDefault();
        // Gather a burst of wheel steps into one relayout per frame.
        if (!wheel) {
          wheel = { factor: 1, x: e.clientX, y: e.clientY };
          requestAnimationFrame(() => {
            const w = wheel;
            wheel = null;
            this.zoomAt(this.zoom * w.factor, w.x, w.y);
          });
        }
        wheel.factor *= Math.exp(-e.deltaY * 0.01);
      },
      { passive: false }
    );
  }

  // Draw the pages near the viewport, drop the ones far from it.
  drawNear() {
    const v = this.view;
    if (!v) return;
    const c = this.container;
    const top = c.scrollTop;
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
    if (!p.box.isConnected) {
      canvas.width = canvas.height = 0;
      return;
    }
    // Swapped in only once drawn, so a redraw (zoom, colours) never blanks the page.
    if (p.canvas) {
      p.canvas.width = p.canvas.height = 0;
      p.canvas.remove();
    }
    p.box.appendChild(canvas);
    p.canvas = canvas;
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
    const top = c.scrollTop;
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

  // Page colours, keeping your place.
  setPageView({ dark = this.dark } = {}) {
    if (dark === this.dark) return;
    this.dark = dark;
    this.container.classList.toggle("pdf-dark", dark);
    this.drawNear();
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
    v.list.remove();
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
