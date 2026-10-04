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
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { TIMELINE, WORK, fieldsOf, isMessage, listOf, textKey } from './lib.mjs'

const tl = JSON.parse(await readFile(TIMELINE, 'utf8'))
const text = JSON.parse(await readFile(path.join(WORK, 'text.json'), 'utf8'))
const runes = JSON.parse(await readFile(path.join(WORK, 'runes.json'), 'utf8'))

const errors = []
const pos = (at) => at.split(':').map(Number)
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1]
const para = ([c, p]) => text[c]?.[p]
const norm = (s) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ')
const has = (hay, needle) => norm(hay).includes(norm(needle))

// A paragraph that belongs on a rune sheet (as opposed to Sunny's commentary between runes).
const isRuneLine = (t) =>
  !!fieldsOf(t) || isMessage(t) || /^\s*(\[[^\]]+\]\s*)?[A-Z][\w' ]{0,40}(Description|Attributes?|Enchantments?|Abilities|Ability|Rank|Tier|Type|Class|Fragments):/.test(t)

const ref = ([c, p]) => ({ ch: c, p, fp: textKey(text[c][p]) })

// ---- resolve + validate events -------------------------------------------------
const events = []
for (const e of tl.events) {
  const at = pos(e.at)
  const t = para(at)
  const id = e.gain ?? e.lose ?? e.runes ?? e.history ?? e.become ?? e.name ?? e.set
  if (t == null) { errors.push(`${e.at}: no such paragraph`); continue }
  if (!tl.entries[id]) errors.push(`${e.at}: unknown entry "${id}"`)
  if (e.to && !tl.entries[e.to] && !/^\d+:\d+$/.test(e.to)) errors.push(`${e.at}: unknown entry "${e.to}"`)
  for (const k of ['label', 'value'].concat(e.gain || e.become ? ['name'] : []))
    if (typeof e[k] === 'string' && !has(t, e[k])) errors.push(`${e.at}: "${e[k]}" is not in the paragraph`)
  const out = { ...e, at, ref: ref(at) }
  if (e.runes || e.history) {
    const end = e.to ? pos(e.to) : at
    if (end[0] !== at[0] || end[1] < at[1]) errors.push(`${e.at}: bad range to ${e.to}`)
    const ps = []
    for (let p = at[1]; p <= end[1]; p++) if (e.history || isRuneLine(text[at[0]][p])) ps.push(ref([at[0], p]))
    if (!ps.length) errors.push(`${e.at}: no rune lines in range`)
    out.paras = ps
  }
  events.push(out)
}

// ---- Sunny's Shadow Fragments, derived from the runes ---------------------------
// A "Shadow Fragments: [x/y]" line is Sunny's when it sits in his own sheet, or
// stands alone with the same denominator as his last sheet (his Shadow has its own).
{
  let denom = null
  const sheets = runes.blocks.filter((b) => b.ch <= tl.reviewedThrough)
  for (const b of sheets) {
    const own = b.kind === 'status' && b.fields.some((f) => f.label === 'Name' && /^Sun(ny|less)\b/.test(f.value))
    for (const f of b.fields.filter((f) => f.label === 'Shadow Fragments')) {
      const d = f.value.match(/\/\s*(\d+)/)?.[1]
      if (own) denom = d
      else if (b.kind !== 'status' || !denom || d !== denom) continue
      events.push({ set: 'fragments', value: f.value.replace(/[.\s]+$/, ''), at: [b.ch, f.p], ref: ref([b.ch, f.p]), auto: true })
    }
  }
  for (const m of runes.messages.filter((m) => m.ch <= tl.reviewedThrough)) {
    const v = m.text.match(/^\[Shadow Fragments: \[?(\d+\/(\d+))\]?\.?\]$/)
    if (v && v[2] === (denom ?? v[2])) events.push({ set: 'fragments', value: `[${v[1]}]`, at: [m.ch, m.p], ref: ref([m.ch, m.p]), auto: true })
  }
  tl.entries.fragments = { kind: 'stat', label: 'Shadow Fragments' }
}

events.sort((a, b) => cmp(a.at, b.at))

// ---- replay ----------------------------------------------------------------------
/** Inventory state just after position `upto` ([ch, p]). */
export function stateAt(upto) {
  const s = {}
  const get = (id) => (s[id] ??= { id, kind: tl.entries[id].kind, runes: [], history: [] })
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

// ---- checkpoints: the rune lists Sunny reads ---------------------------------------
const LISTS = { Memories: 'memory', Echoes: 'echo', Shadows: 'shadow', Attributes: 'attribute' }
const key = (n) => norm(n).toLowerCase().replace(/[^a-z…]/g, '')
const checkpoints = []
for (const b of runes.blocks) {
  if (b.ch > tl.reviewedThrough || b.kind !== 'status') continue
  const who = b.fields.find((f) => f.label === 'Name')?.value
  if (who && !/^Sun(ny|less)\b/.test(who)) continue
  if ((tl.notSunny ?? []).includes(`${b.ch}:${b.paras[0]}`)) continue
  for (const f of b.fields.filter((f) => LISTS[f.label])) {
    const { names, truncated } = listOf(f.value)
    const st = stateAt([b.ch, f.p])
    const held = Object.values(st).filter((x) => x.held && x.kind === LISTS[f.label]).map((x) => x.name ?? x.label ?? x.id)
    const missing = names.filter((n) => !held.some((h) => key(h) === key(n)))
    const note = tl.checkpointNotes?.[`${b.ch}:${f.p}`]
    const extra = truncated ? [] : held.filter((h) => !names.some((n) => key(h) === key(n)) && !note?.extra?.includes(h))
    checkpoints.push({ at: `${b.ch}:${f.p}`, list: f.label, names, truncated, missing, extra, note: note?.why })
  }
}

await writeFile(path.join(WORK, 'resolved.json'), JSON.stringify({ ...tl, events, checkpoints }, null, 1))

for (const c of checkpoints) {
  const ok = !c.missing.length && !c.extra.length
  console.log(`${ok ? '✓' : '✗'} ${c.at.padEnd(7)} ${c.list.padEnd(10)} ${c.names.length} listed${c.truncated ? ' (cut off)' : ''}` +
    (c.missing.length ? `\n     in the book, not in the timeline: ${c.missing.join(', ')}` : '') +
    (c.extra.length ? `\n     in the timeline, not in the book: ${c.extra.join(', ')}` : '') +
    (c.note ? `\n     note: ${c.note}` : ''))
}
if (errors.length) {
  console.error(`\n${errors.length} error(s):\n  ` + errors.join('\n  '))
  process.exit(1)
}
console.log(`\n${events.length} events, all anchors and strings verified against the text.`)
