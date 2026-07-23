/**
 * Dedicated Playwright lane for real owner sign-in and post-sign-in activation.
 * It serves the shipped app renderer while the spec owns an isolated real API.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const uiPort = Number(process.env.ELIZA_AUTH_ACTIVATION_UI_PORT || 22_138);
const apiPort = Number(process.env.ELIZA_AUTH_ACTIVATION_API_PORT || 22_139);

process.env.ELIZA_UI_PORT = String(uiPort);
process.env.ELIZA_API_PORT = String(apiPort);

export default defineConfig({
  testDir: "./test/auth-activation-live",
  timeout: 600_000,
  expect: {
    timeout: 30_000,
  },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  outputDir: "./test-results/auth-activation-live",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${uiPort}`,
    trace: "retain-on-failure",
    video: "on",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "bun run dev",
    cwd: appDir,
    env: {
      ...process.env,
      CI: "true",
      ELIZA_API_PORT: String(apiPort),
      ELIZA_UI_PORT: String(uiPort),
      FORCE_COLOR: "0",
      NODE_NO_WARNINGS: "1",
    },
    url: `http://127.0.0.1:${uiPort}`,
    reuseExistingServer: false,
    timeout: 420_000,
  },
});
