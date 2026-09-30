// @ts-check
const { test, expect } = require("@playwright/test");

// Real beforeinstallprompt/appinstalled events are Chromium-internal and
// not dispatchable by test code, so every test here simulates them with a
// plain Event carrying fake prompt()/userChoice members -- exactly the
// shape initInstallPrompt() actually reads, and the same technique used to
// hand-test this feature during development.
async function fireBeforeInstallPrompt(page, outcome = "dismissed") {
  await page.evaluate((outcome) => {
    const e = new Event("beforeinstallprompt", { cancelable: true });
    // @ts-ignore - test-only shape matching the real event's members
    e.prompt = () => {
      window.__promptCalled = (window.__promptCalled || 0) + 1;
    };
    // @ts-ignore
    e.userChoice = Promise.resolve({ outcome });
    window.dispatchEvent(e);
  }, outcome);
}

test.describe("install prompt", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/index.html");
  });

  test("banner and icon appear together, dismiss hides only the banner", async ({ page }) => {
    await fireBeforeInstallPrompt(page);
    await expect(page.locator("#install-banner")).toBeVisible();
    await expect(page.locator("#install-icon-btn")).toBeVisible();

    await page.click("#install-dismiss");
    await expect(page.locator("#install-banner")).toBeHidden();
    await expect(page.locator("#install-icon-btn")).toBeVisible();

    const dismissed = await page.evaluate(() => localStorage.getItem("usbands-install-dismissed"));
    expect(dismissed).toBe("1");
  });

  test("the icon still triggers the native prompt after a prior dismissal", async ({ page }) => {
    await page.evaluate(() => localStorage.setItem("usbands-install-dismissed", "1"));
    await page.reload();

    await fireBeforeInstallPrompt(page, "accepted");
    // The banner respects the earlier dismissal and stays hidden...
    await expect(page.locator("#install-banner")).toBeHidden();
    // ...but the icon is the permanent way back in, regardless.
    await expect(page.locator("#install-icon-btn")).toBeVisible();

    await page.click("#install-icon-btn");
    await expect.poll(() => page.evaluate(() => window.__promptCalled)).toBe(1);
  });

  test("appinstalled hides the icon", async ({ page }) => {
    await fireBeforeInstallPrompt(page);
    await expect(page.locator("#install-icon-btn")).toBeVisible();

    await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
    await expect(page.locator("#install-icon-btn")).toBeHidden();
  });

  test("neither banner nor icon shows without a captured install event", async ({ page }) => {
    await expect(page.locator("#install-banner")).toBeHidden();
    await expect(page.locator("#install-icon-btn")).toBeHidden();
  });
});

test.describe("install prompt on iOS", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });

  test("shows Share-sheet instructions instead of a native Install button", async ({ page }) => {
    await page.goto("/index.html");
    await expect(page.locator("#install-banner")).toBeVisible();
    await expect(page.locator("#install-btn")).toBeHidden();
    await expect(page.locator("#install-banner-text")).toContainText("Add to Home Screen");
    await expect(page.locator("#install-icon-btn")).toBeVisible();
  });

  test("the icon re-shows the instructions even after dismissal", async ({ page }) => {
    await page.goto("/index.html");
    await page.click("#install-dismiss");
    await expect(page.locator("#install-banner")).toBeHidden();

    await page.click("#install-icon-btn");
    await expect(page.locator("#install-banner")).toBeVisible();
    await expect(page.locator("#install-banner-text")).toContainText("Add to Home Screen");
  });
});
