// Step 5 — write the accepted corrections into the epubs.
//
//   node scripts/proofread/apply.mjs            → proofread/out/<same name>.epub for every book with accepted fixes
//   node scripts/proofread/apply.mjs --check    → only verify that every finding still locates its text
//
// Reads every proofread/findings/**/*.json and proofread/decisions.json
// ({ [id]: { status: 'accepted' | 'discarded', replacement?, choice? } }).
// Edits are made on the raw XHTML (no re-serialisation), so untouched markup stays byte-identical.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { textKey } from '../../src/lib/proof-key.js'
import { WORK, decode, encode, listEpubs, looseBlocks, openEpub, paragraphs, straightQuotes } from './lib.mjs'

export async function loadFindings() {
  const out = []
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.name.endsWith('.json')) out.push(...JSON.parse(await readFile(p, 'utf8')))
    }
  }
  await walk(path.join(WORK, 'findings'))
  // A Claude title fix supersedes the automatic clean-up of the same title.
  const overridden = new Set(out.filter((f) => f.overrides && !f.invalid).map((f) => f.overrides))
  // A chapter replaced whole (rewrites.mjs) drops the paragraph fixes made for its fake text.
  const replaced = new Set(out.filter((f) => f.op === 'replace-chapter').map((f) => `${f.book}|${f.href}`))
  const stale = (f) => f.op !== 'replace-chapter' && f.op !== 'title' && f.op !== 'delete-block' && replaced.has(`${f.book}|${f.href}`)
  // Findings without an id/book haven't been through ingest.mjs yet.
  return out.filter((f) => f.id && f.book && !f.invalid && !overridden.has(f.id) && !stale(f))
}

export async function loadDecisions() {
  try {
    return JSON.parse(await readFile(path.join(WORK, 'decisions.json'), 'utf8'))
  } catch {
    return {}
  }
}

/** The edit a decision resolves to (the reviewer may have edited the replacement or picked the other copy). */
export function resolve(f, d = {}) {
  const r = { ...f }
  if (d.replacement !== undefined && f.op !== 'delete-paras') r.replacement = straightQuotes(d.replacement)
  if (d.choice === 'other' && f.dupOf) Object.assign(r, { para: f.dupOf.para, paraEnd: f.dupOf.paraEnd })
  return r
}

const titleRe = (t) => new RegExp(`(>\\s*)${t.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s*<)`, 'g')

/** Apply edits to one chapter's XHTML. Returns { xhtml, failed: [{ edit, reason }] }. */
// Text outside paragraphs (loose.mjs): found by the fingerprint of its text, not
// by position, and applied after the paragraph edits (wrapping text in a new <p>
// would shift every paragraph index after it).
export const isBlockOp = (e) => e.op === 'delete-block' || e.op === 'wrap-text'

/** Apply delete-block / wrap-text edits to a chapter's XHTML. Returns { xhtml, failed }. */
export function applyBlocks(xhtml, edits) {
  const failed = []
  const blocks = looseBlocks(xhtml)
  const used = new Set()
  const hits = []
  for (const e of edits) {
    const b = blocks.find(
      (b) => !used.has(b) && textKey(b.text) === e.block.key && (e.op === 'wrap-text' ? b.type === 'text' : b.type === 'element' && b.tag === e.block.tag),
    )
    if (!b) {
      failed.push({ edit: e, reason: 'block not found' })
      continue
    }
    used.add(b)
    hits.push({ b, e })
  }
  for (const { b, e } of hits.sort((x, y) => y.b.start - x.b.start)) {
    const html = e.op === 'wrap-text' && e.replacement.trim() ? `<p>${encode(e.replacement.trim())}</p>` : ''
    xhtml = xhtml.slice(0, b.start) + html + xhtml.slice(b.end)
  }
  return { xhtml, failed }
}

export function applyToChapter(xhtml, edits) {
  const failed = []
  const ps = paragraphs(xhtml)
  const perPara = new Map()
  const deleted = new Set()
  for (const e of edits) {
    if (e.op === 'title' || isBlockOp(e)) continue
    if (e.op === 'delete-paras') {
      for (let i = e.para; i <= e.paraEnd; i++) deleted.add(i)
      continue
    }
    // The whole chapter's text: the first paragraph becomes all the new ones, the rest go.
    if (e.op === 'replace-chapter') for (let i = e.para + 1; i <= e.paraEnd; i++) deleted.add(i)
    if (e.alsoDelete != null) deleted.add(e.alsoDelete) // sentence split across paragraphs, joined back
    ;(perPara.get(e.para) ?? perPara.set(e.para, []).get(e.para)).push(e)
  }
  // A join pulls in the *corrected* text of the next paragraph, so fixes accepted
  // inside that paragraph survive being merged. Last first: in a chain (¶37 ← ¶38
  // ← ¶39…) the next paragraph's own join must already hold everything after it.
  for (const e of edits.filter((e) => e.join).sort((a, b) => b.para - a.para)) {
    const n = ps[e.alsoDelete]
    if (!n) continue
    let t = n.text
    for (const x of perPara.get(e.alsoDelete) ?? []) if (x.op === 'replace' && t.includes(x.original)) t = t.replace(x.original, x.replacement)
    e.replacement = `${e.original.trimEnd()} ${t.trim()}`
  }
  // Rebuild back to front so earlier offsets stay valid.
  const order = [...new Set([...deleted, ...perPara.keys()])].sort((a, b) => b - a)
  for (const i of order) {
    const p = ps[i]
    if (!p) {
      for (const e of perPara.get(i) ?? []) failed.push({ edit: e, reason: `no paragraph ${i}` })
      continue
    }
    let html
    const whole = (perPara.get(i) ?? []).find((e) => e.op === 'replace-chapter')
    if (deleted.has(i)) html = ''
    else if (whole) html = whole.replacement.split('\n\n').map((t) => `${p.open}${encode(t)}</p>`).join('\n')
    else {
      let inner = p.inner
      // Made-up tags (<azfd6c>…</azfd6c>) are a scraper's watermark wrapper, not
      // formatting: drop them so the paragraph can be edited as plain text.
      const bogus = /<\/?(?!(?:i|em|b|strong|u|s|sub|sup|small|span|a|br)\b)[a-z][a-z0-9]*\b[^>]*>/gi
      if ((perPara.get(i) ?? []).some((e) => e.op === 'replace') && bogus.test(inner)) inner = inner.replace(bogus, '')
      const plain = !/</.test(inner)
      let text = plain ? decode(inner) : null
      let split = false
      let breaks = null
      for (const e of perPara.get(i)) {
        if (e.op === 'split-para') {
          split = true
          breaks = e.breaks ?? null
          continue
        }
        if (plain) {
          const at = text.indexOf(e.original)
          if (at < 0) failed.push({ edit: e, reason: 'text not found' })
          else text = text.slice(0, at) + e.replacement + text.slice(at + e.original.length)
        } else {
          const at = inner.indexOf(encode(e.original))
          if (at < 0) failed.push({ edit: e, reason: 'text not found (paragraph has markup)' })
          else inner = inner.slice(0, at) + encode(e.replacement) + inner.slice(at + encode(e.original).length)
        }
      }
      if (plain) inner = encode(text)
      if (breaks) {
        // Run-together paragraphs (breaks.mjs): cut before each new paragraph's opening words.
        const at = []
        for (const b of breaks) {
          const from = at.at(-1) ?? 0
          let k = inner.indexOf(encode(b), from + 1)
          if (k < 0) k = inner.indexOf(encode(b.slice(0, 12)), from + 1)
          if (k < 0) failed.push({ edit: perPara.get(i).find((e) => e.op === 'split-para'), reason: `break not found: ${b}` })
          else at.push(k)
        }
        const bounds = [0, ...at, inner.length]
        html = bounds
          .slice(0, -1)
          .map((b, k) => inner.slice(b, bounds[k + 1]).replace(/^[\s\u00a0]+|[\s\u00a0]+$/g, ''))
          .filter(Boolean)
          .map((s) => `${p.open}${s}</p>`)
          .join('')
      } else if (split)
        html = inner
          .split(/<br\s*\/?>|\n/)
          .map((s) => s.replace(/^[\s\u00a0]+|[\s\u00a0]+$/g, ''))
          .filter(Boolean)
          .map((s) => `${p.open}${s}</p>`)
          .join('')
      else html = `${p.open}${inner}</p>`
    }
    xhtml = xhtml.slice(0, p.start) + html + xhtml.slice(p.end)
  }
  return { xhtml, failed }
}

/** Apply title edits to every navigation document and the chapter itself. */
function applyTitle(files, e) {
  let hits = 0
  const variants = [...new Set([e.original, encode(e.original), encode(e.original).replace(/'/g, '&#39;'), encode(e.original).replace(/"/g, '&quot;')].map((s) => s.trim()))]
  for (const [name, content] of files) {
    let c = content
    for (const v of variants) c = c.replace(titleRe(v), (m, a, b) => (hits++, `${a}${encode(e.replacement)}${b}`))
    files.set(name, c)
  }
  return hits
}

export async function applyBook(epub, edits) {
  const { zip, spine } = await openEpub(epub.file)
  const failed = []
  // Automatic fixes first: some Claude findings only match once a watermark is cut.
  edits = [...edits].sort((a, b) => (a.source === 'auto' ? 0 : 1) - (b.source === 'auto' ? 0 : 1))
  const byHref = Object.groupBy(edits, (e) => e.href)
  const nav = [...Object.keys(zip.files)].filter((n) => /\.(ncx|x?html?)$/i.test(n) && !spine.includes(n))
  const navFiles = new Map(await Promise.all(nav.map(async (n) => [n, await zip.file(n).async('string')])))
  let changedNav = false
  for (const [href, list] of Object.entries(byHref)) {
    const original = await zip.file(href).async('string')
    const res = applyToChapter(original, list)
    failed.push(...res.failed)
    const blockEdits = list.filter(isBlockOp)
    if (blockEdits.length) {
      const b = applyBlocks(res.xhtml, blockEdits)
      failed.push(...b.failed)
      res.xhtml = b.xhtml
    }
    const files = new Map([[href, res.xhtml], ...navFiles])
    for (const t of list.filter((e) => e.op === 'title')) {
      if (!applyTitle(files, t)) failed.push({ edit: t, reason: 'title not found' })
      else changedNav = true
    }
    for (const [n, c] of files) n === href ? zip.file(href, c) : navFiles.set(n, c)
  }
  if (changedNav) for (const [n, c] of navFiles) zip.file(n, c)
  // The mimetype entry must stay first and uncompressed.
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: 'application/epub+zip' })
  return { buf, failed }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes('--check')
  const findings = await loadFindings()
  const decisions = await loadDecisions()
  const epubs = await listEpubs()
  const outDir = path.join(WORK, 'out')
  await mkdir(outDir, { recursive: true })
  let totalFailed = 0
  for (const epub of epubs) {
    const mine = findings.filter((f) => f.book === epub.slug)
    const edits = check ? mine : mine.filter((f) => decisions[f.id]?.status === 'accepted').map((f) => resolve(f, decisions[f.id]))
    if (!edits.length) continue
    // In --check mode apply each finding alone: overlapping alternatives are fine to coexist.
    const failed = []
    if (check) {
      const { zip } = await openEpub(epub.file)
      for (const f of edits) {
        if (f.op === 'title') continue
        const x = await zip.file(f.href)?.async('string')
        if (!x) failed.push({ edit: f, reason: 'no such chapter' })
        else if (isBlockOp(f)) failed.push(...applyBlocks(x, [f]).failed)
        else {
          // A Claude fix may only match once the automatic fixes of its paragraph are in.
          const before = f.afterAuto ? mine.filter((a) => a.source === 'auto' && a.href === f.href && a.para === f.para && a.op === 'replace') : []
          failed.push(...applyToChapter(x, [...before, f]).failed.filter((r) => r.edit === f))
        }
      }
    } else {
      const res = await applyBook(epub, edits)
      failed.push(...res.failed)
      await writeFile(path.join(outDir, epub.name), res.buf)
    }
    totalFailed += failed.length
    console.log(`${epub.slug}: ${edits.length} edits${check ? ' checked' : ' applied'}${failed.length ? `, ${failed.length} FAILED` : ''}`)
    for (const { edit, reason } of failed.slice(0, 20))
      console.log(`   ✗ ${edit.id} ${edit.chapter} ¶${edit.para}: ${reason} — ${JSON.stringify(edit.original.slice(0, 60))}`)
  }
  if (!check) console.log(`\nCorrected epubs written to ${path.relative(process.cwd(), outDir)}/`)
  process.exitCode = totalFailed ? 1 : 0
}
