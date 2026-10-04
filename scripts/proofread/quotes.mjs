// Step 3d — French quotes. Part of Shadow Slave (≈ ch 1533–1966) uses «…» for
// dialogue where the rest of the book uses straight "…": one finding per
// paragraph turns them back into ", fixing the spacing around them.
// Writes proofread/findings/quotes/<slug>.json (ids `quotes-<slug>-<n>`, their own
// namespace so the detector ids never shift). Run after ingest.mjs, since it
// steers clear of text other findings already rewrite: a quote inside another
// finding's original is left to that finding, whose replacement gets the same
// straight quotes here (only while it's still undecided).
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { WORK } from './lib.mjs'
import { loadDecisions, loadFindings } from './apply.mjs'

const GUILLEMET = /[«»]/g
const OPEN_BEFORE = /[\s([{—–-]/u

/** The edits that turn «» into straight quotes: [{ s, e, to }] over `text`. */
export function quoteEdits(text) {
  const edits = []
  for (const m of text.matchAll(GUILLEMET)) {
    const i = m.index
    const prev = text[i - 1]
    const next = text[i + 1]
    // Role from the surroundings, not the glyph: the source mixes them up ("topic?« Nephis").
    const opener = (prev === undefined || OPEN_BEFORE.test(prev)) && next !== undefined && !/\s/.test(next)
    let s = i
    let e = i + 1
    let to = '"'
    if (opener) {
      if (prev !== undefined && /[\p{L}\p{N}]/u.test(prev)) to = ' "'
    } else {
      // "Text »" → "Text"" and "needs!»Sunny" → "needs!" Sunny".
      if (/[  ]/.test(prev ?? '') && (next === undefined || /[\s.,;:!?…)]/.test(next))) s--
      if (next !== undefined && /[\p{L}\p{N}]/u.test(next)) to = '" '
    }
    edits.push({ s, e, to })
  }
  // An asterisk standing in for the closing quote: "«Second company, fall back!*".
  const opens = (text.match(GUILLEMET) ?? []).length
  const star = text.match(/[.!?…]\*$/)
  if (star && opens % 2 === 1) edits.push({ s: text.length - 1, e: text.length, to: '"' })
  return edits.sort((a, b) => a.s - b.s)
}

const applyEdits = (text, edits) => {
  let out = text
  for (const x of [...edits].sort((a, b) => b.s - a.s)) out = out.slice(0, x.s) + x.to + out.slice(x.e)
  return out
}

/** Straight quotes in someone else's replacement text. */
export const straighten = (t) => applyEdits(t, quoteEdits(t))

export async function quoteFindings(book, others) {
  const out = []
  let seq = 0
  for (const c of book.chapters) {
    if (!c.isChapter) continue
    c.paras.forEach((p, pi) => {
      if (!GUILLEMET.test(p)) return
      GUILLEMET.lastIndex = 0
      // Text other findings of this paragraph rewrite: leave the quotes in there to them.
      const busy = []
      for (const f of others.get(`${c.href}|${pi}`) ?? []) {
        if (f.op !== 'replace') continue
        for (let at = p.indexOf(f.original); at >= 0 && f.original; at = p.indexOf(f.original, at + 1)) busy.push([at, at + f.original.length])
      }
      const inBusy = (s, e) => busy.some(([a, b]) => s < b && e > a)
      const edits = quoteEdits(p).filter((x) => !inBusy(x.s, x.e))
      // One finding per run of edits that no busy range interrupts.
      const groups = []
      for (const x of edits) {
        const g = groups.at(-1)
        if (g && !inBusy(g.at(-1).e, x.s)) g.push(x)
        else groups.push([x])
      }
      for (const g of groups) {
        let s = g[0].s
        let e = g.at(-1).e
        // Whole words around the change, so the suggestion reads well and locates uniquely.
        while (s > 0 && /\S/.test(p[s - 1]) && !inBusy(s - 1, s)) s--
        while (e < p.length && /\S/.test(p[e]) && !inBusy(e, e + 1)) e++
        while (p.indexOf(p.slice(s, e)) !== s && s > 0 && !inBusy(s - 1, s)) s--
        if (p.indexOf(p.slice(s, e)) !== s) continue
        const original = p.slice(s, e)
        const replacement = applyEdits(original, g.map((x) => ({ ...x, s: x.s - s, e: x.e - s })))
        if (replacement === original) continue
        out.push({
          id: `quotes-${book.slug}-${++seq}`,
          book: book.slug,
          source: 'auto',
          href: c.href,
          chapter: c.title,
          para: pi,
          op: 'replace',
          original,
          replacement,
          kind: 'quotes',
          note: 'French quotes « » instead of "',
        })
      }
    })
  }
  return out
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const all = (await loadFindings()).filter((f) => f.kind !== 'quotes')
  const decisions = await loadDecisions()
  // Undecided suggestions that already touch a «»: give their fix the same straight quotes.
  const claudeDir = path.join(WORK, 'findings', 'claude')
  let restyled = 0
  for (const file of await readdir(claudeDir).catch(() => [])) {
    const p = path.join(claudeDir, file)
    const list = JSON.parse(await readFile(p, 'utf8'))
    let changed = false
    for (const f of list) {
      if (f.op !== 'replace' || decisions[f.id] || !/[«»]/.test(f.replacement ?? '')) continue
      f.replacement = straighten(f.replacement)
      changed = true
      restyled++
    }
    if (changed) await writeFile(p, JSON.stringify(list, null, 1))
  }

  const others = Object.groupBy(all.filter((f) => f.para != null), (f) => `${f.book}|${f.href}|${f.para}`)
  const dir = path.join(WORK, 'books')
  const outDir = path.join(WORK, 'findings', 'quotes')
  await mkdir(outDir, { recursive: true })
  for (const file of (await readdir(dir)).filter((f) => f.endsWith('.json'))) {
    const book = JSON.parse(await readFile(path.join(dir, file), 'utf8'))
    const mine = new Map(Object.entries(others).filter(([k]) => k.startsWith(`${book.slug}|`)).map(([k, v]) => [k.slice(book.slug.length + 1), v]))
    const found = await quoteFindings(book, mine)
    await writeFile(path.join(outDir, file), JSON.stringify(found, null, 1))
    if (found.length) console.log(`${book.slug}: ${found.length} quote findings in ${new Set(found.map((f) => f.href)).size} chapters`)
  }
  if (restyled) console.log(`${restyled} undecided suggestions switched to straight quotes`)
}
