// @vitest-environment jsdom
//
// usePermissionPriming sequencing: mount-time status check skips already-granted
// items, "Enable" fires exactly one OS request (soft-ask), failures remain
// separate from OS status with retry paths, and the sequence completes. The
// permissions client (`getPermission`/`requestPermission`) is mocked; the hook is real.
import type {
  PermissionId,
  PermissionState,
  PermissionStatus,
} from "@elizaos/shared/contracts/permissions";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPermission: vi.fn(),
  requestPermission: vi.fn(),
  openPermissionSettings: vi.fn(async () => undefined),
}));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    client: {
      getPermission: mocks.getPermission,
      requestPermission: mocks.requestPermission,
      openPermissionSettings: mocks.openPermissionSettings,
    },
  };
});

import { usePermissionPriming } from "./use-permission-priming";

function state(
  id: PermissionId,
  status: PermissionStatus,
  canRequest = status === "not-determined",
): PermissionState {
  return { id, status, canRequest, platform: "web", lastChecked: 0 };
}

/** Route getPermission by id from a status map. */
function seedStatuses(map: Partial<Record<PermissionId, PermissionStatus>>) {
  mocks.getPermission.mockImplementation(async (id: PermissionId) =>
    state(id, map[id] ?? "not-determined"),
  );
}

const IDS: PermissionId[] = ["microphone", "location", "notifications"];

afterEach(() => {
  vi.clearAllMocks();
});

describe("usePermissionPriming", () => {
  it("checks on mount without prompting and drops already-granted ids", async () => {
    seedStatuses({
      microphone: "granted",
      location: "not-determined",
      notifications: "granted",
    });

    const { result } = renderHook(() => usePermissionPriming(IDS));
    await waitFor(() => expect(result.current.ready).toBe(true));

    // Mount only checks; it must never request.
    expect(mocks.requestPermission).not.toHaveBeenCalled();
    // Granted ids are excluded; only location remains.
    expect(result.current.items.map((i) => i.id)).toEqual(["location"]);
    expect(result.current.active?.id).toBe("location");
    expect(result.current.totalSteps).toBe(1);
    expect(result.current.done).toBe(false);
  });

  it("is done immediately when everything is already granted", async () => {
    seedStatuses({
      microphone: "granted",
      location: "granted",
      notifications: "granted",
    });
    const { result } = renderHook(() => usePermissionPriming(IDS));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.items).toHaveLength(0);
    expect(result.current.active).toBeNull();
    expect(result.current.done).toBe(true);
  });

  it("skips a privacy-opaque permission without re-prompting", async () => {
    seedStatuses({ health: "opaque" });

    const { result } = renderHook(() => usePermissionPriming(["health"]));
    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(result.current.items).toHaveLength(0);
    expect(result.current.done).toBe(true);
    expect(mocks.requestPermission).not.toHaveBeenCalled();
  });

  it("renders a failed initial probe without fabricating a promptable status", async () => {
    mocks.getPermission.mockImplementation(async (id: PermissionId) => {
      if (id === "microphone") throw new Error("bridge unavailable");
      return state(id, "granted", false);
    });

    const { result } = renderHook(() => usePermissionPriming(IDS));
    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(result.current.active).toMatchObject({
      id: "microphone",
      status: null,
      canRequest: false,
      error: { operation: "check" },
    });
    expect(mocks.requestPermission).not.toHaveBeenCalled();

    mocks.getPermission.mockResolvedValue(
      state("microphone", "granted", false),
    );
    await act(async () => {
      await result.current.recheck("microphone");
    });
    expect(result.current.done).toBe(true);
  });

  it("fires the OS request only on request(), resolves + advances on grant", async () => {
    seedStatuses({
      microphone: "not-determined",
      location: "not-determined",
      notifications: "not-determined",
    });
    mocks.requestPermission.mockImplementation(async (id: PermissionId) =>
      state(id, "granted", false),
    );

    const { result } = renderHook(() => usePermissionPriming(IDS));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.active?.id).toBe("microphone");

    await act(async () => {
      await result.current.request("microphone");
    });

    expect(mocks.requestPermission).toHaveBeenCalledWith("microphone");
    // Granted → resolved → advance to the next card.
    expect(result.current.active?.id).toBe("location");
    expect(result.current.currentStep).toBe(2);
  });

  it("resolves when an OS request returns a privacy-opaque decision", async () => {
    seedStatuses({ health: "not-determined" });
    mocks.requestPermission.mockResolvedValueOnce(
      state("health", "opaque", false),
    );

    const { result } = renderHook(() => usePermissionPriming(["health"]));
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      await result.current.request("health");
    });

    expect(result.current.items[0]).toMatchObject({
      id: "health",
      status: "opaque",
      canRequest: false,
      resolved: true,
    });
    expect(result.current.done).toBe(true);
  });

  it("keeps a denied card active with a recovery path, then skip advances", async () => {
    seedStatuses({ microphone: "not-determined" });
    mocks.getPermission.mockImplementation(async (id: PermissionId) =>
      state(id, id === "microphone" ? "not-determined" : "granted"),
    );
    mocks.requestPermission.mockResolvedValueOnce(
      state("microphone", "denied", false),
    );

    const { result } = renderHook(() => usePermissionPriming(IDS));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.items.map((i) => i.id)).toEqual(["microphone"]);

    await act(async () => {
      await result.current.request("microphone");
    });

    // Denied does NOT resolve — the card stays active so recovery can show.
    expect(result.current.active?.id).toBe("microphone");
    expect(result.current.active?.status).toBe("denied");
    expect(result.current.active?.canRequest).toBe(false);
    expect(result.current.done).toBe(false);

    act(() => result.current.skip("microphone"));
    expect(result.current.done).toBe(true);
  });

  it("surfaces a thrown request separately and retries without fabricating denial", async () => {
    seedStatuses({ microphone: "not-determined" });
    mocks.getPermission.mockImplementation(async (id: PermissionId) =>
      state(id, id === "microphone" ? "not-determined" : "granted"),
    );
    mocks.requestPermission.mockRejectedValueOnce(new Error("bridge down"));

    const { result } = renderHook(() => usePermissionPriming(IDS));
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      await result.current.request("microphone");
    });

    expect(result.current.active).toMatchObject({
      status: "not-determined",
      canRequest: true,
      requesting: false,
      error: { operation: "request" },
    });

    mocks.requestPermission.mockResolvedValueOnce(
      state("microphone", "granted", false),
    );
    await act(async () => {
      await result.current.request("microphone");
    });
    expect(result.current.done).toBe(true);
  });

  it("skipAll resolves everything at once", async () => {
    seedStatuses({
      microphone: "not-determined",
      location: "not-determined",
      notifications: "not-determined",
    });
    const { result } = renderHook(() => usePermissionPriming(IDS));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.totalSteps).toBe(3);

    act(() => result.current.skipAll());
    expect(result.current.done).toBe(true);
    expect(result.current.active).toBeNull();
    expect(mocks.requestPermission).not.toHaveBeenCalled();
  });

  it("keeps the sequence complete when an in-flight request settles after skipAll", async () => {
    seedStatuses({ microphone: "not-determined" });
    let finishRequest:
      | ((value: PermissionState | PromiseLike<PermissionState>) => void)
      | undefined;
    mocks.requestPermission.mockImplementationOnce(
      () =>
        new Promise<PermissionState>((resolve) => {
          finishRequest = resolve;
        }),
    );
    const { result } = renderHook(() => usePermissionPriming(["microphone"]));
    await waitFor(() => expect(result.current.ready).toBe(true));

    let pendingRequest: Promise<void> | undefined;
    act(() => {
      pendingRequest = result.current.request("microphone");
    });
    await waitFor(() => expect(mocks.requestPermission).toHaveBeenCalled());
    act(() => result.current.skipAll());
    await act(async () => {
      finishRequest?.(state("microphone", "granted", false));
      await pendingRequest;
    });

    expect(result.current.done).toBe(true);
    expect(result.current.active).toBeNull();
    expect(result.current.items[0]).toMatchObject({
      status: "not-determined",
      resolved: true,
    });
  });

  it("recheck reflects a permission granted out-of-band (e.g. via Settings)", async () => {
    seedStatuses({ microphone: "denied" });
    mocks.getPermission.mockImplementation(async (id: PermissionId) =>
      state(id, id === "microphone" ? "denied" : "granted"),
    );

    const { result } = renderHook(() => usePermissionPriming(IDS));
    await waitFor(() => expect(result.current.ready).toBe(true));
    // A denied id is still promptable-as-a-card (not satisfied), so it shows.
    expect(result.current.active?.id).toBe("microphone");

    mocks.getPermission.mockImplementation(async (id: PermissionId) =>
      state(id, "granted", false),
    );
    await act(async () => {
      await result.current.recheck("microphone");
    });
    expect(result.current.done).toBe(true);
  });

  it("keeps a failed recheck distinct from the last known denied state", async () => {
    seedStatuses({ microphone: "denied" });
    const { result } = renderHook(() => usePermissionPriming(["microphone"]));
    await waitFor(() => expect(result.current.ready).toBe(true));

    mocks.getPermission.mockRejectedValueOnce(new Error("probe timed out"));
    await act(async () => {
      await result.current.recheck("microphone");
    });

    expect(result.current.active).toMatchObject({
      status: "denied",
      error: { operation: "recheck" },
      resolved: false,
    });

    mocks.getPermission.mockResolvedValueOnce(
      state("microphone", "granted", false),
    );
    await act(async () => {
      await result.current.recheck("microphone");
    });
    expect(result.current.done).toBe(true);
  });

  it("renders and retries settings-navigation failures without changing status", async () => {
    seedStatuses({ microphone: "denied" });
    const { result } = renderHook(() => usePermissionPriming(["microphone"]));
    await waitFor(() => expect(result.current.ready).toBe(true));

    mocks.openPermissionSettings.mockRejectedValueOnce(
      new Error("settings bridge failed"),
    );
    await act(async () => {
      await result.current.openSettings("microphone");
    });
    expect(result.current.active).toMatchObject({
      status: "denied",
      error: { operation: "settings" },
      resolved: false,
    });

    await act(async () => {
      await result.current.openSettings("microphone");
    });
    expect(result.current.active?.status).toBe("denied");
    expect(result.current.active?.error).toBeUndefined();
  });

  it("ignores an operation result from an earlier id-list generation", async () => {
    seedStatuses({
      microphone: "not-determined",
      location: "not-determined",
    });
    let resolveOldRequest:
      | ((value: PermissionState | PromiseLike<PermissionState>) => void)
      | undefined;
    mocks.requestPermission.mockImplementationOnce(
      () =>
        new Promise<PermissionState>((resolve) => {
          resolveOldRequest = resolve;
        }),
    );
    const { result, rerender } = renderHook(
      ({ ids }: { ids: readonly PermissionId[] }) => usePermissionPriming(ids),
      { initialProps: { ids: ["microphone"] } },
    );
    await waitFor(() => expect(result.current.active?.id).toBe("microphone"));

    let oldRequest: Promise<void> | undefined;
    act(() => {
      oldRequest = result.current.request("microphone");
    });
    rerender({ ids: ["location"] });
    await waitFor(() => expect(result.current.active?.id).toBe("location"));

    await act(async () => {
      resolveOldRequest?.(state("microphone", "granted", false));
      await oldRequest;
    });

    expect(result.current.items).toHaveLength(1);
    expect(result.current.active).toMatchObject({
      id: "location",
      status: "not-determined",
      resolved: false,
    });
  });
});
