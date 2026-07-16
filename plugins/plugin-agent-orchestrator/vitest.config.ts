/**
 * Vitest configuration for the orchestrator package. Workspace source aliases
 * keep clean-checkout tests independent of prebuilt peer-package artifacts.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const coverageEnabled = process.argv.some((argument) =>
  /^--coverage(?:$|[.=])/.test(argument),
);

export default defineConfig({
  resolve: {
    alias: {
      "@elizaos/auth/token-expiry": fileURLToPath(
        new URL("../../packages/auth/src/token-expiry.ts", import.meta.url),
      ),
      "@elizaos/auth": new URL(
        "../../packages/auth/src/index.ts",
        import.meta.url,
      ).pathname,
      "@elizaos/shared": fileURLToPath(
        new URL("./__tests__/shared-runtime-env.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    // V8 coverage cannot reliably flush this package's local HTTP/git suites
    // after fork teardown; threads preserve file isolation and let LCOV finish.
    pool: coverageEnabled ? "threads" : "forks",
    setupFiles: ["./__tests__/setup.ts"],
    include: ["__tests__/**/*.test.ts", "src/__tests__/**/*.test.ts"],
    coverage: {
      reporter: ["text", "json", "html"],
    },
  },
});
