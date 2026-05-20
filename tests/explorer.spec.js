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

  test("unreviewed filter requires API sign-in (select reverts without JWT)", async ({ page }) => {
    await expect(page.locator("#filter-my-review")).toBeVisible();
    await page.locator("#filter-my-review").selectOption("unreviewed");
    await expect(page.locator("#filter-my-review")).toHaveValue("all");
    await expect(page.locator("#explorer-auth-panel")).toBeVisible();
    await expect(page.locator("#inat-api-auth-status")).toContainText(/sign in with an api token/i);
  });

  test("favorited by me filter requires API sign-in (checkbox reverts without JWT)", async ({ page }) => {
    await expect(page.locator("#filter-faved-by-me")).toBeVisible();
    await page.locator("#filter-faved-by-me").click();
    await expect(page.locator("#filter-faved-by-me")).not.toBeChecked();
    await expect(page.locator("#explorer-auth-panel")).toBeVisible();
    await expect(page.locator("#inat-api-auth-status")).toContainText(/sign in/i);
  });

  test("API sign-in is available from Log in at bottom of Filters", async ({ page }) => {
    await expect(page.locator("#btn-explorer-auth-toggle")).toHaveText("Log in");
    await page.locator("#btn-explorer-auth-toggle").click();
    await expect(page.getByRole("group", { name: /iNaturalist sign-in/i })).toBeVisible();
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

test.describe("explorer near_me geolocation", () => {
  test("shows alert and banner when Nearby geolocation is denied", async ({ page }) => {
    await page.addInitScript(() => {
      navigator.geolocation.getCurrentPosition = (_ok, reject) => {
        reject({ code: 1, message: "User denied Geolocation" });
      };
    });
    const dialogPromise = new Promise((resolve) => {
      page.once("dialog", (d) => {
        expect(d.message()).toMatch(/denied|permission/i);
        void d.accept();
        resolve(null);
      });
    });
    await page.goto("/explorer/?view=filters", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".view-tabs")).toBeVisible();
    await page.waitForFunction(() => window.__EXPLORER_BOOT__ != null, { timeout: 60_000 });
    await page.evaluate(() => window.__EXPLORER_BOOT__);
    await page.locator("#place-input").focus();
    await page.getByRole("option", { name: "Nearby" }).click();
    await dialogPromise;
    await expect(page.locator("#error-banner-place")).toBeVisible();
    await expect(page.locator("#error-banner-place")).toContainText(/permission|denied/i);
  });

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

  test("near_me=1 link fills coordinates from geolocation on load (no session restore)", async ({ page, context }) => {
    const origin = test.info().project.use.baseURL;
    if (!origin) throw new Error("Playwright baseURL is required for geolocation permission");
    await context.grantPermissions(["geolocation"], { origin });
    await page.addInitScript(() => {
      navigator.geolocation.getCurrentPosition = (success) => {
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
      };
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
