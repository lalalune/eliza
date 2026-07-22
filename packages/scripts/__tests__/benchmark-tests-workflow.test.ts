/** Pins the LifeOps benchmark bridge commands to paths Vitest resolves from its configured root. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../../../.github/workflows/benchmark-tests.yml", import.meta.url),
  "utf8",
);
const parsedWorkflow = Bun.YAML.parse(workflow) as {
  on?: {
    pull_request?: { branches?: string[]; paths?: string[] };
    push?: { branches?: string[]; paths?: string[] };
  };
};

describe("Benchmark Bridge Tests workflow", () => {
  test("resolves the Vitest config once from the package root", () => {
    expect(workflow).toContain(
      "bunx vitest run --config vitest.config.ts --root packages/lifeops-bench",
    );
    expect(workflow).not.toContain("--passWithNoTests");
    expect(workflow).not.toContain(
      "--config packages/lifeops-bench/vitest.config.ts --root packages/lifeops-bench",
    );
  });

  test("keeps formatting as an independent matrix lane", () => {
    expect(workflow).toContain(
      "bunx @biomejs/biome check packages/lifeops-bench/src",
    );
  });

  test("runs the benchmark CI-classification contract without model credentials", () => {
    expect(workflow).toContain("lane: benchmark-ci-coverage");
    expect(workflow).toContain("runtime: python");
    expect(workflow).toContain(
      "PYTHONPATH=packages python -m pytest packages/benchmarks/tests/test_ci_coverage.py -q",
    );
    expect(workflow).toContain("if: matrix.runtime == 'python'");
    expect(workflow).toContain("pytest==8.4.1");
  });

  test("runs for develop and every source or setup dependency it consumes", () => {
    const requiredPaths = [
      "packages/lifeops-bench/**",
      "packages/benchmarks/**",
      "packages/agent/**",
      "packages/core/**",
      "packages/shared/**",
      "packages/cloud/routing/**",
      "packages/cloud/sdk/**",
      "plugins/plugin-groq/**",
      "plugins/plugin-local-inference/**",
      ".github/actions/setup-bun-workspace/**",
      ".github/ci-bun-version.json",
      "package.json",
      "bun.lock",
      ".github/workflows/benchmark-tests.yml",
      ".github/workflows/benchmark-orchestrator-scheduled.yml",
    ];

    expect(parsedWorkflow.on?.push?.branches).toEqual(["main", "develop"]);
    expect(parsedWorkflow.on?.pull_request?.branches).toEqual([
      "main",
      "develop",
    ]);
    for (const paths of [
      parsedWorkflow.on?.push?.paths,
      parsedWorkflow.on?.pull_request?.paths,
    ]) {
      expect(paths).toEqual(expect.arrayContaining(requiredPaths));
    }
  });
});
