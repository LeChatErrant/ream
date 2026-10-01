// -------------------------------------------------------------------------
// DOM plumbing shared by every screen: the tiny element builder, the inline
// SVG icons, the cover-image cache, the collected element refs, and the two
// touch gesture primitives (long-press, drag-reorder).
// -------------------------------------------------------------------------

// Tiny DOM builder. Titles/authors come from untrusted epub metadata, so
// everything is set as text nodes — never innerHTML — unless marked `html`.
export function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props)
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "style") e.style.cssText = v;
      else if (k === "html") e.innerHTML = v;
      else if (k === "dataset") Object.assign(e.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2).toLowerCase(), v);
      else e.setAttribute(k, v === true ? "" : v);
    }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}
export const svg = (html) => {
  const span = document.createElement("span");
  span.innerHTML = html;
  span.setAttribute("aria-hidden", "true");
  return span;
};
export const ICON = {
  plus: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  more: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  handle: '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="9" cy="6" r="1.4" fill="currentColor"/><circle cx="15" cy="6" r="1.4" fill="currentColor"/><circle cx="9" cy="12" r="1.4" fill="currentColor"/><circle cx="15" cy="12" r="1.4" fill="currentColor"/><circle cx="9" cy="18" r="1.4" fill="currentColor"/><circle cx="15" cy="18" r="1.4" fill="currentColor"/></svg>',
  sort: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="15" height="15"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M16 16l4 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

// -------------------------------------------------------------------------
// Screen-size tiers — the same breakpoints as wide.css. Below WIDE is the phone
// layout (style.css alone); WIDE (tablet and up) gets centred dialogs and
// anchored menus; DESK (desktop) gets the multi-column pages and the docked
// reader sidebar.
// -------------------------------------------------------------------------
export const WIDE = matchMedia("(min-width: 640px)");
export const DESK = matchMedia("(min-width: 1024px)");

// -------------------------------------------------------------------------
// Cover object URLs — created lazily from stored blobs and cached per book,
// revoked only when a book is removed.
// -------------------------------------------------------------------------
export const coverUrls = new Map();
export function coverUrlFor(book) {
  if (!book?.coverBlob) return null;
  if (!coverUrls.has(book.id)) coverUrls.set(book.id, URL.createObjectURL(book.coverBlob));
  return coverUrls.get(book.id);
}
export function coverNode(book, cls = "cover") {
  const url = book && coverUrlFor(book);
  if (url) return h("div", { class: cls }, h("img", { class: "cover__img", src: url, alt: "", loading: "lazy", draggable: "false" }));
  return h("div", { class: cls + " cover--ph" });
}
export function progressBar(pct, variant) {
  return h("div", { class: "pbar pbar--" + variant }, h("div", { class: "pbar__fill", style: `width:${pct}%` }));
}

// -------------------------------------------------------------------------
// Collected DOM refs, filled by collectRefs() after DOMContentLoaded. Every
// module reads `el.foo`; the object is mutated in place so all importers share
// the same live refs.
// -------------------------------------------------------------------------
export const el = {};
export function collectRefs() {
  const ids = {
    libBody: "lib-body",
    libMark: "lib-mark",
    libImport: "lib-import",
    libSearch: "lib-search",
    libSearchRow: "lib-search-row",
    libSearchInput: "lib-search-input",
    infoScreen: "info-screen",
    chaptersScreen: "chapters-screen",
    topTitle: "book-title",
    chapterTitle: "chapter-title",
    titleBlock: "title-block",
    topbar: "topbar",
    btnToc: "btn-toc",
    readerMark: "reader-mark",
    btnPrev: "btn-prev",
    btnNext: "btn-next",
    drawer: "drawer",
    drawerHome: "drawer-home",
    drawerBook: "drawer-book",
    drawerCover: "drawer-cover",
    drawerBookTitle: "drawer-book-title",
    drawerBookSub: "drawer-book-sub",
    drawerVolumes: "drawer-volumes",
    scrim: "scrim",
    tocList: "toc-list",
    viewer: "viewer",
    selectBar: "select-bar",
    selectCancel: "select-cancel",
    selectCount: "select-count",
    selectGroup: "select-group",
    selectDelete: "select-delete",
    suggestSheet: "suggest-sheet",
    suggestScrim: "suggest-scrim",
    suggestBody: "suggest-body",
    suggestGroup: "suggest-group",
    suggestKeep: "suggest-keep",
    nameSheet: "name-sheet",
    nameScrim: "name-scrim",
    nameTitle: "name-title",
    nameInput: "name-input",
    nameConfirm: "name-confirm",
    nameCancel: "name-cancel",
    confirmSheet: "confirm-sheet",
    confirmScrim: "confirm-scrim",
    confirmTitle: "confirm-title",
    confirmBody: "confirm-body",
    confirmOk: "confirm-ok",
    confirmCancel: "confirm-cancel",
    volumeSheet: "volume-sheet",
    volumeScrim: "volume-scrim",
    volumeCard: "volume-card",
    actionSheet: "action-sheet",
    actionScrim: "action-scrim",
    actionCard: "action-card",
    editor: "editor",
    installNote: "install-note",
    installNoteText: "install-note-text",
    installLead: "install-lead",
    installStepsPhone: "install-steps-phone",
    installStepsComputer: "install-steps-computer",
    installSheet: "install-sheet",
    installScrim: "install-scrim",
    installSheetClose: "install-sheet-close",
    appVersion: "app-version",
    checkUpdate: "check-update",
    updateStatus: "update-status",
    updateBanner: "update-banner",
    updateText: "update-banner-text",
    updateReload: "update-reload",
    updateDismiss: "update-dismiss",
    fileInput: "file-input",
  };
  for (const [k, id] of Object.entries(ids)) el[k] = document.getElementById(id);
}

// -------------------------------------------------------------------------
// Touch gestures.
// -------------------------------------------------------------------------
// A long-press primitive that survives a touchscreen. The naïve version
// cancelled on *any* pointermove, so finger jitter killed the press before it
// fired — on a phone it never triggered at all. Here the timer is only
// cancelled once movement passes a small threshold (a real scroll), so a still
// finger reliably reaches the hold.
//
// On a computer the same action is a right-click (or the keyboard's menu key):
// `onLongPress` receives the viewport point it was raised at ({ x, y }), so a
// wide screen can open its menu right there. `onTap` receives the click event
// (for ⌘/Ctrl-click). A non-button target is made focusable and answers
// Enter/Space, so the shelf is usable from the keyboard too.
export function attachLongPress(node, { onLongPress, onTap, canStart = () => true, delay = 450, moveTolerance = 10 }) {
  let timer = null;
  let longPressed = false;
  let startX = 0;
  let startY = 0;
  let lastPointerType = null;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  if (node.tagName !== "BUTTON") {
    node.setAttribute("role", "button");
    node.tabIndex = 0;
    node.addEventListener("keydown", (e) => {
      if (e.target !== node || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      onTap(e);
    });
  }
  node.addEventListener("pointerdown", (e) => {
    lastPointerType = e.pointerType;
    if (!canStart()) return;
    // A mouse's secondary button is the desktop long-press: `contextmenu`
    // (below) handles it, so it never arms the hold timer.
    if (e.pointerType === "mouse" && e.button !== 0) return;
    longPressed = false;
    startX = e.clientX;
    startY = e.clientY;
    clear();
    timer = setTimeout(() => {
      timer = null;
      longPressed = true;
      onLongPress({ x: startX, y: startY });
    }, delay);
  });
  node.addEventListener("pointermove", (e) => {
    if (!timer) return;
    if (Math.abs(e.clientX - startX) > moveTolerance || Math.abs(e.clientY - startY) > moveTolerance) clear();
  });
  node.addEventListener("pointerup", clear);
  node.addEventListener("pointercancel", clear);
  node.addEventListener("pointerleave", clear);
  // On Android a long-press fires `contextmenu` (the "Download image / open in
  // new tab" popup on covers), which collides with our own hold-to-select.
  // iOS's `-webkit-touch-callout: none` handles the equivalent there; this is
  // the cross-browser counterpart. Suppress it whenever a press could start.
  node.addEventListener("contextmenu", (e) => {
    // Not from a finger → a right-click or the menu key: run the long-press
    // action at once, in place of the browser's own menu.
    const type = e.pointerType || lastPointerType;
    if (type !== "touch" && type !== "pen" && canStart()) {
      e.preventDefault();
      clear();
      const r = node.getBoundingClientRect();
      // The menu key reports no pointer position — anchor inside the target.
      onLongPress(e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: r.left + 12, y: r.top + 12 });
      return;
    }
    if (canStart() || longPressed) e.preventDefault();
  });
  node.addEventListener("click", (e) => {
    if (longPressed) {
      e.preventDefault();
      e.stopPropagation();
      longPressed = false;
      return;
    }
    onTap(e);
  });
}

// Pointer-based drag reorder for one handle. Uses pointer capture so the drag
// survives the finger leaving the handle, and reorders DOM live; the caller
// syncs its model on each move.
// Reorder a list by dragging its rows. The whole `row` is the drag surface (the
// grip glyph is only an affordance) — on a phone the 18px handle is far too easy
// to miss, and a press that lands on the row's text was being read as a text
// selection instead of a drag. The row must carry `touch-action: none` (so the
// browser doesn't claim the gesture for scrolling) and `user-select: none` (so
// it never selects text) for this to work on touch.
export function attachOrderDrag(row, list, onReorder) {
  row.addEventListener("pointerdown", (e) => {
    // Ignore secondary mouse buttons; let primary touch/mouse start a drag.
    if (e.button && e.button !== 0) return;
    e.preventDefault();
    row.classList.add("dragging");
    const move = (ev) => {
      const others = [...list.querySelectorAll(".order-row:not(.dragging)")];
      const after = others.find((r) => ev.clientY < r.getBoundingClientRect().top + r.offsetHeight / 2);
      if (after) list.insertBefore(row, after);
      else list.append(row);
      onReorder();
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
      row.classList.remove("dragging");
    };
    // Track the pointer on the document, not the row. Explicit pointer capture on
    // the row is released almost immediately on touch (Chrome/Android), which
    // dropped the drag the moment the finger left the starting row and left the
    // list unchanged. Document-level listeners receive every move for the whole
    // gesture regardless of which row is under the finger. touch-action: none on
    // the row (see CSS) stops the browser claiming the gesture for scrolling.
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
  });
}
