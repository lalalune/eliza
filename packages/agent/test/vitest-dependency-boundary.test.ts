/**
 * Verifies that the agent test runner transforms workspace plugin source
 * without pulling third-party packages under plugin-local node_modules into
 * Vite's source pipeline.
 */
import { describe, expect, it } from "vitest";
import {
  resolveOrchestratorTestDependency,
  workspacePluginSourcePattern,
} from "../vitest-dependency-aliases";

describe("agent Vitest dependency boundary", () => {
  it("inlines workspace plugin source but externalizes plugin dependencies", () => {
    const pluginSource = "/repo/plugins/plugin-agent-orchestrator/src/index.ts";
    const pluginDependency =
      "/repo/plugins/plugin-agent-orchestrator/node_modules/@octokit/core/dist-src/index.js";

    expect(workspacePluginSourcePattern.test(pluginSource)).toBe(true);
    expect(workspacePluginSourcePattern.test(pluginDependency)).toBe(false);
  });

  it("uses Bun's real dependency graph for Octokit entrypoints", () => {
    for (const specifier of ["@octokit/core", "@octokit/rest"] as const) {
      const resolved = resolveOrchestratorTestDependency(specifier);

      expect(resolved).toContain("/node_modules/.bun/");
      expect(resolved).not.toContain(
        "/plugins/plugin-agent-orchestrator/node_modules/",
      );
    }
  });
});
