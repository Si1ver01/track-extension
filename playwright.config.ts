import { defineConfig, devices } from "@playwright/test";

const fixturePort = 4173;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: "line",
  outputDir: "test-results/playwright",
  use: {
    baseURL: `http://localhost:${fixturePort}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node tests/e2e/fixture-server.mjs",
    port: fixturePort,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
  },
  projects: [
    {
      name: "chromium-extension",
      testMatch: /chromium-extension\.spec\.ts/,
    },
    {
      name: "firefox-smoke",
      testMatch: /firefox-smoke\.spec\.ts/,
      use: { ...devices["Desktop Firefox"] },
    },
  ],
});
