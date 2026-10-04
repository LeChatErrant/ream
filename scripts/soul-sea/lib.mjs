// Shared helpers for the Soul Sea pipeline (scripts/soul-sea/*): pulls the
// rune blocks Shadow Slave prints (Memories, Echoes, Shadows, Attributes,
// Aspect, Flaw, status sheets) out of the epubs, verbatim, so an inventory
// timeline can point at them. Not part of the app.
import path from 'node:path'
import { ROOT, listEpubs, readChapters } from '../proofread/lib.mjs'
import { textKey } from '../../src/lib/proof-key.js'

export { ROOT, textKey }
export const WORK = path.join(ROOT, 'soul-sea')
export const TIMELINE = path.join(import.meta.dirname, 'timeline.json')
// What the app ships: references and fingerprints only (see build.mjs).
export const APP_DATA = path.join(ROOT, 'src/soul-sea/shadow-slave.json')

/** Every Shadow Slave chapter, keyed by its global number: { n, vol, href, title, paras }. */
export async function readSeries() {
  const chapters = []
  for (const { name, file } of await listEpubs()) {
    const vol = +name.match(/^shadow slave\D*(\d+)/i)?.[1]
    if (!vol) continue
    for (const c of await readChapters(file)) {
      const n = +c.title.match(/^Chapter\W*(\d+)/i)?.[1]
      if (n) chapters.push({ n, vol, href: c.href, title: c.title, paras: c.paras })
    }
  }
  return chapters.sort((a, b) => a.n - b.n)
}

// Labels the Spell uses in rune sheets, longest first so "Memory Rank" wins over "Memory".
const LABELS = [
  'Name', 'True Name', 'Rank', 'Class', 'Soul Core', 'Soul Cores', 'Shadow Core', 'Shadow Cores',
  'Soul Fragments', 'Shadow Fragments', 'Memories', 'Echoes', 'Shadows', 'Attributes', 'Attribute',
  'Attribute Description', 'Attribute Traits', 'Aspect', 'Aspect Rank', 'Aspect Description',
  'Aspect Abilities', 'Aspect Ability', 'Aspect Ability Name', 'Aspect Ability Description',
  'Aspect Legacy', 'Aspect Legacy Description', 'Ability', 'Ability Description', 'Ability Descriptions',
  'Innate Ability', 'Flaw', 'Flaw Description', 'Memory', 'Memory Rank', 'Memory Tier', 'Memory Type',
  'Memory Description', 'Memory Enchantments', 'Memory Enchantment', 'Enchantments', 'Enchantment',
  'Enchantment Description', 'Echo', 'Echo Rank', 'Echo Class', 'Echo Type', 'Echo Core',
  'Echo Attributes', 'Echo Abilities', 'Echo Description', 'Shadow', 'Shadow Rank', 'Shadow Class',
  'Shadow Attributes', 'Shadow Abilities', 'Shadow Description', 'Shadow Dance Mastery Level',
  'Shadow Dance Description', 'First Relic', 'Second Relic', 'Third Relic', 'Fourth Relic',
  'Fifth Relic', 'Vanquished Foes',
].sort((a, b) => b.length - a.length)

// "[Fated] Attribute Description:" / "[Unbroken] Enchantment Description:" carry their subject first.
const LABEL_RE = new RegExp(
  `(?:^|(?<=[.\\]…"\\-—]\\s{0,2}))(\\[[^\\]]{1,60}\\]\\s+)?(${LABELS.map((l) => l.replace(/ /g, '\\s+')).join('|')})\\s*:\\s*`,
  'g',
)

/**
 * Split one paragraph into rune fields, or null if it isn't a rune line.
 * "Name: Sunless.True Name: Lost from Light." → [{label:'Name', value:'Sunless.'}, …]
 */
export function fieldsOf(text) {
  const t = text.trim()
  const hits = [...t.matchAll(LABEL_RE)]
  if (!hits.length || hits[0].index !== 0) return null
  // Prose like "Memory: it was a strange word" — rune values start with a bracket, a dash,
  // a capital or a digit.
  const fields = hits.map((m, i) => ({
    subject: m[1]?.trim().slice(1, -1),
    label: m[2].replace(/\s+/g, ' '),
    value: t.slice(m.index + m[0].length, hits[i + 1]?.index ?? t.length).trim(),
  }))
  if (!/^[[\-—–A-Z0-9"“«….]/.test(fields[0].value)) return null
  return fields
}

/** "[Silver Bell], [Puppeteer's Shroud]." → ['Silver Bell', "Puppeteer's Shroud"] (+ truncated flag). */
export function listOf(value) {
  const names = [...value.matchAll(/\[([^\]]+)\]?/g)].map((m) => m[1].trim()).filter(Boolean)
  return { names, truncated: /(\.\.\.|…)\s*$/.test(value.trim()) }
}

/** A system message: a paragraph that is one bracketed line, e.g. "[You have received a Memory: Azure Blade.]" */
export const isMessage = (text) => /^\s*\[[^[\]]*(\[[^\]]*\][^[\]]*)*\]\.?\s*$/.test(text) && !fieldsOf(text)

// Which kind of block a field opens. Anything else continues the open block.
const OPENS = {
  Name: 'status', Memory: 'memory', Echo: 'echo', Shadow: 'shadow', Aspect: 'aspect',
  Flaw: 'flaw', Attribute: 'attribute', Enchantment: 'enchantment',
}
// Fields that may legitimately repeat inside one block.
const REPEATS = new Set(['Attribute Description', 'Enchantment Description', 'Ability Description', 'Ability', 'Aspect Ability Description'])
// How far (in paragraphs) prose may interrupt a block before it is closed.
const GAP = 14

/**
 * Group the rune paragraphs of one chapter into blocks:
 * { kind, name, paras: [i…], fields: [{ p, subject, label, value }] }.
 */
export function blocksOf(paras) {
  const blocks = []
  let cur = null
  paras.forEach((text, p) => {
    const fields = fieldsOf(text)
    if (!fields) return
    for (const f of fields) {
      let opens = OPENS[f.label]
      // Inside a status sheet, "Aspect:" / "Flaw:" are rows of the sheet, not new blocks.
      if (cur?.kind === 'status' && (opens === 'aspect' || opens === 'flaw') && p - cur.last <= GAP) opens = null
      // A memory's "Enchantment: [X]" detail belongs to that memory.
      if (cur?.kind === 'memory' && opens === 'enchantment' && p - cur.last <= GAP) opens = null
      const stale = !cur || p - cur.last > GAP
      const dup = cur && !REPEATS.has(f.label) && cur.fields.some((g) => g.label === f.label && !g.subject && !f.subject)
      if (opens || stale || dup) {
        cur = { kind: opens ?? (dup && cur ? cur.kind : guessKind(f.label)), name: null, paras: [], fields: [], last: p }
        blocks.push(cur)
      }
      if (OPENS[f.label] && !cur.name) cur.name = listOf(f.value).names[0] ?? f.value.replace(/[.\s]+$/, '')
      cur.fields.push({ p, ...f })
      if (!cur.paras.includes(p)) cur.paras.push(p)
      cur.last = p
    }
  })
  for (const b of blocks) delete b.last
  return blocks
}

function guessKind(label) {
  if (/Fragments|Cores?$/.test(label)) return 'status'
  const w = label.split(' ')[0]
  return { Memory: 'memory', Echo: 'echo', Shadow: 'shadow', Aspect: 'aspect', Flaw: 'flaw' }[w] ?? (/Attribute/.test(label) ? 'attribute' : 'status')
}
