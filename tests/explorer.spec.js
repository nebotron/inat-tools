// @ts-check
import { test, expect } from "@playwright/test";

/** Narrow place + taxon so iNaturalist responses stay small and stable. */
const SEED_QUERY =
  "place_id=14&taxon_id=47208&view=filters";

test.describe("explorer", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/explorer/?${SEED_QUERY}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator(".view-tabs")).toBeVisible();
    await page.waitForFunction(() => window.__EXPLORER_BOOT__ != null, { timeout: 60_000 });
    await page.evaluate(() => window.__EXPLORER_BOOT__);
  });

  test("loads filters and can open Observations with results summary", async ({ page }) => {
    await page.getByRole("tab", { name: "Observations" }).click();
    await expect(page.locator("#panel-observations")).toBeVisible();
    await expect(page.locator("#search-summary-obs")).toContainText(/observation/i, { timeout: 90_000 });
  });

  test("evidence filter is reflected in the URL", async ({ page }) => {
    await expect(page.locator("#filter-evidence-presence")).toBeVisible();
    await page.locator("#filter-evidence-presence").selectOption("egg");
    await expect(page).toHaveURL(/evidence=egg/);
    await page.locator("#filter-evidence-presence").selectOption("any");
    await expect(page).not.toHaveURL(/evidence=/);
  });

  test("unreviewed filter requires API sign-in (select reverts without JWT)", async ({ page }) => {
    await expect(page.locator("#filter-my-review")).toBeVisible();
    page.once("dialog", (d) => d.accept());
    await page.locator("#filter-my-review").selectOption("unreviewed");
    /* Without a stored JWT the UI reverts the select and shows an alert. */
    await expect(page.locator("#filter-my-review")).toHaveValue("all");
  });

  test("API sign-in fieldset is available for JWT and Agree", async ({ page }) => {
    await expect(page.getByRole("group", { name: /API sign-in/i })).toBeVisible();
    await expect(page.locator("#inat-api-token")).toBeVisible();
    await expect(page.locator("#inat-api-auth-status")).toContainText(/not signed in/i);
  });

  test("Stats tab shows cumulative species line chart", async ({ page }) => {
    await page.getByRole("tab", { name: "Stats" }).click();
    await expect(page.locator("#panel-stats")).toBeVisible();
    await expect(page.locator(".stats-heading")).toContainText(/distinct species/i, { timeout: 90_000 });
    await expect(page.locator("#stats-content .stats-line-chart")).toBeVisible({ timeout: 90_000 });
  });

  test("Map tab shows user location marker when geolocation is granted", async ({ page, context }) => {
    await page.addInitScript(() => {
      let nextId = 1;
      navigator.geolocation.watchPosition = (success) => {
        const id = nextId++;
        queueMicrotask(() =>
          success({
            coords: {
              latitude: 37.7749,
              longitude: -122.4194,
              accuracy: 10,
              altitude: null,
              altitudeAccuracy: null,
              heading: null,
              speed: null,
            },
            timestamp: Date.now(),
          })
        );
        return id;
      };
    });
    await page.goto(`/explorer/?${SEED_QUERY}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__EXPLORER_BOOT__ != null, { timeout: 60_000 });
    await page.evaluate(() => window.__EXPLORER_BOOT__);
    await context.grantPermissions(["geolocation"], { origin: page.url() });
    await context.setGeolocation({ latitude: 37.7749, longitude: -122.4194 });
    await page.getByRole("tab", { name: "Map" }).click();
    /* Leaflet adds `leaflet-container` to `#map-container` itself, not a child. */
    await expect(page.locator("#map-container.leaflet-container")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".map-user-location-marker")).toBeVisible({ timeout: 30_000 });
  });
});

test.describe("explorer near_me session restore", () => {
  test("writes near_me to URL before geolocation resolves", async ({ page, context }) => {
    const origin = test.info().project.use.baseURL;
    if (!origin) throw new Error("Playwright baseURL is required for geolocation permission");
    await context.grantPermissions(["geolocation"], { origin });
    await page.addInitScript(() => {
      navigator.geolocation.getCurrentPosition = (success) => {
        setTimeout(() => {
          success({
            coords: {
              latitude: 47.606_138,
              longitude: -122.332_056,
              accuracy: 10,
              altitude: null,
              altitudeAccuracy: null,
              heading: null,
              speed: null,
            },
            timestamp: Date.now(),
          });
        }, 3000);
      };
    });
    await page.goto("/explorer/?view=filters", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".view-tabs")).toBeVisible();
    await page.waitForFunction(() => window.__EXPLORER_BOOT__ != null, { timeout: 60_000 });
    await page.evaluate(() => window.__EXPLORER_BOOT__);
    await page.locator("#place-input").focus();
    await page.getByRole("option", { name: "Nearby" }).click();
    await expect(page).toHaveURL(/near_me=1/, { timeout: 2000 });
  });

  test("restores Nearby lat/lng from sessionStorage when URL uses near_me=1", async ({ page }) => {
    await page.addInitScript(() => {
      sessionStorage.setItem(
        "inatExplorerNearMeGeo",
        JSON.stringify({
          v: 2,
          lat: 47.606_138,
          lng: -122.332_056,
          intentKey: "near_me|25",
          savedAt: Date.now(),
        }),
      );
    });
    await page.goto("/explorer/?near_me=1&radius=25&view=filters", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".view-tabs")).toBeVisible();
    await page.waitForFunction(() => window.__EXPLORER_BOOT__ != null, { timeout: 60_000 });
    await page.evaluate(() => window.__EXPLORER_BOOT__);
    await expect(page.locator("#place-input")).toHaveValue("Nearby");
    await expect(page.locator("#lat")).toHaveValue(/47\.606/);
    await expect(page.locator("#lng")).toHaveValue(/-122\.332/);
    await expect(page.locator("#nearby-controls")).toBeVisible();
  });
});
