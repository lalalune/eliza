/**
 * Runs the standalone plugin's runtime and React rendering tests.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: ["dist/**", "**/node_modules/**"],
    environment: "node",
  },
});
