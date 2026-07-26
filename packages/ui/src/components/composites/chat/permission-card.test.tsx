// @vitest-environment jsdom
/**
 * Renders PermissionCard in jsdom against a stub permissions registry to cover
 * each permission state (including OS-private choices) and its CTA, plus the
 * visible retry contract for failed initial probes, requests, and rechecks.
 */
import type {
  IPermissionsRegistry,
  PermissionId,
  PermissionState,
} from "@elizaos/shared";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PermissionCard } from "./permission-card";
import { parsePermissionRequestFromText } from "./permission-card.helpers";

afterEach(() => {
  cleanup();
});

function makeRegistry(
  initial: PermissionState,
  overrides: Partial<IPermissionsRegistry> = {},
): IPermissionsRegistry {
  return {
    get: vi.fn(() => initial),
    check: vi.fn(async () => initial),
    request: vi.fn(async () => initial),
    recordBlock: vi.fn(),
    list: vi.fn(() => [initial]),
    pending: vi.fn(() => []),
    subscribe: vi.fn(() => () => {}),
    registerProber: vi.fn(),
    ...overrides,
    openSettings: overrides.openSettings ?? vi.fn(async () => false),
  };
}

function state(
  overrides: Omit<PermissionState, "platform"> &
    Partial<Pick<PermissionState, "platform">>,
): PermissionState {
  return { platform: "darwin", ...overrides };
}

const baseProps = {
  permission: "reminders" as PermissionId,
  reason: "I'd like to add 'pick up groceries' to your Apple Reminders.",
  feature: "lifeops.reminders.create",
};

describe("PermissionCard", () => {
  it("renders the friendly title and reason for not-determined state", () => {
    render(
      <PermissionCard
        {...baseProps}
        initialState={{
          id: "reminders",
          status: "not-determined",
          lastChecked: 0,
          canRequest: true,
          platform: "darwin",
        }}
      />,
    );
    expect(screen.getByText("Apple Reminders")).toBeTruthy();
    expect(screen.getByText(baseProps.reason)).toBeTruthy();
    expect(
      (screen.getByTestId("permission-card-primary") as HTMLButtonElement)
        .textContent,
    ).toContain("Grant access");
  });

  it("calls registry.request and reports granted on success", async () => {
    const grantedState: PermissionState = state({
      id: "reminders",
      status: "granted",
      lastChecked: 1,
      canRequest: false,
    });
    const registry = makeRegistry(
      state({
        id: "reminders",
        status: "not-determined",
        lastChecked: 0,
        canRequest: true,
      }),
      { request: vi.fn(async () => grantedState) },
    );
    const onGranted = vi.fn();
    render(
      <PermissionCard
        {...baseProps}
        registry={registry}
        onGranted={onGranted}
      />,
    );

    const btn = screen.getByTestId(
      "permission-card-primary",
    ) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false));
    fireEvent.click(btn);
    // findByTestId waits for the granted confirmation to appear after the
    // async request resolves and the component re-renders.
    await screen.findByTestId("permission-card-granted");

    expect(registry.request).toHaveBeenCalledWith("reminders", {
      reason: baseProps.reason,
      feature: { app: "lifeops", action: "reminders.create" },
    });
    expect(onGranted).toHaveBeenCalledWith(grantedState);
  });

  it("renders 'Open System Settings' when denied and canRequest is false", () => {
    render(
      <PermissionCard
        {...baseProps}
        initialState={{
          id: "reminders",
          status: "denied",
          lastChecked: 0,
          canRequest: false,
          platform: "darwin",
        }}
      />,
    );
    expect(
      (screen.getByTestId("permission-card-primary") as HTMLButtonElement)
        .textContent,
    ).toContain("Open System Settings");
  });

  it("opens settings when not-determined cannot be requested directly", () => {
    const onOpenSettings = vi.fn();
    render(
      <PermissionCard
        {...baseProps}
        permission="screentime"
        initialState={{
          id: "screentime",
          status: "not-determined",
          lastChecked: 0,
          canRequest: false,
          platform: "darwin",
        }}
        onOpenSettings={onOpenSettings}
      />,
    );
    const button = screen.getByTestId(
      "permission-card-primary",
    ) as HTMLButtonElement;
    expect(button.textContent).toContain("Open System Settings");
    fireEvent.click(button);
    expect(onOpenSettings).toHaveBeenCalledWith("screentime");
  });

  it("renders a retryable settings error when native settings reports opened false", async () => {
    const onOpenSettings = vi.fn(async () => ({
      opened: false,
      reason: "No settings route is available.",
    }));
    render(
      <PermissionCard
        {...baseProps}
        permission="screentime"
        initialState={{
          id: "screentime",
          status: "denied",
          lastChecked: 0,
          canRequest: false,
          platform: "ios",
        }}
        onOpenSettings={onOpenSettings}
      />,
    );

    fireEvent.click(screen.getByTestId("permission-card-primary"));

    expect(
      (await screen.findByTestId("permission-card-error")).textContent,
    ).toContain("could not be opened");
    expect(screen.getByTestId("permission-card-primary").textContent).toContain(
      "Open System Settings",
    );
  });

  it("serializes settings navigation so rapid clicks cannot open two native sheets", async () => {
    let finishOpen: ((result: { opened: boolean }) => void) | undefined;
    const onOpenSettings = vi.fn(
      () =>
        new Promise<{ opened: boolean }>((resolve) => {
          finishOpen = resolve;
        }),
    );
    render(
      <PermissionCard
        {...baseProps}
        initialState={{
          id: "reminders",
          status: "denied",
          lastChecked: 0,
          canRequest: false,
          platform: "ios",
        }}
        onOpenSettings={onOpenSettings}
      />,
    );

    const primary = screen.getByTestId(
      "permission-card-primary",
    ) as HTMLButtonElement;
    fireEvent.click(primary);
    fireEvent.click(primary);

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(primary.disabled).toBe(true);
    await act(async () => {
      finishOpen?.({ opened: true });
    });
    expect(primary.disabled).toBe(false);
  });

  it("does not admit Grant while a deferred permission check owns the card", async () => {
    const notDetermined = state({
      id: "reminders",
      status: "not-determined",
      lastChecked: 0,
      canRequest: true,
    });
    const granted = state({
      id: "reminders",
      status: "granted",
      lastChecked: 1,
      canRequest: false,
    });
    let finishCheck: ((next: PermissionState) => void) | undefined;
    const check = vi
      .fn<IPermissionsRegistry["check"]>()
      .mockResolvedValueOnce(notDetermined)
      .mockImplementationOnce(
        () =>
          new Promise<PermissionState>((resolve) => {
            finishCheck = resolve;
          }),
      );
    const request = vi.fn(async () => granted);
    const registry = makeRegistry(notDetermined, { check, request });
    render(<PermissionCard {...baseProps} registry={registry} />);

    const primary = screen.getByTestId(
      "permission-card-primary",
    ) as HTMLButtonElement;
    await waitFor(() => expect(primary.disabled).toBe(false));
    fireEvent.click(screen.getByTestId("permission-card-check-again"));
    expect(primary.disabled).toBe(true);

    fireEvent.click(primary);
    expect(request).not.toHaveBeenCalled();

    await act(async () => {
      finishCheck?.(notDetermined);
    });
    await waitFor(() => expect(primary.disabled).toBe(false));
    fireEvent.click(primary);

    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  });

  it("renders private Health choices as settings-managed and never requests again", async () => {
    const opaqueState: PermissionState = state({
      id: "health",
      status: "opaque",
      lastChecked: 1,
      canRequest: true,
      platform: "ios",
    });
    const request = vi.fn(async () => opaqueState);
    const registry = makeRegistry(opaqueState, { request });
    const onOpenSettings = vi.fn();

    render(
      <PermissionCard
        {...baseProps}
        permission="health"
        registry={registry}
        initialState={opaqueState}
        onOpenSettings={onOpenSettings}
      />,
    );

    expect(screen.getByText("Choices set")).toBeTruthy();
    expect(
      screen.getByText(/iOS keeps individual HealthKit read choices private/),
    ).toBeTruthy();
    const button = screen.getByTestId(
      "permission-card-primary",
    ) as HTMLButtonElement;
    expect(button.textContent).toContain("Manage access");
    await waitFor(() => expect(button.disabled).toBe(false));

    fireEvent.click(button);

    await waitFor(() => expect(onOpenSettings).toHaveBeenCalledWith("health"));
    expect(request).not.toHaveBeenCalled();
  });

  it("renders disabled 'Coming soon' when restricted by entitlement", () => {
    render(
      <PermissionCard
        {...baseProps}
        permission="health"
        initialState={{
          id: "health",
          status: "restricted",
          restrictedReason: "entitlement_required",
          lastChecked: 0,
          canRequest: false,
          platform: "darwin",
        }}
      />,
    );
    const btn = screen.getByTestId(
      "permission-card-primary",
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain("Coming soon");
    expect(
      screen.getByText(/requires an app entitlement that is not available/),
    ).toBeTruthy();
  });

  it("renders unavailable for platform-unsupported restricted permissions", () => {
    render(
      <PermissionCard
        {...baseProps}
        permission="health"
        initialState={{
          id: "health",
          status: "restricted",
          restrictedReason: "platform_unsupported",
          lastChecked: 0,
          canRequest: false,
          platform: "darwin",
        }}
      />,
    );
    const btn = screen.getByTestId(
      "permission-card-primary",
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain("Unavailable on this platform");
    expect(
      screen.getByText("Apple Health is not available on this platform."),
    ).toBeTruthy();
  });

  it("renders an OS-policy restriction as settings-managed, not unavailable", () => {
    const onOpenSettings = vi.fn();
    render(
      <PermissionCard
        {...baseProps}
        permission="health"
        initialState={{
          id: "health",
          status: "restricted",
          restrictedReason: "os_policy",
          lastChecked: 0,
          canRequest: false,
          platform: "ios",
        }}
        onOpenSettings={onOpenSettings}
      />,
    );

    const button = screen.getByTestId(
      "permission-card-primary",
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain("Open System Settings");
    expect(
      screen.getByText(/controlled by the current OS or administrator policy/),
    ).toBeTruthy();
    fireEvent.click(button);
    expect(onOpenSettings).toHaveBeenCalledWith("health");
  });

  it("auto-collapses to 'Access granted' when initial state is granted", () => {
    render(
      <PermissionCard
        {...baseProps}
        initialState={{
          id: "reminders",
          status: "granted",
          lastChecked: 0,
          canRequest: false,
          platform: "darwin",
        }}
      />,
    );
    expect(screen.getByTestId("permission-card-granted")).toBeTruthy();
    expect(screen.queryByTestId("permission-card")).toBeNull();
  });

  it("dismisses on 'Not now'", () => {
    const onDismiss = vi.fn();
    render(
      <PermissionCard
        {...baseProps}
        initialState={{
          id: "reminders",
          status: "not-determined",
          lastChecked: 0,
          canRequest: true,
          platform: "darwin",
        }}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByTestId("permission-card-dismiss"));
    expect(onDismiss).toHaveBeenCalled();
    expect(screen.queryByTestId("permission-card")).toBeNull();
  });

  it("does not report a late grant after the user dismisses the card", async () => {
    const notDetermined = state({
      id: "reminders",
      status: "not-determined",
      lastChecked: 0,
      canRequest: true,
    });
    const granted = state({
      id: "reminders",
      status: "granted",
      lastChecked: 1,
      canRequest: false,
    });
    let finishRequest: ((result: PermissionState) => void) | undefined;
    const request = vi.fn(
      () =>
        new Promise<PermissionState>((resolve) => {
          finishRequest = resolve;
        }),
    );
    const registry = makeRegistry(notDetermined, { request });
    const onGranted = vi.fn();
    render(
      <PermissionCard
        {...baseProps}
        registry={registry}
        onGranted={onGranted}
      />,
    );
    await waitFor(() => expect(registry.check).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("permission-card-primary"));
    await waitFor(() => expect(request).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("permission-card-dismiss"));
    await act(async () => {
      finishRequest?.(granted);
    });

    expect(onGranted).not.toHaveBeenCalled();
    expect(screen.queryByTestId("permission-card")).toBeNull();
  });

  it("emits fallback choice when offered and clicked", () => {
    const onFallback = vi.fn();
    render(
      <PermissionCard
        {...baseProps}
        fallbackOffered
        fallbackLabel="Use internal reminders instead"
        initialState={{
          id: "reminders",
          status: "not-determined",
          lastChecked: 0,
          canRequest: true,
          platform: "darwin",
        }}
        onFallback={onFallback}
      />,
    );
    fireEvent.click(screen.getByTestId("permission-card-fallback"));
    expect(onFallback).toHaveBeenCalledWith({
      type: "use_fallback",
      feature: "lifeops.reminders.create",
      permission: "reminders",
    });
    expect(screen.queryByTestId("permission-card")).toBeNull();
  });

  it("parsePermissionRequestFromText extracts fenced permission_request", () => {
    const text =
      "I can add that.\n```json\n" +
      '{"action":"permission_request","reasoning":"x","permission":"reminders","reason":"add groceries","feature":"lifeops.reminders.create","fallback_offered":true,"fallback_label":"Use internal reminders"}' +
      "\n```";
    const result = parsePermissionRequestFromText(text);
    expect(result).not.toBeNull();
    expect(result?.display).toBe("I can add that.");
    expect(result?.payload.permission).toBe("reminders");
    expect(result?.payload.fallbackOffered).toBe(true);
    expect(result?.payload.fallbackLabel).toBe("Use internal reminders");
  });

  it("parsePermissionRequestFromText returns null for non-permission actions", () => {
    expect(
      parsePermissionRequestFromText(
        '```json\n{"action":"respond","reasoning":"x","response":"hi"}\n```',
      ),
    ).toBeNull();
  });

  it("hides fallback button when fallbackOffered is false", () => {
    render(
      <PermissionCard
        {...baseProps}
        initialState={{
          id: "reminders",
          status: "not-determined",
          lastChecked: 0,
          canRequest: true,
          platform: "darwin",
        }}
      />,
    );
    expect(screen.queryByTestId("permission-card-fallback")).toBeNull();
  });

  it("surfaces an initial probe failure and clears it after a successful retry", async () => {
    const notDetermined = state({
      id: "reminders",
      status: "not-determined",
      lastChecked: 0,
      canRequest: true,
    });
    const check = vi
      .fn<IPermissionsRegistry["check"]>()
      .mockRejectedValueOnce(new Error("native probe failed"))
      .mockResolvedValue(notDetermined);
    const registry = makeRegistry(notDetermined, { check });

    render(<PermissionCard {...baseProps} registry={registry} />);

    expect(
      (await screen.findByTestId("permission-card-error")).textContent,
    ).toContain("could not be read");
    expect(screen.getByTestId("permission-card-primary").textContent).toContain(
      "Retry check",
    );
    fireEvent.click(screen.getByTestId("permission-card-primary"));

    await waitFor(() =>
      expect(screen.queryByTestId("permission-card-error")).toBeNull(),
    );
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("surfaces a failed request and lets the user retry the request", async () => {
    const notDetermined = state({
      id: "reminders",
      status: "not-determined",
      lastChecked: 0,
      canRequest: true,
    });
    const granted = state({
      id: "reminders",
      status: "granted",
      lastChecked: 2,
      canRequest: false,
    });
    const request = vi
      .fn<IPermissionsRegistry["request"]>()
      .mockRejectedValueOnce(new Error("request transport failed"))
      .mockResolvedValue(granted);
    const registry = makeRegistry(notDetermined, { request });

    render(<PermissionCard {...baseProps} registry={registry} />);

    const primary = screen.getByTestId(
      "permission-card-primary",
    ) as HTMLButtonElement;
    await waitFor(() => expect(primary.disabled).toBe(false));
    fireEvent.click(primary);
    expect(
      (await screen.findByTestId("permission-card-error")).textContent,
    ).toContain("request failed");
    await waitFor(() => expect(primary.disabled).toBe(false));
    fireEvent.click(primary);

    await screen.findByTestId("permission-card-granted");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("surfaces a failed recheck and preserves the same retry control", async () => {
    const notDetermined = state({
      id: "reminders",
      status: "not-determined",
      lastChecked: 0,
      canRequest: true,
    });
    const check = vi
      .fn<IPermissionsRegistry["check"]>()
      .mockResolvedValueOnce(notDetermined)
      .mockRejectedValueOnce(new Error("recheck failed"))
      .mockResolvedValue(notDetermined);
    const registry = makeRegistry(notDetermined, { check });

    render(<PermissionCard {...baseProps} registry={registry} />);
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId("permission-card-check-again"));
    expect(
      (await screen.findByTestId("permission-card-error")).textContent,
    ).toContain("could not be read");
    fireEvent.click(screen.getByTestId("permission-card-primary"));

    await waitFor(() =>
      expect(screen.queryByTestId("permission-card-error")).toBeNull(),
    );
    expect(check).toHaveBeenCalledTimes(3);
  });
});
