// Step 2 — deterministic, high-precision detectors over proofread/books/*.json.
// Writes proofread/findings/auto/<slug>.json. Findings share one shape:
//   { id, book, href, chapter, para, op, original, replacement, kind, source, note }
// op: 'replace'      → replace `original` (exact substring of the paragraph text) by `replacement`
//     'delete-paras' → delete paragraphs para..paraEnd (inclusive)
//     'title'        → replace the chapter title `original` by `replacement` (h2, <title>, toc)
// They also emit hints (repeated sentences) for the Claude pass: proofread/hints/<slug>.json.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { WORK } from './lib.mjs'

// --- character folding -------------------------------------------------------

// Look-alikes seen in these books (Cyrillic, Greek, Armenian, small caps, fullwidth…).
const CONFUSABLES = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ɡ: 'g', ո: 'n', օ: 'o', ս: 'u', г: 'r', κ: 'k', ο: 'o', ν: 'v', α: 'a',
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', Ѕ: 'S', І: 'I',
  ᴀ: 'a', ʙ: 'b', ᴄ: 'c', ᴅ: 'd', ᴇ: 'e', ꜰ: 'f', ɢ: 'g', ʜ: 'h', ɪ: 'i', ᴊ: 'j', ᴋ: 'k', ʟ: 'l', ᴍ: 'm',
  ɴ: 'n', ᴏ: 'o', ᴘ: 'p', ʀ: 'r', ꜱ: 's', ᴛ: 't', ᴜ: 'u', ᴠ: 'v', ᴡ: 'w', ʏ: 'y', ᴢ: 'z', ɾ: 'r', ℴ: 'o',
  ⅼ: 'l', є: 'e', ę: 'e', ṃ: 'm',
}
const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]|\u034f/g

/** Fold look-alikes to ASCII and drop invisible characters (keeps real accents like é). */
export function fold(s) {
  let out = ''
  for (const ch of s.replace(ZERO_WIDTH, '')) {
    if (CONFUSABLES[ch]) out += CONFUSABLES[ch]
    else if (/[！-～]/.test(ch)) out += String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
    else out += ch
  }
  return out
}

const PLAIN = /^[\x20-\x7e\u00a0‘’“”…—–«»àâäçéèêëîïìôöòûüùñœæÉÈÀÇ]*$/u
const isPlain = (s) => PLAIN.test(s)

// Aggressive skeleton used only to recognise site names hidden in watermarks.
const skeleton = (s) =>
  fold(s.normalize('NFKD'))
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/0/g, 'o')
    .replace(/3/g, 'e')
    .replace(/[^a-z]/g, '')

const SITES =
  /lightnovel|novelfire|novelfre|noveifire|lnovelfire|ranobes|novelbin|novelight|freewebnovel|webnovelcom|wuxiaworld|novelfull|boxnovel|mtlnovel|readnovel|novelupdates|9kafe|pandanovel|novelcave|lightnovelpub/

// Words watermark sentences are built from ("New novel chapters are published on…").
const WATERMARK_WORDS = new Set(
  `new novel novels chapter chapters are is published publish released hosted updated update updates first
  latest read reading on at by from the a this of source content rightful official link to origin
  information rests in google search visit find follow current available can be found should not ignored
  our channel tegram telegram receive version had it been dot and fresh full story get more for posted
  newest release updates originally comes text`.split(/\s+/),
)

const NOT_STORY =
  /^(\[?\s*(author'?s?|translator'?s?|editor'?s?|erdiul'?s?|tl|ed)\s*(note|n)\b|join our (channel|discord)|certainly! here'?s|here'?s the continuation|support (us|the author) on|← ?previous chapter|next chapter ?→)/i

// --- English vocabulary for homoglyph repair ---------------------------------

let DICT
async function dictionary(books) {
  if (DICT) return DICT
  DICT = new Set()
  try {
    for (const w of (await readFile('/usr/share/dict/words', 'utf8')).split('\n')) DICT.add(w.toLowerCase())
  } catch {
    /* no system word list: fall back to the books' own vocabulary */
  }
  const freq = new Map()
  for (const b of books)
    for (const c of b.chapters)
      for (const p of c.paras)
        for (const w of p.toLowerCase().match(/[a-z']+/g) ?? []) freq.set(w, (freq.get(w) ?? 0) + 1)
  for (const [w, n] of freq) if (n >= 3) DICT.add(w)
  return DICT
}
const isWord = (w) => {
  const bare = w.toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, '')
  return bare.length > 0 && /^[a-z'-]+$/.test(bare) && DICT.has(bare.replace(/'s$/, ''))
}

// --- detectors --------------------------------------------------------------

const norm = (s) => s.replace(/[\s\u00a0\ufeff\u200b-\u200d]+/g, ' ').trim()
const ENDS_SENTENCE = /[.!?…"'”’\])]$/

/** UTF-8 text that was decoded as Latin-1 ("déjÃ\u00a0vu", "â\u0080\u0099"): undo it, or null. */
export function unmojibake(t) {
  // Repair each broken byte run on its own: the word may also hold real accents ("déjÃ\u00a0").
  const RUN = /[Â-ô][\u0080-¿]+/g
  if (!RUN.test(t)) return null
  let ok = true
  const fixed = t.replace(RUN, (m) => {
    const s = Buffer.from(m, 'latin1').toString('utf8')
    if (s.includes('�')) ok = false
    return s
  })
  // Only accept repairs that land back in Latin script (an English book).
  return ok && !/[^\t\n\r -\u024f\u2000-\u206f]/.test(fixed) ? fixed : null
}

function classify(t) {
  const f = fold(t)
  const sk = skeleton(t)
  if (unmojibake(t) || /(?:[ÐÑ].){2}/.test(t)) return 'text' // broken encoding: repaired elsewhere
  if (SITES.test(sk) || /\.(com|net|org)\b/i.test(f.replace(/[^a-z.]/gi, ''))) return 'anchor'
  if (/[�©؀-ۿ]/.test(t) && !/\p{L}{3}/u.test(f)) return 'anchor'
  // Obfuscated URLs: "c`о/m", "ìgօw~օ", "n/o/vel/b//in", "c//om", "r.a", "b.i/n".
  if (/\p{L}[~`\\|]+\p{L}/u.test(t) || /\p{L}\/+\p{L}\/+\p{L}/u.test(t) || /\p{L}\/\/\p{L}/u.test(t)) return 'anchor'
  if (/^\p{L}([./|*:\\+"-]\p{L}){1,}$/u.test(t) && !/^\p{L}(\.\p{L})+\.?$/u.test(t)) return 'anchor'
  const odd = [...t].filter((ch) => !isPlain(ch)).length
  const bare = isPlain(f) ? f.toLowerCase().replace(/[^a-z]/g, '') : ''
  if (odd === 0) return WATERMARK_WORDS.has(bare) ? 'word' : 'text'
  if (/^[\s\p{P}․]+$/u.test(f)) return /․/.test(t) ? 'anchor' : 'punct'
  if (WATERMARK_WORDS.has(bare)) return 'oddword' // "ᴛʜɪs", "ѕhоuld": disguised watermark words
  if (isPlain(f) && isWord(f)) return 'homoglyph'
  // Readable word with a single odd character ("palÄ", "that®", "Ruín"): not a watermark —
  // left to the Claude pass.
  if (odd === 1 && /\p{L}{3}/u.test(f)) return 'text'
  return 'anchor'
}

/**
 * Watermarks and stray garbage inside a paragraph. Works on whitespace tokens:
 * an "anchor" is a token that hides a site name or is unreadable garbage; the
 * junk span grows over neighbouring watermark words within the junk sentence.
 */
function junkSpans(text) {
  const toks = []
  for (const m of text.matchAll(/\S+/g)) {
    // A watermark glued to the end of a story word: "himself?'n/ô/vel/b//jn", "him?Nôv(el)B\\jnn".
    const glued = m[0].match(/^(.*?\p{L}[.!?…]+['"”’]*)(\S{3,})$/u)
    if (glued && classify(glued[2]) === 'anchor' && isWord(glued[1].match(/\p{L}+(?=[^\p{L}]*$)/u)?.[0] ?? '')) {
      toks.push({ s: m.index, e: m.index + glued[1].length, t: glued[1] })
      toks.push({ s: m.index + glued[1].length, e: m.index + m[0].length, t: glued[2], glued: true })
    } else toks.push({ s: m.index, e: m.index + m[0].length, t: m[0] })
  }
  const n = toks.length
  const kind = toks.map(({ t }) => classify(t))
  const junky = (k) => k === 'anchor' || k === 'oddword' || k === 'punct'
  const spans = []
  for (let i = 0; i < n; i++) {
    if (kind[i] !== 'anchor') continue
    let a = i
    let b = i
    // Grow left over watermark words while still inside the junk sentence
    // ("New novel chapters are published on ‹site›"); plain words only count
    // if the run reaches a sentence boundary — otherwise they're story.
    while (a > 0 && (junky(kind[a - 1]) || kind[a - 1] === 'word') && !ENDS_SENTENCE.test(toks[a - 1].t) && !toks[a].glued) a--
    while (a < i && kind[a] === 'word' && a > 0 && !ENDS_SENTENCE.test(toks[a - 1].t)) a++
    // Grow right over disguised words / punctuation / further anchors; plain
    // watermark words only when another anchor follows them.
    for (;;) {
      if (b + 1 >= n || /[.!?]$/.test(fold(toks[b].t).replace(/․/g, '.'))) break
      if (junky(kind[b + 1])) {
        b++
        continue
      }
      let c = b + 1
      while (c < n && kind[c] === 'word') c++
      if (c < n && kind[c] === 'anchor' && c > b + 1) b = c
      else break
    }
    while (b + 1 < n && kind[b + 1] === 'punct') b++
    spans.push([a, b])
    i = b
  }
  const merged = []
  for (const sp of spans) {
    const last = merged.at(-1)
    if (last && sp[0] <= last[1] + 1) last[1] = Math.max(last[1], sp[1])
    else merged.push([...sp])
  }
  return {
    spans: merged.map(([a, b]) => ({ s: toks[a].s, e: toks[b].e })),
    homoglyphs: toks.filter((_, i) => kind[i] === 'homoglyph' && !merged.some(([a, b]) => i >= a && i <= b)),
    mojibake: toks.filter(({ t }) => unmojibake(t)),
  }
}

/** Remove [s,e) from text and tidy the seam. */
function cutSpan(text, s, e) {
  let S = s
  let E = e
  while (S > 0 && /\s/.test(text[S - 1])) S--
  while (E < text.length && /\s/.test(text[E])) E++
  const before = text.slice(0, S)
  let after = text.slice(E)
  // " lіght\nоvel\cаve~c`о/m .Scowling" — the junk swallowed the next sentence's leading dot.
  if (/^\.\p{Lu}/u.test(after)) E++, (after = after.slice(1))
  const glue = before && after ? ' ' : ''
  return { start: S, end: E, replacement: glue }
}

// Encoding damage that isn't plain UTF-8-as-Latin-1 (handled by unmojibake).
const MOJIBAKE = [
  [/Ã[ \u00a0]{1,2}/g, 'à '], // "déjÃ  vu": the no-break-space half of à became a space
  [/¬/g, '-'],
  [/\.„/g, '...'],
]

// Titles the source dropped (the long "…Abridged (Volume N)" recap chapters), looked up online.
const MISSING_TITLES = {
  139: 'The Incredible Adventures and Astonishing Deeds of Heroic Dreamer Sunless and His Beautiful Female Companions Princess Nephis and Lady Cassia, Abridged (Volume I)',
  463: 'The Incredible Adventures and Astonishing Deeds of Heroic Dreamer Sunless and his Stoic Stone Companions Talking Rock and Silent Saint, Abridged (Volume II)',
  1159: 'The Incredible Adventures and Astonishing Deeds of Heroic Dreamer Sunless in the Cold and Dreadful Darkness of the Long Night, Abridged (Volume V)',
  1422: 'The Incredible Adventures and Astonishing Deeds of Heroic Dreamer Sunless and his Valiant Companions in the Evil Pyramid of Ancient Dread, Abridged (Volume VI)',
}

function titleFix(title) {
  let t = fold(title).normalize('NFC').replace(/\s+/g, ' ').trim()
  t = t.replace(/^Chapter\W*(\d+)\s*[:.\-–—]?\s*/i, 'Chapter $1: ')
  const num = +t.match(/^Chapter (\d+)/)?.[1]
  if (/^Chapter \d+: $/.test(t) && MISSING_TITLES[num]) return `Chapter ${num}: ${MISSING_TITLES[num]}`
  // OCR-style l/L for I: "lnferno", "Trust lssues", "Lnto the Storm", "Lron Hand lsland".
  t = t.replace(/\b[lL]([a-z]+)\b/g, (m, r) => (!isWord(m) && isWord('i' + r) ? 'I' + r : m))
  t = t.replace(/\bl(?=[A-Z])/g, 'I')
  t = t.replace(/\s*,\s*/g, ', ').replace(/(\w)\s+\.(?!\.)/g, '$1.').replace(/([^.])\.$/, '$1')
  // Sentence-case the first word after "Chapter N:" if it starts lowercase.
  t = t.replace(/^(Chapter \d+: )([a-z])/, (m, p, c) => p + c.toUpperCase())
  return t
}

export async function detect(book, books) {
  await dictionary(books)
  const out = []
  const hints = []
  let seq = 0
  const add = (f) => out.push({ id: `auto-${book.slug}-${++seq}`, book: book.slug, source: 'auto', ...f })

  book.chapters.forEach((c, ci) => {
    if (!c.isChapter) return
    const at = { href: c.href, chapter: c.title }

    // Chapter title: look-alikes, invisible chars, missing colon, OCR l/I.
    const fixed = titleFix(c.title)
    if (fixed !== c.title.trim())
      add({ ...at, para: null, op: 'title', original: c.title, replacement: fixed, kind: 'title', note: /: $/.test(titleFix(c.title).slice(0, -1)) || /^Chapter\W*\d+\W*$/.test(c.title.trim()) ? 'Missing chapter title (looked up online)' : 'Clean up the chapter title' })

    // Title repeated as the first paragraph.
    // Either "Chapter 1475: Defiled Saints" or a bare "1475 Defiled Saints".
    const first = norm(fold(c.paras[0] ?? ''))
    const num = c.title.match(/\d+/)?.[0]
    if (first.length < 140 && (/^chapter\s*\d+/i.test(first) || (num && new RegExp(`^${num}\\b\\s*[:.\\-–—]?\\s*\\S`).test(first) && !/[.!?"”]$/.test(first))))
      add({ ...at, para: 0, op: 'delete-paras', paraEnd: 0, original: c.paras[0], replacement: '', kind: 'junk', note: 'Chapter title repeated as the first paragraph' })

    // Exact doubled blocks inside the chapter (keep the first copy).
    const N = c.paras.map(norm)
    const covered = new Set()
    for (let i = 0; i < N.length; i++) {
      for (let j = i + 1; j < N.length; j++) {
        if (covered.has(j) || N[i] !== N[j] || N[i].length < 10) continue
        let k = 0
        while (j + k < N.length && i + k < j && N[i + k] === N[j + k]) k++
        const chars = N.slice(j, j + k).join('').length
        // Single short repeats are usually deliberate ("He died in agony."); require substance.
        const consecutive = j === i + k
        if (!(k >= 2 || (consecutive && chars >= 25) || chars >= 200)) continue
        if (N.slice(j, j + k).every((t) => /^\[.*\]$/.test(t))) continue // system messages repeat by design
        for (let x = j; x < j + k; x++) covered.add(x)
        add({
          ...at,
          para: j,
          paraEnd: j + k - 1,
          op: 'delete-paras',
          original: c.paras.slice(j, j + k).join('\n\n'),
          replacement: '',
          kind: 'duplicate',
          note: `Same text as ¶${i + 1}${k > 1 ? `–${i + k}` : ''} of this chapter`,
          dupOf: { para: i, paraEnd: i + k - 1 },
        })
      }
    }

    c.paras.forEach((p, pi) => {
      if (covered.has(pi)) return
      // Notes and promos that aren't part of the story.
      if (NOT_STORY.test(norm(fold(p)))) {
        add({ ...at, para: pi, op: 'delete-paras', paraEnd: pi, original: p, replacement: '', kind: 'junk', note: 'Not part of the story (note / promo)' })
        return
      }
      // Several paragraphs fused into one <p> (line breaks inside it).
      const parts = p.split(/[ \t\u00a0]*\n\s*/).map((s) => s.trim()).filter(Boolean)
      if (parts.length > 1)
        add({ ...at, para: pi, op: 'split-para', original: p, replacement: parts.join('\n\n'), kind: 'format', note: `${parts.length} paragraphs merged into one` })
      // Watermarks / garbage.
      const { spans, homoglyphs, mojibake } = junkSpans(p)
      const cuts = spans.map(({ s, e }) => cutSpan(p, s, e))
      let rest = p
      for (const c of [...cuts].reverse()) rest = rest.slice(0, c.start) + c.replacement + rest.slice(c.end)
      rest = norm(rest)
      // Nothing (or a stub like "Btw, fuck") left once the junk is gone: drop the paragraph.
      if (cuts.length && (rest === '' || (rest.length < (cuts.length > 1 ? 30 : 12) && !/[.!?…"'”’]$/.test(rest))))
        add({ ...at, para: pi, op: 'delete-paras', paraEnd: pi, original: p, replacement: '', kind: 'junk', note: 'Website watermark / garbage paragraph' })
      else
        for (const c of cuts)
          add({ ...at, para: pi, op: 'replace', original: p.slice(c.start, c.end), replacement: c.replacement, kind: 'junk', note: 'Website watermark / garbage' })
      // Scan the text itself: the broken pair can straddle a no-break space ("déjÃ\u00a0vu").
      void mojibake
      for (const m of p.matchAll(/[^ \t\n]*?[\u00c2-\u00f4][\u0080-\u00bf]+[^ \t\n]*/g))
        if (unmojibake(m[0]))
          add({ ...at, para: pi, op: 'replace', original: m[0], replacement: unmojibake(m[0]), kind: 'encoding', note: 'Broken character encoding' })
      // Look-alike letters inside real words.
      for (const h of homoglyphs)
        add({ ...at, para: pi, op: 'replace', original: h.t, replacement: fold(h.t), kind: 'homoglyph', note: 'Look-alike (non-Latin) letters inside a word' })
      // Invisible characters left in otherwise clean text.
      if (!spans.length && ZERO_WIDTH.test(p)) {
        ZERO_WIDTH.lastIndex = 0
        const m = p.match(/\S*(?:[\u200b-\u200d\u2060\ufeff]|\u034f)\S*/)
        if (m && !homoglyphs.some((h) => h.t === m[0]))
          add({ ...at, para: pi, op: 'replace', original: m[0], replacement: m[0].replace(ZERO_WIDTH, ''), kind: 'invisible', note: 'Invisible zero-width characters' })
      }
      ZERO_WIDTH.lastIndex = 0
      // Mojibake.
      for (const [re, rep] of MOJIBAKE) {
        for (const m of p.matchAll(re)) {
          const s = Math.max(0, p.lastIndexOf(' ', m.index - 1) + 1)
          const eIdx = p.indexOf(' ', m.index + m[0].length)
          const word = p.slice(s, eIdx < 0 ? p.length : eIdx)
          add({ ...at, para: pi, op: 'replace', original: word, replacement: word.replace(re, rep), kind: 'encoding', note: 'Broken character encoding' })
        }
      }
      // Doubled word ("the the").
      for (const m of p.matchAll(/\b([a-z]+)\s+\1\b/g)) {
        if (/^(had|that|very|no|so|ha|he|hm|bye|knock|tick|now|go|run|yes|well|far|more|again|is|ah|oh|there|thump|drip|tap|step|out|on|down|deeper|faster|closer|higher|louder)$/.test(m[1]))
          continue
        add({ ...at, para: pi, op: 'replace', original: m[0], replacement: m[1], kind: 'typo', note: 'Doubled word' })
      }
      // Left quote used as an apostrophe ("didn‘t", "Sunny‘s").
      for (const m of p.matchAll(/\S*\p{L}‘\p{L}\S*/gu))
        add({ ...at, para: pi, op: 'replace', original: m[0], replacement: m[0].replace(/(\p{L})‘(?=\p{L})/gu, '$1’'), kind: 'punctuation', note: 'Opening quote used as an apostrophe' })
      // A sentence cut in two by a paragraph break: no closing punctuation here,
      // and the next paragraph carries on in lowercase.
      const next = c.paras[pi + 1]
      const end = p.trimEnd()
      if (next && !covered.has(pi + 1) && /[\p{Ll},;]$/u.test(end) && /^\s*\p{Ll}/u.test(next) && !/^\[/.test(end)) {
        const tail = end.slice(Math.max(0, end.lastIndexOf(' ', end.length - 25)))
        add({ ...at, para: pi, op: 'replace', original: tail, replacement: `${tail.trimEnd()} ${next.trim()}`, alsoDelete: pi + 1, join: true, kind: 'format', note: `Sentence split across two paragraphs (joins ¶${pi + 1} into this one)` })
      }
    })

    // Hints for the Claude pass: 8-word sequences repeated in nearby paragraphs.
    const seen = new Map()
    c.paras.forEach((p, pi) => {
      const w = norm(p).toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, '').split(' ')
      for (let i = 0; i + 8 <= w.length; i++) {
        const g = w.slice(i, i + 8).join(' ')
        const prev = seen.get(g)
        if (prev !== undefined && prev !== pi && pi - prev <= 12) {
          hints.push({ href: c.href, chapterIndex: ci, paras: [prev, pi], text: g })
          break
        }
        if (prev === undefined) seen.set(g, pi)
      }
    })
  })
  return { findings: out, hints }
}

// --- main -------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = path.join(WORK, 'books')
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
  const books = await Promise.all(files.map(async (f) => JSON.parse(await readFile(path.join(dir, f), 'utf8'))))
  books.sort((a, b) => a.slug.localeCompare(b.slug, 'en', { numeric: true }))
  await mkdir(path.join(WORK, 'findings', 'auto'), { recursive: true })
  await mkdir(path.join(WORK, 'hints'), { recursive: true })
  for (const book of books) {
    const { findings, hints } = await detect(book, books)
    await writeFile(path.join(WORK, 'findings', 'auto', `${book.slug}.json`), JSON.stringify(findings, null, 1))
    await writeFile(path.join(WORK, 'hints', `${book.slug}.json`), JSON.stringify(hints, null, 1))
    const byKind = Object.entries(Object.groupBy(findings, (f) => f.kind)).map(([k, v]) => `${k} ${v.length}`)
    console.log(`${book.slug}: ${findings.length} findings (${byKind.join(', ')}), ${hints.length} hints`)
  }
}
