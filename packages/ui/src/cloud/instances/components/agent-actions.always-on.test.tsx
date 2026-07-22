// @vitest-environment jsdom

/** Exercises the billing-consent boundary for in-place lazy-to-always agent transitions. */

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaAgentActions } from "./agent-actions";

const apiWithStatusMock = vi.hoisted(() => vi.fn());
const pollerTrackMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/api-client", () => ({
  apiWithStatus: apiWithStatusMock,
  readCloudBearerToken: vi.fn(),
}));

vi.mock("../lib/use-job-poller", () => ({
  useJobPoller: () => ({
    getStatus: () => undefined,
    isActive: () => false,
    track: pollerTrackMock,
  }),
}));

vi.mock("../lib/i18n", () => ({
  useT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: toastSuccessMock,
    error: toastErrorMock,
    info: vi.fn(),
  },
}));

vi.mock("../lib/open-web-ui", () => ({
  openWebUIWithPairing: vi.fn(),
}));

vi.mock("../../handoff/start-tier-upgrade", () => ({
  runSharedToDedicatedUpgradeHandoff: vi.fn(),
}));

describe("ElizaAgentActions always-on transition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiWithStatusMock.mockResolvedValue({
      status: 202,
      data: {
        success: true,
        transition: "in_place",
        data: {
          agentId: "agent-lazy-1",
          executionTier: "dedicated-always",
          status: "pending",
          jobId: "job-always-1",
        },
      },
    });
  });

  afterEach(() => cleanup());

  it("requires explicit continuous-billing confirmation and tracks the in-place job", async () => {
    const user = userEvent.setup();
    render(
      <ElizaAgentActions
        agentId="agent-lazy-1"
        executionTier="dedicated-lazy"
        status="running"
        webUiUrl="https://agent.example"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Enable Always-On" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/scaling to zero/i)).toBeTruthy();
    expect(
      within(dialog).getByText(/consumes credits continuously/i),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(/chat history.*stay the same/i),
    ).toBeTruthy();

    await user.click(
      within(dialog).getByRole("button", {
        name: "Confirm continuous billing",
      }),
    );

    await waitFor(() => {
      expect(apiWithStatusMock).toHaveBeenCalledWith(
        "/api/v1/eliza/agents/agent-lazy-1/upgrade-tier",
        {
          method: "POST",
          json: { confirmContinuousBilling: true },
        },
      );
    });
    expect(pollerTrackMock).toHaveBeenCalledWith(
      "agent-lazy-1",
      "job-always-1",
    );
    expect(toastSuccessMock).toHaveBeenCalledWith(
      expect.stringContaining("restart or wake in place"),
    );
  });

  it("keeps shared migration and lazy always-on actions distinct", () => {
    const { rerender } = render(
      <ElizaAgentActions
        agentId="agent-shared-1"
        executionTier="shared"
        status="running"
        webUiUrl={null}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Upgrade to Dedicated" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Enable Always-On" }),
    ).toBeNull();

    rerender(
      <ElizaAgentActions
        agentId="agent-always-1"
        executionTier="dedicated-always"
        status="running"
        webUiUrl="https://always.example"
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Upgrade to Dedicated" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Enable Always-On" }),
    ).toBeNull();
  });
});
