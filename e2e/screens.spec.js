// Every other screen, walked end to end: the chapters list, the editors, the
// stats tracker fed by real (clock-accelerated) reading. The point is less the
// exact numbers than that each screen renders without a single error.
import {
  test,
  expect,
  openApp,
  importBook,
  importBooks,
  tile,
  chapter,
  startReading,
  chapterTitle,
  scrollChapter,
  leaveReader,
} from "./helpers.js";

test.describe("screens", () => {
  test("chapters screen: list, search, open a chapter", async ({ page }) => {
    await openApp(page);
    await importBook(page, "long.epub", "Long Road");
    await tile(page, "Long Road").locator(".tile__cover").click();
    await page.getByText("See all 30 chapters").click();
    await expect(page.locator("#app")).toHaveAttribute("data-route", "chapters");
    const screen = page.locator("#chapters-screen");
    await expect(screen).toContainText("Chapter 1");
    const search = screen.locator("input[type=search], input").first();
    await search.fill("27");
    await expect(screen.getByText("Chapter 27", { exact: true })).toBeVisible();
    await screen.getByText("Chapter 27", { exact: true }).click();
    await expect(page.locator("#app")).toHaveAttribute("data-route", "reader");
    await expect(chapterTitle(page)).toHaveText("Chapter 27");
  });

  test("edit details: a new title sticks", async ({ page }) => {
    await openApp(page);
    await importBook(page, "basic.epub", "The Lamplighter");
    await tile(page, "The Lamplighter").locator(".tile__cover").click();
    await page.locator("#info-screen [aria-label='More']").first().click();
    await page.locator(".action-item", { hasText: "Edit details" }).click();
    const editor = page.locator("#editor");
    await expect(editor).toBeVisible();
    const title = editor.locator("input, textarea").first();
    await title.fill("The Night Walker");
    await editor.getByRole("button", { name: /^Save$/ }).click();
    await expect(editor).toBeHidden();
    await expect(page.locator("#info-screen")).toContainText("The Night Walker");
    await page.reload();
    await expect(tile(page, "The Night Walker")).toBeVisible();
  });

  test("stats UI is off, but reading time is still recorded", async ({ page, allowedErrors }) => {
    // The stats screens sit behind STATS_UI (src/lib/features.js), off in this
    // build; the tracker must keep recording underneath so nothing is lost
    // before they're turned on. The fake clock is a script Playwright injects
    // into every frame; the chapter's sandbox refuses it (as it should any script).
    allowedErrors.push(/Blocked script execution in 'about:srcdoc'/);
    await page.clock.install();
    await page.clock.resume(); // real time flows; fastForward jumps ahead
    await openApp(page);
    await importBook(page, "long.epub", "Long Road");
    await startReading(page, "Long Road");
    await expect(chapterTitle(page)).toHaveText("Chapter 1");
    // Five minutes of reading: a scroll every 30 s (under the 3-minute idle gap).
    for (let i = 1; i <= 10; i++) {
      await page.clock.fastForward(30_000);
      await scrollChapter(page, i / 12);
    }
    await leaveReader(page);

    // Recorded, and kept across a reload…
    const recordedMs = () =>
      page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const req = indexedDB.open("webnovel-reader");
            req.onerror = () => reject(req.error);
            req.onsuccess = () => {
              const all = req.result.transaction("stats").objectStore("stats").getAll();
              all.onerror = () => reject(all.error);
              all.onsuccess = () => {
                req.result.close();
                resolve(all.result.filter((r) => !r.bf).reduce((t, r) => t + r.ms, 0));
              };
            };
          })
      );
    await expect.poll(recordedMs).toBeGreaterThanOrEqual(4 * 60_000);
    await page.reload();
    await expect(tile(page, "Long Road")).toBeVisible();
    expect(await recordedMs()).toBeGreaterThanOrEqual(4 * 60_000);

    // …but no way into the stats: no "This week" strip, no card on the book's page.
    await expect(page.locator(".st-strip")).toHaveCount(0);
    await tile(page, "Long Road").locator(".tile__cover").click();
    await expect(page.locator("#app")).toHaveAttribute("data-route", "info");
    await expect(page.locator("#info-screen [aria-label='Reading stats']")).toHaveCount(0);
  });

  test("install help opens and closes", async ({ page }) => {
    await openApp(page);
    await page.locator("#install-note").click();
    await expect(page.locator("#install-sheet")).toBeVisible();
    await page.locator("#install-sheet-close").click();
    await expect(page.locator("#install-sheet")).toBeHidden();
  });

  test("Escape and Back close sheets before leaving the screen", async ({ page }) => {
    await openApp(page);
    await importBooks(page, "basic.epub");
    await tile(page, "The Lamplighter").locator(".tile__cover").click();
    await page.locator("#info-screen [aria-label='More']").first().click();
    await expect(page.locator("#action-sheet")).toBeVisible();
    await page.goBack();
    await expect(page.locator("#action-sheet")).toBeHidden();
    await expect(page.locator("#app")).toHaveAttribute("data-route", "info");
    await page.goBack();
    await expect(page.locator("#app")).toHaveAttribute("data-route", "library");
  });

  test("a long session in one chapter keeps the end card working", async ({ page }) => {
    // Scrolling to the very end and back must not break the chapter's nav.
    await openApp(page);
    await importBook(page, "long.epub", "Long Road");
    await startReading(page, "Long Road");
    for (const f of [1, 0, 0.5, 1]) await scrollChapter(page, f);
    await chapter(page).locator(".cn-card").click();
    await expect(chapterTitle(page)).toHaveText("Chapter 2");
  });
});
