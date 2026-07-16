/**
 * Pins the credentialed scenario workflow's build graph, source-export
 * conditions, default evidence artifacts, and scheduled catalog coverage.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { listScenarioMetadata } from "../../scenario-runner/src/loader.ts";

const workflowPath = fileURLToPath(
  new URL("../../../.github/workflows/live-scenarios.yml", import.meta.url),
);
const agentPackagePath = fileURLToPath(
  new URL("../../agent/package.json", import.meta.url),
);
const liveScenarioWrapperPath = fileURLToPath(
  new URL("../run-live-scenarios.mjs", import.meta.url),
);
const defaultScenarioRoot = fileURLToPath(
  new URL("../../test/scenarios/", import.meta.url),
);

test("builds the dist-exported runtime packages before the scenario CLI starts", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const runStep = "- name: Run EA + connector live scenarios";

  expect(workflow).toMatch(
    /package_dirs=\([\s\S]*plugins\/plugin-local-inference[\s\S]*plugins\/plugin-app-control[\s\S]*plugins\/plugin-health[\s\S]*\)[\s\S]*for package_dir in "\$\{package_dirs\[@\]\}"/,
  );
  expect(workflow).toMatch(
    /package_dirs=\([\s\S]*plugins\/plugin-blocker[\s\S]*\)[\s\S]*for package_dir in "\$\{package_dirs\[@\]\}"/,
  );
  expect(workflow.indexOf("package_dirs=(")).toBeLessThan(
    workflow.indexOf(runStep),
  );
});

test("runs every live scenario root against workspace source exports", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const sourceConditionEntries = [
    ...workflow.matchAll(/NODE_OPTIONS: "--conditions=eliza-source"/g),
  ];
  expect(sourceConditionEntries).toHaveLength(3);
});

test("includes the dynamically loaded app manager in the agent build graph", () => {
  const packageJson = JSON.parse(readFileSync(agentPackagePath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  expect(packageJson.dependencies?.["@elizaos/plugin-app-manager"]).toBe(
    "workspace:*",
  );
});

test("discovers the orchestrator live evidence in the scheduled catalog", async () => {
  const metadata = await listScenarioMetadata(
    defaultScenarioRoot,
    undefined,
    undefined,
    false,
    "live-only",
  );
  const orchestratorEvidence = metadata.filter((entry) =>
    [
      "orchestrator.grilling-happy-path",
      "orchestrator.origin-routing-live",
    ].includes(entry.id),
  );

  expect(orchestratorEvidence.map((entry) => entry.id).sort()).toEqual([
    "orchestrator.grilling-happy-path",
    "orchestrator.origin-routing-live",
  ]);
});

test("exports native trajectories into the run directory by default", () => {
  const wrapper = readFileSync(liveScenarioWrapperPath, "utf8");

  expect(wrapper).toContain(
    'process.env.EXPORT_NATIVE_PATH ?? path.join(runDir, "native.jsonl")',
  );
  expect(wrapper).toMatch(
    /if \(exportNativePath\.length > 0\)[\s\S]*args\.push\("--export-native", exportNativePath\)/,
  );
});
