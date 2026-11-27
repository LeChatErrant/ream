// The PWA promises: after one visit the app opens and reads with no network at
// all, and a new version waits to be applied — it never swaps itself in
// mid-read. These run the real service worker, served from dist/ by a tiny
// server of our own so a test can publish a "new version" of sw.js.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { test, expect, importBook, startReading, chapter, chapterTitle } from "./helpers.js";

const DIST = new URL("../dist/", import.meta.url).pathname;
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".epub": "application/epub+zip",
};

test.use({ serviceWorkers: "allow" });

let server;
let origin;
let swSuffix = ""; // appended to sw.js: a changed worker is a new version

test.beforeAll(async () => {
  server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const rel = normalize(path === "/" ? "/index.html" : path).replace(/^(\.\.[/\\])+/, "");
    try {
      let body = await readFile(join(DIST, rel));
      if (rel === "/sw.js" && swSuffix) body = Buffer.concat([body, Buffer.from(`\n// ${swSuffix}\n`)]);
      res.writeHead(200, {
        "content-type": TYPES[extname(rel)] || "application/octet-stream",
        "cache-control": "no-cache",
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}/`;
});
test.afterAll(() => new Promise((r) => server.close(r)));
test.beforeEach(() => {
  swSuffix = "";
});

/** Load the app and wait until the service worker controls the page. */
async function installed(page) {
  await page.goto(origin);
  await page.evaluate(() => navigator.serviceWorker.ready);
  // The first visit installs the worker; from the next load on it serves the app.
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await expect(page.locator("#library")).toBeVisible();
}

test.describe("offline", () => {
  test("opens, imports and reads with no network", async ({ page, context }) => {
    await installed(page);
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator("#library")).toBeVisible();
    await expect(page.locator("#app-version")).toHaveText(/\d+\.\d+\.\d+/);

    await importBook(page, "basic.epub", "The Lamplighter");
    await startReading(page, "The Lamplighter");
    await expect(chapterTitle(page)).toHaveText("Chapter 1");
    await expect(chapter(page).locator("p").first()).toContainText("Chapter 1, paragraph 1.");
    // Every font the reading theme points at is served offline (precached).
    const fonts = await page.evaluate(async () => {
      const css = document
        .querySelector("#viewer iframe")
        .contentDocument.getElementById("webnovel-theme").textContent;
      const urls = [...css.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]);
      const res = await Promise.all(
        urls.map((u) =>
          fetch(u).then(
            (r) => r.ok,
            () => false
          )
        )
      );
      return { count: urls.length, ok: res.every(Boolean) };
    });
    expect(fonts.count).toBeGreaterThan(0);
    expect(fonts.ok).toBe(true);
  });

  test("a PDF opens offline too (PDF.js is precached)", async ({ page, context }) => {
    await installed(page);
    await context.setOffline(true);
    await page.reload();
    await importBook(page, "text.pdf", "Printed Matter");
    await startReading(page, "Printed Matter");
    await expect(page.locator("#viewer .pdf-page canvas").first()).toBeVisible({ timeout: 20_000 });
  });

  test("'Check for updates' while offline says it couldn't check", async ({ page, context }) => {
    await installed(page);
    await context.setOffline(true);
    await page.locator("#check-update").click();
    await expect(page.locator("#update-status")).toHaveText(/Couldn't check|up to date/);
  });
});

test.describe("updates", () => {
  test("a new version waits for Reload, then applies", async ({ page }) => {
    await installed(page);
    await importBook(page, "basic.epub", "The Lamplighter");
    await startReading(page, "The Lamplighter");
    await expect(chapterTitle(page)).toHaveText("Chapter 1");

    swSuffix = "next version";
    // The app checks on focus / every minute; ask now.
    await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
    await expect(page.locator("#update-banner")).toBeVisible();
    await expect(page.locator("#update-banner-text")).toHaveText("A new version is ready.");
    // Still reading: nothing reloaded under us.
    await expect(page.locator("#app")).toHaveAttribute("data-route", "reader");
    await expect(chapterTitle(page)).toHaveText("Chapter 1");

    // Tapped straight away — before workbox-window would have armed its own
    // reload (it reports "waiting" ~200 ms after install). That used to
    // activate the new version without reloading, leaving the banner stuck.
    await Promise.all([page.waitForEvent("load"), page.locator("#update-reload").click()]);
    await expect(page.locator("#library")).toBeVisible();
    await expect(page.locator("#update-banner")).toBeHidden();
    // The library is intact after the update.
    await expect(page.locator(".continue-card")).toContainText("The Lamplighter");
  });
});
