/**
 * Guards the supported-platform packaged reset lane without replacing its real
 * macOS launcher proof with a renderer fixture or static application-menu mock.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface WorkflowStep {
  name?: string;
  run?: string;
  env?: Record<string, string>;
}

interface WorkflowJob {
  name?: string;
  "runs-on"?: string;
  steps?: WorkflowStep[];
}

interface WorkflowTrigger {
  branches?: string[];
  paths?: string[];
}

interface DesktopResetWorkflow {
  on?: {
    pull_request?: WorkflowTrigger;
    push?: WorkflowTrigger;
  };
  jobs?: Record<string, WorkflowJob>;
}

const workflowPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.github/workflows/desktop-packaged-reset.yml",
);

describe("desktop packaged reset workflow", () => {
  it("runs the real application-menu reset on a supported macOS launcher", () => {
    const workflow = parse(
      readFileSync(workflowPath, "utf8"),
    ) as DesktopResetWorkflow;
    const job = workflow.jobs?.["reset-macos"];
    expect(job?.["runs-on"]).toBe("macos-15");

    const steps = job?.steps ?? [];
    const cloudRoutingBuildIndex = steps.findIndex(
      (step) => step.name === "Build cloud routing dependency",
    );
    const packagedBuildIndex = steps.findIndex(
      (step) => step.name === "Build packaged Electrobun application",
    );
    const resetStepIndex = steps.findIndex(
      (step) =>
        step.name === "Drive reset through the real packaged application menu",
    );
    const cloudRoutingBuild = steps[cloudRoutingBuildIndex];
    const packagedBuild = steps[packagedBuildIndex];
    const resetStep = steps[resetStepIndex];

    expect(cloudRoutingBuild?.run).toBe(
      "bun run --cwd packages/cloud/routing build",
    );
    expect(packagedBuild?.run).toBe(
      "bun run --cwd packages/app-core/platforms/electrobun build",
    );
    expect(packagedBuild?.env?.ELECTROBUN_SKIP_CODESIGN).toBe("1");
    expect(cloudRoutingBuildIndex).toBeGreaterThan(-1);
    expect(packagedBuildIndex).toBeGreaterThan(cloudRoutingBuildIndex);
    expect(resetStepIndex).toBeGreaterThan(packagedBuildIndex);
    expect(resetStep?.run).toContain("test:desktop:packaged");
    expect(resetStep?.run).toContain(
      "packaged desktop reset from the application menu",
    );
    expect(resetStep?.env?.ELIZA_TEST_PACKAGED_AUTO_BUILD).toBe("0");
  });

  it("runs on relevant pull requests and develop pushes", () => {
    const workflow = parse(
      readFileSync(workflowPath, "utf8"),
    ) as DesktopResetWorkflow;
    const requiredPaths = [
      ".github/workflows/desktop-packaged-reset.yml",
      ".github/actions/setup-bun-workspace/**",
      ".github/ci-bun-version.json",
      "package.json",
      "bun.lock",
      "packages/app/**",
      "packages/agent/src/api/**",
      "packages/app-core/**",
      "packages/cloud/routing/**",
      "packages/ui/**",
    ];

    for (const trigger of [workflow.on?.pull_request, workflow.on?.push]) {
      expect(trigger?.branches).toEqual(["develop"]);
      expect(trigger?.paths).toEqual(expect.arrayContaining(requiredPaths));
    }
  });
});
