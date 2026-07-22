/**
 * Runs changed Vitest files through their nearest package configuration.
 *
 * The coverage gate executes before workspace builds, so combining unrelated
 * package tests under the root config can resolve absent dist entrypoints and
 * bypass package-specific aliases or setup. A coverage-only wrapper preserves
 * each package config while appending the complete workspace source-alias set.
 * Package aliases stay first so their test stubs and platform shims retain
 * precedence. Each group runs in isolation, and the per-group LCOV reports are
 * then union-merged into a single
 * `coverage/vitest/lcov.info` (see {@link mergeAndRemoveLcovReports}) so the
 * gate sees one record per file across every group that executed it.
 *
 * Explicit routes preserve canonical harness, Electrobun, benchmark,
 * browser-extension, and personal-assistant integration configs without ever
 * guessing among live/real/e2e variants. Each group runs from the directory
 * used by its package script, and a bounded reporter requires every requested
 * file to produce at least one passed assertion before its LCOV is accepted.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeAndRemoveLcovReports } from "./merge-lcov-reports.mjs";

const CONFIG_NAMES = [
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.js",
  "vitest.config.mjs",
  "vitest.config.cts",
  "vitest.config.cjs",
];

// PGLite-runtime harness suites are excluded from plain package configs and
// carry their own config with the workspace source-alias set.
const HARNESS_CONFIG_NAME = "vitest.harness.config.ts";
const HARNESS_TEST_SUFFIXES = [".harness.test.ts", ".harness.test.tsx"];

// These packages intentionally use named configs as their canonical unit or
// integration lanes. Keep the routing explicit: selecting an arbitrary
// vitest.*.config file would risk running live, real-device, or e2e suites in
// the credential-free changed-coverage gate.
const LIFEOPS_QUALITY_PREFIX = "packages/benchmarks/lifeops-quality/";
const LIFEOPS_GATE_CONFIG =
  "packages/benchmarks/lifeops-quality/vitest.gate.config.ts";
const LIFEOPS_UNIT_CONFIG =
  "packages/benchmarks/lifeops-quality/vitest.unit.config.ts";
const BROWSER_EXTENSION_PREFIX = "packages/browser-extension/src/";
const BROWSER_EXTENSION_CONFIG =
  "packages/browser-extension/vitest.extension.config.ts";
const PERSONAL_ASSISTANT_PREFIX = "plugins/plugin-personal-assistant/";
const PERSONAL_ASSISTANT_SRC_INTEGRATION_CONFIG =
  "plugins/plugin-personal-assistant/vitest.src-integration.config.ts";
const REPO_INTEGRATION_CONFIG = "packages/test/vitest/integration.config.ts";
const PERSONAL_ASSISTANT_SRC_INTEGRATION_FILES = new Set([
  "test/approval-queue.integration.test.ts",
  "test/approval-queue-notify-error.integration.test.ts",
  "test/global-pause.integration.test.ts",
  "test/meeting-ghost.integration.test.ts",
  "test/resolve-referent-action.integration.test.ts",
  "test/scheduled-task-action.integration.test.ts",
]);

// The Electrobun desktop shell lives under platforms/electrobun as an isolated
// sub-tree. The owning app-core config deliberately excludes
// `platforms/electrobun/**` (its suites need the electrobun/bun stub alias), so
// grouping one there exits "no test files found". The platform carries its own
// `vitest.electrobun.config.ts`; prefer it for any test under that sub-tree.
const ELECTROBUN_CONFIG_NAME = "vitest.electrobun.config.ts";
const ELECTROBUN_DIR_SEGMENT = `${path.sep}platforms${path.sep}electrobun${path.sep}`;
const CHANGED_COVERAGE_CONFIG = fileURLToPath(
  new URL("./vitest.changed-coverage.config.ts", import.meta.url),
);
const CHANGED_TEST_REPORTER = fileURLToPath(
  new URL("./vitest.changed-test-reporter.mjs", import.meta.url),
);

const normalize = (value) => value.split(path.sep).join("/");

function isHarnessTest(testFile) {
  return HARNESS_TEST_SUFFIXES.some((suffix) => testFile.endsWith(suffix));
}

function isElectrobunTest(absoluteTest) {
  return normalize(absoluteTest).includes(normalize(ELECTROBUN_DIR_SEGMENT));
}

function isTestSuffix(testFile, marker) {
  return [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].some(
    (extension) => testFile.endsWith(`${marker}${extension}`),
  );
}

function isRepositoryIntegrationTest(testFile) {
  if (!isTestSuffix(testFile, ".integration.test")) return false;
  return (
    /^plugins\/[^/]+\/(?:src|test)\//.test(testFile) ||
    /^apps\/[^/]+\/test\//.test(testFile) ||
    testFile.startsWith("packages/agent/test/") ||
    testFile.startsWith("packages/app-core/test/")
  );
}

function requireConfig(repoRoot, configPath, testFile) {
  const absoluteConfig = path.join(repoRoot, configPath);
  if (!existsSync(absoluteConfig)) {
    throw new Error(
      `Required Vitest config ${configPath} is missing for changed test: ${testFile}`,
    );
  }
  return absoluteConfig;
}

function findExplicitVitestConfig(repoRoot, relativeTest, absoluteTest) {
  const normalizedTest = normalize(relativeTest);
  if (normalizedTest.startsWith(LIFEOPS_QUALITY_PREFIX)) {
    return requireConfig(
      repoRoot,
      isTestSuffix(normalizedTest, ".gate.test")
        ? LIFEOPS_GATE_CONFIG
        : LIFEOPS_UNIT_CONFIG,
      relativeTest,
    );
  }

  if (normalizedTest.startsWith(BROWSER_EXTENSION_PREFIX)) {
    return requireConfig(repoRoot, BROWSER_EXTENSION_CONFIG, relativeTest);
  }

  if (
    normalizedTest.startsWith(PERSONAL_ASSISTANT_PREFIX) &&
    isTestSuffix(normalizedTest, ".integration.test")
  ) {
    const packageRelative = normalizedTest.slice(
      PERSONAL_ASSISTANT_PREFIX.length,
    );
    const usesPackageIntegrationConfig =
      packageRelative.startsWith("src/") ||
      PERSONAL_ASSISTANT_SRC_INTEGRATION_FILES.has(packageRelative);
    if (usesPackageIntegrationConfig) {
      return requireConfig(
        repoRoot,
        PERSONAL_ASSISTANT_SRC_INTEGRATION_CONFIG,
        relativeTest,
      );
    }
  }

  if (isRepositoryIntegrationTest(normalizedTest)) {
    return requireConfig(repoRoot, REPO_INTEGRATION_CONFIG, relativeTest);
  }

  if (isHarnessTest(absoluteTest)) return undefined;
  if (isElectrobunTest(absoluteTest)) return undefined;
  return null;
}

export function findNearestVitestConfig(repoRoot, testFile) {
  const absoluteRoot = path.resolve(repoRoot);
  const absoluteTest = path.resolve(absoluteRoot, testFile);
  const relativeTest = path.relative(absoluteRoot, absoluteTest);
  if (
    relativeTest === ".." ||
    relativeTest.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTest)
  ) {
    throw new Error(`Changed test escapes the repository: ${testFile}`);
  }

  const explicitConfig = findExplicitVitestConfig(
    absoluteRoot,
    relativeTest,
    absoluteTest,
  );
  if (explicitConfig) return explicitConfig;

  let configNames = CONFIG_NAMES;
  if (isHarnessTest(absoluteTest)) {
    configNames = [HARNESS_CONFIG_NAME, ...CONFIG_NAMES];
  } else if (isElectrobunTest(absoluteTest)) {
    configNames = [ELECTROBUN_CONFIG_NAME, ...CONFIG_NAMES];
  }

  let directory = path.dirname(absoluteTest);
  while (true) {
    for (const name of configNames) {
      const candidate = path.join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
    if (directory === absoluteRoot) break;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  throw new Error(`No Vitest config found for changed test: ${testFile}`);
}

export function findNearestPackageDir(repoRoot, configDir) {
  const absoluteRoot = path.resolve(repoRoot);
  let directory = path.resolve(configDir);
  while (true) {
    if (existsSync(path.join(directory, "package.json"))) return directory;
    if (directory === absoluteRoot) return absoluteRoot;
    const parent = path.dirname(directory);
    if (parent === directory) return absoluteRoot;
    directory = parent;
  }
}

function findConfigExecutionDir(repoRoot, configPath) {
  if (configPath === path.join(repoRoot, REPO_INTEGRATION_CONFIG)) {
    // This shared config is invoked from the repository root and derives its
    // plugin globs from process.cwd(); packages/test is only its storage site.
    return repoRoot;
  }
  return findNearestPackageDir(repoRoot, path.dirname(configPath));
}

function isolatedReportSuffix(repoRoot, testPath) {
  const relativeTest = normalize(path.relative(repoRoot, testPath));
  const readableStem = path
    .basename(relativeTest)
    .replaceAll(/[^a-zA-Z0-9._-]+/g, "-")
    .slice(0, 48);
  const digest = createHash("sha256")
    .update(relativeTest)
    .digest("hex")
    .slice(0, 12);
  return `-${readableStem}-${digest}`;
}

export function groupChangedVitestTests(repoRoot, testFiles) {
  const absoluteRoot = path.resolve(repoRoot);
  const groups = new Map();

  for (const testFile of testFiles) {
    const configPath = findNearestVitestConfig(absoluteRoot, testFile);
    const absoluteTest = path.resolve(absoluteRoot, testFile);
    // The shared repo integration config's serial-fork combination races its
    // coverage provider's reportDir/.tmp teardown across multiple PGlite
    // files. Give each file one thread-backed process, then union the reports.
    const isolatedTest =
      configPath === path.join(absoluteRoot, REPO_INTEGRATION_CONFIG)
        ? absoluteTest
        : undefined;
    const groupKey = isolatedTest
      ? `${configPath}\0${isolatedTest}`
      : configPath;
    const group = groups.get(groupKey) ?? {
      configPath,
      isolatedTest,
      tests: [],
    };
    group.tests.push(absoluteTest);
    groups.set(groupKey, group);
  }

  return [...groups.values()]
    .sort((left, right) => {
      const configOrder = left.configPath.localeCompare(right.configPath);
      if (configOrder !== 0) return configOrder;
      return (left.isolatedTest ?? "").localeCompare(right.isolatedTest ?? "");
    })
    .map(({ configPath, isolatedTest, tests }) => {
      const configDir = path.dirname(configPath);
      const relativeDir = normalize(path.relative(absoluteRoot, configDir));
      // A non-default config (vitest.harness.config.ts) can share a directory
      // with the default one; suffix its slug so the two groups' LCOV reports
      // do not clobber each other. Default-config slugs stay unchanged.
      const configBase = path.basename(configPath);
      const slugSuffix = CONFIG_NAMES.includes(configBase)
        ? ""
        : `-${path.basename(configBase, path.extname(configBase))}`;
      const isolatedSuffix = isolatedTest
        ? isolatedReportSuffix(absoluteRoot, isolatedTest)
        : "";
      const reportSlug =
        `${relativeDir || "root"}${slugSuffix}${isolatedSuffix}`.replaceAll(
          /[^a-zA-Z0-9._-]+/g,
          "-",
        );
      return {
        configDir,
        configPath,
        isIsolatedRepoIntegration: isolatedTest !== undefined,
        packageDir: findConfigExecutionDir(absoluteRoot, configPath),
        reportDir: path.join(absoluteRoot, "coverage", "vitest", reportSlug),
        testResultsPath: path.join(
          absoluteRoot,
          "coverage",
          "vitest",
          reportSlug,
          "vitest-results.json",
        ),
        tests: tests.sort(),
      };
    });
}

export function buildChangedVitestArgs(group) {
  return [
    "vitest",
    "run",
    ...group.tests,
    "--config",
    CHANGED_COVERAGE_CONFIG,
    "--reporter=default",
    `--reporter=${CHANGED_TEST_REPORTER}`,
    // Each shared integration file already owns a separate Vitest process.
    // Threads retain that isolation while letting PGlite's WASM worker close
    // cleanly instead of timing out a fork after successful assertions.
    ...(group.isIsolatedRepoIntegration ? ["--pool=threads"] : []),
    "--coverage",
    "--coverage.reporter=lcov",
    // Package configs carry whole-suite global thresholds. This lane runs
    // only changed files and applies its stricter changed-source floor in
    // coverage-gate.awk after merging the per-package LCOV reports.
    "--coverage.thresholds.lines=0",
    "--coverage.thresholds.functions=0",
    "--coverage.thresholds.statements=0",
    "--coverage.thresholds.branches=0",
    // Cross-package suites (the PGLite runtime harness) execute workspace
    // sources OUTSIDE the package root via source aliases; without this flag
    // that real execution is invisible to the changed-file gate.
    "--coverage.allowExternal=true",
    `--coverage.reportsDirectory=${group.reportDir}`,
  ];
}

function canonicalTestPath(baseDir, testPath) {
  const filePath = testPath.startsWith("file:")
    ? fileURLToPath(testPath)
    : testPath;
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(baseDir, filePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`Vitest reported a nonexistent test file: ${testPath}`);
  }
  return realpathSync(absolutePath);
}

export function validateChangedTestResults(
  baseDir,
  expectedTests,
  resultsPath,
) {
  if (!existsSync(resultsPath)) {
    throw new Error(`Vitest produced no JSON results: ${resultsPath}`);
  }
  const parsed = JSON.parse(readFileSync(resultsPath, "utf8"));
  if (
    !parsed ||
    typeof parsed !== "object" ||
    parsed.reason !== "passed" ||
    parsed.unhandledErrorCount !== 0 ||
    !Array.isArray(parsed.testResults)
  ) {
    throw new TypeError(`Vitest JSON results are malformed: ${resultsPath}`);
  }

  const expected = new Map(
    expectedTests.map((testPath) => [
      canonicalTestPath(baseDir, testPath),
      testPath,
    ]),
  );
  const statuses = new Map(
    [...expected.keys()].map((testPath) => [testPath, []]),
  );

  for (const result of parsed.testResults) {
    if (
      !result ||
      typeof result !== "object" ||
      typeof result.name !== "string" ||
      !Array.isArray(result.assertionResults)
    ) {
      throw new TypeError(
        `Vitest JSON contains a malformed file result: ${resultsPath}`,
      );
    }
    const resultPath = canonicalTestPath(baseDir, result.name);
    if (!expected.has(resultPath)) {
      throw new Error(
        `Vitest executed an unexpected changed-coverage file: ${result.name}`,
      );
    }
    const fileStatuses = statuses.get(resultPath);
    for (const assertion of result.assertionResults) {
      if (
        !assertion ||
        typeof assertion !== "object" ||
        typeof assertion.status !== "string"
      ) {
        throw new TypeError(
          `Vitest JSON contains a malformed assertion result: ${resultsPath}`,
        );
      }
      fileStatuses.push(assertion.status);
    }
  }

  for (const [testPath, displayPath] of expected) {
    const fileStatuses = statuses.get(testPath);
    if (fileStatuses.length === 0) {
      throw new Error(
        `Vitest did not discover changed test file: ${displayPath}`,
      );
    }
    if (!fileStatuses.includes("passed")) {
      throw new Error(
        `Changed test file executed no passing tests: ${displayPath}`,
      );
    }
    const nonPassing = fileStatuses.filter((status) => status !== "passed");
    if (nonPassing.length > 0) {
      throw new Error(
        `Changed test file did not pass every discovered test (${nonPassing.join(", ")}): ${displayPath}`,
      );
    }
  }
}

export function normalizeLcovReport(repoRoot, baseDir, reportDir) {
  const lcovPath = path.join(reportDir, "lcov.info");
  if (!existsSync(lcovPath)) return;

  const absoluteRoot = path.resolve(repoRoot);
  const normalized = readFileSync(lcovPath, "utf8")
    .split("\n")
    .map((line) => {
      if (!line.startsWith("SF:")) return line;
      const sourcePath = line.slice("SF:".length);
      const candidates = path.isAbsolute(sourcePath)
        ? [sourcePath]
        : [
            path.resolve(baseDir, sourcePath),
            path.resolve(absoluteRoot, sourcePath),
          ];
      const existing = candidates.find((candidate) => existsSync(candidate));
      if (!existing) return line;
      const relative = path.relative(absoluteRoot, existing);
      if (relative.startsWith("..") || path.isAbsolute(relative)) return line;
      return `SF:${normalize(relative)}`;
    })
    .join("\n");
  writeFileSync(lcovPath, normalized);
}

export function runChangedVitestCoverage(repoRoot, testFiles) {
  const groups = groupChangedVitestTests(repoRoot, testFiles);
  for (const group of groups) {
    // A zero-test Vitest invocation exits successfully and an all-skipped file
    // can still emit LCOV. Remove prior reports so fresh per-file JSON proves
    // execution while fresh LCOV proves coverage was collected.
    rmSync(group.reportDir, { recursive: true, force: true });
    const result = spawnSync("bunx", buildChangedVitestArgs(group), {
      // Run from the owning package (not the config's directory): package
      // scripts invoke nested configs from the package root, and relative
      // `include` patterns resolve against the cwd.
      cwd: group.packageDir,
      env: {
        ...process.env,
        ELIZA_CHANGED_VITEST_CONFIG: group.configPath,
        ELIZA_CHANGED_VITEST_REPO_ROOT: path.resolve(repoRoot),
        ELIZA_CHANGED_VITEST_RESULTS: group.testResultsPath,
        ELIZA_CHANGED_VITEST_THREAD_POOL: group.isIsolatedRepoIntegration
          ? "1"
          : "0",
        ELIZA_CHANGED_VITEST_TESTS: JSON.stringify(group.tests),
      },
      stdio: "inherit",
    });

    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `Vitest coverage failed for ${normalize(path.relative(repoRoot, group.configDir)) || "root"} (exit ${result.status ?? "signal"})`,
      );
    }
    validateChangedTestResults(
      group.packageDir,
      group.tests,
      group.testResultsPath,
    );
    const groupLcov = path.join(group.reportDir, "lcov.info");
    if (!existsSync(groupLcov)) {
      throw new Error(
        `Vitest coverage produced no LCOV for ${normalize(path.relative(repoRoot, group.configDir)) || "root"}; its config did not execute the changed tests`,
      );
    }
    normalizeLcovReport(repoRoot, group.packageDir, group.reportDir);
    rmSync(group.testResultsPath, { force: true });
  }

  // Collapse per-group reports into one union record per file, then remove the
  // group files: the workflow feeds every `coverage/**/lcov.info` to the gate,
  // and a leftover per-group report would re-introduce the low-occurrence
  // latch the merge exists to fix.
  const groupReports = groups.map((group) =>
    path.join(group.reportDir, "lcov.info"),
  );
  if (groupReports.length > 0) {
    mergeAndRemoveLcovReports(
      groupReports,
      path.join(path.resolve(repoRoot), "coverage", "vitest", "lcov.info"),
    );
  }
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  const testFiles = process.argv.slice(2).filter(Boolean);
  if (testFiles.length === 0) {
    throw new Error("At least one changed Vitest file is required.");
  }
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
  runChangedVitestCoverage(repoRoot, testFiles);
}
