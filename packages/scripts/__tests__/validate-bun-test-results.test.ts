/** Verifies changed Bun coverage rejects missing execution proof and failed runs. */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateBunTestResults } from "../validate-bun-test-results.mjs";

const temporaryDirectories: string[] = [];

function writeReport(contents: string): {
  baseDir: string;
  reportPath: string;
  testFile: string;
} {
  const baseDir = mkdtempSync(path.join(tmpdir(), "bun-junit-validation-"));
  temporaryDirectories.push(baseDir);
  const testFile = "packages/demo/src/example.test.ts";
  const reportPath = path.join(baseDir, "junit.xml");
  writeFileSync(reportPath, contents);
  return { baseDir, reportPath, testFile };
}

function junit({
  errors = 0,
  failures,
  file = "packages/demo/src/example.test.ts",
  skipped,
  tests,
}: {
  errors?: number;
  failures: number;
  file?: string;
  skipped: number;
  tests: number;
}): string {
  return `<?xml version="1.0"?><testsuites tests="${tests}" failures="${failures}" errors="${errors}" skipped="${skipped}"><testsuite name="${file}" file="${file}" tests="${tests}" failures="${failures}" skipped="${skipped}"></testsuite></testsuites>`;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("changed Bun JUnit validation", () => {
  test("rejects an all-skipped file even when Bun exited successfully", () => {
    const fixture = writeReport(junit({ failures: 0, skipped: 4, tests: 4 }));
    expect(() =>
      validateBunTestResults(
        fixture.testFile,
        fixture.reportPath,
        fixture.baseDir,
      ),
    ).toThrow("executed no passing tests");
  });

  test("rejects a mixed pass-and-skip file that could mask guarded behavior", () => {
    const fixture = writeReport(junit({ failures: 0, skipped: 3, tests: 5 }));
    expect(() =>
      validateBunTestResults(
        fixture.testFile,
        fixture.reportPath,
        fixture.baseDir,
      ),
    ).toThrow("skipped 3 test(s)");
  });

  test("accepts a complete passing report for the requested file", () => {
    const fixture = writeReport(junit({ failures: 0, skipped: 0, tests: 2 }));
    expect(
      validateBunTestResults(
        fixture.testFile,
        fixture.reportPath,
        fixture.baseDir,
      ),
    ).toEqual({ errors: 0, failures: 0, passed: 2, skipped: 0, tests: 2 });
  });

  test("rejects a failed file even when another test passed", () => {
    const fixture = writeReport(junit({ failures: 1, skipped: 0, tests: 2 }));
    expect(() =>
      validateBunTestResults(
        fixture.testFile,
        fixture.reportPath,
        fixture.baseDir,
      ),
    ).toThrow("reported 1 failure(s)");
  });

  test("rejects malformed and internally inconsistent reports", () => {
    const malformed = writeReport('<testsuites tests="1">');
    expect(() =>
      validateBunTestResults(
        malformed.testFile,
        malformed.reportPath,
        malformed.baseDir,
      ),
    ).toThrow("malformed");

    const inconsistent = writeReport(
      junit({ failures: 0, skipped: 2, tests: 1 }),
    );
    expect(() =>
      validateBunTestResults(
        inconsistent.testFile,
        inconsistent.reportPath,
        inconsistent.baseDir,
      ),
    ).toThrow("counts are inconsistent");
  });

  test("rejects a missing or wrong-file report", () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), "bun-junit-validation-"));
    temporaryDirectories.push(baseDir);
    expect(() =>
      validateBunTestResults(
        "packages/demo/src/example.test.ts",
        path.join(baseDir, "missing.xml"),
        baseDir,
      ),
    ).toThrow("produced no JUnit report");

    const wrongFile = writeReport(
      junit({
        failures: 0,
        file: "packages/demo/src/other.test.ts",
        skipped: 0,
        tests: 1,
      }),
    );
    expect(() =>
      validateBunTestResults(
        wrongFile.testFile,
        wrongFile.reportPath,
        wrongFile.baseDir,
      ),
    ).toThrow("did not identify changed test file");
  });
});
