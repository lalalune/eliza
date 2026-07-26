// @vitest-environment jsdom
/**
 * Covers the Cloud overview's account escape hatch. Mobile users can get stuck
 * on a connected Cloud session without a desktop account menu, so this section
 * must expose the same sign-out path inline with the Cloud status.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __setAppValueForTests } from "../../state/app-store";
import { CloudOverviewSection } from "./CloudOverviewSection";

vi.mock("../../agent-surface", () => ({
  useAgentElement: () => ({ ref: null, agentProps: {} }),
}));

function t(_key: string, opts?: { defaultValue?: string; id?: string }) {
  return (opts?.defaultValue ?? _key).replace("{{id}}", opts?.id ?? "");
}

function seedCloudOverviewState(
  overrides: Partial<{
    elizaCloudConnected: boolean;
    elizaCloudDisconnecting: boolean;
    elizaCloudLoginBusy: boolean;
    elizaCloudUserId: string | null;
    handleCloudDisconnect: () => Promise<void>;
    handleCloudLogin: () => Promise<void>;
    handleCloudSignOut: () => Promise<void>;
  }> = {},
) {
  __setAppValueForTests({
    t,
    elizaCloudConnected: overrides.elizaCloudConnected ?? false,
    elizaCloudDisconnecting: overrides.elizaCloudDisconnecting ?? false,
    elizaCloudLoginBusy: overrides.elizaCloudLoginBusy ?? false,
    elizaCloudUserId: overrides.elizaCloudUserId ?? null,
    handleCloudDisconnect:
      overrides.handleCloudDisconnect ?? vi.fn(async () => undefined),
    handleCloudLogin:
      overrides.handleCloudLogin ?? vi.fn(async () => undefined),
    handleCloudSignOut:
      overrides.handleCloudSignOut ?? vi.fn(async () => undefined),
    setActionNotice: vi.fn(),
  } as never);
}

afterEach(() => {
  cleanup();
  __setAppValueForTests(null);
  vi.clearAllMocks();
});

describe("CloudOverviewSection", () => {
  it("exposes a sign-out action for connected Cloud accounts", () => {
    const handleCloudDisconnect = vi.fn(async () => undefined);
    const handleCloudSignOut = vi.fn(async () => undefined);
    seedCloudOverviewState({
      elizaCloudConnected: true,
      elizaCloudUserId: "user-123",
      handleCloudDisconnect,
      handleCloudSignOut,
    });

    render(<CloudOverviewSection />);

    expect(screen.getByText("Cloud account")).not.toBeNull();
    expect(screen.getByText("Signed in as user-123")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(handleCloudSignOut).toHaveBeenCalledTimes(1);
    expect(handleCloudDisconnect).not.toHaveBeenCalled();
  });

  it("does not show the sign-out row before Cloud is connected", () => {
    seedCloudOverviewState({ elizaCloudConnected: false });

    render(<CloudOverviewSection />);

    expect(screen.queryByText("Cloud account")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("disables sign-out while disconnect is already in flight", () => {
    seedCloudOverviewState({
      elizaCloudConnected: true,
      elizaCloudDisconnecting: true,
    });

    render(<CloudOverviewSection />);

    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Signing out..." })
        .disabled,
    ).toBe(true);
  });
});
