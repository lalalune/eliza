// @vitest-environment jsdom
/**
 * Verifies that the recovery surface owns one permission operation at a time
 * so settings navigation and a retry cannot overlap native OS work.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionRecoveryCallout } from "./PermissionRecoveryCallout";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PermissionRecoveryCallout", () => {
  it("serializes settings navigation and retry", async () => {
    let finishSettings: (() => void) | undefined;
    const onOpenSettings = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSettings = resolve;
        }),
    );
    const onRetry = vi.fn(async () => {});

    render(
      <PermissionRecoveryCallout
        permission="camera"
        title="Camera unavailable"
        description="Enable camera access in Settings."
        onOpenSettings={onOpenSettings}
        onRetry={onRetry}
      />,
    );

    const settings = screen.getByTestId(
      "permission-recovery-callout-settings",
    ) as HTMLButtonElement;
    const retry = screen.getByTestId(
      "permission-recovery-callout-retry",
    ) as HTMLButtonElement;

    fireEvent.click(settings);
    fireEvent.click(retry);

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    expect(settings.disabled).toBe(true);
    expect(retry.disabled).toBe(true);

    await act(async () => {
      if (!finishSettings) throw new Error("Settings operation did not start");
      finishSettings();
    });
    await waitFor(() => expect(settings.disabled).toBe(false));

    fireEvent.click(retry);
    await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1));
  });

  it("renders a settings failure instead of fabricating successful navigation", async () => {
    const onOpenSettings = vi.fn(async () => {
      throw new Error("native settings route unavailable");
    });

    render(
      <PermissionRecoveryCallout
        permission="camera"
        title="Camera unavailable"
        description="Enable camera access in Settings."
        onOpenSettings={onOpenSettings}
      />,
    );

    fireEvent.click(screen.getByTestId("permission-recovery-callout-settings"));

    const error = await screen.findByTestId(
      "permission-recovery-callout-error",
    );
    expect(error.textContent).toContain("Settings could not be opened");
  });
});
