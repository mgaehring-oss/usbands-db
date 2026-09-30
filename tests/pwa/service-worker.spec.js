// @ts-check
const { test, expect } = require("@playwright/test");

// A brand-new service worker registration does NOT control the page that
// triggered it -- only the NEXT navigation is controlled (see sw.js's
// clients.claim() in its activate handler). Every test here reloads once
// after the initial goto() for exactly that reason; skipping it was the
// root cause of real confusion while building this feature by hand.
test.describe("service worker", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/index.html");
    await page.evaluate(() => navigator.serviceWorker.ready);
  });

  test("registers and takes control on the next load", async ({ page }) => {
    await page.reload();
    const controllerUrl = await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null);
    expect(controllerUrl).toBe(new URL("/sw.js", page.url()).href);
  });

  test("caches the app shell, database, and vendor assets", async ({ page }) => {
    await page.reload();
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    // Give the shell/data/vendor fetches triggered by this load a moment to
    // land in Cache Storage via the service worker's fetch handler.
    await page.waitForTimeout(1000);

    const cacheContents = await page.evaluate(async () => {
      const names = await caches.keys();
      const out = {};
      for (const name of names) {
        const cache = await caches.open(name);
        out[name] = (await cache.keys()).map((r) => new URL(r.url).pathname);
      }
      return out;
    });

    expect(cacheContents["usbands-shell-v1"]).toEqual(
      expect.arrayContaining(["/index.html", "/app.js", "/style.css", "/manifest.json"])
    );
    expect(cacheContents["usbands-data-v1"]).toEqual(
      expect.arrayContaining(["/data/usbands.db", "/data/last_updated.txt"])
    );
    expect(cacheContents["usbands-vendor-v1"].some((p) => p.endsWith("sql-wasm.wasm"))).toBe(true);
  });

  test("still renders the leaderboard with the network fully offline", async ({ page, context }) => {
    // Warm every cache first: one reload to get under SW control, a second
    // so that load's own fetches (shell + data + vendor) are the ones
    // actually intercepted and cached, not just kicked off uncontrolled.
    await page.reload();
    await page.waitForTimeout(1000);
    await page.reload();
    await expect(page.locator(".division-section").first()).toBeVisible();

    await context.setOffline(true);
    try {
      await page.reload();
      await expect(page.locator(".division-section").first()).toBeVisible({ timeout: 10_000 });
      await expect(page.locator("#status")).toBeHidden();
      // The install/data-update banners depend on live events or a network
      // diff; only the offline banner should be showing.
      await expect(page.locator("#offline-banner")).toBeVisible();
    } finally {
      await context.setOffline(false);
    }
  });
});
