import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: "./test",
  testMatch: /(?:desktop-ui|electron-smoke|electron-stability|pdf-preview|support|sidebar)\.spec\.ts/,
  outputDir: "test-results/artifacts",
  fullyParallel: true,
  workers: 4,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [["list"], ["html", { outputFolder: "test-results/report", open: "never" }]],
  use: {
    browserName: "chromium",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
