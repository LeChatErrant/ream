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
