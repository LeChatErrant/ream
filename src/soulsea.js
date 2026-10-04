// =========================================================================
// SOUL SEA — Shadow Slave only: Sunny's inventory (Memories, Echoes, Shadows,
// Attributes, Aspect, abilities, Flaw, rank) as of where you are in the book.
//
// The data (soul-sea/shadow-slave.json, made by scripts/soul-sea) holds no book
// text: just item names and references — [chapter, paragraph, fingerprint] —
// to the rune sheets. Those are read from the reader's own epubs
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
  const get = (id) => (s[id] ??= { id, kind: data.entries[id]?.kind, sheet: null });
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
    else if (e.type === "runes") x.sheet = e; // each sheet already carries the earlier lines (see build.mjs)
    else if (e.type === "source") x.source = e.value;
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
  current = st;
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
      h("div", { class: "ch-bar__context" }, `${data.character} · Chapter ${viewNum}${atLive ? "" : " · looking back"}`)
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
            h("span", { class: "soulsea__stat-v" }, x.value)
          )
        )
      )
    );

  for (const [kind, label] of SECTIONS) {
    const held = items.filter((x) => x.kind === kind && x.held);
    if (!held.length) continue; // an empty section would hint at what's to come
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
          onclick: () => toggle("#gone"),
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
let current = {}; // id → item, in the state being drawn
const stateOf = (id) => current[id];
const toggle = (key) => (expanded.has(key) ? expanded.delete(key) : expanded.add(key), render());

function row(x, gone, prevSt) {
  const open = expanded.has(x.id);
  const isNew = !gone && !prevSt[x.id]?.held;
  const head = h(
    "button",
    { class: "soulsea__row-head", "aria-expanded": String(open), onclick: () => toggle(x.id) },
    h("span", { class: "soulsea__name" + (x.name ? "" : " soulsea__name--label") }, nameOf(x)),
    isNew ? h("span", { class: "soulsea__new" }, "New") : null,
    gone ? h("span", { class: "soulsea__meta" }, HOW[x.how] || "Lost") : null,
    h("span", { class: "soulsea__chev" }, svg(ICON.chevron))
  );
  const out = h("div", { class: "soulsea__row" + (gone ? " soulsea__row--gone" : "") + (open ? " soulsea__row--open" : "") }, head);
  if (!open) return out;

  const detail = h("div", { class: "soulsea__detail" });
  if (x.sheet) detail.append(sheet(x.sheet, x));
  // Where it came from: the creature, the giver, or what it evolved from.
  const before = x.from && stateOf(x.from);
  const origin = x.source || (before && nameOf(before) !== nameOf(x) ? nameOf(before) : null);
  if (origin)
    detail.append(
      h("div", { class: "soulsea__origin" }, h("span", { class: "soulsea__k" }, x.source ? "Obtained from" : "Evolved from"), h("span", { class: "soulsea__origin-v" }, origin))
    );
  const when = gone ? `${HOW[x.how] || "Lost"} in chapter ${x.lost}` : `Chapter ${x.since}`;
  detail.append(h("p", { class: "soulsea__when-note" }, when));
  out.append(detail);
  return out;
}

// ---- rune sheets -----------------------------------------------------------------
// The lines are the book's own; only the layout is ours. "Memory Rank: Awakened."
// becomes a Rank / Awakened row: the label loses the item-kind word, brackets and
// the closing full stop, and a list of names becomes chips. The item's description
// reads as an epigraph; enchantments, attributes and abilities get their name as
// a heading.

const KIND_WORD = /^(Memory|Echo|Shadow|Aspect|Flaw)\s+/;
// A short value loses its full stop ("Awakened."); prose keeps its own, losing
// only one that closes the brackets ("[…deserts].").
const unwrap = (v, prose = false) =>
  v
    .trim()
    .replace(prose ? /(?<=[\]"])\.$/ : /\.$/, "")
    .replace(/^\[([^[\]]*)\]$/, "$1")
    .replace(/^"([^"]*)"$/, "$1")
    .replace(/^\[(.*)\]$/s, "$1")
    .trim();

/** One rune line → { label, subject?, value }. */
function parseRune(t) {
  t = t.trim();
  let m = t.match(/^\[([^\]]+)\]\s+(\w+ Description)\s*:\s*(.*)$/s); // [Fated] Attribute Description: "…"
  if (m) return { label: m[2], subject: m[1], value: m[3] };
  m = t.match(/^((?:[A-Z][\w']*\s){1,4})(Attribute|Enchantment|Ability) Description\s*:\s*(.*)$/s); // Battle Master Attribute Description: […]
  if (m && !KIND_WORD.test(m[1] + " ")) return { label: `${m[2]} Description`, subject: m[1].trim(), value: m[3] };
  m = t.match(/^([A-Z][\w' ]{0,40}?)\s*:\s*(.*)$/s); // Memory Rank: Awakened.
  if (m) return { label: m[1], value: m[2] };
  m = t.match(/^\[(.*)\]\.?$/s); // a Spell message: "[Silver Bell: a small memento…]", "[Shadow Fragments: 0/200.]"
  if (m) {
    const inner = parseRune(m[1]);
    // "[Silver Bell: …]" names the item, then describes it.
    return inner.label && !/^[A-Z][\w' ]*(Fragments|Rank|Tier|Type|Class)$/.test(inner.label)
      ? { label: "Description", value: inner.value }
      : inner.label
        ? inner
        : { label: "Description", value: m[1] };
  }
  return { label: "Description", value: t };
}

function buildSheet(lines, x) {
  const facts = [];
  const lists = [];
  const notes = []; // named descriptions: enchantments, attributes, abilities
  let epigraph = null;
  let enchantment = null;
  for (const t of lines) {
    const r = parseRune(t);
    const label = r.label.replace(KIND_WORD, "");
    const value = unwrap(r.value);
    const prose = unwrap(r.value, true);
    if (label === "Enchantment") {
      enchantment = value;
      continue;
    }
    // The line naming the item ("Memory: [Midnight Shard].") repeats the row's title.
    if (!r.subject && value === x.name) continue;
    const own = !r.subject || r.subject === x.name;
    // An attribute's or ability's own description is its epigraph.
    if (/(^|\s)Description$/.test(label) && own && !epigraph && (x.kind === "attribute" || x.kind === "ability")) epigraph = prose;
    else if (/(^|\s)Description$/.test(label) && label !== "Description") {
      notes.push({ title: r.subject || (label === "Enchantment Description" ? enchantment : null), kind: label, text: prose });
      enchantment = null;
    } else if (label === "Description" || /^(Memory|Echo|Shadow|Aspect|Flaw) Description$/.test(r.label)) epigraph = prose;
    // A list of names ("[Battle Master], [Stalwart]") — not a count like "[27/200]".
    else if (/^\[[^\]\d][^\]]*\](,\s*\[.+\])*$/.test(r.value.trim().replace(/\.$/, "")) && /s$/.test(label))
      lists.push({ label, names: [...r.value.matchAll(/\[([^\]]+)\]?/g)].map((m) => m[1].trim()) });
    else facts.push({ label, value });
  }
  // Enchantment descriptions the book lists without naming: in the order of the list.
  const ench = lists.find((l) => l.label === "Enchantments");
  const unnamed = notes.filter((n) => n.kind === "Enchantment Description" && !n.title);
  if (ench && unnamed.length === ench.names.length) unnamed.forEach((n, i) => (n.title = ench.names[i]));

  const box = h("div", { class: "soulsea__sheet" });
  if (facts.length)
    box.append(
      h(
        "div",
        { class: "soulsea__facts" },
        facts.map((f) => h("div", { class: "soulsea__fact" }, h("span", { class: "soulsea__fact-k" }, f.label), h("span", { class: "soulsea__fact-v" }, f.value)))
      )
    );
  if (epigraph) box.append(h("p", { class: "soulsea__epigraph" }, epigraph));
  // Under each list ("Enchantments"), every name in the book's order, with its
  // description when the book gives one.
  const note = (n) => h("div", { class: "soulsea__note-block" }, n.title ? h("div", { class: "soulsea__note-title" }, n.title) : null, n.text ? h("p", { class: "soulsea__note-text" }, n.text) : null);
  const placed = new Set();
  for (const l of lists) {
    const entries = l.names.map((name) => {
      const n = notes.find((m) => m.title === name);
      if (n) placed.add(n);
      return n || { title: name };
    });
    box.append(h("div", { class: "soulsea__list-row" }, h("span", { class: "soulsea__k" }, l.label), entries.map(note)));
  }
  for (const n of notes) if (!placed.has(n)) box.append(note(n));
  return box;
}

// Resolved paragraphs, so a re-render (expanding another row) draws instantly.
const textCache = new Map();
function load(e) {
  const [ch] = e.at;
  const refs = (e.paras || [[e.at[1], e.fp]]).map(([p, fp, from = ch]) => [from, p, fp]);
  const key = (r) => r.join(":");
  if (refs.every((r) => textCache.has(key(r)))) return refs.map((r) => textCache.get(key(r))).filter((t) => t != null);
  return Promise.all(refs.map((r) => paragraph(...r).then((t) => (textCache.set(key(r), t), t)))).then((ts) => ts.filter((t) => t != null));
}

// Paragraphs come from the reader's own epubs; one that isn't found verbatim in
// this copy is left out rather than approximated.
function whenLoaded(e, draw) {
  const box = h("div", { class: "soulsea__loadbox" });
  const done = (ts) => box.replaceChildren(ts.length ? draw(ts) : h("p", { class: "soulsea__empty" }, "This chapter isn’t in your library, or differs from the mapped copy."));
  const got = load(e);
  if (Array.isArray(got)) done(got);
  else {
    box.append(h("p", { class: "soulsea__empty" }, "…"));
    got.then(done);
  }
  return box;
}

const sheet = (e, x) => whenLoaded(e, (ts) => buildSheet(ts, x));
