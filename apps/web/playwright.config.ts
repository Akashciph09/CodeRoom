import { defineConfig } from "@playwright/test";
import { loadEnv } from "vite";

// Same repo-root .env the app uses.
const env = loadEnv("", "../..", "");
const WEB_URL = process.env.E2E_WEB_URL ?? "http://localhost:5173";

/**
 * Browser tests for the interviewer/candidate flow. They drive the real stack:
 * local Supabase, Redis, API and worker must be running (see README → Getting started).
 * Locally they use the installed Google Chrome; set PLAYWRIGHT_CHANNEL="" (and run
 * `pnpm exec playwright install chromium`) to use Playwright's bundled Chromium instead, e.g. in CI.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts", // not *.spec.ts / *.test.ts, so Vitest never picks these up
  globalSetup: "./e2e/global-setup.ts",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  // Tests create real users and rooms and run real sandboxes; keep them sequential.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: WEB_URL,
    viewport: { width: 1400, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chrome",
      // No `devices["Desktop Chrome"]` preset: it fakes a Windows user agent, so Monaco would bind
      // select-all to Ctrl+A while Playwright's ControlOrMeta sends Cmd on macOS. Keep the real UA.
      use: {
        browserName: "chromium",
        viewport: { width: 1400, height: 900 },
        channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome",
      },
    },
  ],
  webServer: {
    // Starts web + API + worker if nothing is running yet; reuses them if they are.
    command: "pnpm --dir ../.. dev",
    url: WEB_URL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
  metadata: { apiUrl: env.VITE_API_URL },
});
