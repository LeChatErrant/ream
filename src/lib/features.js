// =========================================================================
// Feature flags — front-end features that are built but not shown yet.
//
// A flag hides a feature's UI only. Whatever data the feature needs keeps
// being collected while it's off, so turning it on later shows the full
// history rather than starting from the day it was enabled.
//
// Flags are read at build time from Vite env vars, off unless set to "on",
// e.g. `VITE_STATS_UI=on npm run dev` (or a `.env.local` with that line) to
// work on a hidden feature, or set per deploy environment once there is more
// than one.
// =========================================================================

// Reading stats screens: the Library's "This week" strip, the info page's
// "Reading stats" card and the stats route. Off: the reading-time tracker
// (src/stats.js) still records every session to the `stats` store.
export const STATS_UI = import.meta.env.VITE_STATS_UI === "on";
