// @ts-check
const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

// Icons are precached as part of SHELL_ASSETS and, like app.js, served
// through the same stale-while-revalidate path (see sw.js's fetch handler:
// any same-origin GET not matching isDataAsset/isVendorAsset falls through
// to the shell's staleWhileRevalidate) -- this had never been explicitly
// checked, only inferred from the code.
//
// Checking it surfaced a real asymmetry with app.js, though: a plain
// page.reload() issues ZERO network requests for <link rel="icon">-type
// resources (confirmed empirically -- a request listener across a reload
// saw nothing matching "icon" at all). Browsers cache favicons far more
// aggressively than they cache scripts/stylesheets, largely independent of
// normal per-navigation fetching, so the service worker's fetch handler
// often never gets a chance to revalidate an icon just because the user
// reloaded or reopened the page -- unlike app.js, which the browser always
// re-requests on every navigation. This test instead fetches the icon
// directly (the one case that reliably reaches the service worker) to
// confirm the underlying stale-while-revalidate mechanism itself is
// correct. The practical upshot: if an icon's *pixels* ever genuinely need
// to change, ship it under a new filename (the standard cache-busting
// approach for any static asset) rather than overwriting the existing one
// in place and hoping a revalidation happens to occur.
const ICON_PATH = path.join(__dirname, "..", "..", "docs", "icons", "icon-192.png");
const REPLACEMENT_ICON_PATH = path.join(__dirname, "..", "..", "docs", "icons", "icon-512-maskable.png");
const ICON_URL = "http://localhost:4173/icons/icon-192.png";

async function cachedIconByteLength(page) {
  return page.evaluate(async (key) => {
    const cache = await caches.open("usbands-shell-v1");
    const resp = await cache.match(key);
    return resp ? (await resp.arrayBuffer()).byteLength : null;
  }, ICON_URL);
}

test("precaches every manifest icon on install", async ({ page }) => {
  await page.goto("/index.html");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForTimeout(500);

  const cached = await page.evaluate(async () => {
    const cache = await caches.open("usbands-shell-v1");
    return (await cache.keys()).map((r) => new URL(r.url).pathname);
  });
  expect(cached).toEqual(
    expect.arrayContaining(["/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-512-maskable.png"])
  );
});

test("a plain reload does not re-request the icon (unlike app.js)", async ({ page }) => {
  await page.goto("/index.html");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.waitForTimeout(500);

  const iconRequests = [];
  page.on("request", (req) => {
    if (req.url().includes("/icons/")) iconRequests.push(req.url());
  });
  await page.reload();
  await page.waitForTimeout(1000);

  expect(iconRequests).toEqual([]);
});

test("the cache itself correctly revalidates an icon once actually fetched", async ({ page }) => {
  const originalIcon = fs.readFileSync(ICON_PATH);
  const replacementIcon = fs.readFileSync(REPLACEMENT_ICON_PATH);
  expect(originalIcon.length).not.toBe(replacementIcon.length); // must be a genuine diff

  try {
    await page.goto("/index.html");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await page.waitForTimeout(500);
    expect(await cachedIconByteLength(page)).toBe(originalIcon.length);

    // Simulate a real deploy: the same file, genuinely changed.
    fs.writeFileSync(ICON_PATH, replacementIcon);

    // Force the one path that does reach the service worker: an explicit
    // fetch. First call still returns the stale cached copy (by design --
    // stale-while-revalidate always serves what's cached immediately)...
    const firstFetchLength = await page.evaluate(
      (url) => fetch(url, { cache: "no-store" }).then((r) => r.arrayBuffer()).then((b) => b.byteLength),
      ICON_URL
    );
    expect(firstFetchLength).toBe(originalIcon.length);
    await page.waitForTimeout(500); // let the background revalidation finish

    // ...and the cache is now warm for next time.
    expect(await cachedIconByteLength(page)).toBe(replacementIcon.length);
  } finally {
    fs.writeFileSync(ICON_PATH, originalIcon);
  }
});
