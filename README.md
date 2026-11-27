# Ream

A minimal EPUB reader that renders like Webnovel's dark night-mode:
Merriweather 18px / 1.8 line-height, `#1f2129` page, `#83848f` text,
ragged-left, no indent, spaced paragraphs. Chapters are read one at a time
with an end-of-chapter "Previous / Next chapter" break.

Everything runs locally in the browser — no book ever leaves your device.

## Features

- Open any `.epub` (button, or drag & drop the file anywhere)
- **PDFs too** — shown as their real pages, as printed (PDF.js, loaded only for
  PDFs). Chapters come from the PDF's bookmarks — or, when it has none worth
  using, from the big titles on its pages (every 10 pages as a last resort) —
  with the same progress, Continue, end-of-chapter card and stats as a book.
  Pinch or double-tap to zoom (Ctrl/⌘ + scroll, double-click or + / − / 0 on a
  computer; kept per book),
  links on the page work, and an opt-in **Dark pages** switch in the drawer
  redraws the pages in the reader's colours (`src/pdf.js`, `src/lib/pdf.js`)
- Chapters menu (drawer) — jump to any chapter, current one highlighted
- **Text & theme** (EPUBs) — *switched off for now* (`READER_SETTINGS = false`
  in `src/lib/reader-prefs.js`) while a fuller v2 is designed. When on, the top
  bar's `Aa` opens text size (80–170 %), line spacing (compact / normal /
  relaxed) and a dark / light page; the defaults are the original look and add
  nothing, and your place in the text holds while you change them
  (`src/readerprefs.js`)
- One chapter per view, with an end-of-chapter Previous/Next block
- Phone reading chrome: a permanent top bar (menu · title · chapter tools) and
  a bottom bar (‹ Previous · ⤒ top · ⤓ end · Next ›, its top edge filling with
  the chapter's progress) that hides as you read and returns on scroll-up, a
  tap, or the chapter's top / end. After a jump, that button offers the way
  back ("↩ 38 %"); a jump never counts as reading.
- Resumes the last book and reading position automatically (IndexedDB)
- **Reading stats** — per book or series (a card on its info page): time
  left and when you'll be done or caught up at your recent pace, time a week
  lately, and a progress curve from your first day to the end. Overall (the
  Library's "This week" strip): week / month / year totals you can step back
  through and tap bar by bar, each set against your usual (the average of
  your last full weeks or months), the books read in the period and how far
  you got in each, a reading calendar shaded by your own days, and records.
  Time counts while you scroll or tap and pauses after 3 idle minutes; days
  turn at 4 AM. Reading from before stats existed (Aug 24 – Nov 24, 2026) was
  backfilled once from your progress (`src/stats.js`, `src/statsview.js`)
  — **hidden for now** behind the `STATS_UI` flag (`src/lib/features.js`,
  build with `VITE_STATS_UI=on` to show it); the tracking keeps recording.
- Installable, fully offline PWA (service worker via `vite-plugin-pwa`)
- Asks the browser to keep the library's storage persistent, and keeps the
  screen awake while you read — released after 5 minutes without a scroll or tap
- Designed for the phone, with a full tablet / desktop layout (see below)
- **Soul Sea** (Shadow Slave only) — Sunny's Memories, Echoes, Shadows, Attributes
  and Aspect as of where you are, in the book's own words (`scripts/soul-sea/`)

### On a computer

The phone design is the reference; wider screens get their own arrangement of
the same pieces (`src/wide.css`, two tiers: ≥ 640 px tablet, ≥ 1024 px desktop):

- **Library** — a centred shelf with as many cover columns as fit, the search
  field always in the header (`/` focuses it), and a drop-anywhere import target.
  Right-click is the long-press: on a series it opens its menu, on a book it
  starts multi-select (so does ⌘/Ctrl-click); the selection toolbar floats at
  the bottom.
- **Book / series page** — the cover beside the title and description, then
  volumes + chapters on the left and details on the right.
- **Reader** — the menu button docks the chapter list beside the text (remembered);
  a hairline under the top bar shows progress through the chapter.
  Keys: `Space` / `Shift+Space`, `PageUp` / `PageDown`, `↑` / `↓`, `Home` /
  `End` scroll — also with focus in the text.
- Sheets become centred dialogs, the `⋯` menu a popover, editors a modal.

## Run (development)

```bash
npm install
npm run dev      # http://localhost:5173  (also printed on your LAN IP)
```

Open the LAN URL (e.g. `http://192.168.1.40:5173`) on your phone while on the
same WiFi to read on mobile. Note: the service worker / offline install only
activates over HTTPS (or `localhost`), so LAN dev is online-only — see below
to install it as a real offline app.

## Logo & icons

The mark — five stacked lines, the current one lit — is pure geometry in
`src/lib/ream-mark.js`. It is drawn live in two places (`src/brand.js`): the
Library header, where the stack scrolls with the shelf, and the reader's menu
button (in place of a burger), where it scrolls at half the text's pace (one
line per two lines of text) as you read; `npm run icons` renders the same geometry
into `public/` (`icon.svg`, the PWA PNGs, the maskable icon and
`apple-touch-icon.png`). Re-run it after touching the mark and commit the output.

## Build

```bash
npm run build    # static site + service worker in dist/
npm run preview  # serve the built site locally
```

`dist/` is a plain static bundle: HTML, JS, CSS, the Merriweather fonts, and a
Workbox service worker that precaches the whole app shell.

## Put it on your phone (offline app)

The service worker needs HTTPS, so host the built `dist/` on any free static
host, then "Add to Home Screen". After the first load the app runs with **no
network at all** — your books are opened locally from the phone's Files /
iCloud Drive / Downloads and kept in the browser; nothing is ever uploaded.

Pick one (run from the project root after `npm run build`):

```bash
# Cloudflare Pages — root domain, ideal for a PWA
npx wrangler pages deploy dist

# Netlify
npx netlify deploy --prod --dir dist

# Surge
npx surge dist
```

GitHub Pages also works (base is `./`, so a project subpath is fine): push the
repo and serve `dist/` from a Pages workflow or the `gh-pages` branch.

On the phone: open the deployed URL in Safari (iOS) or Chrome (Android) →
Share / menu → **Add to Home Screen**. Launch it once online to cache, then
it opens offline forever.

## Layout

The app is plain ES modules (no framework); Vite bundles them into one file, so
the split is purely for readability — there is no runtime cost. Each module owns
one concern:

- `src/main.js` — entry: pulls the modules together, wires the static chrome, boots
- `src/db.js` — IndexedDB primitives
- `src/state.js` — in-memory library data + persistence (single source of truth)
- `src/reading.js` — derived reading state (percentages, ordinals, titles)
- `src/dom.js` — element builder, icons, cover cache, element refs, touch gestures
- `src/sheets.js` — action sheet + confirm / name / suggest prompts
- `src/router.js` — routing + the overlay/Back history stack
- `src/import.js` — `.epub` parsing, import/grouping, dev-seed
- `src/epub.js` — opens an EPUB so that a broken file fails (with a reason)
  instead of leaving epub.js waiting forever
- `src/library.js` — home screen + multi-select
- `src/info.js` — info page + editors + volume sheet
- `src/chapters.js` — chapters screen + shared chapter-preview component
- `src/reader.js` — reading surface, drawer, resume, chapter-nav injection
- `src/readbar.js` — the phone's auto-hiding bottom bar (chapter steps, top / end)
- `src/readerprefs.js` — the `Aa` panel: text size, line spacing, light page (EPUBs)
- `src/pwa.js` — install prompt + service-worker update banner
- `src/device.js` — persistent-storage request + reading wake lock
- `src/lib/` — pure, unit-tested helpers (`text`, `chapters`, `format` math)
- `src/style.css` — app chrome (top bar, drawer, landing) — the phone design
- `src/wide.css` — tablet / desktop layer on top of it (min-width queries only)
- `src/reader-theme.css` — the Webnovel-dark theme injected into each chapter
- `public/fonts/` — Merriweather (OFL) static faces
- `scripts/fetch-seed.mjs` — downloads the dev-seed books into `public/seed/`
- `vite.config.js` — Vite + PWA (service worker, manifest) config

## Quality checks

```bash
npm test          # Vitest unit tests over the pure logic in src/lib
npm run test:e2e  # Playwright: the built app in Chromium, phone + desktop sizes
npm run lint      # ESLint (flat config)
npm run format    # Prettier (pure-logic modules, tests, config)
npm run check     # all of the above, as CI runs them
```

The end-to-end suite (`e2e/`) builds the app, serves it with `vite preview`
and drives it like a reader would: importing good and broken files, reading,
chapter navigation, resuming after a reload or a closed tab, series, PDFs,
stats, and the service worker (offline reading, the update banner). The books
it imports are generated on the fly by `e2e/fixtures/make.mjs`. Any error the
page logs fails the test. First run: `npx playwright install chromium`.

The deploy workflow runs all of these before building, so a failing check
blocks the release.

## Dev seeding

For design/QA there is a hidden reset that fills the library with a fixed set
of real, public-domain books (from Project Gutenberg) covering every case the
design needs — with/without cover, started/unstarted, loose volumes, and
shelves. **Long-press the Import tile** (or the empty-state Import button) and
confirm. It is a *reset*: it wipes the current library first, so it never
duplicates. The books live in `public/seed/` (committed, excluded from the PWA
precache); regenerate them with `npm run seed:fetch`.
