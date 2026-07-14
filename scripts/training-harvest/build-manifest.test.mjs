/**
 * Exercises the real corpus discovery entrypoint and verifies that its portable
 * manifest paths survive generation outside the repository tree.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main, parseBenchmarkAdapters } from "./build-manifest.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("training harvest manifest", () => {
  it("writes repository-relative roots and benchmark working directories", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "harvest-manifest-"));
    temporaryDirectories.push(directory);
    const outputPath = path.join(directory, "manifest.json");
    const entrypoint = fileURLToPath(
      new URL("./build-manifest.mjs", import.meta.url),
    );
    const generated = spawnSync("node", [entrypoint, "--out", outputPath], {
      encoding: "utf8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (generated.error) throw generated.error;
    expect(generated.status, generated.stderr).toBe(0);

    const manifest = JSON.parse(readFileSync(outputPath, "utf8"));
    expect(manifest.repoRoot).toBe(".");

    const discoveredAdapters = manifest.families.benchmark.adapters.filter(
      (adapter) => typeof adapter.id === "string",
    );
    expect(discoveredAdapters.length).toBeGreaterThan(0);
    for (const adapter of discoveredAdapters) {
      expect(path.isAbsolute(adapter.cwd), adapter.id).toBe(false);
      expect(adapter.cwd.startsWith(".."), adapter.id).toBe(false);
    }

    const inProcessOutputPath = path.join(directory, "in-process.json");
    main(["--out", inProcessOutputPath], {
      benchmarkAdapters: discoveredAdapters,
    });
    const inProcessManifest = JSON.parse(
      readFileSync(inProcessOutputPath, "utf8"),
    );
    expect(inProcessManifest.families.benchmark.adapters).toEqual(
      discoveredAdapters,
    );

    const repoRoot = path.resolve(path.dirname(entrypoint), "../..");
    const adapters = parseBenchmarkAdapters(
      [
        `- root dir=root cwd=${repoRoot}`,
        `- nested dir=nested cwd=${path.join(repoRoot, "packages/benchmarks/nested")}`,
      ].join("\n"),
      repoRoot,
    );
    expect(adapters).toEqual([
      { id: "root", dir: "root", cwd: "." },
      {
        id: "nested",
        dir: "nested",
        cwd: "packages/benchmarks/nested",
      },
    ]);
  }, 120_000);
});
