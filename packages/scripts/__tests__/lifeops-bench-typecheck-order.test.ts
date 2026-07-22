/**
 * Pins LifeOps Bench typechecking behind its workspace dependency builds so
 * source-facing agent exports cannot race dist-only transitive declarations.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const turboPath = fileURLToPath(
  new URL("../../../turbo.json", import.meta.url),
);

describe("LifeOps Bench Turbo typecheck ordering", () => {
  test("builds direct workspace dependencies before typechecking", () => {
    const turbo = JSON.parse(readFileSync(turboPath, "utf8")) as {
      tasks: Record<string, { dependsOn?: string[]; outputs?: string[] }>;
    };
    const task = turbo.tasks["@elizaos/lifeops-bench#typecheck"];

    expect(task).toBeDefined();
    expect(task?.dependsOn).toEqual(["^build"]);
    expect(task?.outputs).toEqual([]);
  });
});
