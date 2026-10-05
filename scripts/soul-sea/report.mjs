// What changed in the Soul Sea between two versions of the app data, field by
// field, for eyeballing: `node scripts/soul-sea/report.mjs <before-dir> [toChapter]`.
// <before-dir> holds app.json (an older src/soul-sea/shadow-slave.json) and
// rune-sheet.mjs (the src/lib/rune-sheet.js of that time, for the older format).
// Writes soul-sea/report.html (book text: stays local, like everything in soul-sea/).
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { APP_DATA, WORK } from './lib.mjs'
import { NONE, fieldsAt, itemsOf } from './sheet-fields.mjs'

const [dir, to = '99999'] = process.argv.slice(2)
const upto = +to
const text = JSON.parse(await readFile(path.join(WORK, 'text.json'), 'utf8'))
const after = JSON.parse(await readFile(APP_DATA, 'utf8'))
const before = JSON.parse(await readFile(path.join(dir, 'app.json'), 'utf8'))
const old = await import(pathToFileURL(path.resolve(dir, 'rune-sheet.mjs')))
const vols = JSON.parse(await readFile(path.join(WORK, 'runes.json'), 'utf8')).chapters

// The older format: runes events carry paragraphs, read in the app.
function oldFields(e, x) {
  const out = new Map()
  const paras = e.paras.map((r) => ({ t: text[r.ch ?? e.at[0]]?.[r.p], cont: !!r.c, s: r.s })).filter((r) => r.t != null)
  const { facts, lists, notes, epigraph } = old.readSheet(paras, { ...x, facts: {} })
  for (const f of facts) out.set(f.label, f.value)
  out.set('Description', epigraph ?? NONE)
  const placed = new Set()
  for (const l of lists)
    for (const name of l.names) {
      const n = notes.find((m) => m.title === name)
      if (n) placed.add(n)
      out.set(`${l.label} › ${name}`, n ? n.text : NONE)
    }
  for (const n of notes) if (!placed.has(n)) out.set(`(outside any list) ${n.title ?? n.kind}`, n.text)
  return out
}

const oldItems = Object.fromEntries(itemsOf(before).map((x) => [x.id, x]))
const rows = []
for (const x of itemsOf(after)) {
  const o = oldItems[x.id] ?? { shown: [] }
  const chapters = [...new Set([...x.shown, ...o.shown].map((e) => e.at[0]))].filter((c) => c <= upto).sort((a, b) => a - b)
  const reported = new Set()
  const changes = []
  for (const c of chapters) {
    const oe = o.shown.filter((e) => e.at[0] <= c).at(-1)
    const nf = fieldsAt(x, c, text)
    const of = oe ? oldFields(oe, { ...x, name: o.name ?? x.name }) : new Map()
    if (!oe) of.set('Description', '(nothing: “No runes shown yet”)')
    for (const k of new Set([...of.keys(), ...nf.keys()])) {
      const a = of.get(k) ?? null
      const b = nf.get(k) ?? null
      if (a === b) continue
      const id = `${k}|${a}|${b}`
      if (reported.has(id)) continue
      reported.add(id)
      changes.push({ c, k, a, b })
    }
  }
  // A description that only moved (from "outside any list", or from a misspelled
  // name) into its place: one row, saying where it was.
  for (const gone of changes.filter((ch) => ch.b == null && ch.a && ch.a !== NONE)) {
    const into = changes.find((ch) => ch !== gone && ch.c === gone.c && ch.b === gone.a)
    if (!into) continue
    into.was = gone.k
    changes.splice(changes.indexOf(gone), 1)
  }
  if (changes.length) rows.push({ x, changes })
}
rows.sort((p, q) => p.x.since - q.x.since)

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
const val = (v) => (v == null ? '<i class="gone">(not shown)</i>' : v === NONE || v.startsWith('(nothing') ? `<i class="none">${esc(v)}</i>` : esc(v))
let html = `<!doctype html><meta charset="utf-8"><title>Soul Sea changes</title><style>
body{font:14px/1.45 system-ui;margin:24px auto;max-width:1100px;padding:0 16px;background:#16181c;color:#ddd}
h1{font-size:20px}h2{font-size:15px;margin:28px 0 6px;color:#9fe0b8;border-bottom:1px solid #333;padding-bottom:4px}
h3{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#888;margin:40px 0 0}
table{border-collapse:collapse;width:100%}td{vertical-align:top;padding:6px 8px;border-top:1px solid #2a2d33}
td{white-space:pre-wrap}td.k{width:22%;color:#bbb}td.c{width:5%;color:#777;white-space:nowrap}td.a{width:36%;color:#e0a39b}td.b{width:37%;color:#cfe8d8}
i.none,i.gone{color:#777}.n{color:#888;font-size:12px}</style>
<h1>Soul Sea — what changed${upto < 99999 ? ` (chapters 1–${upto})` : ''}</h1>
<p class="n">${rows.length} items, ${rows.reduce((n, r) => n + r.changes.length, 0)} changes. Each row: the field, the chapter of the sheet where it first differs, before → after.</p>`
let vol = 0
for (const { x, changes } of rows) {
  const v = vols[x.since]?.vol
  if (v !== vol) html += `<h3>Volume ${(vol = v)}</h3>`
  html += `<h2>${esc(x.name ?? x.id)} <span class="n">${x.kind} · from ch ${x.since}</span></h2><table>`
  for (const ch of changes)
    html += `<tr><td class="k">${esc(ch.k)}</td><td class="c">ch ${ch.c}</td><td class="a">${val(ch.a)}${ch.was ? `<br><span class="n">(the text was shown as “${esc(ch.was)}”)</span>` : ''}</td><td class="b">${val(ch.b)}</td></tr>`
  html += '</table>'
}
await writeFile(path.join(WORK, 'report.html'), html)
console.log(`${rows.length} items changed → soul-sea/report.html`)
for (const { x, changes } of rows) console.log(`${x.name ?? x.id}: ${changes.length}`)
