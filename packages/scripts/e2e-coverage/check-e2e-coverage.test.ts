/** Verifies the source-derived keyless-e2e coverage report. */
import { describe, expect, test } from "bun:test";
import {
  buildKeylessCoverageReport,
} from "./check-e2e-coverage.ts";
import {
  buildPluginCoverage,
  inventoryPluginSurfaces,
  keylessScenariosByPlugin,
} from "./inventory.ts";

describe("e2e-coverage inventory", () => {
  test("discovers plugin surfaces from source", () => {
    const surfaces = inventoryPluginSurfaces();
    // The repo ships many plugins; the inventory must see a meaningful set.
    expect(surfaces.length).toBeGreaterThan(20);
    // Every surface entry carries a package name and a plugin directory.
    for (const surface of surfaces) {
      expect(surface.dir).toMatch(/^plugin-/);
      expect(surface.packageName.length).toBeGreaterThan(0);
    }
  });

  test("detects action surface for an action-bearing plugin", () => {
    const surfaces = inventoryPluginSurfaces();
    const todos = surfaces.find((s) => s.dir === "plugin-todos");
    expect(todos).toBeDefined();
    expect(todos?.hasActions).toBe(true);
  });

  test("detects connector surface for a connector plugin", () => {
    const surfaces = inventoryPluginSurfaces();
    const telegram = surfaces.find((s) => s.dir === "plugin-telegram");
    expect(telegram).toBeDefined();
    expect(telegram?.hasConnector).toBe(true);
  });

  test("maps keyless scenarios to the plugins they require", () => {
    const byPlugin = keylessScenariosByPlugin();
    // The convo self-tests are lane:"pr-deterministic" and require their
    // in-memory fixture plugins; the deterministic corpus requires core plugins.
    const todoScenarios = byPlugin.get("@elizaos/plugin-agent-skills") ?? [];
    expect(todoScenarios.length).toBeGreaterThan(0);
  });

  test("a covered plugin is reported as having keyless e2e", () => {
    const coverage = buildPluginCoverage();
    const todos = coverage.find((c) => c.dir === "plugin-todos");
    expect(todos?.hasSurface).toBe(true);
    expect(todos?.hasKeylessE2e).toBe(true);
    expect(todos?.keylessScenarioIds.length).toBeGreaterThan(0);
  });
});

describe("e2e-coverage report", () => {
  test("partitions every surface plugin without a baseline", () => {
    const coverage = buildPluginCoverage();
    const report = buildKeylessCoverageReport(coverage);
    const surfaces = coverage
      .filter((entry) => entry.hasSurface)
      .map((entry) => entry.dir)
      .sort();
    expect([...report.covered, ...report.uncovered].sort()).toEqual(surfaces);
    expect(new Set(report.covered).size).toBe(report.covered.length);
    expect(new Set(report.uncovered).size).toBe(report.uncovered.length);
  });
});
