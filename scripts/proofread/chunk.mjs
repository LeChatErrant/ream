// Step 3a — cut the books into reading chunks for the Claude proofreading pass:
// proofread/chunks/<slug>-NN.txt, ~WORDS words each, whole chapters only.
// The automatic fixes are pre-applied so the agents don't re-report them, but
// paragraph numbers stay those of the original file ([n]).
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { WORK } from './lib.mjs'
import { loadFindings } from './apply.mjs'

const WORDS = +(process.argv.find((a) => a.startsWith('--words='))?.slice(8) ?? 28000)
const only = process.argv.find((a) => a.startsWith('--book='))?.slice(7)

const auto = (await loadFindings()).filter((f) => f.source === 'auto')
const dir = path.join(WORK, 'books')
await mkdir(path.join(WORK, 'chunks'), { recursive: true })
const manifest = []
for (const file of (await readdir(dir)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
  const book = JSON.parse(await readFile(path.join(dir, file), 'utf8'))
  if (only && book.slug !== only) continue
  const hints = JSON.parse(await readFile(path.join(WORK, 'hints', file), 'utf8').catch(() => '[]'))
  const mine = auto.filter((f) => f.book === book.slug)
  let part = []
  let words = 0
  let n = 0
  const flush = async () => {
    if (!part.length) return
    const name = `${book.slug}-${String(++n).padStart(2, '0')}`
    await writeFile(path.join(WORK, 'chunks', `${name}.txt`), part.join('\n'))
    manifest.push({ chunk: name, book: book.slug, words })
    part = []
    words = 0
  }
  for (const c of book.chapters) {
    if (!c.isChapter) continue
    const fixes = mine.filter((f) => f.href === c.href)
    const title = fixes.find((f) => f.op === 'title')?.replacement ?? c.title
    const lines = [`\n### ${c.href} | ${title}`]
    c.paras.forEach((p, i) => {
      const del = fixes.find((f) => f.op === 'delete-paras' && i >= f.para && i <= f.paraEnd)
      if (del) return lines.push(`[${i}] ⟨already removed: ${del.note}⟩`)
      let t = p
      for (const f of fixes.filter((f) => f.para === i && f.op === 'replace')) t = t.replace(f.original, f.replacement)
      lines.push(`[${i}] ${t.replace(/\s*\n\s*/g, ' ')}`)
      words += t.split(/\s+/).length
    })
    for (const h of hints.filter((h) => h.href === c.href))
      lines.push(`(hint: ¶${h.paras[0]} and ¶${h.paras[1]} share the words "${h.text}" — check whether that is a doubled/misplaced passage or deliberate)`)
    part.push(lines.join('\n'))
    if (words >= WORDS) await flush()
  }
  await flush()
}
await writeFile(path.join(WORK, 'chunks', 'manifest.json'), JSON.stringify(manifest, null, 1))
console.log(`${manifest.length} chunks`, Object.entries(Object.groupBy(manifest, (m) => m.book)).map(([b, v]) => `${b.slice(13)}:${v.length}`).join(' '))
