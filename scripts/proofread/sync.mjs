// Proofreading on another device (the phone), offline.
//
//   node scripts/proofread/sync.mjs package          → proofread/out/ream-proofreading-<date>.json
//   node scripts/proofread/sync.mjs merge <file>     → fold a phone export into proofread/decisions.json
//
// (The review server offers the same two actions as buttons.)
//
// The package holds every finding plus the decisions taken so far; the Ream
// reader imports it and works fully offline. Each finding carries fingerprints
// of the paragraph text it was made for (src/lib/proof-key.js), so the reader
// matches it by content — whatever the book is called or however it's grouped.
// The reader later exports its own decisions; merging keeps, per finding, the
// most recent decision from either side.
import { readFile, rename, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { textKey } from '../../src/lib/proof-key.js'
import { WORK } from './lib.mjs'
import { loadDecisions, loadFindings } from './apply.mjs'

export const PACKAGE_FORMAT = 'ream-proofreading'
export const DECISIONS_FORMAT = 'ream-proofreading-decisions'

const books = new Map()
async function book(slug) {
  if (!books.has(slug)) books.set(slug, JSON.parse(await readFile(path.join(WORK, 'books', `${slug}.json`), 'utf8')))
  return books.get(slug)
}

/** A finding as the reader consumes it: the edit plus fingerprints of every paragraph it touches. */
export async function readerFinding(f) {
  const c = (await book(f.book)).chapters.find((c) => c.href === f.href)
  const check = {}
  const add = (i) => {
    if (i != null && c.paras[i] !== undefined) check[i] = textKey(c.paras[i])
  }
  if (f.para != null) {
    const end = f.op === 'delete-paras' ? f.paraEnd : f.para
    for (let i = f.para; i <= end; i++) add(i)
  }
  add(f.alsoDelete)
  if (f.dupOf) for (let i = f.dupOf.para; i <= f.dupOf.paraEnd; i++) add(i)
  const out = {
    id: f.id,
    book: f.book,
    href: f.href,
    op: f.op,
    kind: f.kind,
    source: f.source,
    note: f.note,
    original: f.original,
    replacement: f.replacement,
    check,
  }
  if (f.op === 'title') out.titleKey = textKey(c.title)
  for (const k of ['confidence', 'para', 'paraEnd', 'alsoDelete', 'join', 'dupOf']) if (f[k] != null && f[k] !== false) out[k] = f[k]
  return out
}

export async function buildPackage() {
  const findings = await loadFindings()
  const decisions = await loadDecisions()
  const out = []
  for (const f of findings) out.push(await readerFinding(f))
  const bookNames = {}
  for (const f of findings) bookNames[f.book] ??= (await book(f.book)).name
  return { format: PACKAGE_FORMAT, version: 1, createdAt: new Date().toISOString(), books: bookNames, findings: out, decisions }
}

/**
 * Fold a reader export into decisions.json. Per finding the newer decision wins
 * (by its `at` timestamp), so merging the same file twice — or files from two
 * devices — is safe.
 */
export async function mergeDecisions(incoming) {
  // A full proofreading file (any device's export) or an older decisions-only export.
  if (![PACKAGE_FORMAT, DECISIONS_FORMAT].includes(incoming?.format) || typeof incoming.decisions !== 'object')
    throw new Error("That file isn't a Ream proofreading file.")
  const known = new Set((await loadFindings()).map((f) => f.id))
  const file = path.join(WORK, 'decisions.json')
  const current = await loadDecisions()
  const stats = { added: 0, updated: 0, older: 0, unknown: 0 }
  for (const [id, d] of Object.entries(incoming.decisions)) {
    if (!known.has(id)) {
      stats.unknown++
      continue
    }
    if (!d || !['accepted', 'discarded'].includes(d.status)) continue
    const mine = current[id]
    if (mine && (mine.at ?? '') >= (d.at ?? '')) {
      stats.older++
      continue
    }
    current[id] = { ...d, from: d.from ?? 'phone' }
    stats[mine ? 'updated' : 'added']++
  }
  await writeFile(file + '.tmp', JSON.stringify(current, null, 1))
  await rename(file + '.tmp', file)
  return stats
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, arg] = process.argv.slice(2)
  if (cmd === 'package') {
    const pkg = await buildPackage()
    const dir = path.join(WORK, 'out')
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, 'ream-proofreading.json')
    await writeFile(file, JSON.stringify(pkg))
    const pending = pkg.findings.filter((f) => !pkg.decisions[f.id]).length
    console.log(`${path.relative(process.cwd(), file)} — ${pkg.findings.length} findings (${pending} pending)`)
  } else if (cmd === 'merge' && arg) {
    const s = await mergeDecisions(JSON.parse(await readFile(arg, 'utf8')))
    console.log(`Merged: ${s.added} new, ${s.updated} updated, ${s.older} kept (newer here), ${s.unknown} unknown`)
  } else {
    console.log('usage: sync.mjs package | sync.mjs merge <ream-proofreading….json>')
    process.exitCode = 1
  }
}
