// @vitest-environment jsdom
/**
 * Verifies the chat permission-card boundary passes native settings outcomes
 * through to the card instead of treating a fulfilled no-open result as success.
 */
import type { IPermissionsRegistry } from "@elizaos/shared";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type * as React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { __setAppValueForTests } from "../../state/app-store";
import { AppContext } from "../../state/useApp";

const nativePermissionMocks = vi.hoisted(() => ({
  openSettings: vi.fn(),
  registry: {
    get: vi.fn(() => ({
      id: "health",
      status: "opaque",
      lastChecked: 1,
      canRequest: false,
      platform: "ios",
    })),
    check: vi.fn(async () => ({
      id: "health",
      status: "opaque",
      lastChecked: 1,
      canRequest: false,
      platform: "ios",
    })),
    request: vi.fn(async () => ({
      id: "health",
      status: "opaque",
      lastChecked: 1,
      canRequest: false,
      platform: "ios",
    })),
    openSettings: vi.fn(async () => false),
    recordBlock: vi.fn(),
    list: vi.fn(() => []),
    pending: vi.fn(() => []),
    subscribe: vi.fn(() => () => {}),
    registerProber: vi.fn(),
  } as IPermissionsRegistry,
}));

vi.mock("@elizaos/ui", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("../../api/client", () => ({
  client: {},
}));

vi.mock("../../platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../platform")>()),
  isNative: true,
  isDesktopPlatform: () => false,
}));

vi.mock("../../platform/mobile-permissions-client", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../platform/mobile-permissions-client")
  >()),
  createMobileSignalsPermissionsRegistry: () => nativePermissionMocks.registry,
  openMobilePermissionSettings: nativePermissionMocks.openSettings,
}));

import { MessagePermissionCard } from "./MessageContent";

afterEach(() => {
  cleanup();
  __setAppValueForTests(null);
  nativePermissionMocks.openSettings.mockReset();
});

it("renders opened false from native settings as a retryable chat-card error", async () => {
  nativePermissionMocks.openSettings.mockResolvedValue({
    opened: false,
    target: "health",
    actualTarget: "app",
    reason: "Settings route unavailable.",
  });
  const appValue = {
    t: (_key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? _key,
    sendActionMessage: vi.fn(),
  } as never;
  __setAppValueForTests(appValue);
  render(
    <AppContext.Provider value={appValue}>
      <MessagePermissionCard
        payload={{
          permission: "health",
          reason: "Review Health access.",
          feature: "lifeops.health.read",
          fallbackOffered: false,
        }}
      />
    </AppContext.Provider>,
  );

  fireEvent.click(await screen.findByRole("button", { name: "Manage access" }));

  await waitFor(() =>
    expect(nativePermissionMocks.openSettings).toHaveBeenCalledWith("health"),
  );
  expect(
    (await screen.findByTestId("permission-card-error")).textContent,
  ).toContain("could not be opened");
});
