import {
  test,
  expect,
  openApp,
  importBooks,
  importBook,
  tiles,
  tile,
  chapter,
  startReading,
  chapterTitle,
  leaveReader,
  openDrawer,
  scrollChapter,
} from "./helpers.js";

test.describe("series", () => {
  test("look-alike volumes are offered as a series, then read across", async ({ page }) => {
    await openApp(page);
    await importBooks(page, "vol1.epub", "vol2.epub");
    // Grouping is suggested, never done silently.
    await expect(page.locator("#suggest-sheet")).toBeVisible();
    await expect(page.locator("#suggest-body")).toContainText("Ember Saga");
    await page.locator("#suggest-group").click();
    await expect(tiles(page)).toHaveCount(1);
    const series = tile(page, "Ember Saga");
    await expect(series.locator(".tile__meta")).toHaveText("2 volumes");

    // Survives a reload.
    await page.reload();
    await expect(tile(page, "Ember Saga").locator(".tile__meta")).toHaveText("2 volumes");

    // Read to the end of volume 1: the boundary card leads into volume 2.
    await tile(page, "Ember Saga").locator(".tile__cover").click();
    await page.locator(".info-actions__continue").click();
    await expect(page.locator("#book-title")).toHaveText(/Ember Saga/);
    for (const n of [2, 3]) {
      await chapter(page).locator(".cn-card").click();
      await expect(chapterTitle(page)).toHaveText(`Chapter ${n}`);
    }
    const go = chapter(page).locator(".vol-boundary__go");
    await expect(go).toHaveText(/Continue to Vol\. 2/);
    await go.click();
    await expect(page.locator("#book-title")).toHaveText(/Vol\. 2/);
    await expect(chapterTitle(page)).toHaveText("Chapter 1");

    // A volume's own sheet renders cleanly (no stray "null" where an optional
    // part is absent).
    await leaveReader(page);
    await tile(page, "Ember Saga").locator(".tile__cover").click();
    await page
      .locator(".vrow__more")
      .first()
      .evaluate((b) => b.click());
    const sheet = page.locator(".vsheet__continue");
    await expect(sheet).toBeVisible();
    await expect(page.locator("#volume-card")).not.toContainText("null");
  });

  test("a volume picked in the drawer opens at its chapter's top", async ({ page }) => {
    // Its TOC links point at each chapter's heading: opening there must not
    // land on the anchor, a little way down past the chapter's top padding.
    const scrollTop = () => page.evaluate(() => document.querySelector("#viewer .epub-container").scrollTop);
    await openApp(page);
    await importBooks(page, "ash1.epub", "ash2.epub");
    await page.locator("#suggest-group").click();
    await expect(tiles(page)).toHaveCount(1);
    await tile(page, "Ash Saga").locator(".tile__cover").click();
    await page.locator(".info-actions__continue").click();
    await chapter(page).locator("p").first().waitFor();
    await expect.poll(scrollTop).toBe(0);
    await openDrawer(page);
    await page.locator(".vol-chip", { hasText: "Vol. 2" }).click();
    await expect(page.locator("#book-title")).toHaveText(/Vol\. 2/);
    await expect(chapterTitle(page)).toHaveText("Chapter 1");
    await chapter(page).locator("p").first().waitFor();
    await page.waitForTimeout(500); // let any jump to the anchor happen
    expect(await scrollTop()).toBe(0);
  });

  test("a finished volume left at a chapter's top reopens at that top", async ({ page }) => {
    // Back at the top of a chapter you'd finished, the saved spot still counts
    // as a re-read (a long chapter's top is already ~10 % in, by screens), but
    // reopening the volume must show the chapter's top, not its heading.
    const scrollTop = () => page.evaluate(() => document.querySelector("#viewer .epub-container").scrollTop);
    await openApp(page);
    await importBooks(page, "vol1.epub", "vol2.epub");
    await page.locator("#suggest-group").click();
    await expect(tiles(page)).toHaveCount(1);
    await tile(page, "Ember Saga").locator(".tile__cover").click();
    await page.locator(".info-actions__continue").click();
    for (const n of [1, 2, 3]) {
      await expect(chapterTitle(page)).toHaveText(`Chapter ${n}`);
      for (const f of [0.3, 0.6, 1]) {
        await scrollChapter(page, f);
        await page.waitForTimeout(250);
      }
      if (n < 3) await chapter(page).locator(".cn-card").click();
    }
    await openDrawer(page);
    await page.locator("#toc-list .toc-item", { hasText: "Chapter 1" }).click();
    await expect(chapterTitle(page)).toHaveText("Chapter 1");
    await page.waitForTimeout(1000); // its spot (the chapter's top) is saved
    for (const v of ["Vol. 2", "Vol. 1"]) {
      await openDrawer(page);
      await page.locator(".vol-chip", { hasText: v }).click();
      await expect(page.locator("#book-title")).toHaveText(new RegExp(v));
    }
    await expect(chapterTitle(page)).toHaveText("Chapter 1");
    await chapter(page).locator("p").first().waitFor();
    await page.waitForTimeout(500); // let any jump to the heading happen
    expect(await scrollTop()).toBe(0);
  });

  test("keeping volumes separate leaves two books", async ({ page }) => {
    await openApp(page);
    await importBooks(page, "vol1.epub", "vol2.epub");
    await page.locator("#suggest-keep").click();
    await expect(page.locator("#suggest-sheet")).toBeHidden();
    await expect(tiles(page)).toHaveCount(2);
  });

  test("deleting a series removes every volume, for good", async ({ page }) => {
    await openApp(page);
    await importBooks(page, "vol1.epub", "vol2.epub", "basic.epub");
    await page.locator("#suggest-group").click();
    await expect(tiles(page)).toHaveCount(2);
    await tile(page, "Ember Saga").locator(".tile__cover").click();
    await page.locator("#info-screen [aria-label='More']").first().click();
    await page.locator(".action-item", { hasText: "Delete series" }).click();
    await expect(page.locator("#confirm-body")).toContainText("2 volumes");
    await page.locator("#confirm-ok").click();
    await expect(page.locator("#app")).toHaveAttribute("data-route", "library");
    await expect(tiles(page)).toHaveCount(1);
    await page.reload();
    await expect(tiles(page)).toHaveCount(1);
    await expect(tile(page, "The Lamplighter")).toBeVisible();
  });

  test("mark as read, then as unread", async ({ page }) => {
    await openApp(page);
    await importBook(page, "basic.epub", "The Lamplighter");
    await tile(page, "The Lamplighter").locator(".tile__cover").click();
    await page.locator("#info-screen [aria-label='More']").first().click();
    await page.locator(".action-item", { hasText: "Mark book as read" }).click();
    await expect(page.locator(".info-actions__continue")).toHaveText("Read again");
    await page.reload();
    await tile(page, "The Lamplighter").locator(".tile__cover").click();
    await expect(page.locator(".info-actions__continue")).toHaveText("Read again");
    await page.locator("#info-screen [aria-label='More']").first().click();
    await page.locator(".action-item", { hasText: "Mark book as unread" }).click();
    await page.locator("#confirm-ok").click();
    await expect(page.locator(".info-actions__continue")).toHaveText("Start reading");
  });
});

test.describe("PDF", () => {
  test("imports with its outline as chapters and shows its pages", async ({ page }) => {
    await openApp(page);
    await importBook(page, "text.pdf", "Printed Matter");
    await expect(tile(page, "Printed Matter").locator(".tile__meta")).toHaveText("3 chapters");
    await startReading(page, "Printed Matter");
    await expect(page.locator("#viewer .pdf-page canvas").first()).toBeVisible({ timeout: 20_000 });
    await expect(chapterTitle(page)).toHaveText("Opening");
    // The page really got drawn (not a blank canvas).
    const inked = await page
      .locator("#viewer .pdf-page canvas")
      .first()
      .evaluate((c) => {
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        const first = d.slice(0, 4).join();
        for (let i = 0; i < d.length; i += 4 * 97) if (d.slice(i, i + 4).join() !== first) return true;
        return false;
      });
    expect(inked).toBe(true);
  });

  test("a PDF resumes at its chapter after a reload", async ({ page }) => {
    await openApp(page);
    await importBook(page, "text.pdf", "Printed Matter");
    await startReading(page, "Printed Matter");
    await expect(chapterTitle(page)).toHaveText("Opening");
    const next = (await page.locator("#btn-next").isVisible())
      ? page.locator("#btn-next")
      : page.locator("#rb-next");
    if (!(await next.isVisible())) await page.locator("#viewer").click({ position: { x: 40, y: 200 } });
    await next.click();
    await expect(chapterTitle(page)).toHaveText("Middle");
    await page.reload();
    await page.locator(".continue-card").click();
    await expect(chapterTitle(page)).toHaveText("Middle");
  });

  test("a damaged stored PDF says so instead of a blank page", async ({ page }) => {
    await openApp(page);
    await importBook(page, "text.pdf", "Printed Matter");
    await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const req = indexedDB.open("webnovel-reader");
          req.onsuccess = () => {
            const t = req.result.transaction("books", "readwrite");
            const os = t.objectStore("books");
            os.getAll().onsuccess = (e) => {
              for (const b of e.target.result) os.put({ ...b, fileBlob: new Blob(["%PDF-1.4 broken"]) });
            };
            t.oncomplete = () => resolve();
            t.onerror = () => reject(t.error);
          };
        })
    );
    await page.reload();
    await startReading(page, "Printed Matter");
    await expect(page.locator(".reader-error")).toBeVisible();
    await page.locator(".reader-error .pill-btn").click();
    await expect(page.locator("#app")).toHaveAttribute("data-route", "library");
  });
});
