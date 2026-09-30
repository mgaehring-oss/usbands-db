// @ts-check
const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

// This is the exact bug reported after shipping a real feature: an
// installed PWA kept showing old code with no indication a new version had
// shipped. Reproduce it for real -- write a byte-different sw.js to disk
// (browsers detect a service worker update by comparing script bytes, not
// a version number), the same as a real deploy would, and confirm the page
// notices and offers to reload. The original file is always restored, even
// if an assertion fails partway through.
const SW_PATH = path.join(__dirname, "..", "..", "docs", "sw.js");

test("shows a reload prompt when a new service worker version is deployed", async ({ page }) => {
  const originalSw = fs.readFileSync(SW_PATH, "utf-8");
  try {
    await page.goto("/index.html");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

    await expect(page.locator("#app-update-banner")).toBeHidden();

    // Simulate a real deploy: the same file, genuinely changed.
    fs.writeFileSync(SW_PATH, originalSw + "\n// deployed change\n");

    // Chrome checks for a new service worker version on navigation, but
    // throttles how often it'll do so implicitly -- calling update()
    // directly forces the check rather than depending on that timing,
    // which was flaky here after many prior tests had just registered the
    // same script URL in quick succession.
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) await registration.update();
    });
    await expect(page.locator("#app-update-banner")).toBeVisible({ timeout: 10_000 });

    await page.click("#app-update-refresh");
    // The new worker already activated (skipWaiting + clients.claim), so a
    // plain reload is controlled by it from here on.
    await page.waitForLoadState("load");
    await expect(page.locator("#app-update-banner")).toBeHidden();
  } finally {
    fs.writeFileSync(SW_PATH, originalSw);
  }
});
