import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/visual",
  testMatch: ["**/*.visual.ts", "**/auth.setup.ts"],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  snapshotPathTemplate: "{testDir}/snapshots/{projectName}/{arg}{ext}",
  use: {
    baseURL: process.env.WIZARD_BASE_URL || "http://127.0.0.1:4901",
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    reducedMotion: "reduce",
    deviceScaleFactor: 1,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "desktop-light",
      testIgnore: "**/auth.setup.ts",
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 }, colorScheme: "light", storageState: "tests/visual/.auth.json" },
    },
    {
      name: "desktop-dark",
      testIgnore: "**/auth.setup.ts",
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 }, colorScheme: "dark", storageState: "tests/visual/.auth.json" },
    },
    {
      name: "mobile-light",
      testIgnore: "**/auth.setup.ts",
      dependencies: ["setup"],
      use: { ...devices["iPhone 13"], viewport: { width: 390, height: 844 }, colorScheme: "light", storageState: "tests/visual/.auth.json" },
    },
    {
      name: "mobile-dark",
      testIgnore: "**/auth.setup.ts",
      dependencies: ["setup"],
      use: { ...devices["iPhone 13"], viewport: { width: 390, height: 844 }, colorScheme: "dark", storageState: "tests/visual/.auth.json" },
    },
  ],
});
