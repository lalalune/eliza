#!/usr/bin/env node
/** Emit and self-test per-file line-delta metadata for coverage-gate.awk.
 *
 * Output fields are tab-separated: repo path, current line count, whether the
 * file is new (1/0), and a comma-separated set of added/modified line numbers.
 * Deletions have no executable line in the new file and therefore do not enter
 * the changed-line numerator. With no arguments, a temporary git history proves
 * that the emitted line numbers match the checked-out synthetic merge tree.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function git(cwd, args, options = {}) {
  const output = execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    ...options,
  });
  return typeof output === "string" ? output.trim() : "";
}

function currentLineCount(text) {
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function changedLineNumbers(diff) {
  const lines = new Set();
  for (const row of diff.split("\n")) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(row);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let line = start; line < start + count; line++) lines.add(line);
  }
  return [...lines].sort((left, right) => left - right);
}

function pathExistsAtRevision(cwd, revision, file) {
  const output = execFileSync(
    "git",
    ["ls-tree", "-z", "--name-only", "--full-tree", revision, "--", file],
    { cwd },
  );
  return output.toString("utf8").split("\0").includes(file);
}

function buildDeltaRows({ base, head, files, cwd = process.cwd() }) {
  if (files.length === 0) return [];
  const mergeBase = git(cwd, ["merge-base", base, head]);
  return files.map((file) => {
    const text = readFileSync(join(cwd, file), "utf8");
    const isNew = pathExistsAtRevision(cwd, mergeBase, file) ? 0 : 1;
    const diff = git(cwd, [
      "diff",
      "--unified=0",
      "--no-color",
      mergeBase,
      head,
      "--",
      file,
    ]);
    return [
      file,
      currentLineCount(text),
      isNew,
      changedLineNumbers(diff).join(","),
    ].join("\t");
  });
}

function runSelfTest() {
  const cwd = mkdtempSync(join(tmpdir(), "coverage-delta-spec-"));
  try {
    git(cwd, ["init", "--quiet", "--initial-branch=main"]);
    git(cwd, ["config", "user.email", "coverage@example.invalid"]);
    git(cwd, ["config", "user.name", "Coverage Self-Test"]);
    writeFileSync(join(cwd, "legacy.ts"), "one\ntwo\nthree\n");
    git(cwd, ["add", "legacy.ts"]);
    git(cwd, ["commit", "--quiet", "-m", "base"]);
    git(cwd, ["branch", "feature"]);

    writeFileSync(join(cwd, "legacy.ts"), "zero\none\ntwo\nthree\n");
    git(cwd, ["add", "legacy.ts"]);
    git(cwd, ["commit", "--quiet", "-m", "advance base"]);
    const base = git(cwd, ["rev-parse", "HEAD"]);

    git(cwd, ["switch", "--quiet", "feature"]);
    writeFileSync(join(cwd, "legacy.ts"), "one\ntwo\nTHREE\n");
    writeFileSync(join(cwd, "new.ts"), "alpha\nbeta\n");
    git(cwd, ["add", "legacy.ts", "new.ts"]);
    git(cwd, ["commit", "--quiet", "-m", "feature"]);
    git(cwd, ["switch", "--quiet", "main"]);
    git(cwd, ["merge", "--quiet", "--no-ff", "feature", "-m", "merge"]);
    const head = git(cwd, ["rev-parse", "HEAD"]);

    const rows = buildDeltaRows({
      base,
      head,
      files: ["legacy.ts", "new.ts"],
      cwd,
    });
    assert.deepEqual(rows, ["legacy.ts\t4\t0\t4", "new.ts\t2\t1\t1,2"]);
    console.log("ok - coverage delta matches the synthetic merge tree");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const [base, head] = process.argv.slice(2);
if (!base && !head) {
  runSelfTest();
  process.exit(0);
}
if (!base || !head) {
  console.error(
    "usage: coverage-delta-spec.self-test.mjs BASE HEAD < changed-files",
  );
  process.exit(2);
}
const files = readFileSync(0, "utf8").split(/\r?\n/).filter(Boolean);
console.log(buildDeltaRows({ base, head, files }).join("\n"));
