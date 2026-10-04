// Read passages with their paragraph indices — what timeline anchors point at.
//   node scripts/soul-sea/ctx.mjs 104:20 104:41:2:9   (chapter:paragraph[:before[:after]])
//   node scripts/soul-sea/ctx.mjs 104                 (a whole chapter)
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { WORK } from './lib.mjs'

const text = JSON.parse(await readFile(path.join(WORK, 'text.json'), 'utf8'))
for (const a of process.argv.slice(2)) {
  const [ch, p, before = 6, after = 6] = a.split(':').map(Number)
  const ps = text[ch]
  if (!ps) { console.log(`----- no chapter ${ch}`); continue }
  const from = p == null || isNaN(p) ? 0 : Math.max(0, p - before)
  const to = p == null || isNaN(p) ? ps.length - 1 : Math.min(ps.length - 1, p + after)
  console.log(`----- ch ${ch} (${ps.length} paragraphs)`)
  for (let i = from; i <= to; i++) console.log(`${ch}:${i} ${ps[i]}`)
}
