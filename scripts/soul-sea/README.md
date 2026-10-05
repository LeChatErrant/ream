# Soul Sea pipeline (Shadow Slave)

Builds Sunny's inventory — Memories, Echoes, Shadows, Attributes, Aspect,
abilities, Flaw, rank — as a timeline tied to reading position, using **only
the book's words**. Works on the `Shadow slave - vol N.epub` files at the repo
root; working files go to `soul-sea/` (gitignored — it holds book text).

```bash
npm run soul-sea    # extract → build → review, then open soul-sea/review.html
```

1. `extract.mjs` — every rune block (`Memory: [...]`, `Memory Rank: ...`, status
   sheets…) and every Spell message (`[You have received a Memory: ...]`), with
   chapter, paragraph index and paragraph fingerprint → `soul-sea/runes.json`,
   plus the plain text → `soul-sea/text.json`.
2. `build.mjs` — resolves the hand-curated `timeline.json` against the text →
   `soul-sea/resolved.json`. Fails if any anchor is missing or any shown string
   (name, label, stat value) isn't verbatim in the paragraph it cites. Replays
   the timeline against every rune list Sunny reads (the checkpoints) and
   reports disagreements. Sunny's Shadow Fragments are derived from the runes.
   It also reads every rune sheet (`src/lib/rune-sheet.js`) — facts, lists, which
   description goes with which listed name, the book's typos paired up
   ("Chifonnier" / "Chiffonnier", spelled the book's usual way) — and writes the
   app's copy, `src/soul-sea/shadow-slave.json`: item and enchantment names, short
   values (Rank, Tier…) and, for every description, only the paragraphs to rebuild
   it from (`[chapter, paragraph, fingerprint, similarity signature]`), checking
   that each rebuilds exactly. **Commit it and deploy** after changing the
   timeline — that's what the reader uses.
3. `review.mjs` — `soul-sea/review.html`: pick a chapter, see the Soul Sea as of
   the end of it, the rune sheets, and the passage behind every change.

## Checking

- `node scripts/soul-sea/audit.mjs [--all] [--to N] [name…]` — what the panel would show
  badly: a listed Enchantment / Attribute / Ability with no description, an item with
  none, nothing shown at all. Gaps the book itself leaves go in `knownGaps` (any part
  file: `{ "<id>": ["Enchantments › Enhanced Durability"] }`, reason in `knownGapNotes`).
- `node scripts/soul-sea/report.mjs <dir> [toChapter]` — field-by-field before → after
  against an older copy of the app data (`<dir>/app.json` + the `rune-sheet.js` of that
  time as `<dir>/rune-sheet.mjs`) → `soul-sea/report.html`.

## Lookup tools

- `node scripts/soul-sea/runes-in.mjs <from> <to>` — every rune block and Spell message in a chapter range
- `node scripts/soul-sea/ctx.mjs 104:20 104:41:2:9 104` — passages with their paragraph indices
- `node scripts/soul-sea/find.mjs "<regex>" <from> <to>` — search the text

## timeline.json + parts/

`timeline.json` holds chapters 1–204 and the shared settings; `parts/*.json` hold the
rest, one chapter range each, with a `seed` (what Sunny holds when the part starts).
`node scripts/soul-sea/build.mjs --part parts/<file>.json` checks one part on its own
(replayed from its seed, its own checkpoints, nothing written); the plain build merges
everything and reports any seed that disagrees with the parts before it. Mapped
through ch 2882 (end of volume 11, the latest available).

Hand-curated, reviewed through `reviewedThrough`. Holds **no book text** beyond
item names and short labels, each verified against its cited paragraph — the
app will render rune sheets and passages from the reader's own epub.

Events, anchored at `"chapter:paragraph"` (paragraph index as in `text.json`):

| event | meaning |
| --- | --- |
| `gain` + `name` or `label` | starts holding it; `label` is a quote for an item not yet named |
| `name` + `value` | the item gets its name |
| `lose` + `how` | stops holding it (`destroyed`, `given`, `consumed`…) |
| `become` + `to` + `name` | turns into another entry (Echo → Shadow, Attribute evolution) |
| `set` + `value` | a stat (True Name, Rank, Core) |
| `runes` (+ `to`) | the rune sheet: rune lines in that paragraph range |
| `source` + `value` | where it came from: the creature slain, the giver (“Obtained from”) |
| `fact` + `label` + `value` | a Rank / Class / Tier / Type the book states in prose (\"now a Transcendent Devil\"); shown until a newer rune sheet |
| `told` (+ `to`, `names`) | narration describing an item the runes don't (Essence Pearl, Bone Singer): shown when the item has no rune sheet, or one with no description of its own; `names` = `{ "Enchantments": [...] }` it names |
| `history` (+ `to`) | a passage about the item (review page only); `flashback: true` when told out of order |

Order is **reading order**: a flashback (ch 122–168) adds history, it doesn't
rewind the inventory. Status sheets that aren't Sunny's are skipped by name;
list unnamed ones in `notSunny`. Known checkpoint differences go in
`checkpointNotes` with the reason.

## In the app

`src/soulsea.js`: on any book whose title or series name is *Shadow Slave*, the
reader's top bar gets a Soul Sea button. It replays the timeline up to the
chapter on screen, excluded — a chapter's changes show from the next chapter on,
so opening the panel mid-chapter spoils nothing — lists the gains, evolutions and
losses of the last 15 chapters as "Recently …", and fills each sheet's descriptions
from the imported volumes: the paragraph with the same fingerprint, or — in a copy
edited a little (a typo fixed, a proofread epub) — the one near the same place whose
similarity signature nearly matches (9 of 12 bytes, length within 25%). Never a
different paragraph: a description the copy doesn't have says so.
