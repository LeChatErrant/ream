// Step 1 — dump every epub at the repo root to proofread/books/<slug>.json:
// { name, slug, chapters: [{ href, title, isChapter, paras: [text…] }] }.
// Paragraph indices in that file are what findings point at.
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { WORK, listEpubs, readChapters } from './lib.mjs'

await mkdir(path.join(WORK, 'books'), { recursive: true })
for (const { name, file, slug } of await listEpubs()) {
  const chapters = await readChapters(file)
  await writeFile(path.join(WORK, 'books', `${slug}.json`), JSON.stringify({ name, slug, chapters }, null, 1))
  const words = chapters.flatMap((c) => c.paras).join(' ').split(/\s+/).length
  console.log(`${slug}: ${chapters.filter((c) => c.isChapter).length} chapters, ${words} words`)
}
