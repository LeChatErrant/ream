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
   It also writes the app's copy, `src/soul-sea/shadow-slave.json`: item names,
   short labels and `[chapter, paragraph, fingerprint]` references only. **Commit
   it and deploy** after changing the timeline — that's what the reader uses.
3. `review.mjs` — `soul-sea/review.html`: pick a chapter, see the Soul Sea as of
   the end of it, the rune sheets, and the passage behind every change.

## timeline.json

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
| `history` (+ `to`) | a passage about the item; `flashback: true` when told out of order |

Order is **reading order**: a flashback (ch 122–168) adds history, it doesn't
rewind the inventory. Status sheets that aren't Sunny's are skipped by name;
list unnamed ones in `notSunny`. Known checkpoint differences go in
`checkpointNotes` with the reason.

## In the app

`src/soulsea.js`: on any book whose title or series name is *Shadow Slave*, the
reader's top bar gets a Soul Sea button. It replays the timeline up to the
reading position (earlier chapters + the paragraphs of the current one that have
been on screen) and loads rune sheets / passages from the imported volumes,
showing a paragraph only when its fingerprint matches.
