// Step 3g — paragraph breaks lost by the scrape.
//
// Some chapters (Shadow Slave vol 9–10, ≈1976–2304) came through with their
// paragraphs run together — a whole page in one <p>, the breaks turned into
// spaces. Another copy of the chapter that still has its paragraphs
// (proofread/reference/<chapter number>.txt or a folder of "<n> Title.md" files
// given as argument) says where each paragraph starts; this step only takes
// those *positions*: every suggestion splits the epub's own paragraph text, no
// words come from the other copy. A break is placed only where the reference's
// first words are found in order and the epub text ends a sentence just before.
// Writes proofread/findings/breaks/<slug>.json: one split-para suggestion per
// run-together paragraph, `breaks` = the opening words of each new paragraph.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { textKey } from '../../src/lib/proof-key.js'
import { WORK } from './lib.mjs'

const refDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(WORK, 'reference')
const refs = new Map()
for (const f of (await readdir(refDir).catch(() => [])).filter((f) => /^\d+[ .]/.test(f) && /\.(md|txt)$/.test(f))) refs.set(String(parseInt(f, 10)), path.join(refDir, f))

/** The reference's paragraphs (markdown front matter and the # title line dropped). */
async function refParas(file) {
  const t = (await readFile(file, 'utf8')).replace(/^---\n[\s\S]*?\n---\n/, '')
  return t.split(/\n\s*\n/).map((s) => s.trim()).filter((s) => s && !/^# /.test(s))
}

const words = (s) => [...s.matchAll(/[A-Za-z0-9]+/g)].map((m) => ({ w: m[0].toLowerCase(), at: m.index }))
const ENDS = /[.!?…"”’'—\])*:]$/

const out = {}
let total = 0
for (const name of (await readdir(path.join(WORK, 'books'))).filter((f) => f.endsWith('.json'))) {
  const book = JSON.parse(await readFile(path.join(WORK, 'books', name), 'utf8'))
  for (const c of book.chapters) {
    const n = c.title.match(/^Chapter\s*(\d+)/i)?.[1]
    if (!refs.has(n)) continue
    const ref = await refParas(refs.get(n))
    // Only chapters whose paragraphs were run together: far fewer than the reference.
    const real = c.paras.filter((p) => p.trim()).length
    if (real >= ref.length * 0.8) continue
    // Every epub word, with its paragraph and offset.
    const toks = []
    c.paras.forEach((p, i) => words(p).forEach((t, k) => toks.push({ ...t, i, first: k === 0 })))
    const cuts = new Map() // paragraph → offsets of new paragraph starts
    let cursor = 0
    for (const rp of ref.slice(1)) {
      const key = words(rp).map((t) => t.w)
      if (!key.length) continue
      let found = -1
      for (const len of [6, 4, 3, 2].filter((l) => l <= key.length)) {
        const want = key.slice(0, len)
        const limit = Math.min(toks.length, cursor + (len >= 4 ? 600 : 80))
        for (let t = cursor; t + len <= limit && found < 0; t++) if (want.every((w, k) => toks[t + k].w === w)) found = t
        if (found >= 0) break
      }
      if (found < 0) continue
      cursor = found + 1
      const tk = toks[found]
      if (tk.first) continue // already starts a paragraph
      const p = c.paras[tk.i]
      let at = tk.at
      while (at > 0 && /["“‘'(\[…—.]/.test(p[at - 1])) at-- // keep an opening quote / ellipsis with its paragraph
      if (!ENDS.test(p.slice(0, at).trimEnd())) continue // the epub must end a sentence there
      ;(cuts.get(tk.i) ?? cuts.set(tk.i, []).get(tk.i)).push(at)
    }
    for (const [i, offs] of cuts) {
      const p = c.paras[i]
      const bounds = [0, ...offs, p.length]
      const parts = bounds.slice(0, -1).map((b, k) => p.slice(b, bounds[k + 1]).trim()).filter(Boolean)
      if (parts.length < 2) continue
      ;(out[book.slug] ??= []).push({
        id: `breaks-${book.slug}-${textKey(c.href + '|' + i).replace('.', '')}`,
        book: book.slug,
        href: c.href,
        chapter: c.title,
        source: 'auto',
        op: 'split-para',
        para: i,
        original: p,
        replacement: parts.join('\n\n'),
        breaks: parts.slice(1).map((s) => s.slice(0, 24)),
        kind: 'format',
        note: `Paragraphs run together — restore ${parts.length - 1} paragraph break${parts.length > 2 ? 's' : ''}`,
      })
      total += parts.length - 1
    }
  }
}
await mkdir(path.join(WORK, 'findings', 'breaks'), { recursive: true })
for (const name of (await readdir(path.join(WORK, 'books'))).filter((f) => f.endsWith('.json'))) {
  const slug = name.replace('.json', '')
  await writeFile(path.join(WORK, 'findings', 'breaks', `${slug}.json`), JSON.stringify(out[slug] ?? [], null, 1))
}
const n = Object.values(out).flat()
console.log(`${n.length} run-together paragraphs in ${new Set(n.map((f) => f.book + f.href)).size} chapters → ${total} paragraph breaks`)
