// @vitest-environment jsdom
//
// PermissionPrimingModal rendering: the active card's rationale + Enable/Not now,
// the recovery and explicit operation-error states, the loading state, single
// onComplete firing, and Skip-for-now. Drives the modal through an injected
// `controllerOverride` stub (the live hook is covered by use-permission-priming.test).
import type { PermissionId } from "@elizaos/shared/contracts/permissions";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installJsdomUiPolyfills } from "../../../test/portable-stories";
import { MockAppProvider } from "../../storybook/mock-providers";
import { PermissionPrimingModal } from "./PermissionPrimingModal";
import type {
  PermissionPrimingController,
  PrimingItem,
  PrimingItemOperation,
  PrimingItemStatus,
} from "./use-permission-priming";

beforeAll(() => {
  installJsdomUiPolyfills();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderModal(node: ReactElement) {
  return render(node, {
    wrapper: ({ children }) => <MockAppProvider>{children}</MockAppProvider>,
  });
}

function item(
  id: PermissionId,
  status: PrimingItemStatus,
  canRequest = false,
  error?: PrimingItemOperation,
): PrimingItem {
  return {
    id,
    status,
    canRequest,
    requesting: false,
    resolved: false,
    ...(error ? { error: { operation: error } } : {}),
  };
}

function makeController(
  overrides: Partial<PermissionPrimingController> = {},
): PermissionPrimingController {
  return {
    items: [],
    activeIndex: 0,
    active: null,
    currentStep: 1,
    totalSteps: 1,
    ready: true,
    done: false,
    request: vi.fn(async () => {}),
    skip: vi.fn(),
    openSettings: vi.fn(async () => {}),
    recheck: vi.fn(async () => {}),
    skipAll: vi.fn(),
    ...overrides,
  };
}

describe("PermissionPrimingModal", () => {
  it("renders the active card with rationale and Enable / Not now", () => {
    const controller = makeController({
      items: [item("microphone", "not-determined", true)],
      active: item("microphone", "not-determined", true),
      currentStep: 1,
      totalSteps: 1,
    });
    renderModal(
      <PermissionPrimingModal
        ids={["microphone"]}
        open
        onComplete={vi.fn()}
        controllerOverride={controller}
      />,
    );

    expect(screen.getByTestId("priming-card-microphone")).toBeTruthy();
    // MockAppProvider's t returns the defaultValue, so real copy renders.
    expect(screen.getByText("Talk to me")).toBeTruthy();
    expect(screen.getByTestId("priming-enable-microphone")).toBeTruthy();
    expect(screen.getByTestId("priming-skip-microphone")).toBeTruthy();
  });

  it("Enable fires the OS request, Not now skips without it", () => {
    const controller = makeController({
      items: [item("microphone", "not-determined", true)],
      active: item("microphone", "not-determined", true),
    });
    renderModal(
      <PermissionPrimingModal
        ids={["microphone"]}
        open
        onComplete={vi.fn()}
        controllerOverride={controller}
      />,
    );

    fireEvent.click(screen.getByTestId("priming-enable-microphone"));
    expect(controller.request).toHaveBeenCalledWith("microphone");
    expect(controller.skip).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("priming-skip-microphone"));
    expect(controller.skip).toHaveBeenCalledWith("microphone");
  });

  it("shows the recovery callout for a denied card; retry re-checks when it can't re-prompt", async () => {
    const controller = makeController({
      items: [item("microphone", "denied", false)],
      active: item("microphone", "denied", false),
    });
    renderModal(
      <PermissionPrimingModal
        ids={["microphone"]}
        open
        onComplete={vi.fn()}
        controllerOverride={controller}
      />,
    );

    expect(screen.getByTestId("priming-recovery-microphone")).toBeTruthy();
    // canRequest === false → the retry action re-checks status (post-Settings).
    fireEvent.click(screen.getByTestId("priming-recovery-microphone-retry"));
    await waitFor(() =>
      expect(controller.recheck).toHaveBeenCalledWith("microphone"),
    );
    expect(controller.request).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("priming-recovery-microphone-settings"));
    await waitFor(() =>
      expect(controller.openSettings).toHaveBeenCalledWith("microphone"),
    );
  });

  it("a denied card that can still re-prompt retries via request()", async () => {
    const controller = makeController({
      items: [item("location", "denied", true)],
      active: item("location", "denied", true),
    });
    renderModal(
      <PermissionPrimingModal
        ids={["location"]}
        open
        onComplete={vi.fn()}
        controllerOverride={controller}
      />,
    );
    fireEvent.click(screen.getByTestId("priming-recovery-location-retry"));
    await waitFor(() =>
      expect(controller.request).toHaveBeenCalledWith("location"),
    );
  });

  it("renders a loading state until the initial check completes", () => {
    const controller = makeController({ ready: false, active: null });
    renderModal(
      <PermissionPrimingModal
        ids={["microphone"]}
        open
        onComplete={vi.fn()}
        controllerOverride={controller}
      />,
    );
    expect(screen.getByTestId("permission-priming-loading")).toBeTruthy();
  });

  it("renders an initial probe failure without an Enable action and retries the check", () => {
    const failed = item("microphone", null, false, "check");
    const controller = makeController({
      items: [failed],
      active: failed,
    });
    renderModal(
      <PermissionPrimingModal
        ids={["microphone"]}
        open
        onComplete={vi.fn()}
        controllerOverride={controller}
      />,
    );

    expect(screen.getByTestId("priming-error-microphone")).toBeTruthy();
    expect(
      screen.getByText("Permission status could not be checked"),
    ).toBeTruthy();
    expect(screen.queryByTestId("priming-enable-microphone")).toBeNull();

    fireEvent.click(screen.getByTestId("priming-error-retry-microphone"));
    expect(controller.recheck).toHaveBeenCalledWith("microphone");
    expect(controller.request).not.toHaveBeenCalled();
  });

  it("retries a settings-navigation failure through openSettings", () => {
    const failed = item("microphone", "denied", false, "settings");
    const controller = makeController({
      items: [failed],
      active: failed,
    });
    renderModal(
      <PermissionPrimingModal
        ids={["microphone"]}
        open
        onComplete={vi.fn()}
        controllerOverride={controller}
      />,
    );

    expect(screen.getByText("Settings could not be opened")).toBeTruthy();
    fireEvent.click(screen.getByTestId("priming-error-retry-microphone"));
    expect(controller.openSettings).toHaveBeenCalledWith("microphone");
    expect(controller.recheck).not.toHaveBeenCalled();
  });

  it("calls onComplete exactly once when the sequence is done", async () => {
    const onComplete = vi.fn();
    const controller = makeController({
      ready: true,
      done: true,
      active: null,
    });
    renderModal(
      <PermissionPrimingModal
        ids={["microphone"]}
        open
        onComplete={onComplete}
        controllerOverride={controller}
      />,
    );
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("Skip for now skips the whole flow", () => {
    const controller = makeController({
      items: [item("microphone", "not-determined", true)],
      active: item("microphone", "not-determined", true),
    });
    renderModal(
      <PermissionPrimingModal
        ids={["microphone"]}
        open
        onComplete={vi.fn()}
        controllerOverride={controller}
      />,
    );
    fireEvent.click(screen.getByTestId("priming-skip-all"));
    expect(controller.skipAll).toHaveBeenCalled();
  });
});
