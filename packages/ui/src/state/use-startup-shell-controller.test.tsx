/**
 * Exercises the startup shell's rendered states, authenticated Cloud bootstrap
 * handoff, and trusted/untrusted remote-connect event boundary in jsdom.
 */

// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECT_EVENT } from "../events";

const effects = vi.hoisted(() => ({
  adoptions: [] as Array<{
    apiBase: string;
    token: string | null;
    uiLanguage: string;
  }>,
  authRefreshes: 0,
  confirmations: [] as Array<{ message: string }>,
  confirmResult: true,
  events: [] as Array<{ type: string }>,
  launches: [] as Array<{
    kind?: string;
    apiBase: string;
    token: string | null;
  }>,
  launchError: null as Error | null,
  mobileModes: [] as string[],
  notices: [] as Array<[string, string, number]>,
  retries: 0,
  state: new Map<string, unknown>(),
  workspaceRuns: 0,
}));

const mocks = vi.hoisted(() => ({
  adoptRemoteAgentFirstRun: vi.fn(
    async (
      _client: unknown,
      adoption: {
        apiBase: string;
        token: string | null;
        uiLanguage: string;
      },
    ) => {
      effects.adoptions.push(adoption);
    },
  ),
  applyLaunchConnection: vi.fn(
    (input: { kind?: string; apiBase: string; token: string | null }) => {
      effects.launches.push(input);
      if (effects.launchError) throw effects.launchError;
      return { apiBase: input.apiBase, token: input.token };
    },
  ),
  confirmDesktopAction: vi.fn(async (input: { message: string }) => {
    effects.confirmations.push(input);
    return effects.confirmResult;
  }),
  dispatch: vi.fn((event: { type: string }) => {
    effects.events.push(event);
  }),
  ensureStoreBuildWorkspaceFolder: vi.fn(async () => {
    effects.workspaceRuns += 1;
  }),
  getFirstRunStatus: vi.fn(async () => ({ cloudProvisioned: false })),
  needsBootstrapSession: vi.fn(() => false),
  persistMobileRuntimeModeForServerTarget: vi.fn((mode: string) => {
    effects.mobileModes.push(mode);
  }),
  refreshAuthStatus: vi.fn(async () => {
    effects.authRefreshes += 1;
  }),
  retryStartup: vi.fn(() => {
    effects.retries += 1;
  }),
  setActionNotice: vi.fn((message: string, level: string, duration: number) => {
    effects.notices.push([message, level, duration]);
  }),
  setState: vi.fn((key: string, value: unknown) => {
    effects.state.set(key, value);
  }),
  state: {
    startupCoordinator: {
      phase: "restoring-session",
      state: { phase: "restoring-session" },
      dispatch: vi.fn(),
    },
    startupError: null as null | {
      reason: string;
      message: string;
      phase: string;
    },
    firstRunCloudProvisionedContainer: false,
    retryStartup: vi.fn(),
    setActionNotice: vi.fn(),
    setState: vi.fn(),
    t: (key: string) => `translated:${key}`,
    uiLanguage: "en",
  },
}));

vi.mock("../api", () => ({
  client: { getFirstRunStatus: mocks.getFirstRunStatus },
}));
vi.mock("../first-run/adopt-remote-first-run", () => ({
  adoptRemoteAgentFirstRun: mocks.adoptRemoteAgentFirstRun,
}));
vi.mock("../first-run/ensure-store-build-workspace-folder", () => ({
  ensureStoreBuildWorkspaceFolder: mocks.ensureStoreBuildWorkspaceFolder,
}));
vi.mock("../first-run/mobile-runtime-mode", () => ({
  persistMobileRuntimeModeForServerTarget:
    mocks.persistMobileRuntimeModeForServerTarget,
}));
vi.mock("../hooks/useAuthStatus", () => ({
  refreshAuthStatus: mocks.refreshAuthStatus,
}));
vi.mock("../platform", () => ({
  applyLaunchConnection: mocks.applyLaunchConnection,
}));
vi.mock("../utils/desktop-dialogs", () => ({
  confirmDesktopAction: mocks.confirmDesktopAction,
}));
vi.mock("./app-store", () => ({
  useAppSelectorShallow: <T,>(selector: (state: typeof mocks.state) => T): T =>
    selector(mocks.state),
}));
vi.mock("./top-level-auth-gate", () => ({
  needsBootstrapSession: mocks.needsBootstrapSession,
}));

import { useStartupShellController } from "./use-startup-shell-controller";

function setCoordinator(
  phase: string,
  details: Record<string, unknown> = {},
): void {
  mocks.state.startupCoordinator = {
    phase,
    state: { phase, ...details },
    dispatch: mocks.dispatch,
  };
}

function connect(detail: unknown): void {
  document.dispatchEvent(new CustomEvent(CONNECT_EVENT, { detail }));
}

beforeEach(() => {
  vi.clearAllMocks();
  effects.adoptions.length = 0;
  effects.authRefreshes = 0;
  effects.confirmations.length = 0;
  effects.confirmResult = true;
  effects.events.length = 0;
  effects.launches.length = 0;
  effects.launchError = null;
  effects.mobileModes.length = 0;
  effects.notices.length = 0;
  effects.retries = 0;
  effects.state.clear();
  effects.workspaceRuns = 0;
  mocks.getFirstRunStatus.mockResolvedValue({ cloudProvisioned: false });
  mocks.needsBootstrapSession.mockReturnValue(false);
  mocks.state.startupError = null;
  mocks.state.firstRunCloudProvisionedContainer = false;
  mocks.state.retryStartup = mocks.retryStartup;
  mocks.state.setActionNotice = mocks.setActionNotice;
  mocks.state.setState = mocks.setState;
  setCoordinator("restoring-session");
});

afterEach(() => cleanup());

describe("useStartupShellController views", () => {
  it("maps coordinator loading, pairing, ready, and error states", () => {
    const { result, rerender } = renderHook(() => useStartupShellController());
    expect(result.current.view).toEqual({
      kind: "loading",
      phase: "restoring-session",
      status: "translated:startupshell.Starting",
    });
    expect(effects.workspaceRuns).toBe(1);

    setCoordinator("pairing-required");
    rerender();
    expect(result.current.view).toEqual({ kind: "pairing" });

    setCoordinator("ready");
    rerender();
    expect(result.current.view).toEqual({ kind: "none" });

    setCoordinator("error", {
      reason: "agent-error",
      message: "Runtime failed",
    });
    rerender();
    expect(result.current.view).toEqual({
      kind: "error",
      error: {
        reason: "agent-error",
        message: "Runtime failed",
        phase: "starting-backend",
      },
    });
  });

  it("prefers the explicit startup error supplied by the store", () => {
    mocks.state.startupError = {
      reason: "asset-missing",
      message: "Renderer asset missing",
      phase: "initializing-agent",
    };
    setCoordinator("error");

    const { result } = renderHook(() => useStartupShellController());

    expect(result.current.view).toEqual({
      kind: "error",
      error: mocks.state.startupError,
    });
  });
});

describe("remote connect events", () => {
  it("requires confirmation for remote deep links and leaves state untouched when cancelled", async () => {
    effects.confirmResult = false;
    renderHook(() => useStartupShellController());

    act(() => connect({ gatewayUrl: "https://agent.example" }));

    await waitFor(() =>
      expect(effects.notices).toContainEqual([
        "Connection request cancelled.",
        "info",
        4200,
      ]),
    );
    expect(effects.confirmations).toEqual([
      expect.objectContaining({
        message: 'Point this app at "agent.example"?',
      }),
    ]);
    expect(effects.launches).toEqual([]);
  });

  it("adopts an approved remote target and completes first run", async () => {
    renderHook(() => useStartupShellController());

    act(() =>
      connect({
        gatewayUrl: "https://agent.example/api",
        token: "remote-token",
        completeFirstRun: true,
      }),
    );

    await waitFor(() => expect(effects.retries).toBe(1));
    expect(effects.launches).toEqual([
      {
        kind: "remote",
        apiBase: "https://agent.example/api",
        token: "remote-token",
      },
    ]);
    expect(effects.mobileModes).toEqual(["remote"]);
    expect(Object.fromEntries(effects.state)).toMatchObject({
      firstRunRuntimeTarget: "remote",
      firstRunRemoteApiBase: "https://agent.example/api",
      firstRunRemoteToken: "remote-token",
      firstRunRemoteConnected: true,
      firstRunRemoteError: null,
      firstRunComplete: true,
    });
    expect(effects.adoptions).toEqual([
      {
        apiBase: "https://agent.example/api",
        token: "remote-token",
        uiLanguage: "en",
      },
    ]);
    expect(effects.events).toContainEqual({ type: "FIRST_RUN_COMPLETE" });
    expect(effects.notices).toContainEqual([
      "Connected to remote backend.",
      "success",
      4200,
    ]);
  });

  it("skips confirmation for loopback and reports connection failures", async () => {
    effects.launchError = new Error("Gateway rejected token");
    renderHook(() => useStartupShellController());

    act(() => connect({ gatewayUrl: "http://127.0.0.1:31337" }));

    await waitFor(() =>
      expect(effects.notices).toContainEqual([
        "Gateway rejected token",
        "error",
        8000,
      ]),
    );
    expect(effects.confirmations).toEqual([]);

    act(() => connect({ gatewayUrl: 42 }));
    expect(effects.launches).toHaveLength(1);
  });
});

describe("Cloud-provisioned bootstrap", () => {
  it("advances the bootstrap gate and refreshes the newly installed auth bearer", async () => {
    mocks.state.firstRunCloudProvisionedContainer = true;
    mocks.needsBootstrapSession.mockReturnValue(true);
    mocks.getFirstRunStatus.mockResolvedValue({ cloudProvisioned: true });
    setCoordinator("first-run-required", { serverReachable: true });
    const { result } = renderHook(() => useStartupShellController());

    await waitFor(() => expect(result.current.view.kind).toBe("bootstrap"));
    expect(result.current.view.kind).toBe("bootstrap");
    if (result.current.view.kind !== "bootstrap") {
      throw new Error("Expected bootstrap view");
    }
    act(
      () =>
        result.current.view.kind === "bootstrap" &&
        result.current.view.onAdvance(),
    );

    expect(effects.state.get("firstRunComplete")).toBe(true);
    expect(effects.events).toContainEqual({ type: "FIRST_RUN_COMPLETE" });
    expect(effects.authRefreshes).toBe(1);
  });

  it("skips bootstrap when Cloud reports an existing authenticated session", async () => {
    mocks.state.firstRunCloudProvisionedContainer = true;
    mocks.getFirstRunStatus.mockResolvedValue({ cloudProvisioned: true });
    setCoordinator("first-run-required", { serverReachable: true });

    const { result } = renderHook(() => useStartupShellController());

    expect(result.current.view).toEqual({ kind: "none" });
    await waitFor(() =>
      expect(effects.state.get("firstRunComplete")).toBe(true),
    );
    expect(effects.events).toContainEqual({ type: "FIRST_RUN_COMPLETE" });
  });
});
