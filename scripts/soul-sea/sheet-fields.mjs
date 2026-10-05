// An item's sheet as flat "field → text" pairs, the way the panel shows it — for
// comparing two versions of the data (report.mjs) and spotting gaps (audit.mjs).
// Works on the app's data (src/soul-sea/shadow-slave.json) and soul-sea/text.json.
import { descText } from '../../src/lib/rune-sheet.js'

export const NONE = '(no description)'

/** Replay the app data like the app does: per item, its name and its sheets / told passages in order. */
export function itemsOf(data) {
  const items = {}
  const get = (id) => (items[id] ??= { id, kind: data.entries[id]?.kind, shown: [] })
  for (const e of data.events) {
    const x = get(e.id)
    if (e.type === 'gain') Object.assign(x, { name: e.name ?? e.label, since: e.at[0] })
    else if (e.type === 'become') Object.assign(get(e.to), { name: e.name, since: e.at[0] })
    else if (e.type === 'name') x.name = e.value
    else if (e.type === 'runes' || e.type === 'told') x.shown.push(e)
  }
  return Object.values(items).filter((x) => x.kind !== 'stat')
}

const passage = (e, text) => 'In the story: ' + e.paras.map((r) => text[r.ch ?? e.at[0]]?.[r.p]).join(' ¶ ')

/** What the panel shows for item `x` as of chapter `c`: its latest rune sheet, with the latest told passage standing in for a missing description (as in the app). */
export function fieldsAt(x, c, text) {
  const sheet = x.shown.filter((e) => e.type === 'runes' && e.at[0] <= c).at(-1)
  const told = x.shown.filter((e) => e.type === 'told' && e.at[0] <= c).at(-1)
  if (sheet) return fieldsOf(sheet, told, text)
  const out = new Map()
  if (!told) return out
  for (const [k, ns] of Object.entries(told.names ?? {})) for (const n of ns) out.set(`${k} › ${n}`, NONE)
  out.set('Description', passage(told, text))
  return out
}

/** The fields of one rune sheet (the new format); `told`, a passage standing in for its missing description. */
export function fieldsOf(e, told, text) {
  const t = (r) => text[r.ch ?? e.at[0]]?.[r.p]
  const out = new Map()
  const desc = (d) => descText(d.map((r) => ({ ...r, t: t(r) })))
  const sh = e.sheet
  for (const [k, v] of sh.f) out.set(k, v)
  out.set('Description', sh.d ? desc(sh.d) : told ? passage(told, text) : NONE)
  for (const l of sh.l) for (const n of l.n) out.set(`${l.k} › ${n.n}`, n.d ? desc(n.d) : NONE)
  for (const n of sh.o ?? []) out.set(`(outside any list) ${n.n ?? n.k}`, desc(n.d))
  return out
}
