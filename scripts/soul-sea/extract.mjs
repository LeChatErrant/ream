// Step 1 — every rune block and Spell message of Shadow Slave → soul-sea/runes.json
// (gitignored: it holds book text). Each entry carries its chapter, paragraph
// index and paragraph fingerprint, which is what timeline.json points at.
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { WORK, blocksOf, isMessage, readSeries, textKey } from './lib.mjs'

const chapters = await readSeries()
const blocks = []
const messages = []
for (const c of chapters) {
  for (const b of blocksOf(c.paras)) blocks.push({ ch: c.n, ...b, fps: b.paras.map((p) => textKey(c.paras[p])) })
  c.paras.forEach((text, p) => {
    if (isMessage(text)) messages.push({ ch: c.n, p, fp: textKey(text), text: text.trim() })
  })
}

await mkdir(WORK, { recursive: true })
const index = Object.fromEntries(chapters.map((c) => [c.n, { vol: c.vol, title: c.title, paras: c.paras.length }]))
await writeFile(path.join(WORK, 'runes.json'), JSON.stringify({ chapters: index, blocks, messages }, null, 1))
// Plain text of every chapter, for searching and for the review page.
await writeFile(path.join(WORK, 'text.json'), JSON.stringify(Object.fromEntries(chapters.map((c) => [c.n, c.paras]))))

const by = (k) => blocks.reduce((m, b) => ((m[b[k]] = (m[b[k]] ?? 0) + 1), m), {})
console.log(`${chapters.length} chapters (${chapters[0].n}–${chapters.at(-1).n}), ${blocks.length} blocks, ${messages.length} messages`)
console.log(by('kind'))
