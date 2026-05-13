// @ts-check
import { test, expect } from "@playwright/test";

/** Two common species with a shared insect ancestry (stable iNat taxon ids). */
const TREE_SEED = "taxa=47219,48662";

test.describe("taxonomic tree page", () => {
  test("loads merged tree from URL taxa parameter", async ({ page }) => {
    await page.goto(`/taxon-tree/?${TREE_SEED}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Taxonomic tree" })).toBeVisible();
    await expect(page.locator("svg.tree-viz-svg")).toBeVisible({ timeout: 90_000 });
    await expect(page.locator("svg.tree-viz-svg")).toContainText(/Insecta|Life|Animalia/i, { timeout: 30_000 });
    await expect(page.locator("svg .tree-link")).not.toHaveCount(0);
  });
});
