/**
 * Exercises `CacheClient.getWithSWR` through the real memory backend, including
 * cold fills, fresh hits, stale revalidation, rejected background loads, and
 * separation between upstream availability and cache-backend health.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("CacheClient getWithSWR over the memory backend", () => {
  const prevBackend = process.env.CACHE_BACKEND;
  const prevCacheEnabled = process.env.CACHE_ENABLED;

  beforeEach(() => {
    process.env.CACHE_BACKEND = "memory";
    process.env.CACHE_ENABLED = "true";
  });
  afterAll(() => {
    if (prevBackend === undefined) delete process.env.CACHE_BACKEND;
    else process.env.CACHE_BACKEND = prevBackend;
    if (prevCacheEnabled === undefined) delete process.env.CACHE_ENABLED;
    else process.env.CACHE_ENABLED = prevCacheEnabled;
  });

  test("miss revalidates once and caches; a fresh hit skips revalidation", async () => {
    const { CacheClient } = await import("./client");
    const cache = new CacheClient();
    expect(cache.getBackendKind()).toBe("memory");

    let calls = 0;
    const load = async () => {
      calls += 1;
      return { v: "fresh" };
    };

    // Cold miss: revalidate runs and the result is cached.
    expect(await cache.getWithSWR("swr:hit", 60, load, 120)).toEqual({
      v: "fresh",
    });
    expect(calls).toBe(1);

    // Fresh hit (staleAt is a minute away): served from cache, no revalidate.
    expect(await cache.getWithSWR("swr:hit", 60, load, 120)).toEqual({
      v: "fresh",
    });
    expect(calls).toBe(1);
  });

  test("a stale hit serves the last-good value and revalidates in background", async () => {
    const { CacheClient } = await import("./client");
    const cache = new CacheClient();

    let version = 0;
    const load = async () => {
      version += 1;
      return { v: version };
    };

    // staleTTL 0 → the entry is stale on the next read; ttl keeps it stored.
    expect(await cache.getWithSWR("swr:stale", 0, load, 120)).toEqual({ v: 1 });
    await sleep(5);

    // Stale hit: the OLD value is served immediately…
    expect(await cache.getWithSWR("swr:stale", 0, load, 120)).toEqual({ v: 1 });

    // …and the background revalidation lands the fresh one for the next read.
    await sleep(25);
    expect(await cache.getWithSWR("swr:stale", 60, load, 120)).toEqual({
      v: 2,
    });
  });

  test("a cold-miss with a throwing fetcher propagates the rejection after a single fetch", async () => {
    const { CacheClient } = await import("./client");
    const cache = new CacheClient();

    let calls = 0;
    let fail = true;
    const load = async () => {
      calls += 1;
      if (fail) throw new Error("upstream 503");
      return { v: "good" };
    };

    // The loader stays outside the cache-adapter failure boundary so one
    // upstream outage cannot count against the cache circuit or duplicate work.
    await expect(cache.getWithSWR("swr:coldmiss", 60, load, 120)).rejects.toThrow("upstream 503");
    expect(calls).toBe(1);

    // Nothing was cached from the failure; a recovered fetcher populates the
    // entry normally on the next call.
    fail = false;
    expect(await cache.getWithSWR("swr:coldmiss", 60, load, 120)).toEqual({
      v: "good",
    });
    expect(calls).toBe(2);
    expect(await cache.getWithSWR("swr:coldmiss", 60, load, 120)).toEqual({
      v: "good",
    });
    expect(calls).toBe(2);
  });

  test("malformed SWR metadata reloads once and cannot open the cache circuit", async () => {
    const { CacheClient } = await import("./client");
    const cache = new CacheClient();
    const now = Date.now();
    const malformedEntries = [
      { data: { v: "missing-stale-at" }, cachedAt: now },
      { data: { v: "missing-cached-at" }, staleAt: now },
      { data: { v: "non-finite-cached-at" }, cachedAt: Number.NaN, staleAt: now },
      { data: { v: "string-cached-at" }, cachedAt: "now", staleAt: now },
      {
        data: { v: "non-finite-stale-at" },
        cachedAt: now,
        staleAt: Number.POSITIVE_INFINITY,
      },
      { data: { v: "reversed-window" }, cachedAt: 2, staleAt: 1 },
      {
        data: { v: "future-cached-at" },
        cachedAt: now + 60_000,
        staleAt: now + 120_000,
      },
      {
        data: { v: "oversized-freshness-window" },
        cachedAt: now,
        staleAt: now + 120_000,
      },
    ];
    let calls = 0;

    for (const [index, malformed] of malformedEntries.entries()) {
      const key = `swr:malformed:${index}`;
      const fresh = { v: `fresh-${index}` };
      await cache.set(key, malformed, 120);

      expect(
        await cache.getWithSWR(key, 60, async () => {
          calls += 1;
          return fresh;
        }),
      ).toEqual(fresh);

      const stored = await cache.get<{
        data: { v: string };
        cachedAt: number;
        staleAt: number;
      }>(key);
      expect(stored).toMatchObject({ data: fresh });
      if (!stored) throw new Error("expected repaired SWR entry");
      expect(stored.staleAt).toBeGreaterThanOrEqual(stored.cachedAt);
    }

    expect(calls).toBe(malformedEntries.length);
    expect(cache.isAvailable()).toBe(true);
  });

  test("invalid metadata survives a failed reload and is replaced only after recovery", async () => {
    const { CacheClient } = await import("./client");
    const cache = new CacheClient();
    const key = "swr:invalid-metadata-outage";
    const lastGood = { v: "last-good" };
    const invalidEnvelope = { data: lastGood, cachedAt: Date.now() };

    await cache.set(key, invalidEnvelope, 120);
    await expect(
      cache.getWithSWR(key, 60, async () => {
        throw new Error("upstream 503");
      }),
    ).rejects.toThrow("upstream 503");

    expect(await cache.get(key)).toEqual(invalidEnvelope);
    expect(cache.isAvailable()).toBe(true);

    const recovered = { v: "recovered" };
    expect(await cache.getWithSWR(key, 60, async () => recovered, 120)).toEqual(recovered);
    expect(await cache.get<{ data: { v: string } }>(key)).toMatchObject({ data: recovered });
  });

  test("a FAILING background revalidation keeps the last-good value and does not unhandled-reject", async () => {
    const { CacheClient } = await import("./client");
    const cache = new CacheClient();

    let calls = 0;
    let fail = false;
    const load = async () => {
      calls += 1;
      if (fail) throw new Error("upstream 503");
      return { v: "good" };
    };

    expect(await cache.getWithSWR("swr:fail", 0, load, 120)).toEqual({
      v: "good",
    });
    await sleep(5);

    // Stale hit with a now-failing loader: the stale value is served and the
    // background revalidation rejects. Nobody awaits the queued promise, so the
    // cache client must observe that rejection while retaining the stale entry.
    fail = true;
    expect(await cache.getWithSWR("swr:fail", 0, load, 120)).toEqual({
      v: "good",
    });
    await sleep(25);
    expect(calls).toBe(2);

    // The queue slot was released (finally), so the next stale hit retries…
    fail = false;
    expect(await cache.getWithSWR("swr:fail", 0, load, 120)).toEqual({
      v: "good",
    });
    await sleep(25);
    expect(calls).toBe(3);

    // …and the recovered revalidation refreshed the entry for a fresh read.
    expect(await cache.getWithSWR("swr:fail", 60, load, 120)).toEqual({
      v: "good",
    });
  });

  test("repeated cold loader failures do not open the cache circuit or hide stale data", async () => {
    const { CacheClient } = await import("./client");
    const cache = new CacheClient();
    const retained = { v: "last-good" };

    expect(
      await cache.getWithSWR("swr:retained-after-upstream-failures", 0, async () => retained, 120),
    ).toEqual(retained);
    await sleep(5);

    const upstreamError = new Error("provider unavailable");
    let loaderCalls = 0;
    const failingLoader = () => {
      loaderCalls += 1;
      throw upstreamError;
    };

    // Six failures cross CacheClient's five-backend-failure circuit threshold.
    // They come from the upstream loader, so the memory backend must remain
    // available and each caller must observe one load attempt, not a fallback
    // retry from the adapter catch.
    for (let index = 0; index < 6; index += 1) {
      await expect(
        cache.getWithSWR(`swr:provider-cold-${index}`, 60, failingLoader, 120),
      ).rejects.toBe(upstreamError);
    }
    expect(loaderCalls).toBe(6);
    expect(cache.isAvailable()).toBe(true);

    expect(
      await cache.getWithSWR("swr:retained-after-upstream-failures", 0, failingLoader, 120),
    ).toEqual(retained);
    await sleep(25);
    expect(cache.isAvailable()).toBe(true);
  });
});

// Contract tests for the memory-backend CacheClient surface that the SWR path
// composes with (get/set/del, TTL, atomic helpers, queues, getOrSet). Real
// round-trips against the same client instance the SWR tests use.
describe("CacheClient memory-backend contracts", () => {
  const prevBackend = process.env.CACHE_BACKEND;
  const prevCacheEnabled = process.env.CACHE_ENABLED;

  beforeEach(() => {
    process.env.CACHE_BACKEND = "memory";
    process.env.CACHE_ENABLED = "true";
  });
  afterAll(() => {
    if (prevBackend === undefined) delete process.env.CACHE_BACKEND;
    else process.env.CACHE_BACKEND = prevBackend;
    if (prevCacheEnabled === undefined) delete process.env.CACHE_ENABLED;
    else process.env.CACHE_ENABLED = prevCacheEnabled;
  });

  async function makeCache() {
    const { CacheClient } = await import("./client");
    const cache = new CacheClient();
    expect(cache.getBackendKind()).toBe("memory");
    return cache;
  }

  test("get/set/del round-trip", async () => {
    const cache = await makeCache();
    expect(await cache.get("ct:absent")).toBeNull();
    await cache.set("ct:a", { n: 1 }, 60);
    expect(await cache.get("ct:a")).toEqual({ n: 1 });
    await cache.del("ct:a");
    expect(await cache.get("ct:a")).toBeNull();
  });

  test("getWithOutcome distinguishes a miss from a hit", async () => {
    const cache = await makeCache();
    const miss = await cache.getWithOutcome("ct:outcome");
    expect(miss.kind).toBe("miss");
    await cache.setWithOutcome("ct:outcome", { ok: true }, 60);
    const hit = await cache.getWithOutcome<{ ok: boolean }>("ct:outcome");
    expect(hit.kind).toBe("hit");
    if (hit.kind === "hit") {
      expect(hit.value).toEqual({ ok: true });
    }
  });

  test("setIfNotExists is first-writer-wins", async () => {
    const cache = await makeCache();
    expect(await cache.setIfNotExists("ct:nx", "first", 60_000)).toBe(true);
    expect(await cache.setIfNotExists("ct:nx", "second", 60_000)).toBe(false);
    expect(await cache.get("ct:nx")).toBe("first");
  });

  test("incr counts atomically from zero", async () => {
    const cache = await makeCache();
    expect(await cache.incr("ct:count")).toBe(1);
    expect(await cache.incr("ct:count")).toBe(2);
  });

  test("pttl/pexpire/expire manage a key's lifetime", async () => {
    const cache = await makeCache();
    await cache.set("ct:ttl", "v", 60);
    const remaining = await cache.pttl("ct:ttl");
    expect(remaining).not.toBeNull();
    expect(remaining as number).toBeGreaterThan(0);
    await cache.pexpire("ct:ttl", 120_000);
    await cache.expire("ct:ttl", 300);
    expect(await cache.get("ct:ttl")).toBe("v");
  });

  test("getAndDelete returns the value exactly once", async () => {
    const cache = await makeCache();
    await cache.set("ct:once", { claim: 1 }, 60);
    expect(await cache.getAndDelete("ct:once")).toEqual({ claim: 1 });
    expect(await cache.getAndDelete("ct:once")).toBeNull();
  });

  test("delConfirmed confirms the delete round-trip and the key is gone", async () => {
    const cache = await makeCache();
    await cache.set("ct:delc", 1, 60);
    // Confirms the DEL command succeeded (fail-closed callers key off `false`
    // meaning the invalidation could NOT be confirmed), not prior existence.
    expect(await cache.delConfirmed("ct:delc")).toBe(true);
    expect(await cache.get("ct:delc")).toBeNull();
  });

  test("mget returns values and nulls positionally", async () => {
    const cache = await makeCache();
    await cache.set("ct:m1", "a", 60);
    await cache.set("ct:m3", "c", 60);
    expect(await cache.mget(["ct:m1", "ct:m2", "ct:m3"])).toEqual(["a", null, "c"]);
  });

  test("queue push/pop/length behaves FIFO from head to tail", async () => {
    const cache = await makeCache();
    await cache.pushQueueHead("ct:q", "first");
    await cache.pushQueueHead("ct:q", "second");
    expect(await cache.getQueueLength("ct:q")).toBe(2);
    // Tail pop returns the oldest push.
    expect(await cache.popQueueTail("ct:q")).toBe("first");
    expect(await cache.popQueueTail("ct:q")).toBe("second");
    expect(await cache.popQueueTail("ct:q")).toBeNull();
  });

  test("getOrSet loads once and serves the cached value after", async () => {
    const cache = await makeCache();
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return { loaded: true };
    };
    expect(await cache.getOrSet("ct:gos", 60, loader)).toEqual({
      loaded: true,
    });
    expect(await cache.getOrSet("ct:gos", 60, loader)).toEqual({
      loaded: true,
    });
    expect(calls).toBe(1);
  });
});
