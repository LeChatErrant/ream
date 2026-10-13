// Step 3e — text outside paragraphs, and empty paragraphs.
//
// paragraphs() only sees <p>, but some chapters (Shadow Slave vol 8–10) carry
// text elsewhere (lib.mjs looseBlocks): the title repeated as an <h3>/<h1> or a
// list item, ad links, watermarks in made-up tags, and story text that lost its
// <p> (or was split with <br>). This step suggests:
//   • delete-block — remove the element (title copy, ad, watermark);
//   • wrap-text    — make the orphan text its own paragraph (with any typo fixes
//                    from proofread/loose-fixes.json, the Claude pass over it);
//   • delete-paras — drop empty paragraphs (every volume).
// Writes proofread/findings/loose/<slug>.json. Ids hash the chapter + text, so
// they never shift and decisions stay attached when this is re-run.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { textKey } from '../../src/lib/proof-key.js'
import { WORK, listEpubs, openEpub, looseBlocks, paragraphs, textOf } from './lib.mjs'

const letters = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '')
const fixes = JSON.parse(await readFile(path.join(WORK, 'loose-fixes.json'), 'utf8').catch(() => '{}'))
const forClaude = [] // orphan text to proofread

await mkdir(path.join(WORK, 'findings', 'loose'), { recursive: true })
for (const epub of await listEpubs()) {
  const { zip, spine } = await openEpub(epub.file)
  const out = []
  for (const href of spine) {
    const xhtml = await zip.file(href).async('string')
    const title = textOf(xhtml.match(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/)?.[1] ?? '').trim()
    if (!/^Chapter\W*\d+/i.test(title)) continue
    const ps = paragraphs(xhtml)
    const base = { book: epub.slug, href, chapter: title, source: 'auto' }
    const idFor = (what, key) => `loose-${epub.slug}-${textKey(href + '|' + what + '|' + key).replace('.', '')}`

    for (const b of looseBlocks(xhtml)) {
      const key = textKey(b.text)
      const pos = ps.filter((p) => p.start < b.start).length // paragraphs before it, for ordering
      if (b.type === 'element') {
        const isTitle = letters(b.text) === letters(title) || letters(title).endsWith(letters(b.text))
        const note = isTitle
          ? 'Chapter title repeated in the text'
          : b.tag === 'a'
            ? 'Ad link left in the text'
            : !b.known
              ? 'Website watermark'
              : null
        if (!note) continue // an ordinary element we don't judge
        out.push({ ...base, id: idFor(`del-${b.tag}`, key), op: 'delete-block', block: { tag: b.tag, key }, pos, original: b.text, replacement: '', kind: 'junk', note })
      } else {
        const id = idFor('wrap', key)
        const fix = fixes[id]
        out.push({
          ...base,
          id,
          op: 'wrap-text',
          block: { key },
          pos,
          original: b.text,
          replacement: fix?.replacement ?? b.text,
          kind: 'format',
          note: fix?.note ? `Text outside a paragraph — made a paragraph; ${fix.note}` : 'Text outside a paragraph — made a paragraph',
        })
        forClaude.push({ id, chapter: title, text: b.text })
      }
    }

    // Empty paragraphs leave a gap.
    ps.forEach((p, i) => {
      if (p.text.replace(/[\s\u00a0\u200b-\u200d\u2060\ufeff]/g, '')) return
      out.push({ ...base, id: `empty-${epub.slug}-${textKey(href).replace('.', '')}-${i}`, op: 'delete-paras', para: i, paraEnd: i, original: p.text, replacement: '', kind: 'format', note: 'Empty paragraph' })
    })
  }
  await writeFile(path.join(WORK, 'findings', 'loose', `${epub.slug}.json`), JSON.stringify(out, null, 1))
  if (out.length) {
    const by = Object.entries(Object.groupBy(out, (f) => f.note.replace(/;.*/, ''))).map(([k, v]) => `${k} ${v.length}`)
    console.log(`${epub.slug}: ${out.length} — ${by.join(', ')}`)
  }
}
// The orphan text for the Claude pass (it was never proofread).
await writeFile(
  path.join(WORK, 'chunks', 'loose.txt'),
  forClaude.map((x) => `### ${x.id} | ${x.chapter}\n${x.text}`).join('\n\n') + '\n',
)
console.log(`${forClaude.length} orphan text blocks → proofread/chunks/loose.txt`)
