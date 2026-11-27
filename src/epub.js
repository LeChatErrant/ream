// =========================================================================
// Opening an EPUB safely. epub.js never rejects `book.ready` when a file can't
// be read: a zero-byte file, random bytes, a zip that isn't an EPUB or a broken
// package document only fire an "openFailed" event, and `ready` then stays
// pending forever — so an import (or the reader) would wait with no end and no
// word to the user. openEpub turns all of that into a promise that settles:
// resolved with a fully opened book, or rejected with a BookError saying why.
//
// It also waits for `book.opened`, which epub.js resolves only once its
// resource replacements are done. Destroying a book before then (as a one-shot
// parse does) let that work run on into a destroyed book and throw.
// =========================================================================
import ePub from "epubjs";

// Long enough for a several-thousand-chapter web novel on a slow phone.
const OPEN_TIMEOUT = 90_000;

export class BookError extends Error {
  /** @param {"unreadable" | "empty" | "timeout"} reason */
  constructor(reason, cause) {
    super(
      reason === "timeout"
        ? "Opening the book took too long."
        : reason === "empty"
          ? "The book has no chapters to read."
          : "The file isn't a readable EPUB.",
      cause ? { cause } : undefined
    );
    this.name = "BookError";
    this.reason = reason;
  }
}

/**
 * Attach failure detection to a book epub.js is opening, and resolve once it's
 * fully open (`ready` and `opened`). Rejects with a BookError on a file epub.js
 * can't read, a book with an empty spine, or no answer within `timeout`.
 */
export function whenOpen(book, { timeout = OPEN_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      book.off?.("openFailed", onFailed);
      fn(value);
    };
    const onFailed = (err) => finish(reject, new BookError("unreadable", err));
    const timer = setTimeout(() => finish(reject, new BookError("timeout")), timeout);
    book.on("openFailed", onFailed);
    Promise.all([book.ready, book.opened]).then(
      () => {
        if (!book.spine?.spineItems?.length) finish(reject, new BookError("empty"));
        else finish(resolve, book);
      },
      (err) => finish(reject, err instanceof BookError ? err : new BookError("unreadable", err))
    );
  });
}

/** Open an EPUB from its bytes. On failure the half-open book is destroyed. */
export async function openEpub(buffer, opts) {
  const book = ePub(buffer);
  try {
    return await whenOpen(book, opts);
  } catch (err) {
    try {
      book.destroy();
    } catch {
      /* a book that never opened may not tear down cleanly */
    }
    throw err;
  }
}
