/**
 * Exercises the browser fallback's permission, snapshot, monitoring, and
 * idempotent release contracts without standing in for either native bridge.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { MobileSignalsWeb } from "./web";

function setNavigator(value: Partial<Navigator>): void {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value,
  });
}

function setDocument(value: Partial<Document>): void {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value,
  });
}

describe("MobileSignalsWeb fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns unavailable permission details without native access", async () => {
    setNavigator({ userAgent: "Mozilla/5.0 (iPhone)" });

    await expect(
      new MobileSignalsWeb().checkPermissions(),
    ).resolves.toMatchObject({
      status: "not-applicable",
      canRequest: false,
      canOpenSettings: false,
      engine: "web-fallback",
      capabilities: {
        health: false,
        screenTime: false,
        notifications: false,
        settings: false,
      },
      screenTime: {
        supported: false,
        authorization: {
          status: "unavailable",
          canRequest: false,
        },
      },
    });
  });

  it("normalizes known settings targets and rejects hostile targets", async () => {
    const plugin = new MobileSignalsWeb();

    await expect(
      plugin.openSettings({ target: "screenTime" }),
    ).resolves.toMatchObject({
      opened: false,
      target: "screenTime",
      actualTarget: "app",
    });
    await expect(
      plugin.openSettings({ target: "__proto__" as never }),
    ).rejects.toThrow("target must be a valid mobile settings target");
  });

  it("builds snapshots from visibility, focus, platform, and clamped battery data", async () => {
    setNavigator({
      userAgent: "Mozilla/5.0 (Linux; Android 15)",
      getBattery: vi.fn(async () => ({ charging: false, level: 1.5 })),
    } as Partial<Navigator>);
    setDocument({
      visibilityState: "visible",
      hasFocus: vi.fn(() => true),
    });

    await expect(new MobileSignalsWeb().getSnapshot()).resolves.toMatchObject({
      supported: true,
      snapshot: {
        source: "mobile_device",
        platform: "android",
        state: "active",
        idleState: "active",
        onBattery: true,
        metadata: {
          batteryLevel: 1,
          isCharging: false,
          visibilityState: "visible",
          hasFocus: true,
        },
      },
      healthSnapshot: {
        source: "mobile_health",
        platform: "android",
        state: "idle",
      },
    });
  });

  it("degrades malformed or rejected battery API results to null metadata", async () => {
    setNavigator({
      userAgent: "Mozilla/5.0",
      getBattery: vi.fn(async () => {
        throw new Error("battery denied");
      }),
    } as Partial<Navigator>);
    setDocument({
      visibilityState: "hidden",
      hasFocus: vi.fn(() => false),
    });

    await expect(new MobileSignalsWeb().getSnapshot()).resolves.toMatchObject({
      snapshot: {
        platform: "web",
        state: "background",
        idleState: "idle",
        onBattery: null,
        metadata: {
          batteryLevel: null,
          isCharging: null,
        },
      },
    });
  });

  it("emits initial signals only when requested", async () => {
    setNavigator({ userAgent: "Mozilla/5.0" });
    setDocument({ visibilityState: "visible", hasFocus: vi.fn(() => true) });

    const plugin = new MobileSignalsWeb();
    const listener = vi.fn();
    await plugin.addListener("signal", listener);

    await plugin.startMonitoring({ emitInitial: false });
    expect(listener).not.toHaveBeenCalled();

    await plugin.startMonitoring({ emitInitial: true });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("reports release postconditions as satisfied when nothing remains", async () => {
    const plugin = new MobileSignalsWeb();

    await expect(plugin.stopMonitoring()).resolves.toEqual({ stopped: true });
    await expect(plugin.stopMonitoring()).resolves.toEqual({ stopped: true });
    await expect(plugin.releaseSignalListeners()).resolves.toEqual({
      removed: true,
    });
    await expect(plugin.cancelBackgroundRefresh()).resolves.toMatchObject({
      cancelled: true,
    });
    await expect(plugin.cancelBackgroundRefresh()).resolves.toMatchObject({
      cancelled: true,
    });
  });

  it("does not emit a stopped generation after its battery read resolves", async () => {
    let resolveFirstBattery:
      | ((battery: { charging: boolean; level: number }) => void)
      | undefined;
    const getBattery = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstBattery = resolve;
          }),
      )
      .mockResolvedValue({ charging: false, level: 0.8 });
    setNavigator({
      userAgent: "Mozilla/5.0",
      getBattery,
    } as Partial<Navigator>);
    setDocument({ visibilityState: "visible", hasFocus: vi.fn(() => true) });

    const plugin = new MobileSignalsWeb();
    const listener = vi.fn();
    await plugin.addListener("signal", listener);

    const firstStart = plugin.startMonitoring({ emitInitial: true });
    await vi.waitFor(() => expect(getBattery).toHaveBeenCalledTimes(1));
    await plugin.stopMonitoring();

    const secondStart = plugin.startMonitoring({ emitInitial: true });
    await secondStart;
    expect(listener).toHaveBeenCalledTimes(2);

    resolveFirstBattery?.({ charging: true, level: 0.4 });
    await expect(firstStart).resolves.toMatchObject({ enabled: false });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("confirms signal-listener removal before returning", async () => {
    setNavigator({ userAgent: "Mozilla/5.0" });
    setDocument({ visibilityState: "visible", hasFocus: vi.fn(() => true) });
    const plugin = new MobileSignalsWeb();
    const listener = vi.fn();
    await plugin.addListener("signal", listener);

    await expect(plugin.releaseSignalListeners()).resolves.toEqual({
      removed: true,
    });
    await plugin.startMonitoring({ emitInitial: true });

    expect(listener).not.toHaveBeenCalled();
  });
});
