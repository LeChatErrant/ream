// Step 4 — local review UI: node scripts/proofread/review.mjs → http://localhost:5180
// Shows every finding in context; Accept / Discard / Edit are saved to
// proofread/decisions.json as you go, and "Write corrected epubs" runs apply.mjs.
// It also serves the Ream reader's proofreading mode (/api/proof/*): the app asks
// for the current chapter's findings and posts decisions back into the same file.
import { execFile } from 'node:child_process'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { ROOT, WORK } from './lib.mjs'
import { loadDecisions, loadFindings } from './apply.mjs'
import { buildPackage, mergeDecisions, readerFinding } from './sync.mjs'

const PORT = +(process.env.PORT ?? 5180)
const DECISIONS = path.join(WORK, 'decisions.json')

const books = new Map()
async function book(slug) {
  if (!books.has(slug)) books.set(slug, JSON.parse(await readFile(path.join(WORK, 'books', `${slug}.json`), 'utf8')))
  return books.get(slug)
}

const ORDER = { junk: 0, duplicate: 1, misplaced: 2, typo: 3, 'wrong-word': 4, 'missing-word': 5, garbled: 6, homoglyph: 7, encoding: 8, invisible: 9, punctuation: 10, format: 11, title: 12 }

const ingest = () =>
  new Promise((ok) => execFile(process.execPath, [path.join(import.meta.dirname, 'ingest.mjs')], { cwd: ROOT }, () => ok()))

async function data() {
  await ingest() // pick up Claude findings written since the last load
  const findings = await loadFindings()
  const out = []
  for (const f of findings) {
    const b = await book(f.book)
    const ci = b.chapters.findIndex((c) => c.href === f.href)
    const c = b.chapters[ci]
    const x = { ...f, chapterIndex: ci, volume: b.name.replace(/\.epub$/, '') }
    if (f.para != null) {
      const end = f.paraEnd ?? f.para
      x.paras = c.paras.slice(f.para, end + 1)
      x.prev = c.paras[f.para - 1] ?? null
      x.next = c.paras[end + 1] ?? null
      if (f.alsoDelete != null) {
        x.joined = c.paras[f.alsoDelete]
        x.next = c.paras[f.alsoDelete + 1] ?? null
      }
      if (f.dupOf) x.dupParas = c.paras.slice(f.dupOf.para, f.dupOf.paraEnd + 1)
    }
    out.push(x)
  }
  const vol = (s) => +s.match(/(\d+)$/)[1]
  out.sort((a, b) => vol(a.book) - vol(b.book) || a.chapterIndex - b.chapterIndex || (a.para ?? -1) - (b.para ?? -1) || (ORDER[a.kind] ?? 20) - (ORDER[b.kind] ?? 20))
  return { findings: out, decisions: await loadDecisions() }
}

/** One chapter's findings for the reader (same shape as the phone package), plus the decisions so far. */
async function chapterFindings(slug, href) {
  const b = await book(slug).catch(() => null)
  // The reader's spine href is relative to the OPF; ours is zip-relative.
  const c = b?.chapters.find((c) => c.href === href || c.href.endsWith('/' + href))
  if (!c) return { findings: [], decisions: {} }
  const decisions = await loadDecisions()
  const all = (await loadFindings()).filter((f) => f.book === slug)
  const findings = []
  for (const f of all.filter((f) => f.href === c.href)) findings.push(await readerFinding(f))
  const mine = Object.fromEntries(findings.filter((f) => decisions[f.id]).map((f) => [f.id, decisions[f.id]]))
  return { bookPending: all.filter((f) => !decisions[f.id]).length, findings, decisions: mine }
}

// The deployed reader (https) talks to this local server: allow its origin, and
// answer Chrome's Private Network Access preflight.
const ALLOWED = /^(https:\/\/lechaterrant\.github\.io|http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?)$/
function cors(req, res) {
  const origin = req.headers.origin
  if (!origin || !ALLOWED.test(origin)) return
  res.setHeader('access-control-allow-origin', origin)
  res.setHeader('vary', 'origin')
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  res.setHeader('access-control-allow-headers', 'content-type')
  res.setHeader('access-control-allow-private-network', 'true')
}

let saving = Promise.resolve()
async function saveDecisions(updates) {
  // Serialise writes; write-then-rename so a crash never leaves half a file.
  saving = saving.then(async () => {
    const d = await loadDecisions()
    for (const [id, v] of Object.entries(updates)) {
      if (v === null) delete d[id]
      else d[id] = { ...v, at: new Date().toISOString() }
    }
    await writeFile(DECISIONS + '.tmp', JSON.stringify(d, null, 1))
    await rename(DECISIONS + '.tmp', DECISIONS)
    return d
  })
  return saving
}

const body = (req) =>
  new Promise((ok, ko) => {
    let s = ''
    req.on('data', (c) => (s += c))
    req.on('end', () => ok(s ? JSON.parse(s) : {}))
    req.on('error', ko)
  })

const send = (res, code, type, payload) => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(payload)
}

createServer(async (req, res) => {
  cors(req, res)
  if (req.method === 'OPTIONS') return send(res, 204, 'text/plain', '')
  const url = new URL(req.url, 'http://localhost')
  try {
    if (req.method === 'GET' && url.pathname === '/api/proof/ping') return send(res, 200, 'application/json', '{"ok":true}')
    if (req.method === 'GET' && url.pathname === '/api/proof/chapter')
      return send(res, 200, 'application/json', JSON.stringify(await chapterFindings(url.searchParams.get('book'), url.searchParams.get('href'))))
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html'))
      return send(res, 200, 'text/html; charset=utf-8', await readFile(path.join(import.meta.dirname, 'review.html')))
    if (req.method === 'GET' && req.url === '/api/data') return send(res, 200, 'application/json', JSON.stringify(await data()))
    // Offline package for the phone, and merging the phone's decisions back.
    if (req.method === 'GET' && url.pathname === '/api/proof/package') {
      const pkg = await buildPackage()
      res.setHeader('content-disposition', `attachment; filename="ream-proofreading-${pkg.createdAt.slice(0, 10)}.json"`)
      return send(res, 200, 'application/json', JSON.stringify(pkg))
    }
    if (req.method === 'POST' && url.pathname === '/api/proof/merge') {
      try {
        return send(res, 200, 'application/json', JSON.stringify({ ok: true, ...(await mergeDecisions(await body(req))) }))
      } catch (e) {
        return send(res, 400, 'application/json', JSON.stringify({ ok: false, error: e.message }))
      }
    }
    if (req.method === 'POST' && req.url === '/api/decisions') {
      await saveDecisions(await body(req))
      return send(res, 200, 'application/json', '{"ok":true}')
    }
    if (req.method === 'POST' && req.url === '/api/apply') {
      execFile(process.execPath, [path.join(import.meta.dirname, 'apply.mjs')], { cwd: ROOT }, (err, stdout, stderr) =>
        send(res, 200, 'application/json', JSON.stringify({ ok: !err, log: stdout + stderr, out: path.join(WORK, 'out') })),
      )
      return
    }
    send(res, 404, 'text/plain', 'not found')
  } catch (e) {
    send(res, 500, 'text/plain', String(e.stack ?? e))
  }
}).listen(PORT, () => console.log(`Review at http://localhost:${PORT}`))
