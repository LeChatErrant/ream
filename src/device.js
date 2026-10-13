// =========================================================================
// Device — two quiet asks of the browser, both about keeping reading safe:
//
//   • Persistent storage — the whole library (books, progress, proofreading)
//     lives in IndexedDB, which the browser may evict under storage pressure
//     unless the origin is marked persistent. We ask once at boot (a no-op
//     when already granted) and show the outcome + usage in the Library
//     footer, so a "may be cleared" state is visible rather than discovered.
//
//   • Screen wake lock — while you are actively reading, the phone shouldn't
//     dim halfway through a chapter. Reading activity (scrolls, taps) holds a
//     wake lock; after IDLE_MS without any, it is released and the system's
//     own auto-lock takes over again, so a reader left open on the table
//     doesn't burn the battery. The browser drops the lock whenever the page
//     is hidden; the next activity simply takes it again.
// =========================================================================
import { el } from "./dom.js";
import { formatBytes } from "./lib/format.js";

// Longer than any page takes to read, short enough that a forgotten phone
// still goes to sleep.
const IDLE_MS = 5 * 60 * 1000;

let lock = null; // the live WakeLockSentinel, if any
let requesting = false; // a request is in flight — don't stack another
let idleTimer = 0;

/** Note reading activity: hold the screen awake for the next IDLE_MS. */
export function keepAwake() {
  if (!("wakeLock" in navigator) || document.hidden) return;
  // Only reading counts — a late scroll from the reader being torn down must
  // not take the lock again on the screen we just went back to.
  if (document.getElementById("app").dataset.route !== "reader") return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(releaseWakeLock, IDLE_MS);
  if (lock || requesting) return;
  requesting = true;
  navigator.wakeLock
    .request("screen")
    .then((sentinel) => {
      lock = sentinel;
      // Fired when we release it, and when the browser drops it (page hidden).
      sentinel.addEventListener("release", () => {
        if (lock === sentinel) lock = null;
      });
      // Idle ran out (or the reader closed) while the request was pending.
      if (!idleTimer) releaseWakeLock();
    })
    .catch(() => {}) // battery saver, unsupported context — just let it dim
    .finally(() => {
      requesting = false;
    });
}

/** Let the screen dim again (reader closed, or idle). */
export function releaseWakeLock() {
  clearTimeout(idleTimer);
  idleTimer = 0;
  const l = lock;
  lock = null;
  l?.release().catch(() => {});
}

/** Ask for persistent storage and report the result in the Library footer. */
export async function ensurePersistentStorage() {
  const s = navigator.storage;
  if (!s?.persisted) return;
  let kept = await s.persisted().catch(() => false);
  if (!kept && s.persist) kept = await s.persist().catch(() => false);
  let used = "";
  if (s.estimate) {
    const { usage } = await s.estimate().catch(() => ({}));
    if (usage) used = ` · ${formatBytes(usage)} used`;
  }
  if (!el.storageNote) return;
  el.storageNote.textContent = kept ? `Storage: kept on this device${used}` : `Storage: may be cleared by the browser${used}`;
  el.storageNote.classList.toggle("is-err", !kept);
}
