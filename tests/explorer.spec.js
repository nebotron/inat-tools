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
