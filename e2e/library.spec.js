import { test, expect, openApp, importBook, importBooks, tiles, tile } from "./helpers.js";

test.describe("library", () => {
  test("starts empty, with the version in the footer", async ({ page }) => {
    await openApp(page);
    await expect(page.locator(".empty__title")).toHaveText("No books yet");
    await expect(page.locator("#app-version")).toHaveText(/^\d+\.\d+\.\d+ · \w+$/);
    await expect(tiles(page)).toHaveCount(0);
  });

  test("imports an EPUB with its title, cover and chapter count", async ({ page }) => {
    await openApp(page);
    await importBook(page, "basic.epub", "The Lamplighter");
    const t = tile(page, "The Lamplighter");
    await expect(t.locator(".tile__meta")).toHaveText("3 chapters");
    // The cover image came out of the epub.
    await expect(t.locator(".tile__cover img")).toHaveAttribute("src", /^blob:/);
    await expect(page.locator(".lib-label").filter({ hasText: "All books" })).toHaveText("All books · 1");
  });

  test("keeps the library across a reload", async ({ page }) => {
    await openApp(page);
    await importBook(page, "basic.epub", "The Lamplighter");
    await importBook(page, "ncx-only.epub", "Old Format");
    await page.reload();
    await expect(tile(page, "The Lamplighter")).toBeVisible();
    await expect(tile(page, "Old Format")).toBeVisible();
  });

  test("imports several files picked at once", async ({ page }) => {
    await openApp(page);
    await importBooks(page, "basic.epub", "ncx-only.epub", "no-toc.epub", "text.pdf");
    await expect(tiles(page)).toHaveCount(4);
    await expect(tile(page, "No Contents").locator(".tile__meta")).toHaveText("3 chapters");
    await expect(tile(page, "Printed Matter").locator(".tile__meta")).toHaveText("3 chapters");
  });

  test("handles non-ASCII titles and authors", async ({ page }) => {
    await openApp(page);
    await importBook(page, "unicode.epub", "Élan & Ünïcode “Quotes”");
    await tile(page, "Élan & Ünïcode").locator(".tile__cover").click();
    await expect(page.locator("#info-screen")).toContainText("Zoë Ångström");
  });

  test("search filters the shelf", async ({ page }) => {
    await openApp(page);
    await importBooks(page, "basic.epub", "ncx-only.epub");
    await expect(tiles(page)).toHaveCount(2);
    const search = page.locator("#lib-search-input");
    if (!(await search.isVisible())) await page.locator("#lib-search").click();
    await search.fill("lamp");
    await expect(tiles(page)).toHaveCount(1);
    await expect(tile(page, "The Lamplighter")).toBeVisible();
    await search.fill("nothing like this");
    await expect(tiles(page)).toHaveCount(0);
    await search.fill("");
    await expect(tiles(page)).toHaveCount(2);
  });

  test("deletes a book, for good", async ({ page }) => {
    await openApp(page);
    await importBooks(page, "basic.epub", "ncx-only.epub");
    await expect(tiles(page)).toHaveCount(2);
    await tile(page, "Old Format").locator(".tile__cover").click();
    await page.locator("#info-screen [aria-label='More']").first().click();
    await page.locator(".action-item", { hasText: /^Delete/ }).click();
    await page.locator("#confirm-ok").click();
    await expect(page.locator("#app")).toHaveAttribute("data-route", "library");
    await expect(tiles(page)).toHaveCount(1);
    await page.reload();
    await expect(tiles(page)).toHaveCount(1);
    await expect(tile(page, "The Lamplighter")).toBeVisible();
  });

  test("sort toggles between recent and title", async ({ page }) => {
    await openApp(page);
    await importBook(page, "ncx-only.epub", "Old Format");
    await importBook(page, "basic.epub", "The Lamplighter");
    const titles = () => tiles(page).locator(".tile__title").allInnerTexts();
    expect(await titles()).toEqual(["The Lamplighter", "Old Format"]); // most recent first
    await page.locator(".sort-btn").click();
    await expect(page.locator(".sort-btn")).toHaveText(/Title/);
    expect(await titles()).toEqual(["Old Format", "The Lamplighter"]);
    // The choice is saved in the background; reload once it has landed.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            new Promise((resolve) => {
              const req = indexedDB.open("webnovel-reader");
              req.onsuccess = () => {
                const get = req.result.transaction("kv").objectStore("kv").get("ui");
                get.onsuccess = () => resolve(get.result?.sort);
              };
            })
        )
      )
      .toBe("title");
    await page.reload();
    await expect(page.locator(".sort-btn")).toHaveText(/Title/); // remembered
  });
});

test.describe("shelf alignment", () => {
  test("series, book and Import tiles line up in a row", async ({ page }) => {
    await openApp(page);
    await importBooks(page, "vol1.epub", "vol2.epub");
    await page.locator("#suggest-group").click();
    await expect(tiles(page)).toHaveCount(1);
    // A long title wraps to two lines, making its tile the row's tallest: the
    // Import tile (a <button>) must not centre itself in the extra height.
    await importBook(page, "unicode.epub", "Élan & Ünïcode “Quotes”");
    const box = (loc) => loc.boundingBox();
    const series = await box(tile(page, "Ember Saga").locator(".series-stack"));
    const book = await box(tile(page, "Élan").locator(".tile__cover"));
    const imp = await box(page.locator(".tile--import .import-box"));
    for (const b of [series, imp]) {
      expect(Math.abs(b.y - book.y)).toBeLessThan(1);
      expect(Math.abs(b.y + b.height - (book.y + book.height))).toBeLessThan(1);
    }
    // Titles sit on one line too.
    const t1 = await box(tile(page, "Ember Saga").locator(".tile__title"));
    const t2 = await box(tile(page, "Élan").locator(".tile__title"));
    expect(Math.abs(t1.y - t2.y)).toBeLessThan(1);
  });
});
