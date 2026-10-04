# Proofreading pipeline

Standalone tooling (not part of the app) that finds errors in scraped web-novel
epubs, lets you review each one, and writes corrected copies. Works on every
`*.epub` at the repo root; all working files go to `proofread/` (gitignored —
it holds book text).

```bash
node scripts/proofread/extract.mjs   # 1. epub → proofread/books/<slug>.json (paragraph-indexed text)
node scripts/proofread/detect.mjs    # 2. automatic detectors → proofread/findings/auto/
node scripts/proofread/chunk.mjs     # 3a. ~28k-word chunks for the Claude pass → proofread/chunks/
#   3b. Claude agents proofread each chunk with prompt.md → proofread/findings/claude/<chunk>.json
node scripts/proofread/ingest.mjs    # 3c. normalise + validate Claude findings (idempotent)
node scripts/proofread/review.mjs    # 4. review UI at http://localhost:5180 → proofread/decisions.json
node scripts/proofread/apply.mjs     # 5. accepted fixes → proofread/out/<same name>.epub
node scripts/proofread/apply.mjs --check   # verify every finding still locates its text
```

**Automatic detectors** (`detect.mjs`): site watermarks (incl. look-alike-letter,
small-caps, zero-width and bogus-tag disguises), garbage stamps, look-alike
letters inside real words, broken encoding (`déjÃ  vu`), invisible characters,
exact doubled blocks, the chapter title repeated as a paragraph, paragraphs
fused with line breaks, sentences split across two paragraphs, `‘` used as an
apostrophe, doubled words, chapter-title clean-up (missing colon, `lnferno` → `Inferno`).

**While reading in Ream**: run `npm run proofread` (the review server) on this
computer, then open the reader drawer and switch **Proofreading** on. Each chapter's
open suggestions are marked in the text (paragraph-level ones get a side bar);
tap one — or the `✎ n` pill in the top bar to jump to the next — and Accept (`A`),
Edit, Discard (`D`) or Later. Decisions go into the same `decisions.json`, and
accepted fixes show applied as you read. The deployed app reaches the local server
over `http://localhost:5180`; Chrome asks once to allow local-network access.

**Between devices (offline on the phone)**: one proofreading file — every finding
plus every decision known on that device — goes back and forth, and importing it
always merges (per finding, the most recent decision wins, so importing twice or
from several devices is safe).
- *From the computer*: in Ream's reader drawer → **Proofreading** → *Export
  proofreading* (reading against the local server), or **Export proofreading** on
  the review page, or `npm run proofread:package`.
- *On the phone*: drawer → Proofreading → *Import proofreading…*; everything then
  works offline. After reading, *Export proofreading* (share sheet → AirDrop).
- *Back on the computer*: drawer → Proofreading → *Import proofreading…* in Ream,
  or **Import proofreading** on the review page, or `npm run proofread:merge -- <file>`.
Findings are matched by paragraph fingerprints (`src/lib/proof-key.js`), so
separate volumes, a grouped series or renamed files all work.

**Review UI** keys: `A`/`Enter` accept · `D` discard · `E` edit the fix ·
`O` delete the other copy (duplicates) · `J`/`K` next/previous · `U` undo.
"Accept all shown…" accepts everything matching the current filters.

Edits are applied to the raw XHTML in place, so untouched markup stays
byte-identical; the `mimetype` entry stays first and uncompressed.
