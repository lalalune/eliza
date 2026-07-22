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
  selectedTests: string[],
): ViteUserConfig {
  const packageConditions = packageConfig.resolve?.conditions ?? [];
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
      // The runner passes exact, pre-classified unit-test paths on the CLI.
      // Package include/exclude globs describe their full-suite lanes and can
      // legitimately omit script or specialty tests that this lane selected.
      // Exact includes keep those selected files runnable without widening the
      // changed-file lane to any neighboring suite.
      include: selectedTests,
      exclude: [],
      coverage: {
        ...packageConfig.test?.coverage,
        // Package configs often scope full-suite reports to `src/**`. The
        // changed lane must instead report every module the exact selected
        // tests execute, including package-owned script entrypoints.
        include: undefined,
      },
    },
  };
}

function parseSelectedTests(
  rawTests: string | undefined,
  repoRoot: string,
): string[] {
  if (!rawTests) {
    throw new Error("Changed coverage requires ELIZA_CHANGED_VITEST_TESTS");
  }
  const parsed: unknown = JSON.parse(rawTests);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      "ELIZA_CHANGED_VITEST_TESTS must be a non-empty JSON array",
    );
  }

  return parsed.map((testPath) => {
    if (typeof testPath !== "string" || testPath.length === 0) {
      throw new Error("ELIZA_CHANGED_VITEST_TESTS entries must be file paths");
    }
    const absoluteTest = path.resolve(testPath);
    const relativeTest = path.relative(repoRoot, absoluteTest);
    if (
      relativeTest === ".." ||
      relativeTest.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeTest)
    ) {
      throw new Error(`Changed test escapes the repository: ${testPath}`);
    }
    return absoluteTest.split(path.sep).join("/");
  });
}

export async function loadChangedCoverageConfig(
  configEnv: ConfigEnv,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ViteUserConfig> {
  const configPath = env.ELIZA_CHANGED_VITEST_CONFIG;
  const repoRoot = env.ELIZA_CHANGED_VITEST_REPO_ROOT;
  if (!configPath || !repoRoot) {
    throw new Error(
      "Changed coverage requires ELIZA_CHANGED_VITEST_CONFIG and ELIZA_CHANGED_VITEST_REPO_ROOT",
    );
  }

  const absoluteRoot = path.resolve(repoRoot);
  const selectedTests = parseSelectedTests(
    env.ELIZA_CHANGED_VITEST_TESTS,
    absoluteRoot,
  );
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
    selectedTests,
  );
}

export default defineConfig((configEnv) =>
  loadChangedCoverageConfig(configEnv),
);
