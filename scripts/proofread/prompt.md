You are proofreading one chunk of an English web novel ("Shadow Slave" by Guiltythree)
that was scraped from websites into an epub. The goal is to find **objective errors**
so a human can review each one and fix the epub. You do not edit anything yourself.

## Input

Read the whole chunk file `{CHUNK_FILE}` (use offset/limit reads until you reach the end —
do not skip any part). Format:

    ### <href> | <chapter title>
    [<paragraph index>] <paragraph text>
    (hint: …)            ← optional pointer to repeated wording worth checking

Lines like `[12] ⟨already removed: …⟩` were already handled — ignore them. Website
watermarks, look-alike letters and encoding damage have mostly been cleaned already;
report any that remain.

## What to report

1. **Typos & misspellings** — "templted" → "tempted", "dealy" → "deadly", "warry" → "wary".
2. **Wrong word** — homophones and slips: their/there/they're, its/it's, lose/loose,
   then/than, your/you're, to/too, "will helped" → "helped", wrong tense from a slip.
3. **Missing / extra / doubled words** — "he went the door", "the the", "to to".
4. **Broken punctuation** — missing or unmatched closing quote, doubled punctuation (",."),
   a space before punctuation, a missing space after a sentence end ("door.He").
5. **Doubled or misplaced text** — a sentence/fragment/block that appears twice in a row
   or is pasted in the wrong place (e.g. a phrase from later in the chapter repeated
   mid-paragraph, a sentence repeated with the first copy cut off, a paragraph that
   duplicates the previous one). Use the hints, but judge yourself: the author often
   repeats phrases **on purpose** for rhythm and emphasis — only report clear accidents.
6. **Leftover junk** — website watermarks, "read at …", translator/uploader notes,
   garbage characters, stray chapter titles inside the text, AI-chatbot leftovers.
7. **Garbled words** — look-alike letters, broken encoding ("palė" → "pale").

## What NOT to report (important — false alarms waste the reviewer's time)

- Style, voice, word choice, sentence fragments, comma preferences, repetition used for effect.
- British vs American spelling, "okay"/"OK", hyphenation variants that are common.
- Name variants that can be legitimate: nicknames vs full names (Cassie/Cassia, Effie/Athena,
  Neph/Nephis, Kai/Nightingale…), titles, a character addressing someone differently.
- In-world terms and their capitalization (Aspect, Memory, Echo, Nightmare Creature, Saint,
  Transcendent, Sunless, Nephis, Changing Star, Weaver…), names, made-up words.
- The author's conventions: thoughts in single quotes ('…'), «…» for one kind of speech,
  "…" / "..." ellipses, em dashes, [system messages in brackets].
- Anything you are not confident is an actual error.

## Output

Write a JSON array to `{OUT_FILE}` (use the Write tool; write `[]` if nothing found).
Each item:

```json
{
  "href": "OEBPS/page-12.html",
  "para": 34,
  "op": "replace",
  "original": "would be templted to call",
  "replacement": "would be tempted to call",
  "kind": "typo",
  "note": "misspelling",
  "confidence": "high"
}
```

- `original` MUST be copied **character-for-character** from that paragraph (keep curly
  quotes ’ “ ”, ellipses …, em dashes —). Keep it short but unique within the paragraph —
  include a few neighbouring words so the reviewer sees the context (≤ 100 characters,
  except for doubled/misplaced text where it is the whole repeated passage).
- `replacement` is the corrected version of exactly that span (may be "" to delete text).
- To delete whole paragraphs (a duplicated paragraph, a note, junk): `"op": "delete-paras"`,
  `"para"`: first index, `"paraEnd"`: last index (inclusive), `"original"`: the full text of
  those paragraphs, `"replacement": ""`.
- `kind`: one of `typo`, `wrong-word`, `missing-word`, `punctuation`, `duplicate`,
  `misplaced`, `junk`, `garbled`.
- `note`: a few words explaining the problem (for duplicates, say where the other copy is).
- `confidence`: `high` (certain) or `medium` (very likely). Don't report anything lower.

When you are done, reply with one line: the number of findings by kind.
