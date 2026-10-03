import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: "list",
  outputDir: "./test-results",
  use: {
    baseURL: "http://127.0.0.1:3108",
    serviceWorkers: "block", // Route all remote calls through deterministic fixtures.
    launchOptions: {
      ...(process.env.WIZPAY_TEST_CHROMIUM_PATH
        ? { executablePath: process.env.WIZPAY_TEST_CHROMIUM_PATH }
        : {}),
    },
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    {
      name: "mobile",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command: "node test/start-acceptance.mjs",
    url: "http://127.0.0.1:3108",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
