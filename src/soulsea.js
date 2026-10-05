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
// Spoilers: what happens in a chapter shows only from the next one on — the
// panel holds what Sunny had when the chapter on screen began, so opening it
// mid-chapter never gives away what the chapter is about to bring.
// =========================================================================
import ePub from "epubjs";
import data from "./soul-sea/shadow-slave.json";
import { h, svg, ICON, WIDE } from "./dom.js";
import { books, seriesById } from "./state.js";
import { displayTitle } from "./reading.js";
import { parseChapterLabel } from "./lib/text.js";
import { baseHref } from "./lib/chapters.js";
import { textKey, textSig, sigSimilarity } from "./lib/proof-key.js";
import { descText, cap } from "./lib/rune-sheet.js";
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

/**
 * The text of one referenced paragraph in the reader's copy: the same text, or —
 * when the copy differs a little (a typo fixed, a proofread epub) — the paragraph
 * near the same place whose similarity signature (`g`) nearly matches, so a small
 * edit never hides a rune line. Otherwise nothing: never a different paragraph.
 */
const lenOf = (fp) => parseInt(fp.split(".")[1], 36);
async function paragraph(ch, p, fp, g) {
  const ps = await parasOf(ch);
  if (!ps) return null;
  if (ps[p] != null && textKey(ps[p]) === fp) return ps[p];
  const same = ps.find((t) => textKey(t) === fp);
  if (same != null || !g) return same ?? null;
  let best = null;
  for (let q = Math.max(0, p - 6); q <= Math.min(ps.length - 1, p + 6); q++) {
    const len = lenOf(textKey(ps[q]));
    if (Math.abs(len - lenOf(fp)) > 0.25 * lenOf(fp)) continue;
    const sim = sigSimilarity(textSig(ps[q]), g);
    if (sim >= 0.75 && (!best || sim > best.sim || (sim === best.sim && Math.abs(q - p) < Math.abs(best.q - p)))) best = { q, sim };
  }
  return best ? ps[best.q] : null;
}

// ---- replaying the timeline -------------------------------------------------------

/** Sunny's Soul Sea after every event up to chapter `last`, included. */
function stateAt(last) {
  const s = {};
  const get = (id) => (s[id] ??= { id, kind: data.entries[id]?.kind, sheet: null });
  for (const e of data.events) {
    if (e.at[0] > last) continue;
    const x = get(e.id);
    if (e.type === "gain") Object.assign(x, { held: true, name: e.name, label: e.label, since: e.at[0], lost: null });
    else if (e.type === "lose") Object.assign(x, { held: false, lost: e.at[0], how: e.how });
    else if (e.type === "become") {
      Object.assign(x, { held: false, lost: e.at[0], how: "became", into: e.to });
      Object.assign(get(e.to), { held: true, name: e.name, since: e.at[0], from: e.id });
    } else if (e.type === "name") x.name = e.value;
    else if (e.type === "set") Object.assign(x, { held: true, value: e.value, since: e.at[0], values: [...(x.values || []), e.value] });
    else if (e.type === "runes") {
      x.sheet = e; // each sheet already carries the earlier lines (see build.mjs)
      x.facts = {}; // a newer sheet supersedes facts told in prose
    } else if (e.type === "told") x.told = e; // how the story describes it (no runes, or none describing it)
    else if (e.type === "fact") (x.facts ??= {})[e.label] = e.value; // "now a Transcendent Devil"
    else if (e.type === "source") Object.assign(x, { source: e.value, sourceItem: e.item });
  }
  return s;
}

// ---- the panel ----------------------------------------------------------------------

const SECTIONS = [
  ["aspect", "Aspect"],
  ["legacy", "Aspect Legacy"],
  ["relic", "Legacy Relics"],
  ["ability", "Abilities"],
  ["flaw", "Flaw"],
  ["attribute", "Attributes"],
  ["memory", "Memories"],
  ["echo", "Echoes"],
  ["shadow", "Shadows"],
];
const HOW = { destroyed: "Destroyed", given: "Given away", consumed: "Consumed", lost: "Lost", sold: "Sold", stolen: "Stolen", became: "Evolved" };

let root = null;
let live = null; // the chapter on screen: { num }
const expanded = new Set();

export const soulSeaOpen = () => !!root && !root.hidden;

/** Open the panel for the chapter on screen, { num }. */
export function openSoulSea(point) {
  chapterMap = null; // the library may have changed since last time
  live = point;
  if (!root) {
    root = h("div", { class: "soulsea", role: "dialog", "aria-label": "Soul Sea" });
    document.body.append(root);
  }
  root.hidden = false;
  render();
  armOverlay(() => {
    root.hidden = true;
    root.replaceChildren();
    // Each opening starts fresh: everything folded, at the top.
    expanded.clear();
    focused = null;
  });
}

// On a phone the panel is a pushed screen (Back); on a wide screen a side panel (Close).
function header(context) {
  const close = h("button", { class: "ch-bar__icon", "aria-label": "Close", onclick: () => closeOverlay() }, svg(WIDE.matches ? ICON.close : ICON.back));
  const titles = h("div", { class: "ch-bar__titles" }, h("div", { class: "ch-bar__title" }, "Soul Sea"), context ? h("div", { class: "ch-bar__context" }, context) : null);
  return h("div", { class: "ch-bar soulsea__bar" }, ...(WIDE.matches ? [titles, close] : [close, titles]));
}

// "Shadow Cores: [5/7]" → Shadow Cores · 5 / 7. The book also says it in words once
// ("His soul possessed six cores now", "the seventh, final core"): the count is that
// number, out of the last maximum the runes showed.
const NUMBER = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7 };
function coreStat(x) {
  const runes = [...x.values].reverse().find((v) => /\[\d+\/\d+\]/.test(v));
  const label = (x.value.match(/^\s*([A-Z][\w ]*?):/) || runes?.match(/^\s*([A-Z][\w ]*?):/))?.[1] ?? "Core";
  const n = x.value.match(/\[(\d+)\/(\d+)\]/);
  if (n) return [label, `${n[1]} / ${n[2]}`];
  const w = x.value.match(/\b(one|two|three|four|five|six|seven|first|second|third|fourth|fifth|sixth|seventh)\b[\w, ]*?\bcores?\b/i);
  const max = runes?.match(/\/(\d+)\]/)?.[1];
  if (w) return [label, `${NUMBER[w[1].toLowerCase()]}${max ? " / " + max : ""}`];
  return [label, x.value.replace(/^\s*[A-Z][\w ]*?:\s*/, "").replace(/\.$/, "")];
}

function render() {
  if (!live.num) {
    root.replaceChildren(header(null), h("p", { class: "soulsea__note" }, "Open a chapter first."));
    return;
  }
  // Everything before the chapter on screen (and no further than what's mapped).
  const last = Math.min(live.num - 1, data.reviewedThrough);
  const st = stateAt(last);
  current = st;
  const items = Object.values(st);
  recentFrom = last - RECENT + 1;

  const scroller = root.querySelector(".soulsea__body");
  const keepScroll = scroller?.scrollTop || 0;
  const body = h("div", { class: "soulsea__body" });

  // What changed over the last few chapters, latest first.
  const recent = data.events.filter((e) => e.at[0] >= recentFrom && e.at[0] <= last && st[e.id]?.kind !== "stat").reverse();
  const chip = (x, mod, text) => h("button", { class: "soulsea__change soulsea__change--" + mod, onclick: () => focusItem(x) }, text);
  const groups = [
    // gained and still held (one lost since is under "Recently lost")
    ["Recently gained", recent.filter((e) => e.type === "gain" && st[e.id].held).map((e) => chip(st[e.id], "gain", "+ " + nameOf(st[e.id])))],
    ["Recently evolved", recent.filter((e) => e.type === "become").map((e) => chip(st[e.to], "evolve", `${nameOf(st[e.id])} → ${nameOf(st[e.to])}`))],
    ["Recently lost", recent.filter((e) => e.type === "lose" && !st[e.id].held).map((e) => chip(st[e.id], "lose", "− " + nameOf(st[e.id])))],
  ];
  for (const [label, chips] of groups)
    if (chips.length) body.append(h("h3", { class: "soulsea__h" }, label), h("div", { class: "soulsea__changes" }, chips));

  const STAT_ORDER = ["true-name", "rank", "class", "core", "fragments"];
  const stats = items.filter((x) => x.kind === "stat" && x.held).sort((a, b) => STAT_ORDER.indexOf(a.id) - STAT_ORDER.indexOf(b.id));
  if (stats.length)
    body.append(
      h(
        "div",
        { class: "soulsea__stats" },
        stats.map((x) => {
          const [k, v] =
            x.id === "core" ? coreStat(x) : [data.entries[x.id].label, x.id === "fragments" ? x.value.replace(/^(\d+)\/(\d+)$/, "$1 / $2") : x.value];
          return h("div", { class: "soulsea__stat" }, h("span", { class: "soulsea__stat-k" }, k), h("span", { class: "soulsea__stat-v" }, v));
        })
      )
    );

  let shown = 0;
  for (const [kind, label] of SECTIONS) {
    const held = items.filter((x) => x.kind === kind && x.held);
    if (!held.length) continue; // an empty section would hint at what's to come
    shown += held.length;
    body.append(h("h3", { class: "soulsea__h" }, label, h("span", { class: "soulsea__count" }, String(held.length))));
    body.append(h("div", { class: "soulsea__list" }, held.map((x) => row(x, false))));
  }
  if (!shown && !stats.length) body.append(h("p", { class: "soulsea__empty-state" }, "Nothing in Sunny’s Soul Sea yet."));

  const gone = items.filter((x) => x.held === false && x.kind !== "stat");
  if (gone.length) {
    const open = expanded.has("#gone");
    body.append(
      h(
        "button",
        { class: "soulsea__h soulsea__h--toggle", "aria-expanded": String(open), onclick: () => toggle("#gone") },
        svg(ICON.chevron),
        "No longer held",
        h("span", { class: "soulsea__count" }, String(gone.length))
      )
    );
    if (open) body.append(h("div", { class: "soulsea__list" }, gone.map((x) => row(x, true))));
  }

  if (live.num > data.reviewedThrough)
    body.append(h("p", { class: "soulsea__note" }, `The Soul Sea is mapped up to chapter ${data.reviewedThrough} so far.`));

  root.replaceChildren(header(`${data.character} · Chapter ${live.num}`), body);
  body.scrollTop = keepScroll;
}

// A "Recently …" chip → open that item (inside "No longer held" if it's gone) and bring it into view.
let focused = null; // the item a chip asked for, until its sheet has loaded
function focusItem(x) {
  if (!x.held) expanded.add("#gone");
  expanded.add(x.id);
  focused = x.id;
  render();
  scrollToFocused();
}
function scrollToFocused() {
  const body = root?.querySelector(".soulsea__body");
  const row = focused && root.querySelector(`.soulsea__row[data-id="${focused}"]`);
  if (row && body) body.scrollTo({ top: row.offsetTop - 12, behavior: "smooth" });
}

const nameOf = (x) => x.name || `“${x.label}”`;
// A change stays "recent" for this many chapters, so the last gains still show a
// few chapters on (changes come every nine chapters or so).
const RECENT = 15;
let recentFrom = 0; // the first chapter that counts as recent
let current = {}; // id → item, in the state being drawn
const stateOf = (id) => current[id];
const toggle = (key) => ((focused = null), expanded.has(key) ? expanded.delete(key) : expanded.add(key), render());

function row(x, gone) {
  const open = expanded.has(x.id);
  const isNew = !gone && x.since >= recentFrom;
  const head = h(
    "button",
    { class: "soulsea__row-head", "aria-expanded": String(open), onclick: () => toggle(x.id) },
    h("span", { class: "soulsea__name" + (x.name ? "" : " soulsea__name--label") }, nameOf(x)),
    isNew ? h("span", { class: "soulsea__new" }, "New") : null,
    gone ? h("span", { class: "soulsea__meta" }, HOW[x.how] || "Lost") : null,
    h("span", { class: "soulsea__chev" }, svg(ICON.chevron))
  );
  const out = h("div", { class: "soulsea__row" + (gone ? " soulsea__row--gone" : "") + (open ? " soulsea__row--open" : ""), dataset: { id: x.id } }, head);
  if (!open) return out;

  const detail = h("div", { class: "soulsea__detail" });
  if (x.sheet) detail.append(sheet(x.sheet, x));
  // The story's own description when the runes give none (or there are no runes).
  if (x.told && !x.sheet?.sheet.d) detail.append(told(x.told, !x.sheet));
  if (!x.sheet && !x.told)
    detail.append(
      x.facts && Object.keys(x.facts).length
        ? buildSheet({ at: [0], sheet: { f: [], l: [] } }, new Map(), x)
        : h("p", { class: "soulsea__none" }, "No runes shown yet")
    );
  // Where it came from: the creature, the giver, or what it evolved from.
  // Another item of the Soul Sea (what it evolved from, the Legacy whose relic it is) is a link.
  const before = x.from && stateOf(x.from);
  const via = x.sourceItem && stateOf(x.sourceItem);
  const origin = x.source
    ? via ? itemLink(via, cap(x.source)) : cap(x.source)
    : before && nameOf(before) !== nameOf(x) ? itemLink(before) : null;
  if (origin)
    detail.append(
      h("div", { class: "soulsea__origin" }, h("span", { class: "soulsea__k" }, x.source ? "Obtained from" : "Evolved from"), h("span", { class: "soulsea__origin-v" }, origin))
    );
  const when = gone ? `${HOW[x.how] || "Lost"} in chapter ${x.lost}` : `Chapter ${x.since}`;
  detail.append(h("p", { class: "soulsea__when-note" }, when));
  out.append(detail);
  return out;
}

// ---- rune sheets (read by lib/rune-sheet.js; laid out here) ----------------------
const ORDINAL = { First: 0, Second: 1, Third: 2, Fourth: 3, Fifth: 4, Sixth: 5, Seventh: 6 };

// A reference to another item of the Soul Sea: tapping it opens that item. Only
// what is an item of its own is linked — an Aspect's Abilities, a Legacy's Relics —
// never a Shadow's attribute that happens to share a name with one of Sunny's.
function itemLink(other, text = nameOf(other)) {
  return h("button", { class: "soulsea__link", type: "button", onclick: (e) => (e.stopPropagation(), focusItem(other)) }, text);
}
const LINKABLE = new Set(["aspect", "legacy", "relic", "ability", "flaw"]);
const itemNamed = (name, self) => Object.values(current).find((o) => o !== self && LINKABLE.has(o.kind) && o.name === name);

/**
 * An item's rune sheet, as the build read it (see build.mjs): facts `f`, the item's
 * description `d`, lists `l` of names each with its description, leftovers `o`.
 * A description is a list of paragraph references; `texts` holds what the reader's
 * copy has for them.
 */
function buildSheet(e, texts, x) {
  const sh = e.sheet;
  const box = h("div", { class: "soulsea__sheet" });
  const relics = data.entries[x.id]?.relics;
  // What the book has said since the last rune sheet ("now a Transcendent Devil") wins.
  const facts = sh.f.filter(([k]) => !(x.facts && k in x.facts)).concat(Object.entries(x.facts || {}));
  if (facts.length)
    box.append(
      h(
        "div",
        { class: "soulsea__facts" },
        facts.map(([label, value]) => {
          // "Second Relic: Claimed" → and which item it was; "Innate Ability: Shadow Bond" → that ability.
          // A relic Sunny holds (or held) is claimed, even if this sheet predates the claim ("[Claim]").
          const relic = relics && /Relic$/.test(label) && current[relics[ORDINAL[label.split(" ")[0]]]];
          const other = relic || itemNamed(value, x);
          return h(
            "div",
            { class: "soulsea__fact" },
            h("span", { class: "soulsea__fact-k" }, label),
            h("span", { class: "soulsea__fact-v" }, relic ? itemLink(relic) : other ? itemLink(other, value) : value)
          );
        })
      )
    );
  const prose = (text, cls) => cap(text).split(/\n\n+/).map((t) => h("p", { class: cls }, t));
  // A description the reader's copy doesn't have (another edition, a missing volume) says so.
  const desc = (d, cls) => {
    const parts = d.map((r) => ({ ...r, t: texts.get(refKey(e, r)) }));
    return parts.every((r) => r.t != null) ? prose(descText(parts), cls) : [h("p", { class: "soulsea__none" }, "Not in your copy of the book")];
  };
  if (sh.d) box.append(...desc(sh.d, "soulsea__epigraph"));
  else if ((sh.f.length || sh.l.length) && !x.told) box.append(h("p", { class: "soulsea__none" }, "No description yet"));
  // Under each list ("Enchantments"), every name in the book's order, with its
  // description when the book gives one; a name that is an item of its own (an
  // Aspect's Abilities) links to it instead.
  const note = (n) => {
    const other = !n.d && itemNamed(n.n, x);
    return h(
      "div",
      { class: "soulsea__note-block" },
      n.n ? h("div", { class: "soulsea__note-title" }, other ? itemLink(other) : n.n) : null,
      n.d ? desc(n.d, "soulsea__note-text") : other ? null : h("p", { class: "soulsea__none" }, "No description yet")
    );
  };
  for (const l of sh.l) box.append(h("div", { class: "soulsea__list-row" }, h("span", { class: "soulsea__k" }, l.k), l.n.map(note)));
  for (const n of sh.o || []) box.append(note(n));
  return box;
}

// No runes in the book: what it holds, as the story names it, and the story's own words.
function buildTold(e, texts, withNames) {
  const box = h("div", { class: "soulsea__sheet" });
  for (const [label, names] of withNames ? Object.entries(e.names || {}) : [])
    box.append(h("div", { class: "soulsea__list-row" }, h("span", { class: "soulsea__k" }, label), names.map((n) => h("div", { class: "soulsea__note-block" }, h("div", { class: "soulsea__note-title" }, n)))));
  const ps = e.paras.map((r) => texts.get(refKey(e, r))).filter((t) => t != null);
  box.append(h("span", { class: "soulsea__k" }, "In the story"));
  box.append(...(ps.length ? ps.map((t) => h("p", { class: "soulsea__note-text" }, t)) : [h("p", { class: "soulsea__none" }, "Not in your copy of the book")]));
  return box;
}

// Resolved paragraphs, so a re-render (expanding another row) draws instantly.
// A reference is { p, fp, g, ch? } (see build.mjs); a sheet's are all its descriptions'.
const textCache = new Map();
const refKey = (e, r) => `${r.ch ?? e.at[0]}:${r.p}:${r.fp}`;
const refsOf = (e) =>
  e.sheet ? [e.sheet.d, ...e.sheet.l.flatMap((l) => l.n.map((n) => n.d)), ...(e.sheet.o || []).map((n) => n.d)].filter(Boolean).flat() : e.paras || [];
function load(e) {
  const refs = refsOf(e);
  const out = () => new Map(refs.map((r) => [refKey(e, r), textCache.get(refKey(e, r))]));
  if (refs.every((r) => textCache.has(refKey(e, r)))) return out();
  return Promise.all(refs.map((r) => paragraph(r.ch ?? e.at[0], r.p, r.fp, r.g).then((t) => textCache.set(refKey(e, r), t)))).then(out);
}

// Paragraphs come from the reader's own epubs: the same text or, after a small
// edit, nearly the same — never a stand-in.
function whenLoaded(e, draw) {
  const box = h("div", { class: "soulsea__loadbox" });
  const done = (texts) => {
    box.replaceChildren(draw(texts));
    if (focused && box.closest(`.soulsea__row[data-id="${focused}"]`)) scrollToFocused();
  };
  const got = load(e);
  if (got instanceof Map) done(got);
  else {
    box.append(h("p", { class: "soulsea__empty" }, "…"));
    got.then(done);
  }
  return box;
}

const sheet = (e, x) => whenLoaded(e, (texts) => buildSheet(e, texts, x));
const told = (e, withNames) => whenLoaded(e, (texts) => buildTold(e, texts, withNames));
