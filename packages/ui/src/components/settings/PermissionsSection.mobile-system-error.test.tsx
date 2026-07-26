// @vitest-environment jsdom
/**
 * Verifies that mobile system-permission probe failures render as retryable
 * row errors and never fall back to the registry's promptable cache default.
 */
import type { IPermissionsRegistry, PermissionId } from "@elizaos/shared";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionState } from "../../api";

const registryMock = vi.hoisted(() => ({
  value: {} as IPermissionsRegistry,
}));
const mobileClientMock = vi.hoisted(() => ({
  openSettings: vi.fn(),
}));

vi.mock("../../platform/mobile-permissions-client", () => ({
  createMobileSignalsPermissionsRegistry: () => registryMock.value,
  openMobilePermissionSettings: mobileClientMock.openSettings,
}));

vi.mock("../../bridge/native-plugins", () => ({
  getMobileSignalsPlugin: () => ({}),
  getPushNotificationsPlugin: () => ({}),
}));

vi.mock("../../state", () => ({
  useAppSelector: (
    selector: (state: {
      t: (key: string, options?: { defaultValue?: string }) => string;
    }) => unknown,
  ) =>
    selector({
      t: (key, options) => options?.defaultValue ?? key,
    }),
}));

import { MobileSystemPermissionsPanel } from "./PermissionsSection";

function stateFor(id: PermissionId): PermissionState {
  return {
    id,
    status: "not-determined",
    lastChecked: 1,
    canRequest: true,
    platform: "web",
  };
}

beforeEach(() => {
  mobileClientMock.openSettings.mockReset();
  mobileClientMock.openSettings.mockResolvedValue({
    opened: true,
    target: "app",
    actualTarget: "app",
    reason: null,
  });
  let cameraChecks = 0;
  registryMock.value = {
    get: vi.fn((id) => stateFor(id)),
    check: vi.fn(async (id) => {
      if (id === "camera" && cameraChecks++ === 0) {
        throw new Error("native camera probe failed");
      }
      return stateFor(id);
    }),
    request: vi.fn(async (id) => stateFor(id)),
    openSettings: vi.fn(async () => false),
    recordBlock: vi.fn(),
    list: vi.fn(() => []),
    pending: vi.fn(() => []),
    subscribe: vi.fn(() => () => {}),
    registerProber: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MobileSystemPermissionsPanel probe errors", () => {
  it("renders a failed row with Retry and replaces it only after a real check succeeds", async () => {
    render(<MobileSystemPermissionsPanel />);

    const error = await screen.findByTestId("mobile-permission-error-camera");
    expect(error.textContent).toContain(
      "The current permission state could not be read.",
    );
    expect(
      screen.queryByRole("button", { name: "Check Access Camera" }),
    ).toBeNull();
    expect(registryMock.value.get).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Retry Camera permission check",
      }),
    );

    await waitFor(() =>
      expect(screen.queryByTestId("mobile-permission-error-camera")).toBeNull(),
    );
    expect(
      screen.getByRole("button", { name: "Check Access Camera" }),
    ).toBeTruthy();
  });

  it("renders opened false as a settings error instead of refreshing cached state", async () => {
    registryMock.value.check = vi.fn(
      async (id): Promise<PermissionState> =>
        id === "camera"
          ? {
              ...stateFor(id),
              status: "denied",
              canRequest: false,
            }
          : stateFor(id),
    );
    mobileClientMock.openSettings.mockResolvedValueOnce({
      opened: false,
      target: "app",
      actualTarget: "app",
      reason: "No settings route is available.",
    });

    render(<MobileSystemPermissionsPanel />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Open Settings Camera" }),
    );

    const error = await screen.findByTestId("mobile-permission-error-camera");
    expect(error.textContent).toContain("Settings could not be opened.");
    expect(mobileClientMock.openSettings).toHaveBeenCalledWith("camera");
  });

  it("does not issue duplicate native requests while the first OS prompt is pending", async () => {
    registryMock.value.check = vi.fn(async (id) => stateFor(id));
    let finishRequest: ((state: PermissionState) => void) | undefined;
    registryMock.value.request = vi.fn(
      (id) =>
        new Promise<PermissionState>((resolve) => {
          finishRequest = resolve;
          expect(id).toBe("camera");
        }),
    );
    render(<MobileSystemPermissionsPanel />);

    const cameraButton = await screen.findByRole("button", {
      name: "Check Access Camera",
    });
    fireEvent.click(cameraButton);
    fireEvent.click(cameraButton);

    expect(registryMock.value.request).toHaveBeenCalledTimes(1);
    expect((cameraButton as HTMLButtonElement).disabled).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Refresh mobile system permissions",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    await act(async () => {
      if (!finishRequest)
        throw new Error("Native permission request did not start");
      finishRequest(stateFor("camera"));
    });
    await waitFor(() =>
      expect((cameraButton as HTMLButtonElement).disabled).toBe(false),
    );
  });
});
