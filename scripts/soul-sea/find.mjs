// Search the text: node scripts/soul-sea/find.mjs "<regex>" <fromCh> <toCh> [maxChars]
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { WORK } from './lib.mjs'

const text = JSON.parse(await readFile(path.join(WORK, 'text.json'), 'utf8'))
const [re, from = 1, to = 9999, max = 300] = process.argv.slice(2)
const R = new RegExp(re, 'i')
for (let c = +from; c <= +to; c++) (text[c] || []).forEach((t, i) => R.test(t) && console.log(`${c}:${i} ${t.slice(0, +max)}`))
