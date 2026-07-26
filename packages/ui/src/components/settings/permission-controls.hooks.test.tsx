// @vitest-environment jsdom
/**
 * Exercises desktop permission ownership with deferred bridge responses so
 * stale snapshots and duplicate OS actions cannot pass by timing luck.
 */

import { PERMISSION_IDS } from "@elizaos/shared";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AllPermissionsState,
  PermissionId,
  PermissionState,
  PermissionStatus,
} from "../../api";

const mocks = vi.hoisted(() => ({
  client: {
    getPermission: vi.fn(),
    getPermissions: vi.fn(),
    isShellEnabled: vi.fn(),
    openPermissionSettings: vi.fn(),
    refreshPermissions: vi.fn(),
    requestPermission: vi.fn(),
    setShellEnabled: vi.fn(),
  },
  invokeDesktopBridgeRequest: vi.fn(),
  permissionChangedListener: undefined as (() => void) | undefined,
}));

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return { ...actual, client: mocks.client };
});

vi.mock("../../bridge", () => ({
  invokeDesktopBridgeRequest: mocks.invokeDesktopBridgeRequest,
  subscribeDesktopBridgeEvent: vi.fn(
    ({ listener }: { listener: () => void }) => {
      mocks.permissionChangedListener = listener;
      return vi.fn();
    },
  ),
}));

import { useDesktopPermissionsState } from "./permission-controls.hooks";

function permissionState(
  id: PermissionId,
  status: PermissionStatus,
): PermissionState {
  return {
    id,
    status,
    canRequest: status === "not-determined",
    lastChecked: 1,
    platform: "darwin",
  };
}

function permissionSnapshot(
  accessibility: PermissionStatus,
): AllPermissionsState {
  return Object.fromEntries(
    PERMISSION_IDS.map((id) => [
      id,
      permissionState(id, id === "accessibility" ? accessibility : "granted"),
    ]),
  ) as AllPermissionsState;
}

function deferred<T>() {
  return Promise.withResolvers<T>();
}

function installBridgeSnapshot(snapshot: AllPermissionsState) {
  mocks.invokeDesktopBridgeRequest.mockImplementation(
    ({ rpcMethod }: { rpcMethod: string }) => {
      if (rpcMethod === "permissionsGetAll") return Promise.resolve(snapshot);
      if (rpcMethod === "permissionsIsShellEnabled")
        return Promise.resolve(true);
      if (rpcMethod === "permissionsGetPlatform")
        return Promise.resolve("darwin");
      return Promise.resolve(null);
    },
  );
}

describe("useDesktopPermissionsState lifecycle ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.permissionChangedListener = undefined;
    const initial = permissionSnapshot("denied");
    installBridgeSnapshot(initial);
    mocks.client.getPermission.mockImplementation((id: PermissionId) =>
      Promise.resolve(initial[id]),
    );
    mocks.client.getPermissions.mockResolvedValue(initial);
    mocks.client.isShellEnabled.mockResolvedValue(true);
    mocks.client.openPermissionSettings.mockResolvedValue(undefined);
    mocks.client.refreshPermissions.mockResolvedValue(undefined);
    mocks.client.requestPermission.mockResolvedValue(initial.accessibility);
    mocks.client.setShellEnabled.mockResolvedValue(initial.shell);
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps the newest completed snapshot when an older bridge response arrives last", async () => {
    const { result } = renderHook(() => useDesktopPermissionsState());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const older = deferred<AllPermissionsState>();
    const newer = deferred<AllPermissionsState>();
    let getAllCall = 0;
    mocks.invokeDesktopBridgeRequest.mockImplementation(
      ({ rpcMethod }: { rpcMethod: string }) => {
        if (rpcMethod === "permissionsGetAll") {
          getAllCall += 1;
          return getAllCall === 1 ? older.promise : newer.promise;
        }
        if (rpcMethod === "permissionsIsShellEnabled")
          return Promise.resolve(true);
        if (rpcMethod === "permissionsGetPlatform")
          return Promise.resolve("darwin");
        return Promise.resolve(null);
      },
    );

    act(() => {
      mocks.permissionChangedListener?.();
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(getAllCall).toBe(2));

    await act(async () => {
      newer.resolve(permissionSnapshot("granted"));
      await newer.promise;
    });
    await waitFor(() =>
      expect(result.current.permissions?.accessibility.status).toBe("granted"),
    );

    await act(async () => {
      older.resolve(permissionSnapshot("denied"));
      await older.promise;
    });
    expect(result.current.permissions?.accessibility.status).toBe("granted");
  });

  it("admits only one OS request across rapid duplicate clicks", async () => {
    const { result } = renderHook(() => useDesktopPermissionsState());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const request = deferred<PermissionState>();
    const granted = permissionSnapshot("granted");
    installBridgeSnapshot(granted);
    mocks.invokeDesktopBridgeRequest.mockImplementation(
      ({ rpcMethod }: { rpcMethod: string }) => {
        if (rpcMethod === "permissionsRequest") return request.promise;
        if (rpcMethod === "permissionsGetAll") return Promise.resolve(granted);
        if (rpcMethod === "permissionsIsShellEnabled")
          return Promise.resolve(true);
        if (rpcMethod === "permissionsGetPlatform")
          return Promise.resolve("darwin");
        return Promise.resolve(null);
      },
    );

    let first!: Promise<void>;
    let duplicate!: Promise<void>;
    act(() => {
      first = result.current.handleRequest("accessibility");
      duplicate = result.current.handleRequest("accessibility");
    });

    expect(result.current.busyPermissionId).toBe("accessibility");
    expect(
      mocks.invokeDesktopBridgeRequest.mock.calls.filter(
        ([requestArgs]) => requestArgs.rpcMethod === "permissionsRequest",
      ),
    ).toHaveLength(1);

    await act(async () => {
      request.resolve(granted.accessibility);
      await Promise.all([first, duplicate]);
    });
    await waitFor(() => expect(result.current.busyPermissionId).toBeNull());
    expect(result.current.permissions?.accessibility.status).toBe("granted");
  });

  it("defers passive bridge events until the owned OS request is reconciled", async () => {
    const { result } = renderHook(() => useDesktopPermissionsState());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const request = deferred<PermissionState>();
    const granted = permissionSnapshot("granted");
    let getAllCalls = 0;
    mocks.invokeDesktopBridgeRequest.mockImplementation(
      ({ rpcMethod }: { rpcMethod: string }) => {
        if (rpcMethod === "permissionsRequest") return request.promise;
        if (rpcMethod === "permissionsGetAll") {
          getAllCalls += 1;
          return Promise.resolve(granted);
        }
        if (rpcMethod === "permissionsIsShellEnabled")
          return Promise.resolve(true);
        if (rpcMethod === "permissionsGetPlatform")
          return Promise.resolve("darwin");
        return Promise.resolve(null);
      },
    );

    let operation!: Promise<void>;
    act(() => {
      operation = result.current.handleRequest("accessibility");
      mocks.permissionChangedListener?.();
      window.dispatchEvent(new Event("focus"));
    });
    expect(getAllCalls).toBe(0);

    await act(async () => {
      request.resolve(granted.accessibility);
      await operation;
    });
    await waitFor(() => expect(getAllCalls).toBe(1));
    expect(result.current.permissions?.accessibility.status).toBe("granted");
  });

  it("runs one authoritative refresh when the OS changes before the request rejects", async () => {
    const { result } = renderHook(() => useDesktopPermissionsState());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const request = deferred<PermissionState>();
    const granted = permissionSnapshot("granted");
    let getAllCalls = 0;
    mocks.invokeDesktopBridgeRequest.mockImplementation(
      ({ rpcMethod }: { rpcMethod: string }) => {
        if (rpcMethod === "permissionsRequest") return request.promise;
        if (rpcMethod === "permissionsGetAll") {
          getAllCalls += 1;
          return Promise.resolve(granted);
        }
        if (rpcMethod === "permissionsIsShellEnabled")
          return Promise.resolve(true);
        if (rpcMethod === "permissionsGetPlatform")
          return Promise.resolve("darwin");
        return Promise.resolve(null);
      },
    );

    let operation!: Promise<void>;
    act(() => {
      operation = result.current.handleRequest("accessibility");
      mocks.permissionChangedListener?.();
      window.dispatchEvent(new Event("focus"));
    });
    expect(getAllCalls).toBe(0);

    await act(async () => {
      request.reject(new Error("native request rejected after mutation"));
      await operation;
    });

    await waitFor(() => expect(result.current.busyPermissionId).toBeNull());
    expect(getAllCalls).toBe(1);
    expect(result.current.permissions?.accessibility.status).toBe("granted");
    expect(
      mocks.invokeDesktopBridgeRequest.mock.calls.filter(
        ([requestArgs]) => requestArgs.rpcMethod === "permissionsRequest",
      ),
    ).toHaveLength(1);
  });
});
