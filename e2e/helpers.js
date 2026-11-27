// Shared end-to-end plumbing: a `test` that fails on any uncaught page error or
// console error (so a regression that only shows up as a red line in the
// console still fails the build), plus small helpers for the app's flows.
import { test as base, expect } from "@playwright/test";
import { fixture } from "./fixtures/make.mjs";

export { expect, fixture };

// Console noise that isn't ours to fix.
const IGNORED = [
  /Service Worker registration blocked by Playwright/,
  /Failed to load resource/, // a deliberate 404 probe, or offline
  // Chromium flags epub.js's own `unload` listener inside the sandboxed chapter
  // iframe; harmless, and not ours.
  /Permissions policy violation: unload is not allowed/,
];

export const test = base.extend({
  // Patterns a test expects to see logged as errors (pushed by the test).
  // eslint-disable-next-line no-empty-pattern -- Playwright fixtures must destructure their deps
  allowedErrors: async ({}, use) => use([]),
  // Every message the page logs at error level or throws, in order. A test that
  // expects some (a broken import) clears or filters them itself.
  pageErrors: [
    async ({ page, allowedErrors }, use) => {
      const errors = [];
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      page.on("console", (m) => {
        if (m.type() !== "error") return;
        const text = m.text();
        if (!IGNORED.some((re) => re.test(text))) errors.push(`console.error: ${text}`);
      });
      await use(errors);
      const unexpected = errors.filter((e) => !allowedErrors.some((re) => re.test(e)));
      expect(unexpected, "uncaught errors on the page").toEqual([]);
    },
    { auto: true },
  ],
});

/** Open the app on an empty library. */
export async function openApp(page) {
  await page.goto("./");
  await expect(page.locator("#library")).toBeVisible();
}

/** Import files (fixture names) through the hidden file input. */
export async function importBooks(page, ...names) {
  await page.setInputFiles(
    "#file-input",
    names.map((n) => fixture(n))
  );
}

/** The shelf's book/series tiles (not the Import tile). */
export const tiles = (page) => page.locator("#lib-body .tile:not(.tile--import)");
export const tile = (page, title) =>
  tiles(page).filter({ has: page.locator(".tile__title", { hasText: title }) });

/** Import a book and wait until its tile is on the shelf. */
export async function importBook(page, name, title) {
  await importBooks(page, name);
  await expect(tile(page, title)).toBeVisible();
}

/** The current chapter's document inside the epub.js iframe. */
export const chapter = (page) => page.frameLocator("#viewer iframe").first();

/** From the library, open a book's info page and start reading it. */
export async function startReading(page, title) {
  await tile(page, title).locator(".tile__cover").click();
  await expect(page.locator("#info-screen")).toBeVisible();
  await page.locator(".info-actions__continue").click();
  await expect(page.locator("#app")).toHaveAttribute("data-route", "reader");
}

/** The reader's current chapter label (top bar). */
export const chapterTitle = (page) => page.locator("#chapter-title");

/** Scroll the chapter text to a fraction of its height (once it's on screen). */
export async function scrollChapter(page, fraction) {
  await chapter(page).locator("p").first().waitFor();
  await page.evaluate((f) => {
    // epub.js "scrolled-doc" scrolls its container, not the iframe.
    const scroller = document.querySelector("#viewer .epub-container");
    scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * f;
    scroller.dispatchEvent(new Event("scroll"));
  }, fraction);
}

/**
 * Show the reader's chapter list: the phone's slide-in drawer, or the desktop's
 * docked sidebar (its menu button toggles docking, and docking is remembered).
 */
export async function openDrawer(page) {
  const shown = await page.evaluate(
    () =>
      document.getElementById("drawer").classList.contains("open") ||
      (document.getElementById("app").classList.contains("sidebar-docked") &&
        matchMedia("(min-width: 1024px)").matches)
  );
  if (!shown) await page.locator("#btn-toc").click();
  await expect(page.locator("#toc-list")).toBeVisible();
}

/** Go back to the library from the reader (through the drawer). */
export async function leaveReader(page) {
  await openDrawer(page);
  await page.locator("#drawer-home").click();
  await expect(page.locator("#app")).toHaveAttribute("data-route", "library");
}
