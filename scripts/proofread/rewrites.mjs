// Step 3f — chapters to replace whole.
//
// Some pirate-site copies are AI rewrites planted as bait: the story is the same,
// but every sentence is reworded and invented ones are slipped in (Shadow Slave
// 1905–1906 in vol 9). Nothing short of the real text fixes those, so
// proofread/rewrites/<chapter number>.txt holds it — paragraphs separated by
// blank lines, as copied from the official release. A paragraph the copy cut
// mid-sentence (the next one starts in lowercase) is joined back, and em dashes
// get the book's spacing ("word — word").
// Writes proofread/findings/rewrite/<slug>.json: one replace-chapter suggestion
// per chapter, covering every paragraph of the rewritten copy. Its other
// suggestions are dropped (loadFindings) — they were made for the fake text.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { textKey } from '../../src/lib/proof-key.js'
import { WORK } from './lib.mjs'

/** The paragraphs of a pasted chapter. */
export function parseRewrite(text) {
  const out = []
  for (const raw of text.split(/\n\s*\n/)) {
    const p = raw.replace(/\s+/g, ' ').trim()
    if (!p) continue
    if (out.length && /^[a-z]/.test(p)) out[out.length - 1] += ' ' + p
    else out.push(p)
  }
  return out.map((p) => p.replace(/(?<=\w) ?— ?(?=\w)/g, ' — '))
}

const dir = path.join(WORK, 'rewrites')
const files = (await readdir(dir).catch(() => [])).filter((f) => /^\d+\.txt$/.test(f))
const wanted = new Map(files.map((f) => [f.replace('.txt', ''), f]))
const out = {}
for (const name of (await readdir(path.join(WORK, 'books'))).filter((f) => f.endsWith('.json'))) {
  const book = JSON.parse(await readFile(path.join(WORK, 'books', name), 'utf8'))
  for (const c of book.chapters) {
    const n = c.title.match(/^Chapter\s*(\d+)/i)?.[1]
    if (!wanted.has(n)) continue
    const paras = parseRewrite(await readFile(path.join(dir, wanted.get(n)), 'utf8'))
    wanted.delete(n)
    ;(out[book.slug] ??= []).push({
      id: `rewrite-${book.slug}-${textKey(c.href).replace('.', '')}`,
      book: book.slug,
      href: c.href,
      chapter: c.title,
      source: 'manual',
      op: 'replace-chapter',
      para: 0,
      paraEnd: c.paras.length - 1,
      original: c.paras.join('\n\n'),
      replacement: paras.join('\n\n'),
      kind: 'rewrite',
      note: `This copy is an AI rewrite — replace it with the real chapter (${paras.length} paragraphs)`,
    })
    console.log(`${book.slug}: ${c.title} — ${c.paras.length} ¶ → ${paras.length} ¶`)
  }
}
for (const n of wanted.keys()) console.log(`✗ chapter ${n}: not found in any book`)
await mkdir(path.join(WORK, 'findings', 'rewrite'), { recursive: true })
for (const [slug, list] of Object.entries(out)) await writeFile(path.join(WORK, 'findings', 'rewrite', `${slug}.json`), JSON.stringify(list, null, 1))
