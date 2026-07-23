/**
 * @vitest-environment jsdom
 *
 * Exercises the renderer-service lifecycle registry with real service
 * definitions and the real global store — no mocked lifecycle: registration
 * order-independence, shell-scope gating, disposer retention and invocation on
 * dispose/pagehide/host replacement/re-registration (HMR), serialized async
 * cleanup, replacement coalescing, race-safe pending starts, and observable
 * failure states.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getRendererServiceStates,
  type RendererServiceCleanup,
  registerRendererService,
  resetRendererServicesForTest,
  settleRendererServices,
  startRendererServiceHost,
} from "./renderer-services";

function makeService(
  id: string,
  shells: readonly ("main" | "popout" | "detached")[] = ["main"],
) {
  const cleanup = vi.fn();
  const start = vi.fn(() => cleanup as RendererServiceCleanup);
  return { definition: { id, shells, start }, start, cleanup };
}

function stateOf(id: string) {
  return getRendererServiceStates().services.find((s) => s.id === id)?.status;
}

function createGate() {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    release: () => release?.(),
  };
}

afterEach(async () => {
  await resetRendererServicesForTest();
});

describe("registration and host startup ordering", () => {
  it("starts services registered before the host arrives", async () => {
    const svc = makeService("a.before-host");
    registerRendererService(svc.definition);
    expect(svc.start).not.toHaveBeenCalled();
    expect(stateOf("a.before-host")).toBe("registered");

    startRendererServiceHost({ shell: "main" });
    await settleRendererServices();
    expect(svc.start).toHaveBeenCalledTimes(1);
    expect(stateOf("a.before-host")).toBe("running");
  });

  it("starts services registered after the host arrives (idle-path loads)", async () => {
    startRendererServiceHost({ shell: "main" });
    const svc = makeService("a.after-host");
    registerRendererService(svc.definition);
    await settleRendererServices();
    expect(svc.start).toHaveBeenCalledTimes(1);
    expect(stateOf("a.after-host")).toBe("running");
  });

  it("passes the host shell and a live abort signal to start", async () => {
    const seen: { shell?: string; aborted?: boolean } = {};
    registerRendererService({
      id: "a.context",
      shells: ["main"],
      start: (context) => {
        seen.shell = context.shell;
        seen.aborted = context.signal.aborted;
        return () => {};
      },
    });
    const host = startRendererServiceHost({ shell: "main" });
    await settleRendererServices();
    expect(seen).toEqual({ shell: "main", aborted: false });
    await host.dispose();
  });

  it("rejects definitions with an empty id or no shells", () => {
    expect(() =>
      registerRendererService({
        id: "  ",
        shells: ["main"],
        start: () => () => {},
      }),
    ).toThrow(/non-empty id/);
    expect(() =>
      registerRendererService({
        id: "a.no-shells",
        shells: [],
        start: () => () => {},
      }),
    ).toThrow(/declares no shells/);
  });

  it("upgrades an active pre-queue HMR store without leaking its generation", async () => {
    await resetRendererServicesForTest();
    const cleanup = vi.fn();
    const detachPagehide = vi.fn();
    const definition = {
      id: "a.legacy-hmr",
      shells: ["main"] as const,
      start: vi.fn(() => () => {}),
    };
    const controller = new AbortController();
    const legacyInstance = {
      definition,
      controller,
      status: "running",
      cleanup,
      settled: Promise.resolve(),
    };
    const legacyHost = {
      shell: "main",
      reportError: vi.fn(),
      instances: new Map([[definition.id, legacyInstance]]),
      detachPagehide,
      disposed: false,
    };
    const holder = globalThis as unknown as Record<PropertyKey, unknown>;
    holder[Symbol.for("elizaos.renderer-services.store")] = {
      definitions: new Map([[definition.id, definition]]),
      host: legacyHost,
    };

    startRendererServiceHost({ shell: "main" });
    await settleRendererServices();

    expect(controller.signal.aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(detachPagehide).toHaveBeenCalledTimes(1);
    expect(definition.start).toHaveBeenCalledTimes(1);
    expect(stateOf(definition.id)).toBe("running");
  });
});

describe("shell scoping", () => {
  it("never starts a main-scoped service in popout/detached shells", async () => {
    const svc = makeService("a.main-only", ["main"]);
    registerRendererService(svc.definition);

    const popout = startRendererServiceHost({ shell: "popout" });
    await settleRendererServices();
    expect(svc.start).not.toHaveBeenCalled();
    expect(stateOf("a.main-only")).toBe("ineligible");
    await popout.dispose();

    const detached = startRendererServiceHost({ shell: "detached" });
    await settleRendererServices();
    expect(svc.start).not.toHaveBeenCalled();
    await detached.dispose();
  });

  it("starts a multi-shell service in each declared shell", async () => {
    const svc = makeService("a.multi", ["main", "popout"]);
    registerRendererService(svc.definition);

    const popout = startRendererServiceHost({ shell: "popout" });
    await settleRendererServices();
    expect(svc.start).toHaveBeenCalledTimes(1);
    await popout.dispose();
    expect(svc.cleanup).toHaveBeenCalledTimes(1);

    startRendererServiceHost({ shell: "main" });
    await settleRendererServices();
    expect(svc.start).toHaveBeenCalledTimes(2);
  });
});

describe("teardown", () => {
  it("invokes every retained cleanup on host dispose", async () => {
    const a = makeService("a.one");
    const b = makeService("a.two");
    registerRendererService(a.definition);
    registerRendererService(b.definition);
    const host = startRendererServiceHost({ shell: "main" });
    await settleRendererServices();

    await host.dispose();
    expect(a.cleanup).toHaveBeenCalledTimes(1);
    expect(b.cleanup).toHaveBeenCalledTimes(1);
    // Dispose is idempotent.
    await host.dispose();
    expect(a.cleanup).toHaveBeenCalledTimes(1);
  });

  it("disposes on pagehide (page teardown)", async () => {
    const svc = makeService("a.pagehide");
    registerRendererService(svc.definition);
    startRendererServiceHost({ shell: "main" });
    await settleRendererServices();

    window.dispatchEvent(new Event("pagehide"));
    await settleRendererServices();
    expect(svc.cleanup).toHaveBeenCalledTimes(1);
    expect(getRendererServiceStates().hostShell).toBeNull();
  });

  it("suspends resources in bfcache and starts a fresh generation on restore", async () => {
    const svc = makeService("a.bfcache");
    registerRendererService(svc.definition);
    startRendererServiceHost({ shell: "main" });
    await settleRendererServices();

    const persisted = new Event("pagehide") as Event & { persisted: boolean };
    Object.defineProperty(persisted, "persisted", { value: true });
    window.dispatchEvent(persisted);
    await settleRendererServices();
    expect(svc.cleanup).toHaveBeenCalledTimes(1);
    expect(stateOf("a.bfcache")).toBe("stopped");
    expect(getRendererServiceStates().hostShell).toBe("main");

    const pageshow = new Event("pageshow") as Event & { persisted: boolean };
    Object.defineProperty(pageshow, "persisted", { value: true });
    window.dispatchEvent(pageshow);
    await settleRendererServices();
    expect(svc.start).toHaveBeenCalledTimes(2);
    expect(stateOf("a.bfcache")).toBe("running");

    window.dispatchEvent(new Event("pagehide"));
    await settleRendererServices();
    expect(svc.cleanup).toHaveBeenCalledTimes(2);
    expect(getRendererServiceStates().hostShell).toBeNull();
  });

  it("stops the previous host's instances on host replacement", async () => {
    const svc = makeService("a.replaced-host");
    registerRendererService(svc.definition);
    startRendererServiceHost({ shell: "main" });
    await settleRendererServices();
    expect(svc.start).toHaveBeenCalledTimes(1);

    // A second boot (HMR of the shell, repeated test boots) replaces the host:
    // old instance stops before the new one starts.
    startRendererServiceHost({ shell: "main" });
    await settleRendererServices();
    expect(svc.cleanup).toHaveBeenCalledTimes(1);
    expect(svc.start).toHaveBeenCalledTimes(2);
    expect(stateOf("a.replaced-host")).toBe("running");
  });

  it("re-registering an id stops the old instance before starting the new one (HMR)", async () => {
    const first = makeService("a.hmr");
    registerRendererService(first.definition);
    startRendererServiceHost({ shell: "main" });
    await settleRendererServices();

    const second = makeService("a.hmr");
    registerRendererService(second.definition);
    await settleRendererServices();

    expect(first.cleanup).toHaveBeenCalledTimes(1);
    expect(second.start).toHaveBeenCalledTimes(1);
    expect(stateOf("a.hmr")).toBe("running");
  });

  it("reports a rejecting cleanup and still tears down the remaining services", async () => {
    const reportError = vi.fn();
    const bad = {
      id: "a.bad-cleanup",
      shells: ["main"] as const,
      start: () => async () => {
        await Promise.resolve();
        throw new Error("cleanup exploded");
      },
    };
    const good = makeService("a.good-cleanup");
    registerRendererService(bad);
    registerRendererService(good.definition);
    const host = startRendererServiceHost({ shell: "main", reportError });
    await settleRendererServices();

    await host.dispose();
    expect(good.cleanup).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      "a.bad-cleanup",
      expect.any(Error),
      "cleanup",
    );
  });
});

describe("serialized ownership", () => {
  it("awaits an old generation's async cleanup before starting its replacement", async () => {
    const cleanupGate = createGate();
    const events: string[] = [];
    registerRendererService({
      id: "a.serial-re-register",
      shells: ["main"],
      start: () => {
        events.push("old:start");
        return async () => {
          events.push("old:cleanup:start");
          await cleanupGate.promise;
          events.push("old:cleanup:end");
        };
      },
    });
    startRendererServiceHost({ shell: "main" });
    await settleRendererServices();

    registerRendererService({
      id: "a.serial-re-register",
      shells: ["main"],
      start: () => {
        events.push("new:start");
        return () => {};
      },
    });
    await vi.waitFor(() =>
      expect(events).toEqual(["old:start", "old:cleanup:start"]),
    );
    expect(events).not.toContain("new:start");

    cleanupGate.release();
    await settleRendererServices();
    expect(events).toEqual([
      "old:start",
      "old:cleanup:start",
      "old:cleanup:end",
      "new:start",
    ]);
    expect(stateOf("a.serial-re-register")).toBe("running");
  });

  it("shares one idempotent async stop and aborts ownership immediately", async () => {
    const cleanupGate = createGate();
    const cleanup = vi.fn(() => cleanupGate.promise);
    let signal: AbortSignal | undefined;
    registerRendererService({
      id: "a.idempotent-stop",
      shells: ["main"],
      start: (context) => {
        signal = context.signal;
        return cleanup;
      },
    });
    const host = startRendererServiceHost({ shell: "main" });
    await settleRendererServices();

    const firstStop = host.dispose();
    const secondStop = host.dispose();
    expect(secondStop).toBe(firstStop);
    expect(signal?.aborted).toBe(true);
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));

    cleanupGate.release();
    await firstStop;
    expect(host.dispose()).toBe(firstStop);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent host replacements while old cleanup is pending", async () => {
    const cleanupGate = createGate();
    const oldCleanup = vi.fn(() => cleanupGate.promise);
    const successorCleanup = vi.fn();
    let generation = 0;
    const start = vi.fn(() => {
      generation += 1;
      return generation === 1 ? oldCleanup : successorCleanup;
    });
    registerRendererService({
      id: "a.coalesced-host",
      shells: ["main"],
      start,
    });
    startRendererServiceHost({ shell: "main" });
    await settleRendererServices();

    const superseded = startRendererServiceHost({ shell: "main" });
    const latest = startRendererServiceHost({ shell: "main" });
    await vi.waitFor(() => expect(oldCleanup).toHaveBeenCalledTimes(1));
    expect(start).toHaveBeenCalledTimes(1);

    cleanupGate.release();
    await settleRendererServices();
    expect(start).toHaveBeenCalledTimes(2);
    expect(stateOf("a.coalesced-host")).toBe("running");
    await superseded.dispose();
    await latest.dispose();
    expect(successorCleanup).toHaveBeenCalledTimes(1);
  });

  it("does not let a throwing error reporter poison later ownership transitions", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    registerRendererService({
      id: "a.reporter-failure",
      shells: ["main"],
      start: () => () => {
        throw new Error("cleanup failed");
      },
    });
    const host = startRendererServiceHost({
      shell: "main",
      reportError: () => {
        throw new Error("reporter failed");
      },
    });
    await settleRendererServices();
    await host.dispose();

    const successor = makeService("a.after-reporter-failure");
    registerRendererService(successor.definition);
    startRendererServiceHost({ shell: "main" });
    await settleRendererServices();

    expect(successor.start).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("a.reporter-failure"),
      expect.any(AggregateError),
    );
  });
});

describe("race-safe async start", () => {
  it("runs the late cleanup when stopped during an awaited start", async () => {
    const cleanup = vi.fn();
    let releaseStart: (() => void) | undefined;
    registerRendererService({
      id: "a.slow-start",
      shells: ["main"],
      start: async () => {
        await new Promise<void>((resolve) => {
          releaseStart = resolve;
        });
        return cleanup;
      },
    });
    const host = startRendererServiceHost({ shell: "main" });
    await vi.waitFor(() => expect(stateOf("a.slow-start")).toBe("starting"));

    // Stop while start is still pending — no cleanup exists yet.
    const disposal = host.dispose();
    expect(cleanup).not.toHaveBeenCalled();

    // The start finishes late; its cleanup must run immediately, leaving no
    // orphaned listeners/intervals behind.
    releaseStart?.();
    await disposal;
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("ignores a rejection from a start that was already stopped", async () => {
    const reportError = vi.fn();
    let rejectStart: ((error: Error) => void) | undefined;
    registerRendererService({
      id: "a.aborted-reject",
      shells: ["main"],
      start: async () => {
        await new Promise<never>((_, reject) => {
          rejectStart = reject;
        });
        return () => {};
      },
    });
    const host = startRendererServiceHost({ shell: "main", reportError });
    await vi.waitFor(() => expect(rejectStart).toBeTypeOf("function"));
    const disposal = host.dispose();
    rejectStart?.(new Error("torn down mid-start"));
    await disposal;
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe("observable failures", () => {
  it("marks a rejecting start failed and reports it", async () => {
    const reportError = vi.fn();
    registerRendererService({
      id: "a.start-fails",
      shells: ["main"],
      start: async () => {
        throw new Error("no device");
      },
    });
    startRendererServiceHost({ shell: "main", reportError });
    await settleRendererServices();

    expect(stateOf("a.start-fails")).toBe("failed");
    expect(reportError).toHaveBeenCalledWith(
      "a.start-fails",
      expect.any(Error),
      "start",
    );
  });

  it("treats a start that returns no cleanup as a contract violation", async () => {
    const reportError = vi.fn();
    registerRendererService({
      id: "a.no-cleanup",
      shells: ["main"],
      // Deliberately violates the contract at runtime.
      start: (() => undefined) as unknown as () => RendererServiceCleanup,
    });
    startRendererServiceHost({ shell: "main", reportError });
    await settleRendererServices();

    expect(stateOf("a.no-cleanup")).toBe("failed");
    expect(reportError).toHaveBeenCalledWith(
      "a.no-cleanup",
      expect.objectContaining({
        message: expect.stringContaining("cleanup function"),
      }),
      "start",
    );
  });

  it("a failed service does not block other services from running", async () => {
    const reportError = vi.fn();
    registerRendererService({
      id: "a.fails",
      shells: ["main"],
      start: () => {
        throw new Error("boom");
      },
    });
    const good = makeService("a.survives");
    registerRendererService(good.definition);
    startRendererServiceHost({ shell: "main", reportError });
    await settleRendererServices();

    expect(stateOf("a.fails")).toBe("failed");
    expect(stateOf("a.survives")).toBe("running");
  });
});
