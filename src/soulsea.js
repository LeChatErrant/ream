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
import { h, svg, ICON, WIDE } from "./dom.js";
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
    else if (e.type === "set") Object.assign(x, { held: true, value: e.value, since: e.at[0], values: [...(x.values || []), e.value] });
    else if (e.type === "runes") {
      x.sheet = e; // each sheet already carries the earlier lines (see build.mjs)
      x.facts = {}; // a newer sheet supersedes facts told in prose
    } else if (e.type === "fact") (x.facts ??= {})[e.label] = e.value; // "now a Transcendent Devil"
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
const HOW = { destroyed: "Destroyed", given: "Given away", consumed: "Consumed", lost: "Lost", sold: "Sold", stolen: "Stolen", became: "Evolved" };

let root = null;
let live = null; // where the reader is: { num, seen?, seenCount?, all? }
const expanded = new Set();

export const soulSeaOpen = () => !!root && !root.hidden;

/** Open the panel at the reading point { num, seen?, seenCount?, all? }. */
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
  });
}

// On a phone the panel is a pushed screen (Back); on a wide screen a side panel (Close).
function header(context) {
  const close = h("button", { class: "ch-bar__icon", "aria-label": "Close", onclick: () => closeOverlay() }, svg(WIDE.matches ? ICON.close : ICON.back));
  const titles = h("div", { class: "ch-bar__titles" }, h("div", { class: "ch-bar__title" }, "Soul Sea"), context ? h("div", { class: "ch-bar__context" }, context) : null);
  return h("div", { class: "ch-bar soulsea__bar" }, ...(WIDE.matches ? [titles, close] : [close, titles]));
}

// "Shadow Cores: [5/7]" → Shadow Cores · 5 / 7. The book also says it in words once
// ("His soul possessed six cores now"): the count is that number, out of the last
// maximum the runes showed.
const NUMBER = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
function coreStat(x) {
  const runes = [...x.values].reverse().find((v) => /\[\d+\/\d+\]/.test(v));
  const label = (x.value.match(/^\s*([A-Z][\w ]*?):/) || runes?.match(/^\s*([A-Z][\w ]*?):/))?.[1] ?? "Core";
  const n = x.value.match(/\[(\d+)\/(\d+)\]/);
  if (n) return [label, `${n[1]} / ${n[2]}`];
  const w = x.value.match(/\b(one|two|three|four|five|six|seven)\s+cores?\b/i);
  const max = runes?.match(/\/(\d+)\]/)?.[1];
  if (w) return [label, `${NUMBER[w[1].toLowerCase()]}${max ? " / " + max : ""}`];
  return [label, x.value.replace(/^\s*[A-Z][\w ]*?:\s*/, "").replace(/\.$/, "")];
}

function render() {
  if (!live.num) {
    root.replaceChildren(header(null), h("p", { class: "soulsea__note" }, "Open a chapter first."));
    return;
  }
  const viewNum = Math.min(live.num, data.reviewedThrough);
  const st = stateAt(live.num > data.reviewedThrough ? { num: data.reviewedThrough } : live);
  current = st;
  const items = Object.values(st);
  const prevSt = stateAt({ num: viewNum - 1 });

  const scroller = root.querySelector(".soulsea__body");
  const keepScroll = scroller?.scrollTop || 0;
  const body = h("div", { class: "soulsea__body" });

  // What changed in this chapter.
  const changes = items.filter((x) => x.kind !== "stat" && (x.since === viewNum || x.lost === viewNum));
  if (changes.length) {
    body.append(
      h("h3", { class: "soulsea__h" }, "In this chapter"),
      h(
        "div",
        { class: "soulsea__changes" },
        changes.map((x) =>
          h(
            "button",
            { class: "soulsea__change soulsea__change--" + (x.held ? "gain" : "lose"), onclick: () => focusItem(x) },
            (x.held ? "+ " : "− ") + nameOf(x)
          )
        )
      )
    );
  }

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
    body.append(h("div", { class: "soulsea__list" }, held.map((x) => row(x, false, prevSt))));
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
    if (open) body.append(h("div", { class: "soulsea__list" }, gone.map((x) => row(x, true, prevSt))));
  }

  if (live.num > data.reviewedThrough)
    body.append(h("p", { class: "soulsea__note" }, `The Soul Sea is mapped up to chapter ${data.reviewedThrough} so far.`));

  root.replaceChildren(header(`${data.character} · Chapter ${viewNum}`), body);
  body.scrollTop = keepScroll;
}

// "In this chapter" → open that item (inside "No longer held" if it's gone) and bring it into view.
let focused = null; // the item "In this chapter" asked for, until its sheet has loaded
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
let current = {}; // id → item, in the state being drawn
const stateOf = (id) => current[id];
const toggle = (key) => ((focused = null), expanded.has(key) ? expanded.delete(key) : expanded.add(key), render());

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
  const out = h("div", { class: "soulsea__row" + (gone ? " soulsea__row--gone" : "") + (open ? " soulsea__row--open" : ""), dataset: { id: x.id } }, head);
  if (!open) return out;

  const detail = h("div", { class: "soulsea__detail" });
  if (x.sheet) detail.append(sheet(x.sheet, x));
  else if (x.facts && Object.keys(x.facts).length) detail.append(buildSheet([], x));
  else detail.append(h("p", { class: "soulsea__none" }, "No runes shown yet"));
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
    // a bracket the book opens and never closes (or the reverse)
    .replace(/^\[(?=[^\]]*$)/s, "")
    .replace(/(?<=^[^[]*)\](?=\.?$)/s, "")
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

// Lines the epub runs together in one paragraph ("Echoes: -Shadows: [Onyx Saint]…")
// are split where a new "Label:" starts outside any brackets.
const LABEL_AT = /^(?:\[[^\]]+\]\s+)?[A-Z][A-Za-z' ]{1,40}:\s/;
function splitFields(t) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < t.length; i++) {
    if (depth === 0 && i > start && /[.\]\-—?]/.test(t[i - 1]) && LABEL_AT.test(t.slice(i, i + 80))) {
      out.push(t.slice(start, i).trim());
      start = i;
    }
    if (t[i] === "[") depth++;
    else if (t[i] === "]") depth = Math.max(0, depth - 1);
  }
  out.push(t.slice(start).trim());
  return out.filter(Boolean);
}

/**
 * Paragraphs → rune lines. A continuation (`cont`) is the rest of the line before:
 * more paragraphs of a long description, or — right after a line the book cuts
 * short — the full text it prints next, which replaces the cut-off one.
 */
function runeLines(paras) {
  const lines = [];
  for (const { t, cont } of paras) {
    const prev = lines.at(-1);
    if (cont && prev != null) {
      const cut = /(…|\.\.\.)\]?\.?\s*$/.test(prev) && /^\s*\[[^:]*\]\.?\s*$/.test(t);
      lines[lines.length - 1] = cut ? prev.slice(0, prev.indexOf(":") + 1) + " " + t.trim() : `${prev}\n\n${t.trim()}`;
    } else lines.push(...splitFields(t));
  }
  return lines;
}

// Tiers are Roman numerals in the runes; the book once spells one out ("Memory Tier: Seven.").
const TIER_WORDS = { one: "I", two: "II", three: "III", four: "IV", five: "V", six: "VI", seven: "VII", eight: "VIII", nine: "IX" };
const romanTier = (v) => TIER_WORDS[v.toLowerCase()] ?? v;

function buildSheet(paras, x) {
  const lines = runeLines(paras);
  const facts = [];
  const lists = [];
  const notes = []; // named descriptions: enchantments, attributes, abilities
  let epigraph = null;
  let pending = null; // a name line ("Enchantment: [Doubtless].", "[Blade of Darkness].") titling the description after it
  const clean = (n) => n.trim().replace(/\.$/, "");
  // Repeated lines: the later one wins (sheets are in reading order).
  // …unless it's cut short ("A pitiful little creature...") and the earlier one is the full text.
  const cutOf = (nu, old) => {
    const stem = nu?.replace(/\s*(…|\.\.\.)$/, "");
    return !!old && stem !== nu && old.startsWith(stem) && old.length > stem.length;
  };
  const put = (arr, item, same) => {
    const i = arr.findIndex(same);
    if (i >= 0 && cutOf(item.text ?? item.value, arr[i].text ?? arr[i].value)) return;
    if (i >= 0) arr.splice(i, 1);
    arr.push(item);
  };
  for (const t of lines) {
    // A garbled name line the Spell couldn't finish ("[Fragment of the Shadow Realm].??: ????: ??").
    if (t.startsWith(`[${x.name}]`) && /\?\?/.test(t)) continue;
    const r = parseRune(t);
    const label = r.label.replace(KIND_WORD, "").replace(/^(…|\.\.\.)\s*/, "");
    const value = clean(unwrap(r.value));
    const prose = unwrap(r.value, true);
    const bareName = /^\s*\[[^:\]]{1,60}\]\.?\s*$/.test(t);
    if (bareName || label === "Enchantment" || label === "Ability" || label === "Attribute") {
      if (bareName ? clean(t.replace(/[[\]]/g, "")) !== x.name : value !== x.name) pending = bareName ? clean(t.replace(/[[\]]/g, "")) : value;
      continue;
    }
    // The line naming the item ("Memory: [Midnight Shard].") repeats the row's title —
    // or names what it evolved from.
    if (!r.subject && (value === x.name || /^(Memory|Shadow|Echo)$/.test(r.label))) continue;
    const own = !r.subject || r.subject === x.name;
    if (/(^|\s)Description$/.test(label) && cutOf(prose, epigraph)) continue;
    if (/(^|\s)Description$/.test(label) && label !== "Description" && !(own && !pending && (x.kind === "attribute" || x.kind === "ability"))) {
      const title = r.subject || pending;
      put(notes, { title, kind: label, text: prose }, (n) => title && n.title === title);
      pending = null;
    } else if (/(^|\s)Description$/.test(label)) epigraph = prose; // the item's own description
    // A list of names ("[Battle Master], [Stalwart]") — not a count like "[27/200]".
    else if (/^\[[^\]\d][^\]]*\](,\s*\[.+\])*$/.test(r.value.trim().replace(/\.$/, "")) && /s$/.test(label))
      put(lists, { label, names: [...r.value.matchAll(/\[([^\]]+)\]?/g)].map((m) => clean(m[1])) }, (l) => l.label === label);
    else put(facts, { label, value: label === "Tier" ? romanTier(value) : value }, (f) => f.label === label);
  }
  // What the book has said since the last rune sheet ("now a Transcendent Devil").
  for (const [label, value] of Object.entries(x.facts || {})) put(facts, { label, value }, (f) => f.label === label);
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
  const prose = (text, cls) => text.split(/\n\n+/).map((t) => h("p", { class: cls }, t));
  if (epigraph) box.append(...prose(epigraph, "soulsea__epigraph"));
  else if (paras.length) box.append(h("p", { class: "soulsea__none" }, "No description yet"));
  // Under each list ("Enchantments"), every name in the book's order, with its
  // description when the book gives one.
  const note = (n) => h("div", { class: "soulsea__note-block" }, n.title ? h("div", { class: "soulsea__note-title" }, n.title) : null, n.text ? prose(n.text, "soulsea__note-text") : h("p", { class: "soulsea__none" }, "No description yet"));
  const placed = new Set();
  for (const l of lists) {
    const entries = l.names.map((name) => {
      const n = notes.find((m) => m.title === name);
      if (n) placed.add(n);
      return n || { title: name };
    });
    // A description the book doesn't name goes at the end of its list.
    const kind = { Attributes: "Attribute Description", Abilities: "Ability Description", Enchantments: "Enchantment Description" }[l.label];
    const loose = notes.filter((n) => !n.title && n.kind === kind);
    loose.forEach((n) => placed.add(n));
    box.append(h("div", { class: "soulsea__list-row" }, h("span", { class: "soulsea__k" }, l.label), entries.map(note), loose.map(note)));
  }
  for (const n of notes) if (!placed.has(n)) box.append(note(n));
  return box;
}

// Resolved paragraphs, so a re-render (expanding another row) draws instantly.
const textCache = new Map();
function load(e) {
  const [ch] = e.at;
  const refs = (e.paras || [[e.at[1], e.fp]]).map(([p, fp, from = ch, cont]) => ({ r: [from, p, fp], cont: !!cont }));
  const key = ({ r }) => r.join(":");
  const out = (ts) => refs.map((ref, i) => ({ t: ts[i], cont: ref.cont })).filter((x) => x.t != null);
  if (refs.every((ref) => textCache.has(key(ref)))) return out(refs.map((ref) => textCache.get(key(ref))));
  return Promise.all(refs.map((ref) => paragraph(...ref.r).then((t) => (textCache.set(key(ref), t), t)))).then(out);
}

// Paragraphs come from the reader's own epubs; one that isn't found verbatim in
// this copy is left out rather than approximated.
function whenLoaded(e, draw) {
  const box = h("div", { class: "soulsea__loadbox" });
  const done = (ts) => {
    box.replaceChildren(ts.length ? draw(ts) : h("p", { class: "soulsea__empty" }, "This chapter isn’t in your library, or differs from the mapped copy."));
    if (focused && box.closest(`.soulsea__row[data-id="${focused}"]`)) scrollToFocused();
  };
  const got = load(e);
  if (Array.isArray(got)) done(got);
  else {
    box.append(h("p", { class: "soulsea__empty" }, "…"));
    got.then(done);
  }
  return box;
}

const sheet = (e, x) => whenLoaded(e, (ts) => buildSheet(ts, x));
