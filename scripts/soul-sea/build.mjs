// Step 2 — resolve timeline.json against the book text → soul-sea/resolved.json.
//
// Guarantees the "only the book's words" rule: every string the inventory shows
// (a name, a label, a stat value) must be found verbatim in the paragraph its
// event points at, and rune sheets are whole paragraphs of the book. Anything
// that doesn't check out is reported and fails the build.
//
// Also replays the timeline against every rune list Sunny reads in the book
// (Memories / Echoes / Shadows / Attributes) and reports where they disagree —
// those lists are the checkpoints that catch a missed gain or loss.
//
// The timeline is timeline.json (chapters 1–204, plus the shared settings) and the
// parts in parts/*.json, each { range: [from, to], seed, entries, events, … }.
// `--part parts/X.json` checks one part on its own: its events only, replayed from
// its `seed` (what Sunny holds when the part starts), its own checkpoints, and no
// output written. Without it, everything is merged and each seed is compared with
// what the earlier parts actually lead to.
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { APP_DATA, TIMELINE, WORK, fieldsOf, isMessage, listOf, textKey } from './lib.mjs'

const tl = JSON.parse(await readFile(TIMELINE, 'utf8'))
const text = JSON.parse(await readFile(path.join(WORK, 'text.json'), 'utf8'))
const runes = JSON.parse(await readFile(path.join(WORK, 'runes.json'), 'utf8'))

const PARTS = path.join(import.meta.dirname, 'parts')
const only = process.argv.includes('--part') ? path.resolve(process.argv[process.argv.indexOf('--part') + 1]) : null
const parts = []
for (const f of (await readdir(PARTS).catch(() => [])).filter((f) => f.endsWith('.json')).sort()) {
  const file = path.join(PARTS, f)
  try {
    parts.push({ file, ...JSON.parse(await readFile(file, 'utf8')) })
  } catch (err) {
    if (file === only) throw err
    console.warn(`(skipping ${f}: ${err.message})`)
  }
}
const part = only && parts.find((p) => p.file === only)
if (only && !part) throw new Error(`no part ${only}`)
for (const p of parts) {
  for (const [id, e] of Object.entries(p.entries ?? {})) {
    if (tl.entries[id] && tl.entries[id].kind !== e.kind) console.warn(`entry "${id}" is a ${tl.entries[id].kind} and a ${e.kind}`)
    tl.entries[id] ??= e
  }
  for (const s of p.seed ?? []) tl.entries[s.id] ??= { kind: s.kind }
  tl.notSunny = [...(tl.notSunny ?? []), ...(p.notSunny ?? [])]
  tl.checkpointNotes = { ...tl.checkpointNotes, ...p.checkpointNotes }
}
const RANGE = part ? part.range : [1, Math.max(tl.reviewedThrough, ...parts.map((p) => p.range[1]))]
tl.reviewedThrough = RANGE[1]
tl.events = part ? part.events : [...tl.events, ...parts.flatMap((p) => p.events)]

const errors = []
const pos = (at) => at.split(':').map(Number)
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1]
const para = ([c, p]) => text[c]?.[p]
const norm = (s) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ')
const has = (hay, needle) => norm(hay).includes(norm(needle))

// A paragraph that belongs on a rune sheet (as opposed to Sunny's commentary between
// runes): a known field, a Spell message, or any "Label: value" line ("Death Charge:
// [0/1000].", "[Unbending] Enchantment Description: …").
// A bare "Label:" (its text in the paragraphs below) only for a description.
const isRuneLine = (t) =>
  !!fieldsOf(t) ||
  isMessage(t) ||
  /^\s*(…\s*|\.\.\.\s*)?(\[[^\]]+\]\s*)?[A-Z][\w' ]{0,40}:\s*[[\-—"“«0-9?]/.test(t) ||
  /^\s*(\[[^\]]+\]\s*)?[A-Z][\w' ]{0,40}Description:\s*$/.test(t) ||
  /Description:\s*\[/.test(t) // a garbled sheet ("[Fragment of the Shadow Realm].??: ????: ??Description: […]")
// Brackets a line leaves open: a description that carries on over the next paragraphs.
const openBrackets = (t) => (t.match(/\[/g) || []).length - (t.match(/\]/g) || []).length
const cutShort = (t) => /(…|\.\.\.)\]?\.?\s*$/.test(t)
const bare = (t) => /^\s*\[[^:]*\]\.?\s*$/.test(t)
// A line that only names what the next description is about: "Attribute: Soul Companion.",
// "Enchantment: [Simple Trick].", "[Soul Arrow]."
const NAME_LINE = /^\s*(?:(?:Memory |Aspect |Shadow )?(?:Enchantment|Attribute|Ability)\s*:\s*\[?([^\]:]{1,60}?)\]?|\[([^\]:]{1,60})\])\.?\s*$/
/** What a description line describes, from the line itself or the name line before it in the book. */
function subjectOf(chap, p) {
  const t = chap[p]
  let m = t.match(/^\s*(?:…|\.\.\.)?\s*\[([^\]]+)\]\s+[\w ]*?Descriptions?\s*:/)
  if (m) return m[1].trim()
  m = t.match(/^\s*((?:[A-Z][\w']*\s){1,4})(?:Attribute|Enchantment|Ability)s? Descriptions?\s*:/)
  if (m && !/^(Memory|Echo|Shadow|Aspect|Flaw|Aspect Ability)$/.test(m[1].trim())) return m[1].trim()
  m = t.match(/(?:Enchantment|Attribute|Ability)\s*:\s*\[([^\]]+)\]\.?\s*(?:Attribute|Enchantment|Ability) Descriptions?\s*:/)
  if (m) return m[1].trim()
  if (!/^\s*(?:…\s*)?(?:Attribute|Enchantments?|Ability) Descriptions?\s*:/.test(t)) return null
  for (let q = p - 1; q >= Math.max(0, p - 8); q--) {
    const u = chap[q].trim()
    if (/Descriptions?\s*:/.test(u)) return null
    const n = u.match(NAME_LINE)
    if (n) return (n[1] ?? n[2]).trim()
    const one = u.match(/^(?:Memory |Shadow |Echo )?(?:Enchantments|Attributes|Abilities)\s*:\s*\[([^\]]+)\]\.?\s*$/)
    if (one) return one[1].trim()
    // Narration naming exactly one thing: "The [Soul Beast] wasn't there before..."
    const named = [...u.matchAll(/\[([^\]:]{1,60})\]/g)]
    if (named.length === 1 && !/:/.test(u)) return named[0][1].trim()
  }
  return null
}

const ref = ([c, p]) => ({ ch: c, p, fp: textKey(text[c][p]) })

// ---- resolve + validate events -------------------------------------------------
const events = []
for (const e of tl.events) {
  const at = pos(e.at)
  const t = para(at)
  const id = e.gain ?? e.lose ?? e.runes ?? e.history ?? e.become ?? e.name ?? e.set ?? e.source ?? e.fact
  if (e.fact && !['Rank', 'Class', 'Tier', 'Type'].includes(e.label)) errors.push(`${e.at}: a fact is a Rank, Class, Tier or Type`)
  if (t == null) { errors.push(`${e.at}: no such paragraph`); continue }
  if (!tl.entries[id]) errors.push(`${e.at}: unknown entry "${id}"`)
  if (e.to && !tl.entries[e.to] && !/^\d+:\d+$/.test(e.to)) errors.push(`${e.at}: unknown entry "${e.to}"`)
  for (const k of (e.fact ? ['value'] : ['label', 'value']).concat(e.gain || e.become ? ['name'] : []))
    if (typeof e[k] === 'string' && !has(t, e[k])) errors.push(`${e.at}: "${e[k]}" is not in the paragraph`)
  const out = { ...e, at, ref: ref(at) }
  if (e.runes || e.history) {
    const end = e.to ? pos(e.to) : at
    if (end[0] !== at[0] || end[1] < at[1]) errors.push(`${e.at}: bad range to ${e.to}`)
    const ps = []
    const chap = text[at[0]]
    // A description left open ("[Weaver was known…" or "Memory Description:") carries
    // on over the following paragraphs until its bracket closes — if it closes before
    // the next rune line; otherwise it's taken as it stands (the book dropped a bracket).
    const closing = (from, depth) => {
      for (let q = from; q <= Math.min(end[1], from + 30); q++) {
        if (isRuneLine(chap[q]) && !/^\s*\[/.test(chap[q])) return -1
        depth += openBrackets(chap[q])
        if (depth <= 0) return q
      }
      return -1
    }
    let prevCut = false
    for (let p = at[1]; p <= end[1]; p++) {
      const t = chap[p]
      if (e.history) { ps.push(ref([at[0], p])); continue }
      // The corrected line the book prints right after a cut-off one replaces it.
      if (prevCut && bare(t)) { ps.push({ ...ref([at[0], p]), cont: true }); prevCut = false; continue }
      if (!isRuneLine(t)) continue
      // `about` names a description's subject by hand when only the narration says it.
      const subject = e.about?.[`${at[0]}:${p}`] ?? subjectOf(chap, p)
      if (e.about?.[`${at[0]}:${p}`] && !e.paras?.length && !chap.slice(Math.max(0, p - 8), p + 1).some((u) => u.includes(subject)))
        errors.push(`${at[0]}:${p}: "${subject}" isn't named near that description`)
      ps.push(subject ? { ...ref([at[0], p]), s: subject } : ref([at[0], p]))
      prevCut = cutShort(t)
      const depth = /Description:\s*$/.test(t) ? 0 : openBrackets(t)
      if (depth > 0 || /Description:\s*$/.test(t)) {
        const q = /Description:\s*$/.test(t) ? (/^\s*["“«\[]/.test(chap[p + 1] ?? '') ? closing(p + 1, 0) : -1) : closing(p + 1, depth)
        if (q > 0) {
          for (let c = p + 1; c <= q; c++) ps.push({ ...ref([at[0], c]), cont: true })
          p = q
          prevCut = false
        }
      }
    }
    if (!ps.length) errors.push(`${e.at}: no rune lines in range`)
    out.paras = ps
  }
  events.push(out)
}

// ---- full rune sheets ------------------------------------------------------------
// Each sheet builds on the earlier ones: a line the book repeats is replaced by
// its newest version, a line it leaves out this time is kept, and a line it cuts
// short ("Memory Description: [A worm of doubt…]") keeps the earlier full one. So
// the latest sheet is always the fullest the book has shown — still only whole
// paragraphs of the book.
{
  const label = (t) => t.match(/^\s*([^:]{1,60}):/)?.[1]?.trim().replace(/^(…|\.\.\.)\s*/, '')
  // Every "Label:" in a paragraph (some paragraphs run several rune lines together).
  const labelsOf = (t) => [...t.matchAll(/(?:^|(?<=[.\]\-—]))\s*(?:…|\.\.\.)?\s*((?:\[[^\]]+\]\s+)?[A-Z][\w' ]{1,40}):\s/g)].map((m) => m[1].toLowerCase().replace(/^\[|\]$/g, ''))
  const value = (t) => norm(t.slice(t.indexOf(':') + 1)).replace(/^[\s[]+|[\s.\]]+$/g, '')
  // A paragraph's "Label: value" lines.
  const segments = (t) => {
    const ms = [...t.matchAll(/(?:^|(?<=[.\]\-—?]))\s*(?:…|\.\.\.)?\s*((?:\[[^\]]+\]\s+)?[A-Z][\w' ]{1,40}):\s/g)]
    if (!ms.length) return [{ key: (label(t) ?? t).toLowerCase(), val: t }]
    return ms.map((m, i) => ({ key: m[1].toLowerCase().replace(/^\[|\]$/g, ''), val: t.slice(m.index + m[0].length, ms[i + 1]?.index ?? t.length) }))
  }
  const bareVal = (v) => norm(v).replace(/^[\s["]+|[\s.\]"…]+$/g, '').trim()
  // Does the sheet already hold this line in full?
  const fullerIn = (cur, sg) =>
    cur.some((x) =>
      x.unit.some((r) =>
        segments(text[r.ch][r.p]).some((o) => o.key === sg.key && bareVal(o.val).startsWith(bareVal(sg.val)) && bareVal(o.val).length > bareVal(sg.val).length + 3)
      )
    )
  const sheets = {}
  const carried = []
  for (const e of events.filter((e) => e.runes || e.become).sort((a, b) => cmp(a.at, b.at))) {
    // An evolution keeps what the book said about the item: an Echo turned Shadow its
    // Attribute descriptions; a Shadow or Memory evolving its description, Attributes,
    // Abilities and Enchantments — but not its Rank / Class / Tier / fragments, which
    // the evolution changes (until the book shows them again). The item-name line goes.
    if (e.become) {
      const from = tl.entries[e.become]?.kind
      const to = tl.entries[e.to]?.kind
      const keep = from === 'echo' && to === 'shadow' ? (x) => /attribute description/.test(x.key)
        : from === to && (to === 'shadow' || to === 'memory') ? (x) => ![...x.keys].some((k) => /^(memory|shadow|echo)$|rank$|class$|tier$|fragments$/.test(k))
        : () => false
      sheets[e.to] = (sheets[e.become] ?? []).filter(keep)
      // So the evolved item shows it even if the book never prints its runes again.
      if (sheets[e.to].length) carried.push({ runes: e.to, at: e.at, ref: e.ref, paras: sheets[e.to].flatMap((x) => x.unit), carried: true })
      continue
    }
    const cur = [...(sheets[e.runes] ?? [])]
    const seen = {}
    let last = -1
    // A line and its continuation paragraphs move together.
    const units = []
    for (const r of e.paras) if (r.cont && units.length) units.at(-1).push(r)
    else units.push([r])
    for (const unit of units) {
      const r = unit[0]
      const t = text[r.ch][r.p]
      // A bare name line has done its job once the description after it knows its subject.
      if (NAME_LINE.test(t)) continue
      let key = (label(t) ?? t).toLowerCase().replace(/^\[|\]$/g, '')
      // Descriptions are keyed by what they describe, however the book phrased the line.
      if (r.s) key = (/attribute/.test(key) ? 'attribute' : /ability/.test(key) ? 'ability' : /enchant/.test(key) ? 'enchantment' : key) + '|' + r.s.toLowerCase()
      seen[key] = (seen[key] ?? 0) + 1
      if (seen[key] > 1) key += '#' + seen[key]
      // Several "Label:" lines in one paragraph → keyed by all of them; otherwise by its own key.
      const labels = labelsOf(t)
      const keys = r.s || labels.length < 2 ? new Set([key]) : new Set([key, ...labels])
      // Lines this paragraph cuts short ("[A pitiful little creature...]") where an
      // earlier sheet has them in full: those earlier lines stay.
      const cutKeys = new Set(segments(t).filter((sg) => cutShort(sg.val) && fullerIn(cur, sg)).map((sg) => sg.key))
      if (keys.size === 1 && cutKeys.size) continue
      if (keys.size > 1) {
        // A paragraph holding several lines replaces what it fully covers; anything it
        // only partly overlaps stays, and the newer paragraph goes after it.
        const covered = cur.filter((x) => [...x.keys].every((k) => keys.has(k)) && ![...x.keys].some((k) => cutKeys.has(k)))
        const overlaps = cutKeys.size > 0 || cur.some((x) => !covered.includes(x) && [...x.keys].some((k) => keys.has(k)))
        const at = covered.length ? cur.indexOf(covered[0]) : -1
        for (const x of covered) cur.splice(cur.indexOf(x), 1)
        const pos = overlaps ? cur.length : at >= 0 ? at : last + 1
        cur.splice(pos, 0, { key, keys, unit })
        last = pos
        continue
      }
      const i = cur.findIndex((x) => x.key === key && x.keys.size === 1)
      if (i < 0) {
        const overlaps = cur.some((x) => x.keys.has(key))
        const pos = overlaps ? cur.length : last + 1
        cur.splice(pos, 0, { key, keys, unit })
        last = pos
        continue
      }
      const old = text[cur[i].unit[0].ch][cur[i].unit[0].p]
      const cut = value(t).replace(/(…|\.\.\.)$/, '').trim()
      const keepOld = unit.length === 1 && cutShort(t) && value(old).startsWith(cut) && value(old).length > cut.length + 3
      cur[i] = { key, keys, unit: keepOld ? cur[i].unit : unit }
      last = i
    }
    sheets[e.runes] = cur
    e.paras = cur.flatMap((x) => x.unit)
  }
  events.push(...carried)
}

// ---- Sunny's Shadow Fragments, derived from the runes ---------------------------
// A "Shadow Fragments: [x/y]" line is Sunny's when it sits in his own sheet, or
// stands alone with the same denominator as his last sheet (his Shadow has its own).
{
  let denom = null
  const sheets = runes.blocks.filter((b) => b.ch <= RANGE[1] && b.ch >= RANGE[0])
  for (const b of sheets) {
    const own = b.kind === 'status' && b.fields.some((f) => f.label === 'Name' && /^Sun(ny|less)\b/.test(f.value))
    for (const f of b.fields.filter((f) => f.label === 'Shadow Fragments')) {
      const d = f.value.match(/\/\s*(\d+)/)?.[1]
      if (own) denom = d
      else if (b.kind !== 'status' || !denom || d !== denom) continue
      events.push({ set: 'fragments', value: f.value.replace(/^\[|[\].\s]+$/g, ''), at: [b.ch, f.p], ref: ref([b.ch, f.p]), auto: true })
    }
  }
  for (const m of runes.messages.filter((m) => m.ch <= RANGE[1] && m.ch >= RANGE[0])) {
    const v = m.text.match(/^\[Shadow Fragments: \[?(\d+\/(\d+))\]?\.?\]\.?$/)
    if (v && v[2] === (denom ?? v[2])) events.push({ set: 'fragments', value: v[1], at: [m.ch, m.p], ref: ref([m.ch, m.p]), auto: true })
  }
  tl.entries.fragments = { kind: 'stat', label: 'Shadow Fragments' }
}

for (const e of events.filter((e) => e.auto))
  if (!has(para(e.at), e.value)) errors.push(`${e.at.join(':')}: derived "${e.value}" is not in the paragraph`)
// A part checked on its own starts from its seed.
if (part)
  for (const s of part.seed ?? [])
    events.push({ gain: s.id, name: s.name, label: s.label, at: [RANGE[0], -1], ref: { ch: RANGE[0], p: -1 }, seed: true })
events.sort((a, b) => cmp(a.at, b.at))

// ---- replay ----------------------------------------------------------------------
/** Inventory state just after position `upto` ([ch, p]). */
export function stateAt(upto) {
  const s = {}
  const get = (id) => (s[id] ??= { id, kind: tl.entries[id]?.kind, runes: [], history: [] })
  for (const e of events) {
    if (cmp(e.at, upto) > 0) break
    if (e.gain) Object.assign(get(e.gain), { held: true, name: e.name, label: e.label, since: e.ref })
    if (e.lose) Object.assign(get(e.lose), { held: false, lost: e.ref, how: e.how })
    if (e.become) {
      Object.assign(get(e.become), { held: false, lost: e.ref, how: 'became', into: e.to })
      Object.assign(get(e.to), { held: true, name: e.name, since: e.ref, from: e.become })
    }
    if (e.name && !e.gain && !e.become) get(e.name).name = e.value
    if (e.set) Object.assign(get(e.set), { held: true, value: e.value, since: e.ref })
    if (e.runes) get(e.runes).runes.unshift(e.paras)
    if (e.history) get(e.history).history.push({ paras: e.paras, flashback: !!e.flashback })
  }
  return s
}

// Losing (or evolving) something must follow holding it; gaining twice is suspicious.
{
  const held = new Set()
  const where = (e) => `${e.ref.ch}:${e.ref.p}`
  for (const e of events) {
    if (e.gain && held.has(e.gain)) errors.push(`${where(e)}: gains "${e.gain}" again while holding it`)
    if (e.gain) held.add(e.gain)
    for (const id of [e.lose, e.become].filter(Boolean)) {
      if (!held.has(id)) errors.push(`${where(e)}: ${e.lose ? 'loses' : 'evolves'} "${id}", which isn't held`)
      held.delete(id)
    }
    if (e.become) held.add(e.to)
  }
}

// ---- checkpoints: the rune lists Sunny reads ---------------------------------------
const LISTS = { Memories: 'memory', Echoes: 'echo', Shadows: 'shadow', Attributes: 'attribute' }
const key = (n) => norm(n).toLowerCase().replace(/[^a-z…]/g, '')
// The book sometimes garbles a name with gaps ("M… …old" for "M… Un…old"): a gap matches anything.
const same = (a, b) => {
  const [x, y] = [key(a), key(b)]
  if (x === y) return true
  const re = (k) => new RegExp('^' + k.split('…').map((s) => s.replace(/[^a-z]/g, '')).join('.*') + '$')
  return (x.includes('…') && re(x).test(y)) || (y.includes('…') && re(y).test(x))
}
const checkpoints = []
for (const b of runes.blocks) {
  if (b.ch > RANGE[1] || b.ch < RANGE[0] || b.kind !== 'status') continue
  const who = b.fields.find((f) => f.label === 'Name')?.value
  if (who && !/^Sun(ny|less)\b/.test(who)) continue
  if ((tl.notSunny ?? []).includes(`${b.ch}:${b.paras[0]}`)) continue
  for (const f of b.fields.filter((f) => LISTS[f.label])) {
    const { names, truncated } = listOf(f.value)
    const st = stateAt([b.ch, f.p])
    const held = Object.values(st).filter((x) => x.held && x.kind === LISTS[f.label]).map((x) => x.name ?? x.label ?? x.id)
    const missing = names.filter((n) => !held.some((h) => same(h, n)))
    const note = tl.checkpointNotes?.[`${b.ch}:${f.p}`]
    const extra = truncated ? [] : held.filter((h) => !names.some((n) => same(h, n)) && !note?.extra?.includes(h))
    checkpoints.push({ at: `${b.ch}:${f.p}`, list: f.label, names, truncated, missing, extra, note: note?.why })
  }
}

// Does each part's seed match what the parts before it lead to?
const seedNotes = []
if (!part)
  for (const p of parts.filter((p) => p.seed)) {
    const st = Object.values(stateAt([p.range[0], -1]))
    for (const kind of ['memory', 'echo', 'shadow', 'attribute']) {
      const held = st.filter((x) => x.held && x.kind === kind).map((x) => x.id)
      const seed = p.seed.filter((s) => s.kind === kind).map((s) => s.id)
      const miss = seed.filter((id) => !held.includes(id))
      const extra = held.filter((id) => !seed.includes(id))
      if (miss.length || extra.length)
        seedNotes.push(`${path.basename(p.file)} ${kind}: ${miss.length ? 'seed has ' + miss.join(', ') + ' (not held)' : ''}${miss.length && extra.length ? '; ' : ''}${extra.length ? 'held but not in seed: ' + extra.join(', ') : ''}`)
    }
  }

if (!part) await writeFile(path.join(WORK, 'resolved.json'), JSON.stringify({ ...tl, events, checkpoints }, null, 1))

for (const c of checkpoints) {
  const ok = !c.missing.length && !c.extra.length
  console.log(`${ok ? '✓' : '✗'} ${c.at.padEnd(7)} ${c.list.padEnd(10)} ${c.names.length} listed${c.truncated ? ' (cut off)' : ''}` +
    (c.missing.length ? `\n     in the book, not in the timeline: ${c.missing.join(', ')}` : '') +
    (c.extra.length ? `\n     in the timeline, not in the book: ${c.extra.join(', ')}` : '') +
    (c.note ? `\n     note: ${c.note}` : ''))
}
if (seedNotes.length) console.log('\nSeeds that disagree with the parts before them:\n  ' + seedNotes.join('\n  '))
if (errors.length) {
  console.error(`\n${errors.length} error(s):\n  ` + errors.join('\n  '))
  process.exit(1)
}
console.log(`\n${events.length} events, all anchors and strings verified against the text.`)
if (part) process.exit(0)

// ---- the app's copy: references only, no book text -------------------------------
// The reader resolves every [chapter, paragraph, fingerprint] against the user's own
// epub and shows a paragraph only when its fingerprint matches.
const TYPES = ['gain', 'lose', 'become', 'name', 'set', 'runes', 'history', 'source', 'fact']
const app = {
  format: 'ream-soul-sea',
  series: tl.series,
  character: tl.character,
  reviewedThrough: tl.reviewedThrough,
  entries: tl.entries,
  events: events.map((e) => {
    const type = TYPES.find((t) => e[t] != null)
    const o = { type, id: e[type], at: e.at, fp: e.ref.fp }
    for (const k of ['label', 'value', 'how', 'item']) if (e[k] != null) o[k] = e[k]
    if ((type === 'gain' || type === 'become') && e.name) o.name = e.name
    if (type === 'become') o.to = e.to
    // { p, fp, ch (when not the event's chapter), c: 1 (continues the line before), s: what a description describes }
    if (e.paras)
      o.paras = e.paras.map((r) => {
        const x = { p: r.p, fp: r.fp }
        if (r.ch !== e.at[0]) x.ch = r.ch
        if (r.cont) x.c = 1
        if (r.s) x.s = r.s
        return x
      })
    if (e.flashback) o.flashback = true
    if (e.auto) o.auto = true
    return o
  }),
}
await writeFile(APP_DATA, JSON.stringify(app) + '\n')
console.log(`App data → ${path.relative(process.cwd(), APP_DATA)}`)
