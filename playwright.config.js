import { defineConfig, devices } from "@playwright/test";

// End-to-end tests: the real built app (vite build + vite preview, service
// worker included) driven in Chromium, at phone size (the reference design)
// and at desktop size. Unit tests over the pure logic stay in test/ (Vitest).
const PORT = 4173;

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.mjs",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://localhost:${PORT}/`,
    // Each test starts from an empty library; the offline suite opts back in.
    serviceWorkers: "block",
    trace: "off",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "phone", use: { ...devices["Pixel 7"] } },
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    command: `npm run build -- --logLevel warn && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
