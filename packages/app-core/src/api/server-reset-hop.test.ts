/**
 * Regression tests for #7409: `_clearCompatPgliteDataDirForTests` must stop the
 * runtime and delete the `.elizadb` PGlite data dir purely in-process, never
 * issuing a loopback HTTP request (which would deadlock the reset hop). It also
 * proves stop timeouts, unsafe paths, and filesystem failures reject reset
 * instead of reporting success with live state still present.
 */
import fs, { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _clearCompatPgliteDataDirForTests } from "./server";

const ORIGINAL_FETCH = globalThis.fetch;

describe("server reset hop (regression for #7409)", () => {
  let dataParent: string;
  let elizadb: string;

  beforeEach(() => {
    dataParent = mkdtempSync(join(tmpdir(), "eliza-reset-hop-"));
    elizadb = join(dataParent, ".elizadb");
    fs.mkdirSync(elizadb, { recursive: true });
    writeFileSync(join(elizadb, "marker"), "x");
  });

  afterEach(() => {
    rmSync(dataParent, { recursive: true, force: true });
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it("stops the runtime and removes the .elizadb dir without issuing any HTTP requests", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("loopback fetch detected — would deadlock");
    }) as unknown as typeof globalThis.fetch;
    globalThis.fetch = fetchSpy;

    const teardownForReset = vi.fn().mockResolvedValue(undefined);
    const runtime = { teardownForReset } as unknown as Parameters<
      typeof _clearCompatPgliteDataDirForTests
    >[0];

    const config = {
      database: { pglite: { dataDir: elizadb } },
    } as Parameters<typeof _clearCompatPgliteDataDirForTests>[1];

    const start = Date.now();
    await _clearCompatPgliteDataDirForTests(runtime, config);
    const elapsedMs = Date.now() - start;

    expect(teardownForReset).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(elizadb)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("fails without deleting when runtime.stop() never resolves", async () => {
    vi.useFakeTimers();
    try {
      const teardownForReset = vi.fn(() => new Promise<void>(() => {}));
      const runtime = { teardownForReset } as unknown as Parameters<
        typeof _clearCompatPgliteDataDirForTests
      >[0];
      const config = {
        database: { pglite: { dataDir: elizadb } },
      } as Parameters<typeof _clearCompatPgliteDataDirForTests>[1];

      const pending = expect(
        _clearCompatPgliteDataDirForTests(runtime, config),
      ).rejects.toMatchObject({ code: "AGENT_RESET_RUNTIME_STOP_TIMEOUT" });
      await vi.advanceTimersByTimeAsync(20_000);
      await pending;

      expect(teardownForReset).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(elizadb)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an unexpected directory name without deleting it", async () => {
    const wrongDir = join(dataParent, "not-elizadb");
    fs.mkdirSync(wrongDir, { recursive: true });
    writeFileSync(join(wrongDir, "marker"), "x");

    const config = {
      database: { pglite: { dataDir: wrongDir } },
    } as Parameters<typeof _clearCompatPgliteDataDirForTests>[1];

    await expect(
      _clearCompatPgliteDataDirForTests(null, config),
    ).rejects.toMatchObject({ code: "AGENT_RESET_DATABASE_PATH_UNSAFE" });

    expect(fs.existsSync(wrongDir)).toBe(true);
  });

  it("tolerates a missing data dir (fresh state)", async () => {
    const missing = join(dataParent, "absent", ".elizadb");
    const config = {
      database: { pglite: { dataDir: missing } },
    } as Parameters<typeof _clearCompatPgliteDataDirForTests>[1];

    await expect(
      _clearCompatPgliteDataDirForTests(null, config),
    ).resolves.toBeUndefined();
  });

  it("surfaces filesystem deletion failures", async () => {
    vi.spyOn(fs, "rmSync").mockImplementationOnce(() => {
      throw new Error("permission denied");
    });
    const config = {
      database: { pglite: { dataDir: elizadb } },
    } as Parameters<typeof _clearCompatPgliteDataDirForTests>[1];

    await expect(
      _clearCompatPgliteDataDirForTests(null, config),
    ).rejects.toMatchObject({ code: "AGENT_RESET_DATABASE_DELETE_FAILED" });
    expect(fs.existsSync(elizadb)).toBe(true);
  });
});
