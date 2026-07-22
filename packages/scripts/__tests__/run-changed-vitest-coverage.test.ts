/**
 * Verifies changed Vitest files are grouped by their real package config while
 * root-level tests retain the root config and report namespace. Explicit
 * package lanes preserve specialty setup, and JSON accounting proves every
 * requested file executes at least one passing assertion.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeLcovReports } from "../merge-lcov-reports.mjs";
import {
  buildChangedVitestArgs,
  findNearestPackageDir,
  findNearestVitestConfig,
  groupChangedVitestTests,
  normalizeLcovReport,
  validateChangedTestResults,
} from "../run-changed-vitest-coverage.mjs";
import {
  composeChangedCoverageConfig,
  loadChangedCoverageConfig,
} from "../vitest.changed-coverage.config";
import { serializeChangedTestResults } from "../vitest.changed-test-reporter.mjs";

const roots: string[] = [];
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "changed-vitest-"));
  roots.push(root);
  const packageDir = path.join(root, "packages", "feature");
  const nestedDir = path.join(packageDir, "src", "nested");
  mkdirSync(nestedDir, { recursive: true });
  writeFileSync(path.join(root, "vitest.config.ts"), "export default {};");
  writeFileSync(
    path.join(packageDir, "vitest.config.ts"),
    "export default {};",
  );
  writeFileSync(path.join(root, "root.test.ts"), "");
  writeFileSync(path.join(nestedDir, "feature.test.ts"), "");
  writeFileSync(path.join(nestedDir, "second.test.ts"), "");
  return root;
}

function writeFixtureFile(root: string, relativePath: string, content = "") {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

describe("changed Vitest coverage grouping", () => {
  test("uses the nearest package config and an isolated report directory", () => {
    const root = fixture();
    const config = findNearestVitestConfig(
      root,
      "packages/feature/src/nested/feature.test.ts",
    );
    expect(config).toBe(path.join(root, "packages/feature/vitest.config.ts"));

    const groups = groupChangedVitestTests(root, [
      "packages/feature/src/nested/feature.test.ts",
      "packages/feature/src/nested/second.test.ts",
      "root.test.ts",
    ]);
    expect(groups).toHaveLength(2);
    expect(
      groups.map((group) => path.relative(root, group.reportDir)).sort(),
    ).toEqual(["coverage/vitest/packages-feature", "coverage/vitest/root"]);
    expect(groups.flatMap((group) => group.tests)).toEqual(
      expect.arrayContaining([
        path.join(root, "root.test.ts"),
        path.join(root, "packages/feature/src/nested/feature.test.ts"),
        path.join(root, "packages/feature/src/nested/second.test.ts"),
      ]),
    );
    expect(
      groups.find((group) => group.configDir.endsWith("packages/feature"))
        ?.tests,
    ).toHaveLength(2);
  });

  test("prefers vitest.harness.config.ts for *.harness.test.ts files", () => {
    // The plain package config deliberately excludes harness tests (they need
    // the workspace source-alias set), so grouping one there exits "no test
    // files found" — the config preference is what keeps the lane green.
    const root = fixture();
    const packageDir = path.join(root, "packages", "feature");
    writeFileSync(
      path.join(packageDir, "vitest.harness.config.ts"),
      "export default {};",
    );
    const testsDir = path.join(packageDir, "__tests__");
    mkdirSync(testsDir, { recursive: true });
    writeFileSync(path.join(testsDir, "loop.harness.test.ts"), "");
    writeFileSync(path.join(testsDir, "plain.test.ts"), "");

    const groups = groupChangedVitestTests(root, [
      "packages/feature/__tests__/loop.harness.test.ts",
      "packages/feature/__tests__/plain.test.ts",
    ]);
    expect(groups).toHaveLength(2);
    expect(
      groups.map((group) => path.relative(root, group.configPath)).sort(),
    ).toEqual([
      path.join("packages/feature", "vitest.config.ts"),
      path.join("packages/feature", "vitest.harness.config.ts"),
    ]);
    // Same directory, two configs: the harness group's report slug must not
    // clobber the default group's.
    expect(
      groups.map((group) => path.relative(root, group.reportDir)).sort(),
    ).toEqual([
      "coverage/vitest/packages-feature",
      "coverage/vitest/packages-feature-vitest.harness.config",
    ]);
  });

  test("prefers vitest.electrobun.config.ts for platforms/electrobun tests", () => {
    // The owning app-core config deliberately excludes platforms/electrobun/**
    // (its suites need the electrobun/bun stub alias), so grouping one there
    // exits "no test files found". Preferring the platform's own config is what
    // keeps the changed-coverage lane green for desktop shell tests. Mirrors
    // packages/app-core/platforms/electrobun/vitest.electrobun.config.ts.
    const root = fixture();
    const packageDir = path.join(root, "packages", "feature");
    const electrobunDir = path.join(packageDir, "platforms", "electrobun");
    const electrobunSrc = path.join(electrobunDir, "src", "lifecycle");
    mkdirSync(electrobunSrc, { recursive: true });
    writeFileSync(path.join(electrobunDir, "package.json"), "{}");
    writeFileSync(
      path.join(electrobunDir, "vitest.electrobun.config.ts"),
      "export default {};",
    );
    writeFileSync(path.join(electrobunSrc, "api-base-owner.test.ts"), "");

    const config = findNearestVitestConfig(
      root,
      "packages/feature/platforms/electrobun/src/lifecycle/api-base-owner.test.ts",
    );
    expect(config).toBe(
      path.join(electrobunDir, "vitest.electrobun.config.ts"),
    );

    const groups = groupChangedVitestTests(root, [
      "packages/feature/platforms/electrobun/src/lifecycle/api-base-owner.test.ts",
    ]);
    expect(groups).toHaveLength(1);
    // The platform is its own package: tests run from the electrobun dir so the
    // config's relative `include` patterns resolve.
    expect(groups[0].packageDir).toBe(electrobunDir);
    expect(path.relative(root, groups[0].reportDir)).toBe(
      "coverage/vitest/packages-feature-platforms-electrobun-vitest.electrobun.config",
    );
  });

  test("routes LifeOps quality gates and unit tests through their canonical configs", () => {
    const root = fixture();
    writeFixtureFile(
      root,
      "packages/benchmarks/lifeops-quality/vitest.gate.config.ts",
      "export default {};",
    );
    writeFixtureFile(
      root,
      "packages/benchmarks/lifeops-quality/vitest.unit.config.ts",
      "export default {};",
    );
    writeFixtureFile(
      root,
      "packages/benchmarks/lifeops-quality/timeliness/timeliness.gate.test.ts",
    );
    writeFixtureFile(
      root,
      "packages/benchmarks/lifeops-quality/timeliness/oracle.test.ts",
    );

    expect(
      path.relative(
        root,
        findNearestVitestConfig(
          root,
          "packages/benchmarks/lifeops-quality/timeliness/timeliness.gate.test.ts",
        ),
      ),
    ).toBe("packages/benchmarks/lifeops-quality/vitest.gate.config.ts");
    expect(
      path.relative(
        root,
        findNearestVitestConfig(
          root,
          "packages/benchmarks/lifeops-quality/timeliness/oracle.test.ts",
        ),
      ),
    ).toBe("packages/benchmarks/lifeops-quality/vitest.unit.config.ts");
  });

  test("routes browser-extension tests through the DOM-aware unit config", () => {
    const root = fixture();
    writeFixtureFile(
      root,
      "packages/browser-extension/vitest.extension.config.ts",
      "export default {};",
    );
    writeFixtureFile(
      root,
      "packages/browser-extension/src/dom-actions.test.ts",
    );

    expect(
      path.relative(
        root,
        findNearestVitestConfig(
          root,
          "packages/browser-extension/src/dom-actions.test.ts",
        ),
      ),
    ).toBe("packages/browser-extension/vitest.extension.config.ts");
  });

  test("preserves both personal-assistant integration lanes", () => {
    const root = fixture();
    writeFixtureFile(
      root,
      "plugins/plugin-personal-assistant/vitest.src-integration.config.ts",
      "export default {};",
    );
    writeFixtureFile(
      root,
      "packages/test/vitest/integration.config.ts",
      "export default {};",
    );
    writeFixtureFile(
      root,
      "plugins/plugin-personal-assistant/src/lifeops/scheduled-task/scheduler.integration.test.ts",
    );
    writeFixtureFile(
      root,
      "plugins/plugin-personal-assistant/test/scheduled-task-action.integration.test.ts",
    );
    writeFixtureFile(
      root,
      "plugins/plugin-personal-assistant/test/owner-agent-permission-matrix.integration.test.ts",
    );
    writeFixtureFile(
      root,
      "plugins/plugin-personal-assistant/test/payments-action.integration.test.ts",
    );

    const selected = [
      "plugins/plugin-personal-assistant/src/lifeops/scheduled-task/scheduler.integration.test.ts",
      "plugins/plugin-personal-assistant/test/scheduled-task-action.integration.test.ts",
      "plugins/plugin-personal-assistant/test/owner-agent-permission-matrix.integration.test.ts",
    ].map((testPath) =>
      path.relative(root, findNearestVitestConfig(root, testPath)),
    );
    expect(selected).toEqual([
      "plugins/plugin-personal-assistant/vitest.src-integration.config.ts",
      "plugins/plugin-personal-assistant/vitest.src-integration.config.ts",
      "packages/test/vitest/integration.config.ts",
    ]);
    const groups = groupChangedVitestTests(root, [
      "plugins/plugin-personal-assistant/test/owner-agent-permission-matrix.integration.test.ts",
      "plugins/plugin-personal-assistant/test/payments-action.integration.test.ts",
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.packageDir === root)).toBe(true);
    expect(groups.every((group) => group.tests.length === 1)).toBe(true);
    expect(new Set(groups.map((group) => group.reportDir)).size).toBe(2);
    expect(new Set(groups.map((group) => group.testResultsPath)).size).toBe(2);
    expect(
      groups.every((group) =>
        buildChangedVitestArgs(group).includes("--pool=threads"),
      ),
    ).toBe(true);
    const packageGroup = groupChangedVitestTests(root, [
      "plugins/plugin-personal-assistant/test/scheduled-task-action.integration.test.ts",
    ])[0];
    expect(buildChangedVitestArgs(packageGroup)).not.toContain(
      "--pool=threads",
    );
  });

  test("routes repository integration suites through the shared PGlite config", () => {
    const root = fixture();
    writeFixtureFile(
      root,
      "packages/test/vitest/integration.config.ts",
      "export default {};",
    );
    const integrationTests = [
      "plugins/plugin-calendar/test/calendar-action.integration.test.ts",
      "plugins/plugin-example/src/service.integration.test.ts",
      "packages/agent/test/runtime.integration.test.ts",
      "packages/app-core/test/api.integration.test.ts",
      "apps/example/test/route.integration.test.ts",
    ];
    for (const testPath of integrationTests) writeFixtureFile(root, testPath);

    for (const testPath of integrationTests) {
      expect(path.relative(root, findNearestVitestConfig(root, testPath))).toBe(
        "packages/test/vitest/integration.config.ts",
      );
    }

    const groups = groupChangedVitestTests(root, integrationTests);
    expect(groups).toHaveLength(integrationTests.length);
    expect(groups.every((group) => group.packageDir === root)).toBe(true);
    expect(groups.every((group) => group.tests.length === 1)).toBe(true);
    expect(
      groups.every((group) =>
        buildChangedVitestArgs(group).includes("--pool=threads"),
      ),
    ).toBe(true);
  });

  test("runs a nested config from the owning package directory", () => {
    // Mirrors packages/test/harness/vitest.config.ts: the config sits below
    // the package root and its include patterns resolve against the package
    // script's cwd (the package root), not the config's directory.
    const root = fixture();
    const packageDir = path.join(root, "packages", "feature");
    const nestedConfigDir = path.join(packageDir, "harness");
    const nestedTestsDir = path.join(nestedConfigDir, "__tests__");
    mkdirSync(nestedTestsDir, { recursive: true });
    writeFileSync(path.join(packageDir, "package.json"), "{}");
    writeFileSync(
      path.join(nestedConfigDir, "vitest.config.ts"),
      "export default {};",
    );
    writeFileSync(path.join(nestedTestsDir, "loop.test.ts"), "");

    const groups = groupChangedVitestTests(root, [
      "packages/feature/harness/__tests__/loop.test.ts",
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].configDir).toBe(nestedConfigDir);
    expect(groups[0].packageDir).toBe(packageDir);
  });

  test("falls back to the repository root when no package.json owns the config", () => {
    const root = fixture();
    expect(findNearestPackageDir(root, path.join(root, "packages"))).toBe(root);
  });

  test("rejects a changed test outside the repository", () => {
    const root = fixture();
    expect(() => findNearestVitestConfig(root, "../outside.test.ts")).toThrow(
      "escapes the repository",
    );
  });

  test("preserves package aliases before comprehensive workspace source aliases", () => {
    const packageAlias = {
      find: /^@elizaos\/shared$/,
      replacement: "/test/shared-stub.ts",
    };
    const config = composeChangedCoverageConfig(
      {
        resolve: {
          alias: [packageAlias],
          conditions: ["browser"],
        },
        test: {
          coverage: {
            exclude: ["generated/**"],
          },
        },
      },
      repoRoot,
    );
    const aliases = config.resolve?.alias;
    expect(Array.isArray(aliases)).toBe(true);
    if (!Array.isArray(aliases)) {
      throw new Error("Expected changed coverage aliases to use array order");
    }

    expect(aliases[0]).toEqual(packageAlias);
    const sharedSourceAlias = aliases.find(
      (entry, index) =>
        index > 0 &&
        typeof entry === "object" &&
        entry !== null &&
        "find" in entry &&
        entry.find instanceof RegExp &&
        entry.find.test("@elizaos/shared"),
    );
    expect(sharedSourceAlias).toBeDefined();
    expect(sharedSourceAlias).toMatchObject({
      replacement: path.join(repoRoot, "packages/shared/src/index.ts"),
    });
    const exportedSourceTargets = [
      ["@elizaos/security/kms", "packages/security/src/kms/index.ts"],
      ["@elizaos/app-core/registry", "packages/app-core/src/registry/index.ts"],
      [
        "@elizaos/registry/first-party",
        "packages/registry/src/first-party/index.ts",
      ],
      [
        "@elizaos/shared/steward-session-client",
        "packages/shared/src/steward-session-client/index.ts",
      ],
      [
        "@elizaos/plugin-remote-manifest/worker-runtime",
        "packages/plugin-remote-manifest/src/worker-runtime/index.ts",
      ],
      [
        "@elizaos/scenario-runner/schema",
        "packages/scenario-runner/schema/index.js",
      ],
      ["@elizaos/ui/button", "packages/ui/src/components/ui/button.tsx"],
      [
        "@elizaos/plugin-edge-tts/node",
        "plugins/plugin-edge-tts/src/index.node.ts",
      ],
    ] as const;
    for (const [specifier, relativeTarget] of exportedSourceTargets) {
      const alias = aliases.find(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          "find" in entry &&
          (entry.find instanceof RegExp
            ? entry.find.test(specifier)
            : entry.find === specifier ||
              specifier.startsWith(`${entry.find}/`)),
      );
      expect(alias, `${specifier} must have a source alias`).toBeDefined();
      if (!alias || typeof alias !== "object" || !("find" in alias)) {
        throw new Error(`Missing source alias for ${specifier}`);
      }
      const resolved = specifier.replace(alias.find, alias.replacement);
      expect(resolved).toBe(path.join(repoRoot, relativeTarget));
      expect(existsSync(resolved) && statSync(resolved).isFile()).toBe(true);
    }
    expect(config.resolve?.conditions).toEqual(["browser", "eliza-source"]);
    expect(config.test?.coverage?.exclude).toEqual([
      "generated/**",
      "**/dist/**",
      "**/*.d.ts",
    ]);
  });

  test("loads extensionless TypeScript config dependencies through Vite", async () => {
    // packages/agent imports `packages/test/vitest/default.config` without a
    // file extension. This is valid in a Vite config graph but fails when the
    // package config is loaded through native Node ESM.
    const changedTest = path.join(
      repoRoot,
      "packages/agent/src/api/chat-augmentation.test.ts",
    );
    const config = await loadChangedCoverageConfig(
      { command: "serve", mode: "test" },
      {
        ELIZA_CHANGED_VITEST_CONFIG: path.join(
          repoRoot,
          "packages/agent/vitest.config.ts",
        ),
        ELIZA_CHANGED_VITEST_REPO_ROOT: repoRoot,
        ELIZA_CHANGED_VITEST_TESTS: JSON.stringify([changedTest]),
      },
    );

    expect(config.root).toBe(path.join(repoRoot, "packages/agent"));
    expect(config.test?.environment).toBe("node");
    expect(config.test?.include).toEqual(["src/api/chat-augmentation.test.ts"]);
    expect(config.test?.exclude).toEqual([]);
  });

  test("anchors exact changed-file includes to a config's test root", async () => {
    const changedTest = path.join(
      repoRoot,
      "plugins/__tests__/setup-routes-contract.test.ts",
    );
    const config = await loadChangedCoverageConfig(
      { command: "serve", mode: "test" },
      {
        ELIZA_CHANGED_VITEST_CONFIG: path.join(
          repoRoot,
          "plugins/__tests__/vitest.config.ts",
        ),
        ELIZA_CHANGED_VITEST_REPO_ROOT: repoRoot,
        ELIZA_CHANGED_VITEST_TESTS: JSON.stringify([changedTest]),
      },
    );

    expect(config.test?.root).toBe(path.join(repoRoot, "plugins/__tests__"));
    expect(config.test?.include).toEqual(["setup-routes-contract.test.ts"]);
    expect(config.test?.exclude).toEqual([]);
  });

  test("clears fork-only execArgv for isolated thread coverage", () => {
    const forkConfig = {
      test: { execArgv: ["--max-old-space-size=4096"] },
    };
    const config = composeChangedCoverageConfig(forkConfig, repoRoot, [], true);
    expect(config.test?.execArgv).toEqual([]);
    expect(
      composeChangedCoverageConfig(forkConfig, repoRoot).test?.execArgv,
    ).toEqual(["--max-old-space-size=4096"]);
  });

  test("accepts duplicate file results when at least one assertion passes", () => {
    const root = fixture();
    const testPath = path.join(root, "root.test.ts");
    const resultsPath = writeFixtureFile(
      root,
      "coverage/vitest/root/vitest-results.json",
      JSON.stringify({
        reason: "passed",
        unhandledErrorCount: 0,
        testResults: [
          {
            name: testPath,
            assertionResults: [{ status: "skipped" }],
          },
          {
            name: testPath,
            assertionResults: [{ status: "passed" }],
          },
        ],
      }),
    );

    expect(() =>
      validateChangedTestResults(root, [testPath], resultsPath),
    ).not.toThrow();
  });

  test("serializes only module paths and terminal assertion states", () => {
    const report = serializeChangedTestResults(
      [
        {
          moduleId: "/repo/example.test.ts",
          children: {
            *allTests() {
              yield { result: () => ({ state: "passed", errors: ["large"] }) };
              yield { result: () => ({ state: "skipped" }) };
            },
          },
        },
      ],
      [{ stack: "large unhandled error" }],
      "passed",
    );

    expect(report).toEqual({
      reason: "passed",
      unhandledErrorCount: 1,
      testResults: [
        {
          name: "/repo/example.test.ts",
          assertionResults: [{ status: "passed" }, { status: "skipped" }],
        },
      ],
    });
  });

  test("rejects missing and all-skipped changed files", () => {
    const root = fixture();
    const skippedTest = path.join(root, "root.test.ts");
    const missingTest = path.join(
      root,
      "packages/feature/src/nested/feature.test.ts",
    );
    const resultsPath = writeFixtureFile(
      root,
      "coverage/vitest/root/vitest-results.json",
      JSON.stringify({
        reason: "passed",
        unhandledErrorCount: 0,
        testResults: [
          {
            name: skippedTest,
            assertionResults: [{ status: "skipped" }],
          },
        ],
      }),
    );

    expect(() =>
      validateChangedTestResults(root, [skippedTest], resultsPath),
    ).toThrow("executed no passing tests");
    expect(() =>
      validateChangedTestResults(root, [skippedTest, missingTest], resultsPath),
    ).toThrow("executed no passing tests");
    writeFileSync(
      resultsPath,
      JSON.stringify({
        reason: "passed",
        unhandledErrorCount: 0,
        testResults: [
          {
            name: skippedTest,
            assertionResults: [{ status: "passed" }],
          },
        ],
      }),
    );
    expect(() =>
      validateChangedTestResults(root, [skippedTest, missingTest], resultsPath),
    ).toThrow("did not discover changed test file");
  });

  test("rejects malformed, missing, and unexpected JSON file results", () => {
    const root = fixture();
    const expectedTest = path.join(root, "root.test.ts");
    const unexpectedTest = path.join(
      root,
      "packages/feature/src/nested/feature.test.ts",
    );
    const resultsPath = path.join(
      root,
      "coverage/vitest/root/vitest-results.json",
    );

    expect(() =>
      validateChangedTestResults(root, [expectedTest], resultsPath),
    ).toThrow("produced no JSON results");
    writeFixtureFile(root, "coverage/vitest/root/vitest-results.json", "{}");
    expect(() =>
      validateChangedTestResults(root, [expectedTest], resultsPath),
    ).toThrow("JSON results are malformed");
    writeFileSync(
      resultsPath,
      JSON.stringify({
        reason: "passed",
        unhandledErrorCount: 0,
        testResults: [
          {
            name: unexpectedTest,
            assertionResults: [{ status: "passed" }],
          },
        ],
      }),
    );
    expect(() =>
      validateChangedTestResults(root, [expectedTest], resultsPath),
    ).toThrow("executed an unexpected changed-coverage file");
  });

  test("rejects failed runs and unhandled errors even when assertions passed", () => {
    const root = fixture();
    const expectedTest = path.join(root, "root.test.ts");
    const resultsPath = writeFixtureFile(
      root,
      "coverage/vitest/root/vitest-results.json",
      JSON.stringify({
        reason: "passed",
        unhandledErrorCount: 1,
        testResults: [
          {
            name: expectedTest,
            assertionResults: [{ status: "passed" }],
          },
        ],
      }),
    );

    expect(() =>
      validateChangedTestResults(root, [expectedTest], resultsPath),
    ).toThrow("JSON results are malformed");
    writeFileSync(
      resultsPath,
      JSON.stringify({
        reason: "failed",
        unhandledErrorCount: 0,
        testResults: [
          {
            name: expectedTest,
            assertionResults: [{ status: "passed" }],
          },
        ],
      }),
    );
    expect(() =>
      validateChangedTestResults(root, [expectedTest], resultsPath),
    ).toThrow("JSON results are malformed");
  });

  test("union-merges per-group LCOV reports so any-group coverage counts once per file", () => {
    // The gate latches a failure on EVERY below-threshold occurrence of a
    // changed file; a group that merely LOADED a file must not mask the group
    // that exercised it.
    const root = fixture();
    const reportA = path.join(root, "coverage", "vitest", "a");
    const reportB = path.join(root, "coverage", "vitest", "b");
    mkdirSync(reportA, { recursive: true });
    mkdirSync(reportB, { recursive: true });
    writeFileSync(
      path.join(reportA, "lcov.info"),
      [
        "TN:",
        "SF:packages/feature/src/covered.ts",
        "DA:1,1",
        "DA:2,0",
        "DA:3,0",
        "LF:3",
        "LH:1",
        "end_of_record",
        "SF:packages/feature/src/only-a.ts",
        "DA:1,1",
        "LF:1",
        "LH:1",
        "end_of_record",
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(reportB, "lcov.info"),
      [
        "TN:",
        "SF:packages/feature/src/covered.ts",
        "DA:1,0",
        "DA:2,5",
        "DA:4,2",
        "LF:3",
        "LH:2",
        "end_of_record",
        "",
      ].join("\n"),
    );

    const mergedPath = path.join(root, "coverage", "vitest", "lcov.info");
    mergeLcovReports(
      [
        path.join(reportA, "lcov.info"),
        path.join(reportB, "lcov.info"),
        path.join(root, "coverage", "vitest", "absent", "lcov.info"),
      ],
      mergedPath,
    );

    const merged = readFileSync(mergedPath, "utf8");
    // covered.ts: union of lines 1-4; hits are per-line maxima → 3 of 4 hit.
    expect(merged).toContain(
      [
        "SF:packages/feature/src/covered.ts",
        "DA:1,1",
        "DA:2,5",
        "DA:3,0",
        "DA:4,2",
        "LF:4",
        "LH:3",
        "end_of_record",
      ].join("\n"),
    );
    // A file present in only one group is preserved as-is.
    expect(merged).toContain(
      ["SF:packages/feature/src/only-a.ts", "DA:1,1", "LF:1", "LH:1"].join(
        "\n",
      ),
    );
  });

  test("normalizes package-relative LCOV source paths to repository paths", () => {
    const root = fixture();
    const packageDir = path.join(root, "packages", "feature");
    const reportDir = path.join(root, "coverage", "vitest", "feature");
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(path.join(packageDir, "src", "covered.ts"), "export {};\n");
    writeFileSync(
      path.join(reportDir, "lcov.info"),
      "TN:\nSF:src/covered.ts\nLF:1\nLH:1\nend_of_record\n",
    );

    normalizeLcovReport(root, packageDir, reportDir);

    expect(readFileSync(path.join(reportDir, "lcov.info"), "utf8")).toContain(
      "SF:packages/feature/src/covered.ts",
    );
  });
});
