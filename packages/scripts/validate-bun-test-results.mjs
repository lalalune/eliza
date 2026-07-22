/**
 * Validates one changed Bun test file's JUnit report before its coverage is
 * accepted. Bun exits successfully for an all-skipped file, so the changed-file
 * lane also requires a fresh report for the requested file with passing tests
 * and no skipped, failed, or errored cases. Guarded suites belong in canonical
 * live/real/e2e files instead of hiding behind an unrelated passing case.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function decodeXmlAttribute(value) {
  return value.replace(
    /&(?:#(\d+)|#x([\da-f]+)|amp|quot|apos|lt|gt);/gi,
    (entity, decimal, hexadecimal) => {
      if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10));
      if (hexadecimal) {
        return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
      }
      return {
        "&amp;": "&",
        "&quot;": '"',
        "&apos;": "'",
        "&lt;": "<",
        "&gt;": ">",
      }[entity.toLowerCase()];
    },
  );
}

function parseAttributes(tag) {
  const attributes = new Map();
  for (const match of tag.matchAll(/\s([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) {
    attributes.set(match[1], decodeXmlAttribute(match[2]));
  }
  return attributes;
}

function requiredCount(attributes, name, reportPath) {
  const value = attributes.get(name);
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new TypeError(
      `Bun JUnit report has no valid ${name} count: ${reportPath}`,
    );
  }
  return Number.parseInt(value, 10);
}

function optionalCount(attributes, name, reportPath) {
  const value = attributes.get(name);
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value)) {
    throw new TypeError(
      `Bun JUnit report has no valid ${name} count: ${reportPath}`,
    );
  }
  return Number.parseInt(value, 10);
}

function canonicalPath(baseDir, filePath) {
  return path.resolve(baseDir, filePath);
}

export function validateBunTestResults(
  testFile,
  reportPath,
  baseDir = process.cwd(),
) {
  if (!existsSync(reportPath)) {
    throw new Error(`Bun produced no JUnit report: ${reportPath}`);
  }

  const xml = readFileSync(reportPath, "utf8");
  const rootTag = xml.match(/<testsuites\b[^>]*>/)?.[0];
  if (!rootTag || !xml.includes("</testsuites>")) {
    throw new TypeError(`Bun JUnit report is malformed: ${reportPath}`);
  }

  const rootAttributes = parseAttributes(rootTag);
  const tests = requiredCount(rootAttributes, "tests", reportPath);
  const failures = requiredCount(rootAttributes, "failures", reportPath);
  const skipped = requiredCount(rootAttributes, "skipped", reportPath);
  const errors = optionalCount(rootAttributes, "errors", reportPath);
  if (failures > 0 || errors > 0) {
    throw new Error(
      `Changed Bun test file reported ${failures} failure(s) and ${errors} error(s): ${testFile}`,
    );
  }
  if (skipped > tests || failures + errors + skipped > tests) {
    throw new TypeError(`Bun JUnit counts are inconsistent: ${reportPath}`);
  }

  const expectedFile = canonicalPath(baseDir, testFile);
  const reportedFiles = [...xml.matchAll(/<testsuite\b[^>]*>/g)]
    .map((match) => parseAttributes(match[0]).get("file"))
    .filter((file) => file !== undefined)
    .map((file) => canonicalPath(baseDir, file));
  if (!reportedFiles.includes(expectedFile)) {
    throw new Error(
      `Bun JUnit report did not identify changed test file: ${testFile}`,
    );
  }

  const passed = tests - skipped - failures - errors;
  if (passed === 0) {
    throw new Error(
      `Changed Bun test file executed no passing tests: ${testFile}`,
    );
  }
  if (skipped > 0) {
    throw new Error(
      `Changed Bun test file skipped ${skipped} test(s); split guarded cases into a canonical live/real/e2e suite: ${testFile}`,
    );
  }

  return { errors, failures, passed, skipped, tests };
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  const [testFile, reportPath] = process.argv.slice(2);
  if (!testFile || !reportPath) {
    throw new Error(
      "Usage: validate-bun-test-results.mjs <test-file> <junit-report>",
    );
  }
  const result = validateBunTestResults(testFile, reportPath);
  process.stdout.write(
    `[changed-bun-coverage] ${testFile}: ${result.passed} passed, ${result.skipped} skipped\n`,
  );
}
