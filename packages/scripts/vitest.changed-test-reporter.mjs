/**
 * Emits a bounded per-file assertion summary for changed Vitest coverage.
 * Vitest's JSON reporter embeds the complete coverage map, which can exhaust
 * memory for integration suites; this reporter records only module paths and
 * terminal test states needed to reject missing or all-skipped changed files.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export function serializeChangedTestResults(
  testModules,
  unhandledErrors,
  reason,
) {
  return {
    reason,
    unhandledErrorCount: unhandledErrors.length,
    testResults: testModules.map((testModule) => ({
      name: testModule.moduleId,
      assertionResults: [...testModule.children.allTests()].map((testCase) => ({
        status: testCase.result().state,
      })),
    })),
  };
}

export default class ChangedTestReporter {
  onTestRunEnd(testModules, unhandledErrors, reason) {
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: the direct runner injects this per Vitest subprocess outside Turbo.
    const outputPath = process.env.ELIZA_CHANGED_VITEST_RESULTS;
    if (!outputPath) {
      throw new Error(
        "Changed-test reporter requires ELIZA_CHANGED_VITEST_RESULTS",
      );
    }
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(
      outputPath,
      `${JSON.stringify(
        serializeChangedTestResults(testModules, unhandledErrors, reason),
      )}\n`,
    );
  }
}
