// @ts-check
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT) || 4188;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    navigationTimeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx serve . -l ${PORT} --no-request-logging`,
    url: `${BASE_URL}/explorer/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
