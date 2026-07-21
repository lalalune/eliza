/**
 * Composes each package-owned Vitest config with source aliases for the
 * pre-build changed-file coverage lane. Package aliases stay first so test
 * stubs and platform shims win; the comprehensive workspace aliases then keep
 * every transitive @elizaos package resolvable without a pre-existing dist.
 */

import path from "node:path";
import { type Alias, loadConfigFromFile } from "vite";
import {
  type ConfigEnv,
  defineConfig,
  type ViteUserConfig,
} from "vitest/config";
import { buildHarnessSourceAliases } from "../test/harness/source-aliases";

function normalizeAliasEntries(alias: unknown): Alias[] {
  if (alias === undefined) return [];
  if (Array.isArray(alias)) return alias as Alias[];
  if (!alias || typeof alias !== "object") {
    throw new TypeError("Vitest resolve.alias must be an object or array");
  }

  return Object.entries(alias).map(([find, replacement]) => {
    if (typeof replacement !== "string") {
      throw new TypeError(`Vitest alias ${find} must resolve to a string`);
    }
    return { find, replacement };
  });
}

export function composeChangedCoverageConfig(
  packageConfig: ViteUserConfig,
  repoRoot: string,
  changedTests: string[] = [],
  useThreadPool = false,
): ViteUserConfig {
  const packageConditions = packageConfig.resolve?.conditions ?? [];
  const packageCoverageExcludes = packageConfig.test?.coverage?.exclude ?? [];
  const testRoot = path.resolve(
    packageConfig.test?.root ?? packageConfig.root ?? process.cwd(),
  );
  const exactIncludes = changedTests.map((testPath) =>
    path.relative(testRoot, testPath).split(path.sep).join("/"),
  );
  return {
    ...packageConfig,
    resolve: {
      ...packageConfig.resolve,
      conditions: [...new Set([...packageConditions, "eliza-source"])],
      alias: [
        ...normalizeAliasEntries(packageConfig.resolve?.alias),
        ...buildHarnessSourceAliases(repoRoot),
      ],
    },
    test: {
      ...packageConfig.test,
      // Worker execArgv rejects process-wide V8 heap flags. The isolated route
      // runs one file in its own Vitest process/thread, so dropping the
      // fork-only override retains test isolation.
      ...(useThreadPool ? { execArgv: [] } : {}),
      ...(exactIncludes.length > 0
        ? {
            // CLI file filters still pass through config include/exclude. Pin
            // discovery to the changed files so integration suffixes cannot be
            // silently erased by a unit config's exclusions.
            include: exactIncludes,
            exclude: [],
          }
        : {}),
      coverage: {
        ...packageConfig.test?.coverage,
        // allowExternal is required for cross-package source coverage, but
        // built bundles and declarations are never changed-source targets.
        // Excluding them prevents V8 from remapping multi-megabyte core bundles
        // for every package group while retaining all source-file evidence.
        exclude: [
          ...new Set([...packageCoverageExcludes, "**/dist/**", "**/*.d.ts"]),
        ],
      },
    },
  };
}

export async function loadChangedCoverageConfig(
  configEnv: ConfigEnv,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ViteUserConfig> {
  const configPath = env.ELIZA_CHANGED_VITEST_CONFIG;
  const repoRoot = env.ELIZA_CHANGED_VITEST_REPO_ROOT;
  const changedTestsJson = env.ELIZA_CHANGED_VITEST_TESTS;
  if (!configPath || !repoRoot || !changedTestsJson) {
    throw new Error(
      "Changed coverage requires ELIZA_CHANGED_VITEST_CONFIG, ELIZA_CHANGED_VITEST_REPO_ROOT, and ELIZA_CHANGED_VITEST_TESTS",
    );
  }

  const absoluteRoot = path.resolve(repoRoot);
  const absoluteConfig = path.resolve(configPath);
  const relativeConfig = path.relative(absoluteRoot, absoluteConfig);
  if (
    relativeConfig === ".." ||
    relativeConfig.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeConfig)
  ) {
    throw new Error(
      `Package Vitest config escapes the repository: ${configPath}`,
    );
  }
  const parsedTests: unknown = JSON.parse(changedTestsJson);
  if (
    !Array.isArray(parsedTests) ||
    parsedTests.length === 0 ||
    parsedTests.some((testPath) => typeof testPath !== "string")
  ) {
    throw new TypeError(
      "ELIZA_CHANGED_VITEST_TESTS must be a non-empty string array",
    );
  }
  const changedTests = parsedTests.map((testPath) => path.resolve(testPath));
  for (const testPath of changedTests) {
    const relativeTest = path.relative(absoluteRoot, testPath);
    if (
      relativeTest === ".." ||
      relativeTest.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeTest)
    ) {
      throw new Error(
        `Changed Vitest file escapes the repository: ${testPath}`,
      );
    }
  }

  // Package configs commonly compose extensionless TypeScript modules. Vite's
  // config bundler resolves that graph exactly as a direct `--config` load
  // would; native dynamic import cannot resolve those specifiers under Node ESM.
  const loaded = await loadConfigFromFile(
    configEnv,
    absoluteConfig,
    path.dirname(absoluteConfig),
  );
  if (!loaded) {
    throw new Error(`Package Vitest config was not loaded: ${configPath}`);
  }
  return composeChangedCoverageConfig(
    loaded.config,
    absoluteRoot,
    changedTests,
    env.ELIZA_CHANGED_VITEST_THREAD_POOL === "1",
  );
}

export default defineConfig((configEnv) =>
  loadChangedCoverageConfig(configEnv),
);
