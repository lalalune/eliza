// @vitest-environment jsdom
//
// Three-state guard for the mobile-signals permissions panel (#12784): when
// the plugin is present but its permissions probe throws, the panel must
// render an explicit error row — not disappear like the designed "plugin not
// on this platform" degrade. The designed-hidden state (no checkPermissions
// on this build) still renders nothing.

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileSignalsPermissionStatus } from "../../bridge/native-plugins";

const pluginMock = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));

vi.mock("../../bridge/native-plugins", () => ({
  getMobileSignalsPlugin: () => pluginMock.value,
  // The push-registration module (pulled in transitively by the settings tree)
  // reads this at import time; the full-module mock must expose it or vitest
  // throws "No getPushNotificationsPlugin export is defined on the mock".
  getPushNotificationsPlugin: () => ({}),
}));

vi.mock("../../state", () => ({
  useAppSelector: (
    selector: (s: {
      t: (key: string, options?: { defaultValue?: string }) => string;
    }) => unknown,
  ) =>
    selector({
      t: (_key, options) => options?.defaultValue ?? _key,
    }),
}));

// The panel pulls SettingsGroup/SettingsActionButton for the success render;
// they render fine in jsdom, so only the data seams above are mocked.

import { MobileSignalsPermissionsPanel } from "./PermissionsSection";

const grantedStatus: MobileSignalsPermissionStatus = {
  status: "granted",
  canRequest: false,
  screenTime: {
    supported: false,
    requirements: {
      entitlements: { familyControls: "" },
      frameworks: [],
      deviceActivityReportExtension: false,
      deviceActivityMonitorExtension: false,
    },
    entitlements: { familyControls: false },
    provisioning: {
      satisfied: false,
      inspected: "not-inspectable",
      reason: null,
    },
    authorization: { status: "unavailable", canRequest: false },
    reportAvailable: false,
    coarseSummaryAvailable: false,
    thresholdEventsAvailable: false,
    rawUsageExportAvailable: false,
    reason: null,
  },
  setupActions: [],
  permissions: { sleep: true, biometrics: true },
};

const determinedStatus: MobileSignalsPermissionStatus = {
  ...grantedStatus,
  status: "determined",
  canRequest: false,
  setupActions: [
    {
      id: "health_permissions",
      label: "HealthKit",
      status: "ready",
      canRequest: true,
      canOpenSettings: true,
      settingsTarget: "health",
      reason:
        "iOS keeps individual HealthKit read grants private; monitoring queries return only authorized data.",
    },
  ],
  permissions: { sleep: false, biometrics: false },
};

beforeEach(() => {
  pluginMock.value = {};
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MobileSignalsPermissionsPanel three-state rendering", () => {
  it("renders nothing when the plugin does not expose checkPermissions (designed degrade)", async () => {
    pluginMock.value = {};

    const { container } = render(<MobileSignalsPermissionsPanel />);

    await waitFor(() =>
      expect(screen.queryByText("Loading permissions...")).toBeNull(),
    );
    expect(screen.queryByTestId("mobile-signals-permissions-error")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("renders the explicit error row when the permissions probe throws", async () => {
    const checkPermissions = vi
      .fn()
      .mockRejectedValueOnce(new Error("bridge exploded"))
      .mockResolvedValueOnce(grantedStatus);
    pluginMock.value = {
      checkPermissions,
    };

    render(<MobileSignalsPermissionsPanel />);

    await waitFor(() =>
      expect(
        screen.getByTestId("mobile-signals-permissions-error"),
      ).not.toBeNull(),
    );
    expect(
      screen.getByTestId("mobile-signals-permissions-error").textContent,
    ).toContain("Could not read device permissions.");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Retry mobile signals permission check",
      }),
    );
    await waitFor(() =>
      expect(screen.getByText("LifeOps Signals")).not.toBeNull(),
    );
    expect(checkPermissions).toHaveBeenCalledTimes(2);
  });

  it("renders the panel when the probe resolves", async () => {
    pluginMock.value = {
      checkPermissions: vi.fn().mockResolvedValue(grantedStatus),
    };

    render(<MobileSignalsPermissionsPanel />);

    await waitFor(() =>
      expect(screen.getByText("LifeOps Signals")).not.toBeNull(),
    );
    expect(screen.queryByTestId("mobile-signals-permissions-error")).toBeNull();
  });

  it("renders raw determined HealthKit choices as neutral and settings-managed", async () => {
    const requestPermissions = vi.fn().mockResolvedValue(determinedStatus);
    const openSettings = vi.fn().mockResolvedValue({ opened: true });
    pluginMock.value = {
      checkPermissions: vi.fn().mockResolvedValue(determinedStatus),
      requestPermissions,
      openSettings,
    };

    render(<MobileSignalsPermissionsPanel />);

    await waitFor(() => expect(screen.getByText("Choices set")).toBeTruthy());
    expect(screen.queryByText("Ready")).toBeNull();
    expect(
      screen.getByText(/iOS keeps individual HealthKit read choices private/),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Manage HealthKit" }));

    await waitFor(() =>
      expect(openSettings).toHaveBeenCalledWith({ target: "health" }),
    );
    expect(requestPermissions).not.toHaveBeenCalled();
  });

  it("renders opened false from the HealthKit settings action as retryable failure", async () => {
    const requestPermissions = vi.fn().mockResolvedValue(determinedStatus);
    const openSettings = vi.fn().mockResolvedValue({
      opened: false,
      target: "health",
      actualTarget: "app",
      reason: "Health settings could not be opened.",
    });
    pluginMock.value = {
      checkPermissions: vi.fn().mockResolvedValue(determinedStatus),
      requestPermissions,
      openSettings,
    };

    render(<MobileSignalsPermissionsPanel />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Manage HealthKit" }),
    );

    const error = await screen.findByTestId("mobile-signals-action-error");
    expect(error.textContent).toContain("Could not update HealthKit");
    expect(openSettings).toHaveBeenCalledWith({ target: "health" });
    expect(requestPermissions).not.toHaveBeenCalled();
  });

  it("does not open duplicate native settings sheets while Manage is pending", async () => {
    let finishOpen: ((result: { opened: boolean }) => void) | undefined;
    const openSettings = vi.fn(
      () =>
        new Promise<{ opened: boolean }>((resolve) => {
          finishOpen = resolve;
        }),
    );
    pluginMock.value = {
      checkPermissions: vi.fn().mockResolvedValue(determinedStatus),
      requestPermissions: vi.fn(),
      openSettings,
    };
    render(<MobileSignalsPermissionsPanel />);

    const manage = await screen.findByRole("button", {
      name: "Manage HealthKit",
    });
    fireEvent.click(manage);
    fireEvent.click(manage);

    expect((manage as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(openSettings).toHaveBeenCalledTimes(1));

    await act(async () => {
      if (!finishOpen)
        throw new Error("Native settings operation did not start");
      finishOpen({ opened: true });
    });
    await waitFor(() =>
      expect((manage as HTMLButtonElement).disabled).toBe(false),
    );
  });
});
