// Every rune block and Spell message in a chapter range, in order:
//   node scripts/soul-sea/runes-in.mjs <fromCh> <toCh> [--blocks|--messages]
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { WORK } from './lib.mjs'

const { blocks, messages } = JSON.parse(await readFile(path.join(WORK, 'runes.json'), 'utf8'))
const [from, to] = process.argv.slice(2, 4).map(Number)
const want = (k) => !process.argv.some((a) => a.startsWith('--')) || process.argv.includes(k)
const rows = []
if (want('--blocks'))
  for (const b of blocks.filter((b) => b.ch >= from && b.ch <= to))
    rows.push([b.ch, b.paras[0], `[${b.kind}${b.name ? ': ' + b.name : ''}] ` + b.fields.map((f) => `${f.subject ? '[' + f.subject + '] ' : ''}${f.label}: ${f.value.slice(0, 160)}`).join(' | ') + `  (paras ${b.paras.join(',')})`])
if (want('--messages'))
  for (const m of messages.filter((m) => m.ch >= from && m.ch <= to)) rows.push([m.ch, m.p, m.text.slice(0, 200)])
rows.sort((a, b) => a[0] - b[0] || a[1] - b[1])
for (const [c, p, t] of rows) console.log(`${c}:${p} ${t}`)
