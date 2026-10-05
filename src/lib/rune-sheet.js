// =========================================================================
// RUNE SHEETS — reading the Soul Sea's rune paragraphs (Shadow Slave) into a
// laid-out sheet. Pure: shared by the app (src/soulsea.js) and the pipeline's
// audit (scripts/soul-sea/audit.mjs).
//
// The lines are the book's own; only the layout is ours. "Memory Rank: Awakened."
// becomes a Rank / Awakened row: the label loses the item-kind word, brackets and
// the closing full stop, and a list of names becomes a list. The item's description
// reads as an epigraph; enchantments, attributes and abilities get their name as a
// heading — the build tells each description what it describes (`s`), since the
// book often names it on the line before.

// "Memory Rank" → "Rank" — but "Shadow Dance Mastery Level" stays itself.
const KIND_WORD = /^(Memory|Echo|Shadow|Aspect|Flaw)\s+(?=(Rank|Tier|Type|Class|Description|Attributes|Abilities|Enchantments?|Ability Description|Legacy|Fragments)$)/;
// A short value loses its full stop ("Awakened."); prose keeps its own, losing
// only one that closes the brackets ("[…deserts].").
export const unwrap = (v, prose = false) =>
  v
    .trim()
    .replace(prose ? /(?<=[\]"»])\.$/ : /\.$/, "")
    .replace(/^\[([^[\]]*)\]$/, "$1")
    .replace(/^"([^"]*)"$/, "$1")
    .replace(/^«([^«»]*)»$/, "$1")
    .replace(/^\[(.*)\]$/s, "$1")
    // a bracket the book opens and never closes (or the reverse)
    .replace(/^\[(?=[^\]]*$)/s, "")
    .replace(/^«(?=[^»]*$)/s, "")
    .replace(/(?<=^[^[]*)\](?=\.?$)/s, "")
    .trim();
// The book sometimes starts a description in lower case ("a small memento…").
export const cap = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);

/** One rune line → { label, subject?, value }. */
export function parseRune(t) {
  t = t.trim().replace(/^(…|\.\.\.)\s*/, "");
  let m = t.match(/^\[([^\]]+)\]\s+(\w+ Descriptions?)\s*:\s*(.*)$/s); // [Fated] Attribute Description: "…"
  if (m) return { label: m[2].replace(/s$/, "").replace(/Enchantments/, "Enchantment"), subject: m[1], value: m[3] };
  m = t.match(/^((?:[A-Z][\w']*\s){1,4})(Attribute|Enchantment|Ability) Description\s*:\s*(.*)$/s); // Battle Master Attribute Description: […]
  if (m && !/^(Memory|Echo|Shadow|Aspect|Flaw|Aspect Ability)$/.test(m[1].trim())) return { label: `${m[2]} Description`, subject: m[1].trim(), value: m[3] };
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
export function splitFields(t) {
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
 * Paragraphs → rune lines { t, s, src }. A continuation (`cont`) is the rest of the line
 * before: more paragraphs of a long description, or — right after a line the book
 * cuts short — the full text it prints next, which replaces the cut-off one.
 * `src` says how the line was put together, so it can be rebuilt (descText) from the
 * paragraphs alone: [{ i, seg, raw? }, { i, cut? }…] — `i` indexes `paras`.
 */
// A rune paragraph can run on into Sunny's commentary after a line break
// ("…proficient in all forms of warfare."\nHe was not sure what it meant…): drop it.
const RUNE_START = /^\s*(["“«[(]|(…|\.\.\.)?\s*(\[[^\]]+\]\s*)?[A-Z][\w' ]{0,40}:)/;
const runeOnly = (t) => {
  const ls = t.split("\n");
  const end = ls.findIndex((l, i) => i > 0 && l.trim() && !RUNE_START.test(l));
  return end < 0 ? t : ls.slice(0, end).join("\n");
};
const isCut = (line, t) => /(…|\.\.\.)\]?\.?\s*$/.test(line) && /^\s*\[[^:]*\]\.?\s*$/.test(t);
function extend(line, t, cut) {
  if (!cut) return /:\s*$/.test(line) ? `${line} ${t.trim()}` : `${line}\n\n${t.trim()}`;
  // "Attribute Description..." then "[Damnation!]": the label trails off instead of a colon.
  const colon = line.indexOf(":");
  return (colon >= 0 ? line.slice(0, colon + 1) : line.replace(/\s*(…|\.\.\.)\s*$/, ":")) + " " + t.trim();
}

export function runeLines(paras) {
  const lines = [];
  paras.forEach(({ t: raw, cont, s }, i) => {
    const t = cont ? raw : runeOnly(raw);
    const prev = lines.at(-1);
    if (cont && prev) {
      const cut = isCut(prev.t, t);
      prev.t = extend(prev.t, t, cut);
      prev.src.push(cut ? { i, cut: 1 } : { i });
    } else
      splitFields(t).forEach((part, seg) =>
        lines.push({ t: part, s: /Description/.test(part) ? s : undefined, src: [cont ? { i, seg, raw: 1 } : { i, seg }] })
      );
  });
  return lines;
}

/**
 * A description's text, rebuilt from its paragraphs the way runeLines put it
 * together: `parts` is its `src` with each paragraph's text as `t`.
 */
export function descText(parts) {
  let line = null;
  for (const { t, seg, raw, cut } of parts) {
    if (line == null) line = seg != null ? splitFields(raw ? t : runeOnly(t))[seg] ?? "" : t.trim();
    else line = extend(line, t, !!cut);
  }
  return line == null ? "" : unwrap(parseRune(line).value, true);
}

// Tiers are Roman numerals in the runes; the book once spells one out ("Memory Tier: Seven.").
const TIER_WORDS = { one: "I", two: "II", three: "III", four: "IV", five: "V", six: "VI", seven: "VII", eight: "VIII", nine: "IX" };
const romanTier = (v) => TIER_WORDS[v.toLowerCase()] ?? v;

// The kind of description each list holds.
const LIST_KIND = { Enchantments: "Enchantment Description", Attributes: "Attribute Description", Abilities: "Ability Description" };
const KIND_LIST = Object.fromEntries(Object.entries(LIST_KIND).map(([l, k]) => [k, l]));
// Names compared loosely: case, spacing, punctuation.
const loose = (n) => n.toLowerCase().replace(/[^a-z0-9?]/g, "");
function editDistance(a, b) {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return d[b.length];
}
/** The same name, give or take the book's typos ("Locomotive Chifonnier", "[Stalwar]"). */
export function sameName(a, b) {
  const [x, y] = [loose(a), loose(b)];
  if (x === y) return true;
  if (Math.min(x.length, y.length) < 7) return false;
  return editDistance(x, y) <= Math.max(1, Math.floor(Math.min(x.length, y.length) / 8));
}
// A "subject" that is really a Spell message or a sentence, not a name.
const NOT_A_NAME = /^(You |Your |The Spell)|[.!?]\s*\S/;

/**
 * A rune sheet — the paragraphs { t, cont?, s? } of an item's runes — read as
 * { facts, lists, notes, epigraph }:
 *   facts    [{ label, value }]                       "Rank" / "Ascended"
 *   epigraph { text, src } | null                     the item's own description
 *   lists    [{ label, names: [{ name, text?, src?, typo? }] }]
 *            every listed Enchantment / Attribute / Ability with its description
 *   notes    [{ title, kind, text, src }]             descriptions no list holds
 * `x` is the item: { name, kind, facts? }. `prefer(a, b)` picks between two spellings
 * of one name (a list's and a description's); by default the description's.
 */
export function readSheet(paras, x, { prefer = (listed, described) => described } = {}) {
  const lines = runeLines(paras);
  const facts = [];
  const lists = [];
  const notes = []; // named descriptions: enchantments, attributes, abilities
  let epigraph = null;
  let pending = null; // a name line ("Enchantment: [Doubtless].", "[Blade of Darkness].") titling the description after it
  const clean = (n) => n.trim().replace(/^(…|\.\.\.)\s*/, "").replace(/(\.+|…)$/, "").trim();
  // Repeated lines: the later one wins (sheets are in reading order)…
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
  for (const { t, s, src } of lines) {
    // A garbled name line the Spell couldn't finish ("[Fragment of the Shadow Realm].??: ????: ??").
    if (t.startsWith(`[${x.name}]`) && /\?\?/.test(t)) continue;
    const r = parseRune(t);
    const label = r.label.replace(KIND_WORD, "");
    const value = clean(unwrap(r.value));
    const prose = unwrap(r.value, true);
    // "[Blade of Darkness]." names what follows; "[Shadows recognize you as their ruler.]" is a description.
    const bareName = /^\s*\[[^:\]]{1,60}\]\.?\s*$/.test(t) && !/^\s*\[[^\]]*\S\s+\S+\s+[^\]]*[.!?]\]\.?\s*$/.test(t);
    if (bareName || label === "Enchantment" || label === "Ability" || label === "Attribute") {
      const name = bareName ? clean(t.replace(/[[\]]/g, "")) : value;
      if (name !== x.name && !NOT_A_NAME.test(name)) pending = name;
      continue;
    }
    // The line naming the item ("Memory: [Midnight Shard].") repeats the row's title —
    // or names what it evolved from.
    if (!r.subject && (value === x.name || /^(Memory|Shadow|Echo|Aspect Legacy)$/.test(r.label))) continue;
    if (/Description$/.test(label)) {
      // "Shadow Dance Description", "[Fated] Attribute Description", or a description with no other subject: the item's own.
      const typed = /^(Attribute|Ability|Enchantment) Description$/.test(label);
      let title = r.subject || s || (label !== "Description" && !typed ? label.replace(/ Description$/, "") : null) || pending;
      title = title && clean(title);
      if (title && NOT_A_NAME.test(title)) title = null; // "[You have acquired a new Attribute.]"
      pending = null;
      // An Attribute's or Ability's own description — but the Shadow Nightmare's
      // "[Nightmare] Ability Description" is its ability's.
      const ownKind = !typed || label.startsWith({ attribute: "Attribute", ability: "Ability" }[x.kind] ?? "-");
      const own = (title === x.name && ownKind) || (!title && (label === "Description" || x.kind === "attribute" || x.kind === "ability"));
      if (own) {
        if (!cutOf(prose, epigraph?.text)) epigraph = { text: prose, src };
      } else put(notes, { title, kind: label, text: prose, src }, (n) => title && n.title === title);
    }
    // A list of names ("[Battle Master], [Stalwart]") — not a count like "[27/200]". The
    // book sometimes trails off ("[Royal Promise]...") or garbles a bracket ("(Blessing of Soul],").
    else if (/s$/.test(label) && !/ss$/.test(label) && /^[[(][^\]\d]/.test(r.value.trim()) && /\]/.test(r.value) && !/\]\s*[^,.\s…\]]/.test(r.value.replace(/\]\s*,\s*[[(]/g, "")))
      put(lists, { label, names: [...r.value.matchAll(/[[(]([^[\]()]+)\]/g)].map((m) => clean(m[1])).filter(Boolean) }, (l) => l.label === label);
    else put(facts, { label, value: label === "Tier" ? romanTier(value) : value }, (f) => f.label === label);
  }
  // A list naming the item itself is Sunny's own ("Attributes: [Fated], [Ember of Divinity]"
  // on the Ember's sheet), not what the item holds.
  const own = { attribute: "Attributes", ability: "Abilities" }[x.kind];
  for (const l of [...lists]) if (l.label === own && l.names.some((n) => loose(n) === loose(x.name ?? ""))) lists.splice(lists.indexOf(l), 1);
  // What the book has said since the last rune sheet ("now a Transcendent Devil").
  for (const [label, value] of Object.entries(x.facts || {})) put(facts, { label, value }, (f) => f.label === label);
  // A list's "???" the book later reveals ("[Where is my eye?]"): the described name not in the list.
  for (const l of lists) {
    const unknown = l.names.indexOf("???");
    const revealed = notes.filter((n) => n.kind === LIST_KIND[l.label] && n.title && !l.names.some((m) => sameName(m, n.title)));
    if (unknown >= 0 && revealed.length === 1) l.names[unknown] = revealed[0].title;
  }
  // Descriptions the book lists without naming: in the order of the list.
  for (const l of lists) {
    const unnamed = notes.filter((n) => n.kind === LIST_KIND[l.label] && !n.title);
    const open = l.names.filter((name) => !notes.some((n) => n.title && sameName(n.title, name)));
    if (unnamed.length && unnamed.length === open.length) unnamed.forEach((n, i) => (n.title = open[i]));
  }
  // Each listed name with its description, typos and all. A description the list
  // doesn't name (a list the book cut short or garbled) joins the list of its kind.
  const placed = new Set();
  const out = lists.map((l) => ({
    label: l.label,
    names: l.names.map((name) => {
      const n = notes.find((m) => !placed.has(m) && m.title && loose(m.title) === loose(name)) ?? notes.find((m) => !placed.has(m) && m.title && sameName(m.title, name));
      if (!n) return { name };
      placed.add(n);
      const typo = loose(n.title) !== loose(name);
      return { name: typo ? prefer(name, n.title) : name, text: n.text, src: n.src, ...(typo ? { typo: [name, n.title] } : {}) };
    }),
  }));
  for (const n of notes.filter((n) => !placed.has(n) && n.title && KIND_LIST[n.kind])) {
    let l = out.find((l) => l.label === KIND_LIST[n.kind]);
    if (!l) out.push((l = { label: KIND_LIST[n.kind], names: [] }));
    l.names.push({ name: n.title, text: n.text, src: n.src, unlisted: true });
    placed.add(n);
  }
  return { facts, lists: out, notes: notes.filter((n) => !placed.has(n)), epigraph };
}
