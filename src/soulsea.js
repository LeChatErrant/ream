// =========================================================================
// SOUL SEA — Shadow Slave only: Sunny's inventory (Memories, Echoes, Shadows,
// Attributes, Aspect, abilities, Flaw, rank) as of where you are in the book.
//
// The data (soul-sea/shadow-slave.json, made by scripts/soul-sea) holds no book
// text: just item names and references — [chapter, paragraph, fingerprint] —
// to the rune sheets and passages. Those are read from the reader's own epubs
// (any imported volume of the series) and a paragraph is shown only when its
// fingerprint matches, so everything on screen is the book's own words.
//
// Spoilers: events count only once reached — earlier chapters, plus the part of
// the current chapter that has been on screen. A scrubber looks back at any
// earlier chapter, never ahead.
// =========================================================================
import ePub from "epubjs";
import data from "./soul-sea/shadow-slave.json";
import { h, svg, ICON } from "./dom.js";
import { books, seriesById } from "./state.js";
import { displayTitle } from "./reading.js";
import { parseChapterLabel } from "./lib/text.js";
import { baseHref } from "./lib/chapters.js";
import { textKey } from "./lib/proof-key.js";
import { armOverlay, closeOverlay } from "./router.js";

const MATCH = /shadow\s*slave/i;

/** The Soul Sea data for a library book, or null when it isn't Shadow Slave. */
export function soulSeaFor(lib) {
  if (!lib) return null;
  const s = lib.seriesId ? seriesById(lib.seriesId) : null;
  return [displayTitle(lib), lib.title, s?.name].some((t) => MATCH.test(t || "")) ? data : null;
}

// The Shadow Core with Memories orbiting it, as Sunny sees his Soul Sea.
export const ORB_ICON =
  '<svg viewBox="0 0 24 24" width="22" height="22"><circle cx="12" cy="12" r="3.4" fill="currentColor"/><ellipse cx="12" cy="12" rx="9.2" ry="3.9" transform="rotate(-24 12 12)" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="19.4" cy="7.3" r="1.5" fill="currentColor"/><circle cx="4.6" cy="16.7" r="1.15" fill="currentColor"/></svg>';

// ---- reading the book's paragraphs from the imported volumes ----------------------

let chapterMap = null; // chapter number → { book, href }
function locate(num) {
  if (!chapterMap) {
    chapterMap = new Map();
    for (const b of books.filter(soulSeaFor))
      for (const e of b.chapters || []) {
        const n = parseChapterLabel(e.label).num;
        if (n != null && !chapterMap.has(n)) chapterMap.set(n, { book: b, href: baseHref(e.href) });
      }
  }
  return chapterMap.get(num) || null;
}

const epubs = new Map(); // library book id → Promise<epub.js Book>
const chapterParas = new Map(); // chapter number → Promise<string[] | null>

function openEpub(lib) {
  if (!epubs.has(lib.id))
    epubs.set(
      lib.id,
      lib.fileBlob.arrayBuffer().then((buf) => {
        const b = ePub(buf);
        return b.ready.then(() => b);
      })
    );
  return epubs.get(lib.id);
}

function parasOf(num) {
  if (!chapterParas.has(num))
    chapterParas.set(
      num,
      (async () => {
        const loc = locate(num);
        if (!loc) return null;
        const b = await openEpub(loc.book);
        const section =
          b.spine.get(loc.href) ||
          b.spine.spineItems.find((s) => s.href === loc.href || s.href.endsWith("/" + loc.href) || loc.href.endsWith("/" + s.href));
        if (!section) return null;
        const root = await section.load(b.load.bind(b));
        const out = [...root.querySelectorAll("p")].map((p) => p.textContent);
        section.unload();
        return out;
      })().catch(() => null)
    );
  return chapterParas.get(num);
}

/** The text of one referenced paragraph, only if the reader's copy has exactly it. */
async function paragraph(ch, p, fp) {
  const ps = await parasOf(ch);
  if (!ps) return null;
  if (ps[p] != null && textKey(ps[p]) === fp) return ps[p];
  return ps.find((t) => textKey(t) === fp) ?? null;
}

// ---- replaying the timeline -------------------------------------------------------

/**
 * A reading point: chapter `num`, plus — for the chapter on screen — the
 * fingerprints of the paragraphs already shown (`seen`) and of all of them (`all`).
 */
function reached(e, point) {
  const [ch, p] = e.at;
  if (ch !== point.num) return ch < point.num;
  if (!point.seen) return true; // a whole chapter (the scrubber)
  if (point.all?.has(e.fp)) return point.seen.has(e.fp);
  return p < point.seenCount;
}

function stateAt(point) {
  const s = {};
  const get = (id) => (s[id] ??= { id, kind: data.entries[id]?.kind, runes: [], history: [] });
  for (const e of data.events) {
    if (!reached(e, point)) continue;
    const x = get(e.id);
    if (e.type === "gain") Object.assign(x, { held: true, name: e.name, label: e.label, since: e.at[0], lost: null });
    else if (e.type === "lose") Object.assign(x, { held: false, lost: e.at[0], how: e.how });
    else if (e.type === "become") {
      Object.assign(x, { held: false, lost: e.at[0], how: "became", into: e.to });
      Object.assign(get(e.to), { held: true, name: e.name, since: e.at[0], from: e.id });
    } else if (e.type === "name") x.name = e.value;
    else if (e.type === "set") Object.assign(x, { held: true, value: e.value, since: e.at[0] });
    else if (e.type === "runes") x.runes.unshift(e);
    else if (e.type === "history") x.history.push(e);
  }
  return s;
}

// ---- the panel ----------------------------------------------------------------------

const SECTIONS = [
  ["aspect", "Aspect"],
  ["ability", "Abilities"],
  ["flaw", "Flaw"],
  ["attribute", "Attributes"],
  ["memory", "Memories"],
  ["echo", "Echoes"],
  ["shadow", "Shadows"],
];
const HOW = { destroyed: "Destroyed", given: "Given away", consumed: "Consumed", became: "Evolved" };

let root = null;
let live = null; // { point, max } — where the reader is
let shown = null; // chapter being looked at (≤ live)
const expanded = new Set();

export const soulSeaOpen = () => !!root && !root.hidden;

/** Open the panel at the reading point { num, seen?, seenCount?, all? }. */
export function openSoulSea(point) {
  chapterMap = null; // the library may have changed since last time
  live = point;
  shown = null;
  if (!root) {
    root = h("div", { class: "soulsea", role: "dialog", "aria-label": "Soul Sea" });
    document.body.append(root);
  }
  root.hidden = false;
  render();
  armOverlay(() => {
    root.hidden = true;
    root.replaceChildren();
  });
}

function render() {
  if (!live.num) {
    root.replaceChildren(
      h("div", { class: "ch-bar soulsea__bar" }, h("button", { class: "ch-bar__icon", "aria-label": "Close", onclick: () => closeOverlay() }, svg(ICON.back)), h("div", { class: "ch-bar__titles" }, h("div", { class: "ch-bar__title" }, "Soul Sea"))),
      h("p", { class: "soulsea__note" }, "Open a chapter first.")
    );
    return;
  }
  const max = Math.min(live.num, data.reviewedThrough);
  const atLive = shown == null || shown >= live.num;
  const point = atLive ? (live.num > data.reviewedThrough ? { num: data.reviewedThrough } : live) : { num: shown };
  const viewNum = atLive ? Math.min(live.num, data.reviewedThrough) : shown;
  const st = stateAt(point);
  const items = Object.values(st);
  const prevSt = stateAt({ num: viewNum - 1 });

  const scroller = root.querySelector(".soulsea__body");
  const keepScroll = scroller?.scrollTop || 0;

  const slider = h("input", {
    class: "soulsea__range",
    type: "range",
    min: 1,
    max,
    value: viewNum,
    "aria-label": "Chapter",
    oninput: (e) => {
      shown = +e.target.value >= max ? null : +e.target.value;
      render();
    },
  });

  const body = h("div", { class: "soulsea__body" });
  const bar = h(
    "div",
    { class: "ch-bar soulsea__bar" },
    h("button", { class: "ch-bar__icon", "aria-label": "Close", onclick: () => closeOverlay() }, svg(ICON.back)),
    h(
      "div",
      { class: "ch-bar__titles" },
      h("div", { class: "ch-bar__title" }, "Soul Sea"),
      h("div", { class: "ch-bar__context" }, `${data.character} · as of chapter ${viewNum}${atLive ? "" : " (looking back)"}`)
    )
  );
  const when = h(
    "div",
    { class: "soulsea__when" },
    h("span", { class: "soulsea__ch" }, "Ch. 1"),
    slider,
    h(
      "button",
      { class: "soulsea__now" + (atLive ? " soulsea__now--on" : ""), onclick: () => ((shown = null), render()) },
      atLive ? "Now" : "Back to now"
    )
  );

  // What changed in the chapter being looked at.
  const changes = items.filter((x) => x.kind !== "stat" && (x.since === viewNum || x.lost === viewNum));
  if (changes.length) {
    body.append(
      h("h3", { class: "soulsea__h" }, "In this chapter"),
      h(
        "div",
        { class: "soulsea__changes" },
        changes.map((x) =>
          h(
            "span",
            { class: "soulsea__change soulsea__change--" + (x.held ? "gain" : "lose") },
            (x.held ? "+ " : "− ") + nameOf(x)
          )
        )
      )
    );
  }

  const stats = items.filter((x) => x.kind === "stat" && x.held);
  if (stats.length)
    body.append(
      h(
        "div",
        { class: "soulsea__stats" },
        stats.map((x) =>
          h(
            "div",
            { class: "soulsea__stat" },
            h("span", { class: "soulsea__stat-k" }, data.entries[x.id].label),
            h("span", { class: "soulsea__stat-v" }, x.value, h("span", { class: "soulsea__meta" }, ` · ch. ${x.since}`))
          )
        )
      )
    );

  for (const [kind, label] of SECTIONS) {
    const held = items.filter((x) => x.kind === kind && x.held);
    if (!held.length && kind !== "memory") continue;
    body.append(h("h3", { class: "soulsea__h" }, label, h("span", { class: "soulsea__count" }, String(held.length))));
    body.append(h("div", { class: "soulsea__list" }, held.map((x) => row(x, false, prevSt))));
  }

  const gone = items.filter((x) => x.held === false && x.kind !== "stat");
  if (gone.length) {
    const open = expanded.has("#gone");
    body.append(
      h(
        "button",
        {
          class: "soulsea__h soulsea__h--toggle",
          "aria-expanded": String(open),
          onclick: () => (expanded.has("#gone") ? expanded.delete("#gone") : expanded.add("#gone"), render()),
        },
        svg(ICON.chevron),
        "No longer held",
        h("span", { class: "soulsea__count" }, String(gone.length))
      )
    );
    if (open) body.append(h("div", { class: "soulsea__list" }, gone.map((x) => row(x, true, prevSt))));
  }

  if (live.num > data.reviewedThrough)
    body.append(h("p", { class: "soulsea__note" }, `The Soul Sea is mapped up to chapter ${data.reviewedThrough} so far.`));

  root.replaceChildren(bar, when, body);
  body.scrollTop = keepScroll;
}

const nameOf = (x) => x.name || `“${x.label}”`;

function row(x, gone, prevSt) {
  const open = expanded.has(x.id);
  const isNew = !gone && !prevSt[x.id]?.held;
  const meta = gone ? `${HOW[x.how] || "Lost"} · ch. ${x.lost}` : `ch. ${x.since}`;
  const head = h(
    "button",
    {
      class: "soulsea__row-head",
      "aria-expanded": String(open),
      onclick: () => (expanded.has(x.id) ? expanded.delete(x.id) : expanded.add(x.id), render()),
    },
    h("span", { class: "soulsea__name" + (x.name ? "" : " soulsea__name--label") }, nameOf(x)),
    isNew ? h("span", { class: "soulsea__new" }, "new") : null,
    h("span", { class: "soulsea__meta" }, meta)
  );
  const out = h("div", { class: "soulsea__row" + (gone ? " soulsea__row--gone" : "") + (open ? " soulsea__row--open" : "") }, head);
  if (!open) return out;

  const detail = h("div", { class: "soulsea__detail" });
  if (x.runes[0]) detail.append(sheet(x.runes[0]));
  else detail.append(h("p", { class: "soulsea__empty" }, "No runes shown in the book yet."));
  if (x.runes.length > 1)
    detail.append(fold(`${x.id}#runes`, `Earlier runes (${x.runes.length - 1})`, () => x.runes.slice(1).map(sheet)));
  if (x.history.length)
    detail.append(fold(`${x.id}#history`, `From the book (${x.history.length})`, () => x.history.map((e) => passage(e))));
  out.append(detail);
  return out;
}

function fold(key, label, kids) {
  const open = expanded.has(key);
  const wrap = h("div", { class: "soulsea__fold" });
  wrap.append(
    h(
      "button",
      { class: "soulsea__fold-head", "aria-expanded": String(open), onclick: () => (expanded.has(key) ? expanded.delete(key) : expanded.add(key), render()) },
      svg(ICON.chevron),
      label
    )
  );
  if (open) wrap.append(...kids());
  return wrap;
}

// Paragraphs are filled in as they load from the epub; one that isn't found
// verbatim in this copy is left out rather than approximated.
function fill(box, e, cls) {
  const [ch] = e.at;
  const refs = e.paras || [[e.at[1], e.fp]];
  const ps = refs.map(() => h("p", { class: cls + " soulsea__loading" }, "…"));
  box.append(...ps);
  refs.forEach(([p, fp, from = ch], i) =>
    paragraph(from, p, fp).then((t) => {
      if (t == null) ps[i].remove();
      else {
        ps[i].textContent = t;
        ps[i].classList.remove("soulsea__loading");
      }
      if (!box.querySelector("p")) box.append(h("p", { class: "soulsea__empty" }, `Chapter ${ch} isn’t in your library (or differs from the mapped copy).`));
    })
  );
  return box;
}

const sheet = (e) =>
  fill(h("div", { class: "soulsea__runes" }, h("div", { class: "soulsea__src" }, `Chapter ${e.at[0]}`)), e, "soulsea__rune");
const passage = (e) =>
  fill(
    h("div", { class: "soulsea__passage" }, h("div", { class: "soulsea__src" }, `Chapter ${e.at[0]}` + (e.flashback ? " · flashback" : ""))),
    e,
    "soulsea__para"
  );
