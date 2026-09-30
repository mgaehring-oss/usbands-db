// @ts-check
const { test, expect } = require("@playwright/test");

test.describe("manifest", () => {
  test("declares the required PWA fields", async ({ request }) => {
    const resp = await request.get("/manifest.json");
    expect(resp.ok()).toBeTruthy();
    const manifest = await resp.json();

    expect(manifest.name).toBe("USBands Score Tracker");
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBeTruthy();
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(Array.isArray(manifest.icons)).toBe(true);
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
    expect(manifest.icons.some((i) => i.purpose === "maskable")).toBe(true);
  });

  test("every declared icon is reachable and matches its declared size", async ({ page, request, baseURL }) => {
    await page.goto("/index.html");
    const manifest = await (await request.get("/manifest.json")).json();

    for (const icon of manifest.icons) {
      const resp = await request.get("/" + icon.src);
      expect(resp.ok(), `icon ${icon.src} should be reachable`).toBeTruthy();
      expect(resp.headers()["content-type"]).toContain("image/png");

      const [declaredW, declaredH] = icon.sizes.split("x").map(Number);
      const dims = await page.evaluate(
        (url) =>
          new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
            img.onerror = () => reject(new Error(`failed to decode ${url}`));
            img.src = url;
          }),
        new URL(icon.src, baseURL + "/").href
      );
      expect(dims, `icon ${icon.src} size`).toEqual({ w: declaredW, h: declaredH });
    }
  });

  test("index.html links the manifest and a valid theme-color", async ({ page }) => {
    await page.goto("/index.html");
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "manifest.json");
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", /^#[0-9a-f]{6}$/i);
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
  });
});
