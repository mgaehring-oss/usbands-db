// @ts-check
const { defineConfig, devices } = require("@playwright/test");

// Serves docs/ exactly as GitHub Pages would -- a plain static file server,
// no build step, matching how this site is actually deployed.
module.exports = defineConfig({
  testDir: "./tests/pwa",
  fullyParallel: false, // tests share/inspect Cache Storage and service worker state per page
  forbidOnly: !!process.env.CI,
  // One retry everywhere, not just in CI: this local dev machine's SW tests
  // occasionally hit genuine resource contention (many other processes
  // competing for the same Chromium/Python-server resources this session)
  // severe enough that even a 60s timeout isn't always enough -- CI, on a
  // dedicated runner, has passed cleanly every single time this suite has
  // run there. A retry absorbs that class of one-off local contention
  // without masking a real regression, which would still fail both the
  // first attempt and the retry.
  retries: 1,
  reporter: process.env.CI ? "github" : "list",
  // Chrome throttles how often it'll check a service worker script for
  // updates, and that throttling appears to accumulate across many
  // registrations against the same origin in one run (not per browser
  // context) -- as the suite grew, SW-dependent tests started timing out
  // right at Playwright's 30s default under that load, not because the
  // update genuinely never happens. Doubling it gives Chrome's real (just
  // slower-under-load) timing room instead of hard-failing at the edge.
  timeout: 60_000,
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
