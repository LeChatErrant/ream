import { test, expect, openApp, importBooks, importBook, tiles, tile } from "./helpers.js";

// A file that won't import must say so — promptly, in words — and leave the app
// fully usable. None of these may hang the import or put a ghost on the shelf.
const notice = (page) => page.locator("#confirm-sheet");

test.describe("broken imports", () => {
  for (const name of ["empty.epub", "garbage.epub", "not-an-epub.epub", "bad-opf.epub", "broken.pdf"]) {
    test(`${name} is reported, not imported`, async ({ page }) => {
      await openApp(page);
      await importBooks(page, name);
      await expect(notice(page)).toBeVisible();
      await expect(page.locator("#confirm-title")).toHaveText("Couldn't import this file");
      await expect(page.locator("#confirm-body")).toContainText(name);
      await expect(page.locator("#confirm-cancel")).toBeHidden();
      await expect(page.locator("#busy-toast")).toBeHidden();
      await page.locator("#confirm-ok").click();
      await expect(notice(page)).toBeHidden();
      await expect(tiles(page)).toHaveCount(0);

      // Still works: a good book imports right after.
      await importBook(page, "basic.epub", "The Lamplighter");
      await page.reload();
      await expect(tiles(page)).toHaveCount(1);
    });
  }

  test("a mixed batch imports the good files and lists the bad ones", async ({ page }) => {
    await openApp(page);
    await importBooks(page, "basic.epub", "garbage.epub", "notes.txt", "ncx-only.epub");
    await expect(notice(page)).toBeVisible();
    await expect(page.locator("#confirm-title")).toHaveText("Imported 2 of 4");
    await expect(page.locator("#confirm-body")).toContainText("garbage.epub");
    await expect(page.locator("#confirm-body")).toContainText("notes.txt");
    await page.locator("#confirm-ok").click();
    await expect(tiles(page)).toHaveCount(2);
    await expect(tile(page, "The Lamplighter")).toBeVisible();
    await expect(tile(page, "Old Format")).toBeVisible();
  });

  test("a file that isn't a book is turned away with a reason", async ({ page }) => {
    await openApp(page);
    await importBooks(page, "notes.txt");
    await expect(page.locator("#confirm-title")).toHaveText("Nothing to import");
    await expect(page.locator("#confirm-body")).toContainText("notes.txt");
  });

  test("after a notice, the delete confirm still looks like a delete confirm", async ({ page }) => {
    // The notice borrows the confirm sheet; it must hand it back as it found it.
    await openApp(page);
    await importBooks(page, "garbage.epub");
    await page.locator("#confirm-ok").click();
    await importBook(page, "basic.epub", "The Lamplighter");
    await tile(page, "The Lamplighter").locator(".tile__cover").click();
    await page.locator("#info-screen [aria-label='More']").first().click();
    await page.locator(".action-item", { hasText: /^Delete/ }).click();
    await expect(page.locator("#confirm-cancel")).toBeVisible();
    await expect(page.locator("#confirm-ok")).toHaveClass(/pill-btn--danger/);
    await page.locator("#confirm-cancel").click();
    await expect(page.locator("#confirm-sheet")).toBeHidden();
    await expect(page.locator("#info-screen")).toBeVisible(); // not deleted: still on its page
  });

  test("a write the disk refuses at commit is reported too", async ({ page }) => {
    // A full disk can fail the transaction as a whole (an abort, with no
    // request error) — the import must still end, not wait forever.
    await openApp(page);
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, ...rest) {
        const req = put.call(this, value, ...rest);
        if (this.name === "books") {
          const t = this.transaction;
          req.addEventListener("success", () => t.abort());
        }
        return req;
      };
    });
    await importBooks(page, "basic.epub");
    await expect(page.locator("#confirm-title")).toHaveText("Couldn't import this file");
    await page.locator("#confirm-ok").click();
    await expect(tiles(page)).toHaveCount(0);
  });

  test("running out of storage is explained, and nothing half-saved is left", async ({ page }) => {
    await openApp(page);
    // Make every IndexedDB write of a book fail the way a full disk does.
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, ...rest) {
        if (this.name === "books")
          throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        return put.call(this, value, ...rest);
      };
    });
    await importBooks(page, "basic.epub");
    await expect(page.locator("#confirm-body")).toContainText("no storage space left");
    await page.locator("#confirm-ok").click();
    await expect(tiles(page)).toHaveCount(0);
  });
});
