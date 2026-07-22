/**
 * Unit tests for the Ui Smoke Coverage app shell contract and coverage
 * guardrail.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * UI-smoke spec-coverage ratchet gate (vitest, boot-free).
 *
 * Sibling to the action-coverage and route-coverage gates. Those gates prove
 * that every action/route is *enumerated* in the smoke matrix — but a spec that
 * is enumerated yet never executed in CI is false confidence. This gate closes
 * that hole on the spec axis.
 *
 * The keyless PR lane (scenario-pr.yml) is DIRECTORY-DRIVEN (issue #9943): it
 * runs every ui-smoke spec under test/ui-smoke, including nested specs, EXCEPT
 * the entries recorded in the
 * checked-in deny-list (test/ui-smoke/.pr-deny-list.json). Most specs are
 * hand-named in slice jobs for parallelism; the `app-browser-auto-discovered`
 * job runs the remainder via scripts/ui-smoke-pr-specs.mjs --list-auto. The net
 * effect: a NEW spec is on the PR path by default, and the ONLY way to exclude
 * one is to record it in the deny-list with a category and a reason.
 *
 * This gate enforces that contract:
 *   1. The deny-list is well-formed (real specs, valid category, non-empty
 *      reason, no duplicates).
 *   2. The keyless-debt bucket is a non-growing ratchet (MAX_KEYLESS_DEBT).
 *   3. A spec that is hand-named in the workflow is never simultaneously
 *      deny-listed (that would run it despite the exclusion).
 *   4. The directory-driven catch-all job stays wired into scenario-pr.yml, so
 *      every non-denied spec actually runs (named slices ∪ auto-discovered =
 *      all non-denied specs).
 *   5. Specs ignored by the catch-all's Chromium project are either run in a
 *      named dedicated project or recorded in the deny-list.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_SMOKE_DIR = path.join(HERE, "ui-smoke");
const DENY_LIST_PATH = path.join(UI_SMOKE_DIR, ".pr-deny-list.json");
const REPO_ROOT = path.resolve(HERE, "../../..");
const KEYLESS_WORKFLOW = path.join(
  REPO_ROOT,
  ".github/workflows/scenario-pr.yml",
);
const PLAYWRIGHT_CONFIG = path.join(
  REPO_ROOT,
  "packages/app/playwright.ui-smoke.config.ts",
);
const DEVICE_MATRIX = path.join(
  REPO_ROOT,
  "packages/app/test/ui-smoke/device-matrix.ts",
);

const VALID_CATEGORIES = [
  "live-only",
  "dedicated-tool",
  "keyless-debt",
] as const;
type DenyCategory = (typeof VALID_CATEGORIES)[number];

interface DenyEntry {
  spec: string;
  category: DenyCategory;
  reason: string;
}

interface WorkflowStep {
  name?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}

interface WorkflowJob {
  strategy?: {
    "fail-fast"?: boolean;
    matrix?: {
      include?: Array<{
        lane: string;
        specs: string;
        grep: string;
        project: string;
        test_auth: string;
      }>;
      shard?: Array<{ id: string; value: string }>;
    };
  };
  steps?: WorkflowStep[];
}

function workflowJobs(): Record<string, WorkflowJob> {
  const parsed = parse(readFileSync(KEYLESS_WORKFLOW, "utf8")) as {
    jobs?: Record<string, WorkflowJob>;
  };
  if (!parsed.jobs) {
    throw new Error("scenario-pr.yml must define jobs");
  }
  return parsed.jobs;
}

function workflowStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  if (!step) {
    throw new Error(`scenario-pr.yml job is missing step: ${name}`);
  }
  return step;
}

function githubExpression(expression: string): string {
  return ["$", `{{ ${expression} }}`].join("");
}

/**
 * Hard ceiling on the keyless-debt bucket — specs that are fixture-capable and
 * SHOULD run keyless but are not yet verified. Decrement every time a debt spec
 * is wired into the keyless lane (remove it from the deny-list). This is the
 * ratchet that prevents new dark specs from being parked in debt indefinitely.
 */
const MAX_KEYLESS_DEBT = 3;

function specFileNames(): string[] {
  const specs: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".spec.ts")) {
        specs.push(
          path.relative(UI_SMOKE_DIR, fullPath).split(path.sep).join("/"),
        );
      }
    }
  };
  walk(UI_SMOKE_DIR);
  return specs.sort();
}

function denyList(): DenyEntry[] {
  const parsed = JSON.parse(readFileSync(DENY_LIST_PATH, "utf8")) as {
    specs?: DenyEntry[];
  };
  if (!Array.isArray(parsed.specs)) {
    throw new Error(`${DENY_LIST_PATH}: expected a "specs" array`);
  }
  return parsed.specs;
}

/** Spec paths hand-named in scenario-pr.yml (test/ui-smoke/<path>.spec.ts). */
function namedInWorkflow(): Set<string> {
  const workflow = readFileSync(KEYLESS_WORKFLOW, "utf8");
  return new Set(
    [...workflow.matchAll(/test\/ui-smoke\/([A-Za-z0-9_./-]+\.spec\.ts)/g)].map(
      (match) => match[1] ?? "",
    ),
  );
}

function chromiumIgnoredSpecs(): string[] {
  const source = readFileSync(PLAYWRIGHT_CONFIG, "utf8");
  const ignoreBlock = source.match(
    /name:\s*"chromium",[\s\S]*?testIgnore:\s*\[([\s\S]*?)\],\s*use:/,
  )?.[1];
  if (!ignoreBlock) {
    throw new Error("chromium project must declare its testIgnore inventory");
  }

  const constantNames = [
    ...ignoreBlock.matchAll(/\b([A-Z][A-Z0-9_]+_SPEC)\b/g),
  ].map((match) => match[1] ?? "");
  const specs = specFileNames();
  return constantNames.flatMap((constantName) => {
    const declaration = source.match(
      new RegExp(
        `const\\s+${constantName}\\s*=\\s*\\/((?:\\\\/|[^/])+)\\/[a-z]*;`,
      ),
    );
    if (!declaration?.[1]) {
      throw new Error(`Unable to resolve ${constantName} testIgnore pattern`);
    }
    const pattern = new RegExp(declaration[1]);
    return specs.filter((spec) => pattern.test(spec));
  });
}

function specsMatchedByConstant(sourcePath: string, name: string): string[] {
  const source = readFileSync(sourcePath, "utf8");
  const declaration = source.match(
    new RegExp(
      `(?:const|export\\s+const)\\s+${name}\\s*=\\s*/((?:\\\\/|[^/])+)/[a-z]*;`,
    ),
  );
  if (!declaration?.[1]) {
    throw new Error(`Unable to resolve ${name} testMatch pattern`);
  }
  const pattern = new RegExp(declaration[1]);
  return specFileNames().filter((spec) => pattern.test(spec));
}

describe("ui-smoke spec coverage gate", () => {
  it("the deny-list is the single source of truth: every excluded spec is real, categorized, and justified", () => {
    const specs = new Set(specFileNames());
    const entries = denyList();
    const seen = new Set<string>();

    const stale = entries.map((e) => e.spec).filter((spec) => !specs.has(spec));
    expect(
      stale,
      `Deny-list references specs that no longer exist (remove them): ${stale.join(", ")}`,
    ).toEqual([]);

    const badCategory = entries.filter(
      (e) => !VALID_CATEGORIES.includes(e.category),
    );
    expect(
      badCategory.map((e) => `${e.spec}:${e.category}`),
      `Deny-list entries with an invalid category (expected ${VALID_CATEGORIES.join(", ")})`,
    ).toEqual([]);

    const missingReason = entries.filter(
      (e) => typeof e.reason !== "string" || e.reason.trim().length === 0,
    );
    expect(
      missingReason.map((e) => e.spec),
      "Every deny-list entry must name its reason for being off the keyless PR path",
    ).toEqual([]);

    const duplicates = entries
      .map((e) => e.spec)
      .filter((spec) => {
        const dup = seen.has(spec);
        seen.add(spec);
        return dup;
      });
    expect(
      duplicates,
      `Duplicate deny-list entries: ${duplicates.join(", ")}`,
    ).toEqual([]);
  });

  it("keyless-debt bucket is a non-growing ratchet", () => {
    const debt = denyList().filter((e) => e.category === "keyless-debt");
    expect(
      debt.length,
      `keyless-debt entries (${debt.length}) exceed the ceiling (${MAX_KEYLESS_DEBT}). ` +
        `Do not park new dark specs in debt — wire them into keyless CI instead, or pay ` +
        `off existing debt and lower the ceiling.`,
    ).toBeLessThanOrEqual(MAX_KEYLESS_DEBT);
  });

  it("a hand-named slice spec is never also deny-listed", () => {
    const denied = new Set(denyList().map((e) => e.spec));
    const named = namedInWorkflow();
    const conflict = [...named].filter((spec) => denied.has(spec));
    expect(
      conflict,
      `These specs are both hand-named in scenario-pr.yml AND deny-listed — a ` +
        `deny-listed spec must not run, so remove it from the workflow or the ` +
        `deny-list: ${conflict.join(", ")}`,
    ).toEqual([]);
  });

  it("every spec hand-named in the workflow resolves to a real spec file", () => {
    const specs = new Set(specFileNames());
    const missing = [...namedInWorkflow()].filter((name) => !specs.has(name));
    expect(
      missing,
      `scenario-pr.yml references ui-smoke specs that do not exist ` +
        `(rename/typo?): ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("the directory-driven auto-discovered catch-all job stays wired into scenario-pr.yml", () => {
    const workflow = readFileSync(KEYLESS_WORKFLOW, "utf8");
    expect(
      workflow.includes("ui-smoke-pr-specs.mjs --list-auto"),
      "scenario-pr.yml must invoke `ui-smoke-pr-specs.mjs --list-auto` so every " +
        "non-denied ui-smoke spec runs on the PR path. Without it, new specs run nowhere.",
    ).toBe(true);
    expect(
      workflow.includes("app-browser-auto-discovered"),
      "The app-browser-auto-discovered job must exist and be gated by the " +
        "deterministic-scenario aggregate.",
    ).toBe(true);
  });

  it("never counts a Chromium-ignored spec as auto-discovered coverage", () => {
    const denied = new Set(denyList().map((entry) => entry.spec));
    const named = namedInWorkflow();
    const silentlyIgnored = chromiumIgnoredSpecs().filter(
      (spec) => !denied.has(spec) && !named.has(spec),
    );
    expect(
      silentlyIgnored,
      `The auto-discovered job selects --project=chromium, so every Chromium-ignored ` +
        `spec must run in a named dedicated project or be deny-listed: ${silentlyIgnored.join(", ")}`,
    ).toEqual([]);
  });

  it("dedicated and live-only specs cannot leak through named project inventories", () => {
    const denied = new Set(denyList().map((entry) => entry.spec));
    const projectOwned = [
      ...specsMatchedByConstant(
        DEVICE_MATRIX,
        "ASSERTION_GRADE_DASHBOARD_SPECS",
      ),
      ...specsMatchedByConstant(PLAYWRIGHT_CONFIG, "WEBKIT_SMOKE_SPECS"),
    ];
    const leaked = [...new Set(projectOwned)].filter((spec) =>
      denied.has(spec),
    );
    expect(
      leaked,
      `A deny-listed spec is selected implicitly by a named PR project: ${leaked.join(", ")}`,
    ).toEqual([]);
  });

  it("splits the all-pages lane without dropping any owned browser suite", () => {
    const job = workflowJobs()["app-browser-all-pages"];
    expect(job).toBeDefined();
    expect(job?.strategy?.["fail-fast"]).toBe(false);
    expect(job?.strategy?.matrix?.include).toEqual([
      {
        lane: "desktop-routes",
        specs: "test/ui-smoke/all-pages-clicksafe.spec.ts",
        grep: "route renders without console failures: desktop|visible safe app tiles|shared ViewHeader",
        project: "chromium",
        test_auth: "false",
      },
      {
        lane: "mobile-routes",
        specs: "test/ui-smoke/all-pages-clicksafe.spec.ts",
        grep: "route renders without console failures: mobile",
        project: "chromium",
        test_auth: "false",
      },
      {
        lane: "builtin-desktop",
        specs: "test/ui-smoke/builtin-views-visual.spec.ts",
        grep: "builtin views visual coverage.* desktop$",
        project: "chromium",
        test_auth: "false",
      },
      {
        lane: "builtin-mobile",
        specs: "test/ui-smoke/builtin-views-visual.spec.ts",
        grep: "builtin views visual coverage.* mobile$",
        project: "chromium",
        test_auth: "false",
      },
      {
        lane: "documents",
        specs: "test/ui-smoke/documents-view.spec.ts",
        grep: ".",
        project: "chromium",
        test_auth: "false",
      },
      {
        lane: "cloud-console",
        specs: "test/ui-smoke/cloud-console-routes.spec.ts",
        grep: ".",
        project: "audit-cloud",
        test_auth: "true",
      },
    ]);

    const runStep = workflowStep(
      job ?? {},
      "Actual app all-pages render + click-safety browser coverage",
    );
    expect(runStep.run).toContain(githubExpression("matrix.specs"));
    expect(runStep.run).toContain(githubExpression("matrix.project"));
    expect(runStep.run).toContain(
      `--grep "${githubExpression("matrix.grep")}"`,
    );
    expect(runStep.env?.VITE_PLAYWRIGHT_TEST_AUTH).toBe(
      githubExpression("matrix.test_auth"),
    );
    const artifactStep = workflowStep(
      job ?? {},
      "Upload app browser all-pages artifacts",
    );
    expect(artifactStep.with?.name).toBe(
      `scenario-pr-app-browser-all-pages-${githubExpression("matrix.lane")}`,
    );
  });

  it("runs the auto-discovered browser inventory across four file-safe shards", () => {
    const job = workflowJobs()["app-browser-auto-discovered"];
    expect(job).toBeDefined();
    expect(job?.strategy?.["fail-fast"]).toBe(false);
    expect(job?.strategy?.matrix?.shard).toEqual([
      { id: "1-of-4", value: "1/4" },
      { id: "2-of-4", value: "2/4" },
      { id: "3-of-4", value: "3/4" },
      { id: "4-of-4", value: "4/4" },
    ]);

    const runStep = workflowStep(
      job ?? {},
      "Actual app auto-discovered ui-smoke browser coverage",
    );
    expect(runStep.run).toContain(
      'spec_output="$(node packages/app/scripts/ui-smoke-pr-specs.mjs --list-auto)"',
    );
    expect(runStep.run).toContain('read -r -a specs <<< "$spec_output"');
    expect(runStep.run).not.toMatch(/read[^\n]*<<<[^\n]*\$\(node/);
    expect(runStep.run).toContain('"$' + '{specs[@]}"');
    expect(runStep.run).not.toContain("--fully-parallel");
    expect(runStep.run).toContain(
      `--shard="${githubExpression("matrix.shard.value")}"`,
    );
    const artifactStep = workflowStep(
      job ?? {},
      "Upload app browser auto-discovered artifacts",
    );
    expect(artifactStep.with?.name).toBe(
      `scenario-pr-app-browser-auto-discovered-${githubExpression("matrix.shard.id")}`,
    );
  });

  it("propagates auto-discovery failures instead of reporting an empty inventory", () => {
    const job = workflowJobs()["app-browser-auto-discovered"];
    const runStep = workflowStep(
      job ?? {},
      "Actual app auto-discovered ui-smoke browser coverage",
    );
    const script = (runStep.run ?? "")
      .replace(
        "node packages/app/scripts/ui-smoke-pr-specs.mjs --list-auto",
        "bash -c 'exit 23'",
      )
      .replace(githubExpression("matrix.shard.value"), "1/4");
    const result = spawnSync("bash", ["-c", script], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(23);
  });

  it("named slices ∪ auto-discovered = every non-denied spec (nothing runs nowhere)", () => {
    const denied = new Set(denyList().map((e) => e.spec));
    const named = namedInWorkflow();
    const allSpecs = specFileNames();
    const runnable = allSpecs.filter((name) => !denied.has(name));

    // The auto-discovered job runs exactly the runnable specs not hand-named in a
    // slice (mirror of scripts/ui-smoke-pr-specs.mjs --list-auto). Together with
    // the named slices this must cover every runnable spec, with no overlap gaps.
    const autoDiscovered = runnable.filter((name) => !named.has(name));
    const covered = new Set<string>([
      ...[...named].filter((name) => runnable.includes(name)),
      ...autoDiscovered,
    ]);
    const uncovered = runnable.filter((name) => !covered.has(name));
    expect(
      uncovered,
      `Runnable specs covered by neither a named slice nor the auto-discovered ` +
        `job: ${uncovered.join(", ")}`,
    ).toEqual([]);

    // Sanity: the deny-list never swallows the whole directory.
    expect(denied.size).toBeLessThan(allSpecs.length);
  });
});
