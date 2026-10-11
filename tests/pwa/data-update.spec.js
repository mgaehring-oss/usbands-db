// @ts-check
const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

// Reported bug: after a new data refresh, the "New scores are available"
// banner's Refresh button reloaded the scores but the footer still showed the
// OLD "last updated" date until a second manual reload. Reproduce it for real
// by changing docs/data/last_updated.txt on disk (what a deploy does) and
// clicking through the banner. The original file is always restored.
const STAMP_PATH = path.join(__dirname, "..", "..", "docs", "data", "last_updated.txt");

test("the footer date updates after clicking Refresh on the new-scores banner", async ({ page }) => {
  const original = fs.readFileSync(STAMP_PATH, "utf-8");
  try {
    await page.goto("/index.html");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await page.waitForTimeout(1000); // let this load's revalidation land in the cache
    const before = await page.locator("#last-updated").textContent();
    expect(before).toMatch(/last updated/);
    await expect(page.locator("#data-update-banner")).toBeHidden();

    fs.writeFileSync(STAMP_PATH, "2031-03-04T05:06:07Z\n");

    // A load serves the cached (old) stamp, then the worker sees the new one
    // on the network and announces it.
    await page.reload();
    await expect(page.locator("#data-update-banner")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#last-updated")).toHaveText(before ?? "");

    // The banner must only appear once the new stamp is already cached, so
    // the reload it triggers can't be served the old one.
    const cachedStamp = await page.evaluate(async () => {
      const cache = await caches.open("usbands-data-v1");
      const hit = await cache.match("/data/last_updated.txt");
      return hit ? (await hit.text()).trim() : null;
    });
    expect(cachedStamp).toBe("2031-03-04T05:06:07Z");

    await page.click("#data-update-refresh");
    await expect(page.locator("#last-updated")).toContainText("Mar 4, 2031", { timeout: 10_000 });
    await expect(page.locator("#data-update-banner")).toBeHidden();
  } finally {
    fs.writeFileSync(STAMP_PATH, original);
  }
});
