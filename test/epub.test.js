// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { whenOpen, BookError } from "../src/epub.js";

// A stand-in for an epub.js Book: the promises and the one event whenOpen uses.
function fakeBook({ spine = 3 } = {}) {
  const listeners = {};
  let resolveReady, resolveOpened;
  const book = {
    ready: new Promise((r) => (resolveReady = r)),
    opened: new Promise((r) => (resolveOpened = r)),
    spine: { spineItems: Array.from({ length: spine }, (_, i) => ({ href: `ch${i}.xhtml` })) },
    on: (ev, fn) => ((listeners[ev] ||= []).push(fn), book),
    off: (ev, fn) => (listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn)),
    emit: (ev, ...args) => (listeners[ev] || []).forEach((f) => f(...args)),
    listenerCount: (ev) => (listeners[ev] || []).length,
    markReady: () => resolveReady(),
    open() {
      resolveReady();
      resolveOpened(book);
    },
  };
  return book;
}

afterEach(() => vi.useRealTimers());

describe("whenOpen", () => {
  it("resolves with the book once it is ready and opened", async () => {
    const book = fakeBook();
    const p = whenOpen(book);
    book.open();
    await expect(p).resolves.toBe(book);
    expect(book.listenerCount("openFailed")).toBe(0); // cleaned up
  });

  it("waits for `opened`, not just `ready`", async () => {
    const book = fakeBook();
    let done = false;
    whenOpen(book).then(() => (done = true));
    // ready alone isn't enough: epub.js is still building its resource URLs.
    book.markReady();
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    book.open();
    await new Promise((r) => setTimeout(r, 0));
    expect(done).toBe(true);
  });

  it("rejects when epub.js reports the file can't be opened", async () => {
    const book = fakeBook();
    const p = whenOpen(book);
    book.emit("openFailed", new Error("Cannot load book"));
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(BookError);
    expect(err.reason).toBe("unreadable");
  });

  it("rejects a book with nothing in its spine", async () => {
    const book = fakeBook({ spine: 0 });
    const p = whenOpen(book);
    book.open();
    const err = await p.catch((e) => e);
    expect(err.reason).toBe("empty");
  });

  it("gives up after the timeout instead of waiting forever", async () => {
    vi.useFakeTimers();
    const book = fakeBook();
    const p = whenOpen(book, { timeout: 5000 });
    vi.advanceTimersByTime(5001);
    const err = await p.catch((e) => e);
    expect(err.reason).toBe("timeout");
    expect(err.message).toMatch(/too long/);
  });

  it("settles once: a late failure after success is ignored", async () => {
    const book = fakeBook();
    const p = whenOpen(book);
    book.open();
    await p;
    expect(() => book.emit("openFailed", new Error("late"))).not.toThrow();
    await expect(p).resolves.toBe(book);
  });
});
