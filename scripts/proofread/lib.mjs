// Shared helpers for the proofreading pipeline (scripts/proofread/*).
// Not part of the app: these run in Node against the epub files on disk.
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'

export const ROOT = path.resolve(import.meta.dirname, '../..')
export const WORK = path.join(ROOT, 'proofread')

export const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/\.epub$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

/** The *.epub files at the repo root, in natural (volume) order. */
export async function listEpubs() {
  const names = (await readdir(ROOT)).filter((n) => n.endsWith('.epub'))
  return names
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map((name) => ({ name, file: path.join(ROOT, name), slug: slugify(name) }))
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }

export const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#')
      return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1))
    return ENTITIES[e.toLowerCase()] ?? m
  })

export const encode = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Plain text of a fragment of chapter markup. */
export const textOf = (html) =>
  decode(html.replace(/<br\s*\/?>/gi, ' ').replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ''))

/**
 * Every <p>…</p> in a chapter file, with its raw span so edits can be applied
 * in place without re-serialising the document.
 */
export function paragraphs(xhtml) {
  const out = []
  const re = /<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g
  let m
  while ((m = re.exec(xhtml))) {
    out.push({ start: m.index, end: m.index + m[0].length, open: m[0].slice(0, m[0].indexOf('>') + 1), inner: m[1], text: textOf(m[1]) })
  }
  return out
}

/** Open an epub and return its zip plus the spine-ordered chapter files. */
export async function openEpub(file) {
  const zip = await JSZip.loadAsync(await readFile(file))
  const container = await zip.file('META-INF/container.xml').async('string')
  const opfPath = container.match(/full-path="([^"]+)"/)[1]
  const opf = await zip.file(opfPath).async('string')
  const base = path.posix.dirname(opfPath)
  const manifest = new Map()
  for (const [, attrs] of opf.matchAll(/<item\s([^>]+?)\/?>/g)) {
    const id = attrs.match(/\bid="([^"]+)"/)?.[1]
    const href = attrs.match(/\bhref="([^"]+)"/)?.[1]
    if (id && href) manifest.set(id, path.posix.join(base === '.' ? '' : base, decodeURIComponent(href)))
  }
  const spine = [...opf.matchAll(/<itemref\s[^>]*idref="([^"]+)"/g)].map((m) => manifest.get(m[1])).filter(Boolean)
  return { zip, spine }
}

/** Chapters of an epub as { href, title, paras: string[] } (front matter included, flagged). */
export async function readChapters(file) {
  const { zip, spine } = await openEpub(file)
  const chapters = []
  for (const href of spine) {
    const xhtml = await zip.file(href).async('string')
    const title = textOf(xhtml.match(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/)?.[1] ?? xhtml.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? href).trim()
    const paras = paragraphs(xhtml).map((p) => p.text)
    chapters.push({ href, title, isChapter: /^Chapter\W*\d+/i.test(title), paras })
  }
  return chapters
}

// ---- text outside paragraphs -------------------------------------------------
// Some chapters (Shadow Slave vol 8–10) carry text that isn't in a <p>: the title
// repeated as an <h3> or a list item, a paragraph that lost its <p> tags, lines
// separated by <br>, ads and watermarks in made-up tags. paragraphs() never sees
// them, so they get their own pass (loose.mjs).

const KNOWN_TAGS = new Set(
  'a abbr b bdi bdo blockquote br caption cite code col colgroup dd del details dfn div dl dt em figcaption figure font footer h1 h2 h3 h4 h5 h6 header hr i img ins kbd label li main mark nav ol p pre q rp rt ruby s samp section small span strong sub summary sup table tbody td tfoot th thead time tr u ul var wbr'.split(' '),
)
const INLINE = new Set('b i em strong span u s small sub sup font mark abbr cite q code'.split(' '))

/**
 * Blocks of text in a chapter body that sit outside every <p>:
 *   { type: 'element', tag, start, end, text }  an element holding text (heading,
 *     list, link, made-up tag) — `start`/`end` span the whole element;
 *   { type: 'text', start, end, text }  a run of bare text (with inline markup)
 *     between block boundaries — `end` includes a following <br>, if any.
 * Offsets index the raw XHTML, so edits can be made in place.
 */
export function looseBlocks(xhtml) {
  const at = xhtml.indexOf('chapter-ugc')
  if (at < 0) return []
  const from = xhtml.indexOf('>', at) + 1
  const to = xhtml.lastIndexOf('</body>')
  const out = []
  let run = null // current bare-text run
  const flush = (end) => {
    if (run && /\p{L}/u.test(textOf(xhtml.slice(run.start, run.end)))) {
      let e = run.end
      const br = xhtml.slice(e, end).match(/^\s*<br\s*\/?>/)
      if (br) e += br[0].length
      out.push({ type: 'text', start: run.start, end: e, text: textOf(xhtml.slice(run.start, run.end)).replace(/\s+/g, ' ').trim() })
    }
    run = null
  }
  const re = /<!--[\s\S]*?-->|<(script|style)\b[\s\S]*?<\/\1>|<p(?:\s[^>]*)?>[\s\S]*?<\/p>|<\/?([a-zA-Z][\w-]*)\b[^>]*?\/?>|[^<]+/g
  re.lastIndex = from
  let m
  while ((m = re.exec(xhtml)) && m.index < to) {
    const tok = m[0]
    if (tok.startsWith('<!--') || m[1] || /^<p[\s>]/i.test(tok)) {
      flush(m.index)
      continue
    }
    if (m[2]) {
      const name = m[2].toLowerCase()
      const closing = tok.startsWith('</')
      if (INLINE.has(name)) {
        if (run) run.end = m.index + tok.length
        continue
      }
      flush(m.index)
      if (closing || tok.endsWith('/>') || name === 'br' || name === 'div' || name === 'img' || name === 'hr') continue
      // An element that can hold text on its own: take it whole, if it does.
      const close = new RegExp(`</${name}\\s*>`, 'ig')
      close.lastIndex = m.index + tok.length
      const c = close.exec(xhtml)
      if (!c) continue
      const end = c.index + c[0].length
      const inner = xhtml.slice(m.index + tok.length, c.index)
      // A container of paragraphs (an <article>, a <section>…): look inside it instead.
      if (/<(p|div|article|section|blockquote|ul|ol|table|h[1-6])[\s>/]/i.test(inner) && !/^(ol|ul)$/.test(name)) continue
      const text = textOf(inner).replace(/\s+/g, ' ').trim()
      if (/\p{L}/u.test(text)) out.push({ type: 'element', tag: name, known: KNOWN_TAGS.has(name), start: m.index, end, text })
      re.lastIndex = end
      continue
    }
    // bare text
    if (!run) {
      if (!tok.trim()) continue
      run = { start: m.index, end: m.index + tok.length }
    } else run.end = m.index + tok.length
  }
  flush(to)
  return out
}
