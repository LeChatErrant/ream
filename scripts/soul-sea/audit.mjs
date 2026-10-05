// What the Soul Sea panel would show badly, from the app's data: a listed
// Enchantment / Attribute / Ability with no description, an item with no
// description, a description outside any list, an item with nothing at all.
// `node scripts/soul-sea/audit.mjs [--all] [--to N] [name…]` — each item's latest
// sheet (as of chapter N), or with --all every sheet as the reader meets it.
// A gap the book itself leaves (it never describes that enchantment) goes in
// timeline.json `knownGaps` ("item id": ["field", …]) with the reason.
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { APP_DATA, TIMELINE, WORK } from './lib.mjs'
import { NONE, fieldsAt, itemsOf } from './sheet-fields.mjs'

const data = JSON.parse(await readFile(APP_DATA, 'utf8'))
const text = JSON.parse(await readFile(path.join(WORK, 'text.json'), 'utf8'))
const known = JSON.parse(await readFile(TIMELINE, 'utf8')).knownGaps ?? {}
const PARTS = path.join(import.meta.dirname, 'parts')
for (const f of (await readdir(PARTS)).filter((f) => f.endsWith('.json')))
  for (const [id, gaps] of Object.entries(JSON.parse(await readFile(path.join(PARTS, f), 'utf8')).knownGaps ?? {})) known[id] = [...(known[id] ?? []), ...gaps]
const args = process.argv.slice(2)
const all = args.includes('--all')
const to = args.includes('--to') ? +args[args.indexOf('--to') + 1] : Infinity
const want = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--to').map((a) => a.toLowerCase())
// Items of their own (an Aspect's Abilities) are linked, not described in the list.
const LINKABLE = new Set(['aspect', 'legacy', 'relic', 'ability', 'flaw'])
const items = itemsOf(data)
const linked = new Set(items.filter((x) => LINKABLE.has(x.kind)).map((x) => x.name))

let problems = 0
for (const x of items) {
  if (x.since > to) continue
  const name = x.name ?? x.id
  if (want.length && !want.some((w) => x.id.includes(w) || name.toLowerCase().includes(w))) continue
  const shown = x.shown.filter((e) => e.at[0] <= to)
  const out = []
  if (!shown.length) out.push(['', 'nothing shown: no rune sheet, no told passage'])
  const seen = new Set()
  for (const e of all ? shown : shown.slice(-1)) {
    const f = fieldsAt(x, e.at[0], text)
    // (a told passage's names can't carry descriptions: only a rune sheet's are checked)
    const sheet = x.shown.some((o) => o.type === 'runes' && o.at[0] <= e.at[0])
    for (const [k, v] of f) {
      const field = k.replace(/^.* › /, '')
      if (known[x.id]?.includes(k) || seen.has(k)) continue
      if (v === NONE && k === 'Description' && sheet) out.push([e.at[0], 'no description of the item'])
      else if (v === NONE && k.includes(' › ') && !linked.has(field) && sheet) out.push([e.at[0], `${k}: no description`])
      else if (k.startsWith('(outside')) out.push([e.at[0], `${k}: described, but in no list`])
      else continue
      seen.add(k)
    }
  }
  if (!out.length) continue
  problems += out.length
  console.log(`\n${name} [${x.id}, ${x.kind}, from ch ${x.since}]`)
  for (const [c, m] of out) console.log(`  ${c ? 'sheet ch ' + c + ': ' : ''}${m}`)
}
console.log(`\n${problems} problem(s).`)
