/**
 * Exercises packaged-launcher verification through real child processes and
 * locks release workflows to unmasked checks before publication.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseArguments,
  runCommand,
  verifyPackagedCli,
} from "../verify-packaged-cli.mjs";

const repoRoot = new URL("../../../", import.meta.url);
const verifierPath = fileURLToPath(
  new URL("../verify-packaged-cli.mjs", import.meta.url),
);
const temporaryDirectories: string[] = [];

interface LauncherOptions {
  help?: string;
  helpExit?: number;
  helpStderr?: string;
  requiredPrefix?: string;
  version?: string;
  versionExit?: number;
  versionStderr?: string;
}

function fixture(source: string): string {
  const directory = mkdtempSync(join(tmpdir(), "eliza-packaged-cli-"));
  temporaryDirectories.push(directory);
  const executable = join(directory, "launcher.mjs");
  writeFileSync(executable, source);
  return executable;
}

function launcher({
  help = "Usage: eliza [options]\n\nOptions:\n  --help  Show help\n",
  helpExit = 0,
  helpStderr = "",
  requiredPrefix,
  version = "2.0.0",
  versionExit = 0,
  versionStderr = "",
}: LauncherOptions = {}): string {
  return fixture(`
const args = process.argv.slice(2);
const requiredPrefix = ${requiredPrefix === undefined ? "undefined" : JSON.stringify(requiredPrefix)};
if (requiredPrefix !== undefined && args.shift() !== requiredPrefix) process.exit(64);
const flag = args.shift();
if (args.length > 0) process.exit(64);
if (flag === "--version") {
  process.stdout.write(${JSON.stringify(`${version}\n`)});
  process.stderr.write(${JSON.stringify(versionStderr)});
  process.exit(${versionExit});
}
if (flag === "--help") {
  process.stdout.write(${JSON.stringify(help)});
  process.stderr.write(${JSON.stringify(helpStderr)});
  process.exit(${helpExit});
}
process.exit(64);
`);
}

function verify(
  executable: string,
  {
    commandArgs = [],
    expectedVersion = "2.0.0",
    timeoutMs = 2_000,
  }: {
    commandArgs?: string[];
    expectedVersion?: string;
    timeoutMs?: number;
  } = {},
): string {
  return verifyPackagedCli(
    process.execPath,
    [executable, ...commandArgs],
    expectedVersion,
    { timeoutMs },
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("packaged CLI verification", () => {
  test.each([
    ["one-line", "Usage: eliza [options]\n\nOptions:\n  --help  Show help\n"],
    [
      "multiline",
      "Usage:\n  eliza [options]\n\nCommands:\n  serve  Start API\n",
    ],
  ])("accepts %s usage with the exact version and populated help", (_kind, help) => {
    expect(verify(launcher({ help }))).toMatch(/(?:Options|Commands):/);
  });

  test("rejects a command that cannot start", () => {
    const directory = mkdtempSync(join(tmpdir(), "eliza-missing-launcher-"));
    temporaryDirectories.push(directory);

    expect(() =>
      verifyPackagedCli(join(directory, "missing"), [], "2.0.0", {
        timeoutMs: 500,
      }),
    ).toThrow("Could not start");
  });

  test("rejects a missing runtime dependency and the wrong version", () => {
    expect(() => verify(launcher({ versionExit: 1 }))).toThrow("exited 1");
    expect(() => verify(launcher({ version: "1.9.9" }))).toThrow(
      "version mismatch",
    );
  });

  test("ignores wrapper diagnostics on stderr when validating stdout", () => {
    const help = "Usage: eliza [options]\n\nOptions:\n  --help  Show help\n";
    expect(
      verify(
        launcher({
          help,
          helpStderr: "Gtk-WARNING: portal unavailable\n",
          versionStderr: "snap-confine: using fallback portal\n",
        }),
      ),
    ).toBe(help.trim());
  });

  test("keeps stderr in nonzero-exit diagnostics", () => {
    expect(() =>
      verify(
        launcher({
          versionExit: 1,
          versionStderr: "missing packaged runtime dependency: zod\n",
        }),
      ),
    ).toThrow("missing packaged runtime dependency: zod");
  });

  test("rejects failed or structurally empty help", () => {
    expect(() => verify(launcher({ helpExit: 2 }))).toThrow("exited 2");
    for (const help of [
      "installed\n",
      "Usage:\n",
      "Usage: eliza\n\nOptions:\n",
    ]) {
      expect(() => verify(launcher({ help }))).toThrow(
        "usable Usage and Commands/Options sections",
      );
    }
  });

  test("hard-kills a launcher that never returns", () => {
    const executable = fixture("setInterval(() => {}, 60_000);\n");
    const startedAt = Date.now();

    expect(() =>
      runCommand(process.execPath, [executable, "--version"], {
        timeoutMs: 100,
      }),
    ).toThrow("timed out after 100ms");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("exercises wrapper arguments through the command-line boundary", () => {
    const executable = launcher({ requiredPrefix: "wrapped" });
    const argv = [
      "--expected",
      "2.0.0",
      "--",
      process.execPath,
      executable,
      "wrapped",
    ];

    expect(parseArguments(argv)).toEqual({
      command: process.execPath,
      commandArgs: [executable, "wrapped"],
      expectedVersion: "2.0.0",
    });

    const success = spawnSync(process.execPath, [verifierPath, ...argv], {
      encoding: "utf8",
    });
    expect(success.status).toBe(0);
    expect(success.stdout).toContain("Verified packaged CLI 2.0.0");

    const failure = spawnSync(
      process.execPath,
      [
        verifierPath,
        "--expected",
        "9.9.9",
        "--",
        process.execPath,
        executable,
        "wrapped",
      ],
      { encoding: "utf8" },
    );
    expect(failure.status).toBe(1);
    expect(failure.stderr).toContain("version mismatch");
  });

  test("rejects malformed verifier arguments and timeouts", () => {
    expect(() => parseArguments([])).toThrow("before the packaged command");
    expect(() => parseArguments(["--", "command"])).toThrow(
      "non-empty --expected",
    );
    expect(() => parseArguments(["--expected", "2.0.0", "--"])).toThrow(
      "packaged command",
    );
    expect(() =>
      parseArguments(["--unexpected", "value", "--", "command"]),
    ).toThrow("Unknown verifier argument");
    expect(() =>
      parseArguments([
        "--expected",
        "2.0.0",
        "--expected",
        "2.0.1",
        "--",
        "command",
      ]),
    ).toThrow("only be provided once");
    expect(() => runCommand(process.execPath, [], { timeoutMs: 0 })).toThrow(
      "positive integer",
    );
  });
});

interface WorkflowStep {
  "continue-on-error"?: boolean | string;
  env?: Record<string, string>;
  name?: string;
  run?: string;
}

interface WorkflowJob {
  needs?: string | string[];
  steps?: WorkflowStep[];
}

interface WorkflowPathTrigger {
  branches?: string[];
  paths?: string[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
  on?: {
    pull_request?: WorkflowPathTrigger;
    push?: WorkflowPathTrigger;
  };
}

function workflow(path: string): Workflow {
  return Bun.YAML.parse(
    readFileSync(new URL(path, repoRoot), "utf8"),
  ) as Workflow;
}

function workflowStep(
  path: string,
  job: string,
  stepName: string,
): WorkflowStep {
  const step = workflow(path).jobs?.[job]?.steps?.find(
    (candidate) => candidate.name === stepName,
  );
  if (!step) {
    throw new Error(`Missing ${path} ${job} step ${stepName}`);
  }
  return step;
}

function stepIndex(path: string, job: string, stepName: string): number {
  const index = workflow(path).jobs?.[job]?.steps?.findIndex(
    (candidate) => candidate.name === stepName,
  );
  if (index === undefined || index < 0) {
    throw new Error(`Missing ${path} ${job} step ${stepName}`);
  }
  return index;
}

function expectFailClosedRun(
  path: string,
  job: string,
  stepName: string,
): WorkflowStep {
  const step = workflowStep(path, job, stepName);
  if (!step.run) {
    throw new Error(`Missing run body for ${path} ${job} step ${stepName}`);
  }

  expect(step.run).toContain("set -euo pipefail");
  expect(step["continue-on-error"]).toBeUndefined();
  return step;
}

function expectDirectVerifier(
  path: string,
  job: string,
  stepName: string,
  packagedCommand: RegExp,
): WorkflowStep {
  const step = expectFailClosedRun(path, job, stepName);
  expect(step.run).toContain("packages/scripts/verify-packaged-cli.mjs");
  expect(step.run).toMatch(packagedCommand);
  expect(step.run).not.toMatch(/verify-packaged-cli\.mjs[^\n]*\|\|/);
  return step;
}

function expectInstalledSnapScript(
  path: string,
  job: string,
  stepName: string,
): WorkflowStep {
  const step = workflowStep(path, job, stepName);
  expect(step.run).toContain(
    "bash packages/app-core/packaging/snap/test-installed-snap.sh",
  );
  expect(step["continue-on-error"]).toBeUndefined();
  return step;
}

function expectRunOrder(step: WorkflowStep, fragments: string[]): void {
  if (!step.run) {
    throw new Error(`Missing run body for ${step.name ?? "unnamed step"}`);
  }

  let previous = -1;
  for (const fragment of fragments) {
    const index = step.run.indexOf(fragment);
    expect(index).toBeGreaterThan(previous);
    previous = index;
  }
}

function expectStepBefore(
  path: string,
  job: string,
  first: string,
  second: string,
): void {
  expect(stepIndex(path, job, first)).toBeLessThan(
    stepIndex(path, job, second),
  );
}

function expectJobNeeds(path: string, job: string, dependency: string): void {
  const needs = workflow(path).jobs?.[job]?.needs;
  const dependencies = Array.isArray(needs) ? needs : needs ? [needs] : [];
  expect(dependencies).toContain(dependency);
}

describe("package workflows", () => {
  test("package builds rerun when the shared verifier changes", () => {
    const verifier = "packages/scripts/verify-packaged-cli.mjs";
    const verifierTest =
      "packages/scripts/__tests__/verify-packaged-cli.test.ts";
    const snap = workflow(".github/workflows/snap-build-test.yml");
    const flatpak = workflow(".github/workflows/test-flatpak.yml");
    const packaging = workflow(".github/workflows/test-packaging.yml");

    expect(snap.on?.push?.branches).toEqual(["develop"]);
    expect(snap.on?.pull_request?.branches).toEqual(["develop"]);
    expect(snap.on?.push?.paths).toBeUndefined();
    expect(snap.on?.pull_request?.paths).toBeUndefined();
    expect(flatpak.on?.pull_request?.paths).toContain(verifier);
    expect(flatpak.on?.pull_request?.branches).toEqual(["develop"]);
    expect(packaging.on?.push?.paths).toEqual(
      expect.arrayContaining([verifier, verifierTest]),
    );
    expect(packaging.on?.pull_request?.paths).toEqual(
      expect.arrayContaining([verifier, verifierTest]),
    );
  });

  test("installed Snap and Flatpak validation use the shared fail-closed verifier", () => {
    const installedSnapScript = readFileSync(
      new URL(
        "packages/app-core/packaging/snap/test-installed-snap.sh",
        repoRoot,
      ),
      "utf8",
    );
    const snap = expectInstalledSnapScript(
      ".github/workflows/snap-build-test.yml",
      "build-snap",
      "Install and test snap",
    );
    const flatpak = expectDirectVerifier(
      ".github/workflows/test-flatpak.yml",
      "build",
      "Install and test",
      /-- flatpak run ai\.elizaos\.App/,
    );

    expect(installedSnapScript).toContain("set -euo pipefail");
    expect(installedSnapScript).toContain(
      'run_capture shared-verifier node "$PACKAGED_CLI_VERIFIER" --expected "$EXPECTED_VERSION" -- snap run elizaos-app',
    );
    expect(installedSnapScript).not.toMatch(/shared-verifier[^\n]*\|\|/);
    const installIndex = installedSnapScript.indexOf(
      'sudo snap install "$SNAP_PATH" --dangerous',
    );
    const readOnlyIndex = installedSnapScript.indexOf(
      'chmod 0555 "$CLEAN_CWD"',
    );
    const verifierIndex = installedSnapScript.indexOf(
      "run_capture shared-verifier",
    );
    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(readOnlyIndex).toBeGreaterThan(installIndex);
    expect(verifierIndex).toBeGreaterThan(readOnlyIndex);

    expect(snap.run).toContain('require("./package.json").version');
    expectRunOrder(flatpak, [
      "flatpak --user install --reinstall",
      "packages/scripts/verify-packaged-cli.mjs",
      "flatpak run --command=node",
      "flatpak-runtime.json",
    ]);
  });

  test("every release path verifies the installed launcher before artifacts leave the job", () => {
    const aggregate = ".github/workflows/publish-packages.yml";
    const standaloneSnap = ".github/workflows/snap-publish.yml";
    const standaloneDeb = ".github/workflows/build-debian-package.yml";

    for (const { path, job } of [
      { path: aggregate, job: "publish-snap" },
      { path: standaloneSnap, job: "build-and-publish" },
    ]) {
      const smoke = expectInstalledSnapScript(
        path,
        job,
        "Install and test snap",
      );
      expect(smoke.env?.EXPECTED_VERSION).toBeDefined();
      expectStepBefore(
        path,
        job,
        "Install and test snap",
        "Publish to Snap Store",
      );
    }
    expectStepBefore(
      aggregate,
      "publish-snap",
      "Install and test snap",
      "Upload Snap artifact and evidence",
    );
    expectStepBefore(
      standaloneSnap,
      "build-and-publish",
      "Install and test snap",
      "Upload snap artifact and evidence",
    );

    const aggregateDeb = expectDirectVerifier(
      aggregate,
      "build-deb",
      "Test .deb package",
      /-- elizaos-app/,
    );
    expectRunOrder(aggregateDeb, [
      "sudo dpkg -i",
      "packages/scripts/verify-packaged-cli.mjs",
    ]);
    for (const publication of [
      "Attest Debian build provenance",
      "Upload .deb artifact",
      "Attach .deb to GitHub Release",
    ]) {
      expectStepBefore(
        aggregate,
        "build-deb",
        "Test .deb package",
        publication,
      );
    }

    const aggregateFlatpak = expectDirectVerifier(
      aggregate,
      "build-flatpak",
      "Test Flatpak",
      /-- flatpak run ai\.elizaos\.App/,
    );
    expectRunOrder(aggregateFlatpak, [
      "flatpak --user install --reinstall",
      "packages/scripts/verify-packaged-cli.mjs",
    ]);
    for (const publication of [
      "Checksum Flatpak bundle",
      "Attest Flatpak build provenance",
      "Upload Flatpak bundle",
      "Attach Flatpak to GitHub Release",
    ]) {
      expectStepBefore(aggregate, "build-flatpak", "Test Flatpak", publication);
    }

    const deb = expectDirectVerifier(
      standaloneDeb,
      "build-deb",
      "Install and verify .deb runtime",
      /-- elizaos-app/,
    );
    expectRunOrder(deb, [
      "sudo apt-get install",
      "packages/scripts/verify-packaged-cli.mjs",
    ]);
    expectStepBefore(
      standaloneDeb,
      "build-deb",
      "Install and verify .deb runtime",
      "Upload .deb artifact",
    );
    expectJobNeeds(standaloneDeb, "collect-deb", "build-deb");
    expectStepBefore(
      standaloneDeb,
      "collect-deb",
      "Verify complete native package set",
      "Upload combined Debian artifact",
    );
    expectJobNeeds(standaloneDeb, "attest-deb", "collect-deb");
    expectJobNeeds(standaloneDeb, "release-deb", "collect-deb");
    expectJobNeeds(standaloneDeb, "release-deb", "attest-deb");
  });
});
