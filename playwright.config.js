// @ts-check
const { defineConfig, devices } = require("@playwright/test");

// Serves docs/ exactly as GitHub Pages would -- a plain static file server,
// no build step, matching how this site is actually deployed.
module.exports = defineConfig({
  testDir: "./tests/pwa",
  fullyParallel: false, // tests share/inspect Cache Storage and service worker state per page
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:4173",
    trace: "on-first-retry",
  },
  webServer: {
    command: "python -m http.server 4173 --directory docs --bind 127.0.0.1",
    url: "http://localhost:4173/index.html",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
