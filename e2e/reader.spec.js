import {
  test,
  expect,
  openApp,
  importBook,
  tile,
  chapter,
  startReading,
  chapterTitle,
  scrollChapter,
  leaveReader,
  openDrawer,
} from "./helpers.js";

const scroller = (page) => page.locator("#viewer .epub-container");
const scrollFraction = (page) =>
  scroller(page).evaluate((c) => c.scrollTop / Math.max(1, c.scrollHeight - c.clientHeight));

/** Step to the next / previous chapter with whichever control this layout shows. */
async function step(page, dir) {
  const wide = await page.locator("#btn-next").isVisible();
  if (wide) await page.locator(dir > 0 ? "#btn-next" : "#btn-prev").click();
  else {
    // The phone's bottom bar hides while reading; a tap on the text brings it back.
    const btn = page.locator(dir > 0 ? "#rb-next" : "#rb-prev");
    if (!(await btn.isVisible()))
      await chapter(page)
        .locator("body")
        .click({ position: { x: 40, y: 200 } });
    await btn.click();
  }
}

test.describe("reader", () => {
  test("opens a book at its first chapter, styled, scripts off", async ({ page }) => {
    await openApp(page);
    await importBook(page, "basic.epub", "The Lamplighter");
    await startReading(page, "The Lamplighter");
    await expect(chapterTitle(page)).toHaveText("Chapter 1");
    await expect(page.locator("#book-title")).toHaveText("The Lamplighter");
    await expect(page).toHaveTitle("The Lamplighter");
    await expect(chapter(page).locator("p").first()).toContainText("Chapter 1, paragraph 1.");
    // The reading theme is injected into the chapter.
    await expect(chapter(page).locator("#webnovel-theme")).toHaveCount(1);
    // epub.js sandbox: same-origin for styling, but never scripts.
    const sandbox = await page.locator("#viewer iframe").getAttribute("sandbox");
    expect(sandbox).not.toContain("allow-scripts");
  });

  test("the Soul Sea badge is drawn in the top bar's own colour", async ({ page }) => {
    await openApp(page);
    await importBook(page, "shadow-slave.epub", "Shadow Slave");
    await startReading(page, "Shadow Slave");
    const badge = page.locator("#btn-soulsea svg.soulsea-badge");
    await expect(badge).toBeVisible();
    // A line icon like its neighbours, not a dark sticker with colours of its own.
    const fills = await badge.evaluate((s) =>
      [...s.querySelectorAll("[fill],[stroke]")]
        .filter((n) => !n.closest("mask"))
        .flatMap((n) => [n.getAttribute("fill"), n.getAttribute("stroke")])
        .filter((c) => c && c !== "none")
    );
    expect(new Set(fills)).toEqual(new Set(["currentColor"]));
    expect(await badge.getAttribute("width")).toBe("22");
    // A "Dormant" core (the first chapters) is still a core: a solid sun, not dashed.
    await expect(badge.locator("[stroke-dasharray]")).toHaveCount(0);
  });

  test("steps through chapters: end card, next and previous", async ({ page }) => {
    await openApp(page);
    await importBook(page, "long.epub", "Long Road");
    await startReading(page, "Long Road");
    await expect(chapterTitle(page)).toHaveText("Chapter 1");

    // The end-of-chapter card leads on.
    const card = chapter(page).locator(".cn-card");
    await expect(card).toContainText("Next chapter");
    await card.click();
    await expect(chapterTitle(page)).toHaveText("Chapter 2");
    await expect(chapter(page).locator("p").first()).toContainText("Chapter 2, paragraph 1.");
    // A new chapter opens at its top.
    expect(await scrollFraction(page)).toBeLessThan(0.05);

    await step(page, 1);
    await expect(chapterTitle(page)).toHaveText("Chapter 3");
    await step(page, -1);
    await expect(chapterTitle(page)).toHaveText("Chapter 2");
  });

  test("jumps to a chapter from the drawer", async ({ page }) => {
    await openApp(page);
    await importBook(page, "long.epub", "Long Road");
    await startReading(page, "Long Road");
    await openDrawer(page);
    await page.locator("#toc-list li", { hasText: /^Chapter 17$/ }).click();
    await expect(chapterTitle(page)).toHaveText("Chapter 17");
    await expect(chapter(page).locator("p").first()).toContainText("Chapter 17, paragraph 1.");
  });

  test("resumes where you left off after a reload", async ({ page }) => {
    await openApp(page);
    await importBook(page, "long.epub", "Long Road");
    await startReading(page, "Long Road");
    await openDrawer(page);
    await page.locator("#toc-list li", { hasText: /^Chapter 5$/ }).click();
    await expect(chapterTitle(page)).toHaveText("Chapter 5");
    await scrollChapter(page, 0.5);
    await expect.poll(() => scrollFraction(page)).toBeGreaterThan(0.4);
    // Leaving the reader saves the spot.
    await leaveReader(page);
    await page.reload();

    const cont = page.locator(".continue-card");
    await expect(cont).toContainText("Long Road");
    await cont.click();
    await expect(chapterTitle(page)).toHaveText("Chapter 5");
    await expect.poll(() => scrollFraction(page), { timeout: 10_000 }).toBeGreaterThan(0.35);
  });

  test("leaving the reader right after scrolling keeps the spot", async ({ page }) => {
    await openApp(page);
    await importBook(page, "long.epub", "Long Road");
    await startReading(page, "Long Road");
    await openDrawer(page);
    await page.locator("#toc-list li", { hasText: /^Chapter 5$/ }).click();
    await expect(chapterTitle(page)).toHaveText("Chapter 5");
    // No wait for the scroll-driven save: tap out at once, then reload at once.
    await scrollChapter(page, 0.6);
    await leaveReader(page);
    await page.reload();

    await page.locator(".continue-card").click();
    await expect(chapterTitle(page)).toHaveText("Chapter 5");
    await expect.poll(() => scrollFraction(page), { timeout: 10_000 }).toBeGreaterThan(0.45);
  });

  test("keeps the position when the app is closed mid-chapter", async ({ page }) => {
    // No trip back to the library: the tab just goes away (phone lock, swipe-away).
    await openApp(page);
    await importBook(page, "long.epub", "Long Road");
    await startReading(page, "Long Road");
    await openDrawer(page);
    await page.locator("#toc-list li", { hasText: /^Chapter 8$/ }).click();
    await expect(chapterTitle(page)).toHaveText("Chapter 8");
    await scrollChapter(page, 0.6);
    await expect.poll(() => scrollFraction(page)).toBeGreaterThan(0.5);
    await page.reload(); // fires pagehide, like closing the app
    await page.locator(".continue-card").click();
    await expect(chapterTitle(page)).toHaveText("Chapter 8");
    await expect.poll(() => scrollFraction(page), { timeout: 10_000 }).toBeGreaterThan(0.45);
  });

  test("shows progress on the shelf after reading", async ({ page }) => {
    await openApp(page);
    await importBook(page, "basic.epub", "The Lamplighter");
    await startReading(page, "The Lamplighter");
    await chapter(page).locator(".cn-card").click();
    await expect(chapterTitle(page)).toHaveText("Chapter 2");
    await chapter(page).locator(".cn-card").click();
    await expect(chapterTitle(page)).toHaveText("Chapter 3");
    await leaveReader(page);
    await expect(page.locator(".continue-card")).toContainText("The Lamplighter");
    await tile(page, "The Lamplighter").locator(".tile__cover").click();
    await expect(page.locator(".info-actions__continue")).toHaveText(/Continue/);
  });

  test("the browser's Back leaves the reader", async ({ page }) => {
    await openApp(page);
    await importBook(page, "basic.epub", "The Lamplighter");
    await startReading(page, "The Lamplighter");
    await expect(chapter(page).locator("p").first()).toBeVisible();
    await page.goBack();
    await expect(page.locator("#app")).not.toHaveAttribute("data-route", "reader");
    await expect(page.locator("#viewer iframe")).toHaveCount(0);
  });

  test("leaving the reader while the book is still opening is clean", async ({ page }) => {
    // Back pressed moments after Start reading: epub.js is still starting up.
    await openApp(page);
    await importBook(page, "long.epub", "Long Road");
    for (const wait of [0, 10, 30, 60, 120]) {
      await tile(page, "Long Road").locator(".tile__cover").click();
      await page.locator(".info-actions__continue").click();
      await page.waitForTimeout(wait);
      await page.goBack();
      await expect(page.locator("#app")).not.toHaveAttribute("data-route", "reader");
      await page.goBack();
      await expect(page.locator("#app")).toHaveAttribute("data-route", "library");
    }
    await page.waitForTimeout(500); // let any queued epub.js work surface
    // …and the book still opens normally afterwards.
    await startReading(page, "Long Road");
    await expect(chapter(page).locator("p").first()).toContainText("Chapter 1, paragraph 1.");
  });

  test("never runs a book's scripts", async ({ page, allowedErrors }) => {
    // Chromium logs each script the sandbox refuses — that's the point.
    allowedErrors.push(/Blocked script execution in 'about:srcdoc'/);
    await openApp(page);
    await importBook(page, "scripted.epub", "Sneaky Script");
    await startReading(page, "Sneaky Script");
    await expect(chapter(page).locator("p").first()).toHaveText("Plain text.");
    await page.waitForTimeout(500);
    const ran = await page.evaluate(() => ({
      parent: window.__epubScriptRan === true,
      frame: document.querySelector("#viewer iframe")?.contentWindow?.__epubScriptRan === true,
    }));
    expect(ran).toEqual({ parent: false, frame: false });
  });

  test("reads books without a TOC and EPUB 2 books", async ({ page }) => {
    await openApp(page);
    await importBook(page, "no-toc.epub", "No Contents");
    await startReading(page, "No Contents");
    await expect(chapter(page).locator("p").first()).toContainText("Chapter 1, paragraph 1.");
    await chapter(page).locator(".cn-card").click();
    await expect(chapter(page).locator("p").first()).toContainText("Chapter 2, paragraph 1.");
    await leaveReader(page);

    await importBook(page, "ncx-only.epub", "Old Format");
    await startReading(page, "Old Format");
    await expect(chapterTitle(page)).toHaveText("Chapter 1");
    await chapter(page).locator(".cn-card").click();
    await expect(chapterTitle(page)).toHaveText("Chapter 2");
  });

  test("renders non-Latin text", async ({ page }) => {
    await openApp(page);
    await importBook(page, "unicode.epub", "Élan & Ünïcode");
    await startReading(page, "Élan & Ünïcode");
    await expect(chapterTitle(page)).toHaveText("第一章");
    await expect(chapter(page).locator("body")).toContainText("日本語のテキスト。");
  });

  test("a damaged stored book says so instead of a blank page", async ({ page }) => {
    await openApp(page);
    await importBook(page, "basic.epub", "The Lamplighter");
    // Corrupt the stored file behind the app's back.
    await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const req = indexedDB.open("webnovel-reader");
          req.onsuccess = () => {
            const db = req.result;
            const t = db.transaction("books", "readwrite");
            const os = t.objectStore("books");
            os.getAll().onsuccess = (e) => {
              for (const b of e.target.result) os.put({ ...b, fileBlob: new Blob([new Uint8Array(512)]) });
            };
            t.oncomplete = () => resolve();
            t.onerror = () => reject(t.error);
          };
        })
    );
    await page.reload();
    await startReading(page, "The Lamplighter");
    await expect(page.locator(".reader-error")).toBeVisible();
    await expect(page.locator(".reader-error__title")).toHaveText("This book couldn’t be opened");
    await page.locator(".reader-error .pill-btn").click();
    await expect(page.locator("#app")).toHaveAttribute("data-route", "library");
  });
});

test.describe("reader keys (desktop)", () => {
  test.skip(({ isMobile }) => isMobile, "keyboard reading is a computer thing");

  test("Space, End and Home scroll the chapter", async ({ page }) => {
    await openApp(page);
    await importBook(page, "long.epub", "Long Road");
    await startReading(page, "Long Road");
    await expect(chapter(page).locator("p").first()).toBeVisible();
    await page.keyboard.press("End");
    await expect.poll(() => scrollFraction(page)).toBeGreaterThan(0.95);
    await page.keyboard.press("Home");
    await expect.poll(() => scrollFraction(page)).toBeLessThan(0.02);
    await page.keyboard.press("Space");
    await expect.poll(() => scrollFraction(page)).toBeGreaterThan(0.02);
  });
});
