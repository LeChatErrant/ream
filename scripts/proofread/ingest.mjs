// Step 3b — normalise the Claude pass output in proofread/findings/claude/*.json:
// give every finding an id/book/chapter, snap `original` onto the exact paragraph text
// (agents sometimes swap curly/straight quotes or spaces), and flag what can't be located
// or duplicates an automatic finding. Idempotent — safe to re-run as chunks come in.
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { WORK } from './lib.mjs'

const dir = path.join(WORK, 'findings', 'claude')
const books = new Map()
const book = async (slug) => {
  if (!books.has(slug)) books.set(slug, JSON.parse(await readFile(path.join(WORK, 'books', `${slug}.json`), 'utf8')))
  return books.get(slug)
}
const auto = new Map()
for (const f of await readdir(path.join(WORK, 'findings', 'auto')))
  for (const x of JSON.parse(await readFile(path.join(WORK, 'findings', 'auto', f), 'utf8'))) auto.set(x.id, x)

// Loose matching: quotes, dashes, ellipses and spaces may differ.
const loose = (s) =>
  s
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/[–—]/g, '-')
    .replace(/[\s\u00a0]+/g, ' ')
function locate(text, needle) {
  if (text.includes(needle)) return needle
  // Map loose positions back to the real text.
  const map = []
  let L = ''
  for (let i = 0; i < text.length; i++) {
    const piece = loose(text[i])
    if (piece === ' ' && L.endsWith(' ')) continue
    for (const ch of piece) (L += ch), map.push(i)
  }
  const at = L.indexOf(loose(needle).trim())
  if (at < 0) return null
  const end = map[at + loose(needle).trim().length - 1] + 1
  return text.slice(map[at], end)
}

let total = 0
let bad = 0
for (const file of (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()) {
  // Chunk files are per book; titles.json spans every book (each item names its book).
  const fileSlug = file.replace(/-\d+\.json$/, '')
  let raw
  try {
    raw = JSON.parse(await readFile(path.join(dir, file), 'utf8'))
  } catch (e) {
    console.log(`${file}: unreadable JSON (${e.message})`)
    continue
  }
  const chunk = file.replace(/\.json$/, '')
  const out = []
  for (const [i, f] of raw.entries()) out.push(await check(f, i))
  async function check(f, i) {
    const slug = f.book ?? fileSlug
    const b = await book(slug).catch(() => null)
    if (!b) return { ...f, id: f.id ?? `claude-${chunk}-${i + 1}`, source: 'claude', invalid: 'unknown book' }
    const c = b.chapters.find((c) => c.href === f.href)
    const g = { ...f, id: f.id ?? `claude-${chunk}-${i + 1}`, book: slug, source: 'claude', chapter: c?.title ?? '?' }
    delete g.invalid
    if (!c) return { ...g, invalid: 'unknown chapter' }
    if (g.op === 'title') {
      // Agents see the auto-cleaned title; the edit applies to the raw one.
      const a = [...auto.values()].find((a) => a.book === slug && a.href === g.href && a.op === 'title')
      if (a) g.overrides = a.id
      g.original = c.title
      g.para = null
      return g.replacement.trim() === c.title.trim() ? { ...g, invalid: 'no change' } : g
    }
    if (g.op === 'delete-paras') {
      g.paraEnd ??= g.para
      if (!c.paras[g.para] || !c.paras[g.paraEnd]) return { ...g, invalid: 'no such paragraph' }
      g.original = c.paras.slice(g.para, g.paraEnd + 1).join('\n\n')
      for (const a of auto.values())
        if (a.book === slug && a.href === g.href && a.op === 'delete-paras' && a.para <= g.para && a.paraEnd >= g.paraEnd)
          return { ...g, invalid: `already covered by ${a.id}` }
      return g
    }
    g.op = 'replace'
    const p = c.paras[g.para]
    if (p === undefined) return { ...g, invalid: 'no such paragraph' }
    let found = locate(p, g.original)
    // The text may only exist once an automatic fix is applied (e.g. a watermark cut).
    if (!found) {
      let cleaned = p
      for (const a of auto.values())
        if (a.book === slug && a.href === g.href && a.para === g.para && a.op === 'replace') cleaned = cleaned.replace(a.original, a.replacement)
      if (locate(cleaned, g.original)) g.afterAuto = true
      else return { ...g, invalid: 'text not found in paragraph' }
      found = locate(cleaned, g.original)
    }
    if (found !== g.original) {
      // Carry the agent's intended change over onto the exact characters.
      g.replacement = g.replacement.replace(/[‘’]/g, "'").replace(/[“”]/g, '"') === g.replacement && /[‘’“”]/.test(found) ? requote(found, g.original, g.replacement) : g.replacement
      g.original = found
    }
    if (g.original === g.replacement) return { ...g, invalid: 'no change' }
    for (const a of auto.values())
      if (a.book === slug && a.href === g.href && a.para === g.para && (a.original.includes(g.original) || g.original.includes(a.original.trim())))
        return { ...g, invalid: `already covered by ${a.id}` }
    return g
  }
  // "Sentence split across two paragraphs" arrives as a pair — a replace on ¶k that
  // appends ¶k+1, plus a delete of ¶k+1. Fuse them so they're reviewed (and applied) as one.
  for (const del of out) {
    if (del.invalid || del.op !== 'delete-paras' || del.para !== del.paraEnd) continue
    const head = del.original.trim().slice(0, 25)
    const rep = out.find((r) => !r.invalid && r.op === 'replace' && r.href === del.href && r.para === del.para - 1 && head && r.replacement.includes(head))
    if (!rep) continue
    rep.alsoDelete = del.para
    rep.note = `${rep.note} (joins ¶${del.para} into this paragraph)`
    del.invalid = `merged into ${rep.id}`
  }
  await writeFile(path.join(dir, file), JSON.stringify(out, null, 1))
  const n = out.filter((f) => f.invalid).length
  total += out.length
  bad += n
  if (n) console.log(`${file}: ${out.length} findings, ${n} set aside (${[...new Set(out.filter((f) => f.invalid).map((f) => f.invalid.replace(/ by .*/, '')))].join(', ')})`)
}
console.log(`${total} Claude findings, ${total - bad} usable, ${bad} set aside`)

/** The agent wrote straight quotes where the book has curly ones: keep the book's style in the fix. */
function requote(found, orig, rep) {
  const curlyFor = new Map()
  for (let i = 0; i < Math.min(found.length, orig.length); i++) if (found[i] !== orig[i]) curlyFor.set(orig[i], found[i])
  return [...rep].map((ch) => curlyFor.get(ch) ?? ch).join('')
}
