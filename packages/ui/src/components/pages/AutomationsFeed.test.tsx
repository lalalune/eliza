// @vitest-environment jsdom

/**
 * Renders the real automations feed against an in-memory API client, including
 * status, run, editor, capability-upgrade, and exclusive failure states.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowDefinition } from "../../api/client-types-chat";
import type {
  AutomationItem,
  AutomationListResponse,
} from "../../api/client-types-config";
import { ApiError } from "../../api/client-types-core";
import { getCached, invalidate, setCached } from "../../hooks/resource-cache";
import { AutomationsFeed, automationListCacheKey } from "./AutomationsFeed";
import { dispatchWorkflowActionHandoff } from "./workflow-action-handoff";

const DEFAULT_AGENT_BASE =
  "https://api.elizacloud.ai/api/v1/eliza/agents/de42b5ff-72d3-4a1a-8a16-19aee293bfea";
const SECOND_AGENT_BASE =
  "https://api.elizacloud.ai/api/v1/eliza/agents/9b0deccb-a884-4149-b91d-328004ac108d";
const DEDICATED_AGENT_BASE = "https://agent-lazy-1.elizacloud.ai";

const clientMock = vi.hoisted(() => ({
  baseUrl:
    "https://api.elizacloud.ai/api/v1/eliza/agents/de42b5ff-72d3-4a1a-8a16-19aee293bfea",
  listAutomations: vi.fn(),
  listScheduledTasks: vi.fn(),
  applyScheduledTask: vi.fn(),
  getWorkflowDefinition: vi.fn(),
  runWorkflowDefinition: vi.fn(),
  createTrigger: vi.fn(),
  updateTrigger: vi.fn(),
}));
const openExternalUrlMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../../api", () => ({
  client: clientMock,
}));

vi.mock("../../utils/openExternalUrl", () => ({
  openExternalUrl: openExternalUrlMock,
}));

vi.mock("./WorkflowEditor", () => ({
  WorkflowEditor: ({
    initial,
    cloudAgentId,
    onEnableAlwaysOn,
    onCancel,
  }: {
    initial?: WorkflowDefinition | null;
    cloudAgentId?: string | null;
    onEnableAlwaysOn?: (agentId: string) => void;
    onCancel?: () => void;
  }) => (
    <div
      data-testid="workflow-editor-stub"
      data-cloud-agent-id={cloudAgentId ?? ""}
    >
      {initial?.name ?? "New workflow"}
      {cloudAgentId && onEnableAlwaysOn && (
        <button type="button" onClick={() => onEnableAlwaysOn(cloudAgentId)}>
          Enable always-on
        </button>
      )}
      {onCancel && (
        <button type="button" onClick={onCancel}>
          Close workflow editor
        </button>
      )}
    </div>
  ),
}));

function automationItem(
  overrides: Partial<AutomationItem> = {},
): AutomationItem {
  return {
    id: "automation-1",
    type: "workflow",
    source: "workflow",
    title: "Nightly review",
    description: "",
    status: "active",
    enabled: true,
    system: false,
    isDraft: false,
    hasBackingWorkflow: true,
    updatedAt: "2026-06-20T12:00:00.000Z",
    workflowId: "workflow-1",
    schedules: [
      {
        id: "trigger-1",
        taskId: "task-trigger-1",
        displayName: "Scheduled workflow run: Nightly review",
        instructions: "Run workflow Nightly review",
        triggerType: "interval",
        enabled: true,
        wakeMode: "inject_now",
        createdBy: "workflow.schedule",
        intervalMs: 3_600_000,
        runCount: 0,
      },
    ],
    lastExecution: {
      status: "success",
      startedAt: "2026-06-20T12:00:00.000Z",
      stoppedAt: "2026-06-20T12:00:01.000Z",
    },
    ...overrides,
  };
}

function responseFixture(): AutomationListResponse {
  const automations = [
    automationItem(),
    automationItem({
      id: "automation-2",
      title: "Broken workflow",
      workflowId: "workflow-2",
      lastExecution: {
        status: "error",
        startedAt: "2026-06-20T13:00:00.000Z",
        errorMessage: "HTTP request failed",
      },
    }),
    automationItem({
      id: "task-1",
      type: "coordinator_text",
      source: "workbench_task",
      title: "Simple reminder",
      status: "paused",
      enabled: false,
      hasBackingWorkflow: false,
      workflowId: undefined,
      lastExecution: undefined,
    }),
  ];
  return {
    automations,
    summary: {
      total: automations.length,
      coordinatorCount: 1,
      workflowCount: 2,
      scheduledCount: 0,
      draftCount: 0,
    },
    workflowStatus: null,
    workflowFetchError: null,
    executionFetchErrors: [],
  };
}

function workflowDefinition(
  overrides: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
  return {
    id: "workflow-1",
    name: "Nightly review",
    active: true,
    nodes: [],
    connections: {},
    ...overrides,
  };
}

beforeEach(() => {
  window.location.hash = "#automations";
  clientMock.baseUrl = DEFAULT_AGENT_BASE;
  clientMock.listAutomations.mockResolvedValue(responseFixture());
  clientMock.listScheduledTasks.mockResolvedValue({ tasks: [] });
  clientMock.getWorkflowDefinition.mockResolvedValue(workflowDefinition());
  clientMock.runWorkflowDefinition.mockResolvedValue({ id: "execution-1" });
  clientMock.createTrigger.mockResolvedValue({ trigger: {} });
  clientMock.updateTrigger.mockResolvedValue({ trigger: {} });
});

afterEach(() => {
  cleanup();
  invalidate(automationListCacheKey(DEFAULT_AGENT_BASE));
  invalidate(automationListCacheKey(SECOND_AGENT_BASE));
  invalidate(automationListCacheKey(DEDICATED_AGENT_BASE));
  vi.clearAllMocks();
});

describe("AutomationsFeed", () => {
  it("shows a compact status overview and truthful workflow run action", async () => {
    render(<AutomationsFeed />);

    expect(await screen.findByText("Nightly review")).toBeTruthy();

    expect(
      within(screen.getByTestId("automation-stat-total")).getByText("3"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("automation-stat-active")).getByText("2"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("automation-stat-passed")).getByText("1"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("automation-stat-failed")).getByText("1"),
    ).toBeTruthy();
    expect(screen.getByText("Failed: HTTP request failed")).toBeTruthy();
    expect(screen.getAllByText("Every hour").length).toBeGreaterThan(0);

    expect(
      screen.queryByRole("button", { name: /activate workflow/i }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /deactivate workflow/i }),
    ).toBeNull();

    const runButton = screen.getByRole("button", {
      name: "Run Nightly review now",
    });
    expect(runButton.getAttribute("data-agent-id")).toBe(
      "run-workflow-workflow-1",
    );

    fireEvent.click(runButton);

    await waitFor(() => {
      expect(clientMock.runWorkflowDefinition.mock.calls).toContainEqual([
        "workflow-1",
      ]);
    });
    expect(clientMock.listAutomations.mock.calls).toHaveLength(2);
  });

  it("keeps the feed header focused on status instead of generic creation", async () => {
    render(<AutomationsFeed />);

    await screen.findByText("Nightly review");
    expect(screen.queryByRole("button", { name: "New" })).toBeNull();
  });

  it("closes an open workflow editor after a successful list handoff", async () => {
    window.location.hash = "#automations/workflow-1";
    render(<AutomationsFeed />);

    expect(await screen.findByTestId("workflow-editor-stub")).toBeTruthy();

    act(() => {
      dispatchWorkflowActionHandoff(
        [
          {
            actionName: "WORKFLOW",
            success: true,
            values: { count: 3 },
          },
        ],
        { dispatchNavigate: vi.fn() },
      );
    });

    expect(screen.queryByTestId("workflow-editor-stub")).toBeNull();
    expect(await screen.findByTestId("automations-layout")).toBeTruthy();
    expect(window.location.hash).toBe("#automations");
    await waitFor(() => {
      expect(clientMock.listAutomations.mock.calls).toHaveLength(2);
    });
  });

  it("refreshes the feed behind an id-bearing chat workflow handoff", async () => {
    const refreshed = responseFixture();
    refreshed.automations = [
      ...refreshed.automations,
      automationItem({
        id: "automation-chat-created",
        workflowId: "workflow-chat-created",
        title: "Chat-created workflow",
        enabled: false,
        status: "paused",
        lastExecution: undefined,
      }),
    ];
    clientMock.listAutomations
      .mockResolvedValueOnce(responseFixture())
      .mockResolvedValue(refreshed);
    clientMock.getWorkflowDefinition.mockResolvedValue(
      workflowDefinition({
        id: "workflow-chat-created",
        name: "Chat-created workflow",
        active: false,
      }),
    );
    render(<AutomationsFeed />);
    await screen.findByText("Nightly review");

    act(() => {
      dispatchWorkflowActionHandoff(
        [
          {
            actionName: "WORKFLOW",
            success: true,
            values: { workflowId: "workflow-chat-created" },
          },
        ],
        { dispatchNavigate: vi.fn() },
      );
    });

    expect(
      (await screen.findByTestId("workflow-editor-stub")).textContent,
    ).toContain("Chat-created workflow");
    await waitFor(() => {
      expect(clientMock.listAutomations.mock.calls).toHaveLength(2);
    });
    expect(
      getCached<AutomationListResponse>(
        automationListCacheKey(DEFAULT_AGENT_BASE),
      )?.data.automations.some(
        (automation) => automation.workflowId === "workflow-chat-created",
      ),
    ).toBe(true);

    fireEvent.click(
      screen.getByRole("button", { name: "Close workflow editor" }),
    );
    expect(await screen.findByText("Chat-created workflow")).toBeTruthy();
  });

  it("preserves the dedicated upgrade path when a workflow deep-link is gated", async () => {
    window.location.hash = "#automations/workflow-1";
    clientMock.getWorkflowDefinition.mockRejectedValue(
      new ApiError({
        kind: "http",
        path: "/api/workflow/workflows/workflow-1",
        status: 409,
        code: "workflow_requires_dedicated",
        message:
          "Workflows require a dedicated agent runtime. Upgrade this agent before managing workflows.",
      }),
    );

    render(<AutomationsFeed />);

    expect(await screen.findByText("Dedicated agent required")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Upgrade to Dedicated" }),
    );
    expect(openExternalUrlMock.mock.calls).toContainEqual([
      "https://elizacloud.ai/dashboard/agents/de42b5ff-72d3-4a1a-8a16-19aee293bfea",
    ]);
  });

  it("passes a dedicated subdomain agent id to the workflow subscription control", async () => {
    window.location.hash = "#automations/workflow-1";
    clientMock.baseUrl = DEDICATED_AGENT_BASE;

    render(<AutomationsFeed />);

    const editor = await screen.findByTestId("workflow-editor-stub");
    expect(editor.getAttribute("data-cloud-agent-id")).toBe("agent-lazy-1");
    fireEvent.click(screen.getByRole("button", { name: "Enable always-on" }));
    expect(openExternalUrlMock.mock.calls).toContainEqual([
      "https://elizacloud.ai/dashboard/agents/agent-lazy-1",
    ]);
  });

  it("routes a prompt-trigger always-on rejection to the cloud agent control", async () => {
    window.location.hash = "#automations/task/__new__";
    clientMock.createTrigger.mockRejectedValueOnce(
      new ApiError({
        kind: "http",
        path: "/api/triggers",
        status: 409,
        code: "workflow_requires_always_on",
        message:
          "Scheduled prompt automations require an always-on agent runtime.",
      }),
    );

    render(<AutomationsFeed />);

    fireEvent.change(await screen.findByTestId("task-editor-name"), {
      target: { value: "Morning digest" },
    });
    fireEvent.change(screen.getByTestId("task-editor-prompt"), {
      target: { value: "Summarize my calendar" },
    });
    fireEvent.change(screen.getByTestId("task-editor-scheduled-at"), {
      target: { value: "2099-01-02T03:04" },
    });
    fireEvent.click(screen.getByTestId("task-editor-save"));

    expect(await screen.findByTestId("task-always-on-required")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Enable always-on" }));
    expect(openExternalUrlMock.mock.calls).toContainEqual([
      "https://elizacloud.ai/dashboard/agents/de42b5ff-72d3-4a1a-8a16-19aee293bfea",
    ]);
  });

  it("retries a transient workflow deep-link load without leaving the editor", async () => {
    window.location.hash = "#automations/workflow-1";
    clientMock.getWorkflowDefinition
      .mockRejectedValueOnce(
        new Error("Workflow store temporarily unavailable"),
      )
      .mockResolvedValueOnce(workflowDefinition());

    render(<AutomationsFeed />);

    expect(await screen.findByText("Workflow couldn't be loaded")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByTestId("workflow-editor-stub")).toBeTruthy();
    expect(clientMock.getWorkflowDefinition.mock.calls).toHaveLength(2);
  });

  it("never paints one Cloud agent's cached workflows after switching agents", async () => {
    const firstResponse = responseFixture();
    firstResponse.automations = [
      automationItem({ title: "Agent A private workflow" }),
    ];
    const secondResponse = responseFixture();
    secondResponse.automations = [
      automationItem({
        id: "agent-b-automation",
        workflowId: "agent-b-workflow",
        title: "Agent B private workflow",
      }),
    ];
    let finishSecondRequest:
      | ((response: AutomationListResponse) => void)
      | undefined;
    clientMock.listAutomations
      .mockResolvedValueOnce(firstResponse)
      .mockReturnValueOnce(
        new Promise<AutomationListResponse>((resolve) => {
          finishSecondRequest = resolve;
        }),
      );
    const { rerender } = render(<AutomationsFeed />);

    expect(await screen.findByText("Agent A private workflow")).toBeTruthy();

    clientMock.baseUrl = SECOND_AGENT_BASE;
    rerender(<AutomationsFeed />);

    await waitFor(() => {
      expect(screen.queryByText("Agent A private workflow")).toBeNull();
    });
    expect(screen.queryByText("Agent B private workflow")).toBeNull();

    await act(async () => {
      finishSecondRequest?.(secondResponse);
    });
    expect(await screen.findByText("Agent B private workflow")).toBeTruthy();
  });

  it("discards an editor response from the previously selected agent", async () => {
    let finishFirstEditor: ((workflow: WorkflowDefinition) => void) | undefined;
    const firstEditor = new Promise<WorkflowDefinition>((resolve) => {
      finishFirstEditor = resolve;
    });
    clientMock.getWorkflowDefinition.mockImplementation(() => {
      const requestBase = clientMock.baseUrl;
      return requestBase === DEFAULT_AGENT_BASE
        ? firstEditor
        : Promise.resolve(
            workflowDefinition({ name: "Agent B editor workflow" }),
          );
    });
    const { rerender } = render(<AutomationsFeed />);

    const title = await screen.findByText("Nightly review");
    const openButton = title.closest("button");
    if (!openButton) throw new Error("Workflow row button was not rendered");
    fireEvent.click(openButton);
    await waitFor(() => {
      expect(clientMock.getWorkflowDefinition.mock.calls).toHaveLength(1);
    });

    clientMock.baseUrl = SECOND_AGENT_BASE;
    rerender(<AutomationsFeed />);

    expect(await screen.findByText("Agent B editor workflow")).toBeTruthy();
    await act(async () => {
      finishFirstEditor?.(
        workflowDefinition({ name: "Agent A stale editor workflow" }),
      );
    });
    expect(screen.queryByText("Agent A stale editor workflow")).toBeNull();
    expect(screen.getByText("Agent B editor workflow")).toBeTruthy();
  });

  it("does not publish a stale run failure or refresh across an agent switch", async () => {
    let failFirstRun: ((reason: Error) => void) | undefined;
    clientMock.runWorkflowDefinition.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        failFirstRun = reject;
      }),
    );
    const secondResponse = responseFixture();
    secondResponse.automations = [
      automationItem({
        id: "agent-b-automation",
        workflowId: "agent-b-workflow",
        title: "Agent B private workflow",
      }),
    ];
    clientMock.listAutomations
      .mockResolvedValueOnce(responseFixture())
      .mockResolvedValue(secondResponse);
    const { rerender } = render(<AutomationsFeed />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Run Nightly review now" }),
    );
    clientMock.baseUrl = SECOND_AGENT_BASE;
    rerender(<AutomationsFeed />);
    expect(await screen.findByText("Agent B private workflow")).toBeTruthy();

    await act(async () => {
      failFirstRun?.(new Error("stale Agent A run failure"));
    });
    expect(screen.queryByText("Run failed")).toBeNull();
    expect(screen.queryByText("Run status unknown")).toBeNull();
    expect(screen.queryByText("stale Agent A run failure")).toBeNull();
    expect(clientMock.listAutomations.mock.calls).toHaveLength(2);
  });

  it("prevents duplicate run requests while a workflow execution is pending", async () => {
    let finishRun: ((value: { id: string }) => void) | undefined;
    clientMock.runWorkflowDefinition.mockReturnValueOnce(
      new Promise<{ id: string }>((resolve) => {
        finishRun = resolve;
      }),
    );
    render(<AutomationsFeed />);

    const runButton = await screen.findByRole("button", {
      name: "Run Nightly review now",
    });
    fireEvent.click(runButton);
    fireEvent.click(runButton);

    expect(clientMock.runWorkflowDefinition.mock.calls).toHaveLength(1);
    expect(runButton.hasAttribute("disabled")).toBe(true);

    finishRun?.({ id: "execution-1" });
    await waitFor(() => expect(runButton.hasAttribute("disabled")).toBe(false));
  });

  it("labels a failed run separately and retries the workflow operation", async () => {
    clientMock.runWorkflowDefinition
      .mockRejectedValueOnce(new Error("Smithers execution failed"))
      .mockResolvedValueOnce({ id: "execution-2" });
    render(<AutomationsFeed />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Run Nightly review now" }),
    );

    expect(await screen.findByText("Run failed")).toBeTruthy();
    expect(screen.getByText("Smithers execution failed")).toBeTruthy();
    expect(screen.queryByText("Automations couldn't be loaded")).toBeNull();
    expect(clientMock.listAutomations.mock.calls).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Run again" }));

    await waitFor(() =>
      expect(clientMock.runWorkflowDefinition.mock.calls).toHaveLength(2),
    );
    await waitFor(() =>
      expect(clientMock.listAutomations.mock.calls).toHaveLength(2),
    );
    expect(screen.queryByText("Run failed")).toBeNull();
  });

  it("preserves one workflow's failure while another workflow refreshes successfully", async () => {
    clientMock.runWorkflowDefinition.mockImplementation(
      async (workflowId: string) => {
        if (workflowId === "workflow-1") {
          throw new Error("Nightly review failed");
        }
        return { id: "execution-2" };
      },
    );
    render(<AutomationsFeed />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Run Nightly review now" }),
    );
    expect(await screen.findByText("Nightly review failed")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Run Broken workflow now" }),
    );
    await waitFor(() => {
      expect(clientMock.listAutomations.mock.calls).toHaveLength(2);
    });

    expect(screen.getByText("Run failed")).toBeTruthy();
    expect(screen.getByText("Nightly review failed")).toBeTruthy();
  });

  it("refreshes status instead of repeating a run whose timeout is ambiguous", async () => {
    clientMock.runWorkflowDefinition.mockRejectedValueOnce(
      new ApiError({
        kind: "http",
        path: "/api/workflow/workflows/workflow-1/run",
        status: 504,
        code: "agent_timeout",
        message: "Agent did not start responding in time.",
      }),
    );
    render(<AutomationsFeed />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Run Nightly review now" }),
    );

    expect(await screen.findByText("Run status unknown")).toBeTruthy();
    expect(screen.getByText(/may still be processing/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));

    await waitFor(() => {
      expect(clientMock.listAutomations.mock.calls).toHaveLength(2);
    });
    await waitFor(() => {
      expect(screen.queryByText("Run status unknown")).toBeNull();
    });
    expect(clientMock.runWorkflowDefinition.mock.calls).toHaveLength(1);
  });

  it("keeps a post-run refresh when an older silent revalidation resolves last", async () => {
    const cachedResponse = responseFixture();
    cachedResponse.automations = [automationItem({ title: "Cached workflow" })];
    setCached(automationListCacheKey(DEFAULT_AGENT_BASE), cachedResponse);

    let resolveStaleRefresh:
      | ((value: AutomationListResponse) => void)
      | undefined;
    const staleResponse = responseFixture();
    staleResponse.automations = [
      automationItem({ title: "Stale silent workflow" }),
    ];
    const freshResponse = responseFixture();
    freshResponse.automations = [
      automationItem({ title: "Fresh post-run workflow" }),
    ];
    clientMock.listAutomations
      .mockReturnValueOnce(
        new Promise<AutomationListResponse>((resolve) => {
          resolveStaleRefresh = resolve;
        }),
      )
      .mockResolvedValueOnce(freshResponse);

    render(<AutomationsFeed />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Run Cached workflow now" }),
    );
    expect(await screen.findByText("Fresh post-run workflow")).toBeTruthy();
    expect(clientMock.listAutomations.mock.calls).toHaveLength(2);

    await act(async () => {
      resolveStaleRefresh?.(staleResponse);
      await Promise.resolve();
    });

    expect(screen.queryByText("Stale silent workflow")).toBeNull();
    expect(screen.getByText("Fresh post-run workflow")).toBeTruthy();
    expect(
      getCached<AutomationListResponse>(
        automationListCacheKey(DEFAULT_AGENT_BASE),
      )?.data.automations[0]?.title,
    ).toBe("Fresh post-run workflow");
  });

  it.each(["running", "waiting"] as const)(
    "disables Run now while the persisted execution is %s",
    async (status) => {
      const response = responseFixture();
      response.automations = [
        automationItem({
          lastExecution: {
            status,
            startedAt: "2026-06-20T14:00:00.000Z",
          },
        }),
      ];
      clientMock.listAutomations.mockResolvedValue(response);
      render(<AutomationsFeed />);

      const runButton = await screen.findByRole("button", {
        name: "Run Nightly review now",
      });
      expect(runButton.hasAttribute("disabled")).toBe(true);
      expect(runButton.getAttribute("aria-busy")).toBe("true");
      fireEvent.click(runButton);
      expect(clientMock.runWorkflowDefinition.mock.calls).toHaveLength(0);
    },
  );

  it("exposes the filters as keyboard-navigable selected tabs", async () => {
    render(<AutomationsFeed />);

    await screen.findByText("Nightly review");
    expect(
      screen.getByRole("tablist", { name: "Filter automations" }),
    ).toBeTruthy();
    const allTab = screen.getByRole("tab", { name: /All/i });
    const promptsTab = screen.getByRole("tab", { name: /Prompts/i });
    expect(allTab.getAttribute("aria-selected")).toBe("true");
    expect(promptsTab.getAttribute("aria-selected")).toBe("false");

    allTab.focus();
    fireEvent.keyDown(allTab, { key: "ArrowRight" });

    expect(promptsTab.getAttribute("aria-selected")).toBe("true");
    expect(promptsTab.getAttribute("tabindex")).toBe("0");
    expect(document.activeElement).toBe(promptsTab);
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
      promptsTab.id,
    );
  });

  it("renders the uniform ViewHeader with a centered title and bare-icon back", async () => {
    render(<AutomationsFeed />);

    await screen.findByText("Nightly review");
    const header = screen.getByTestId("view-header");
    expect(header).toBeTruthy();
    // Title lives in the header, not a page-level heading block.
    expect(within(header).getByText("Automations")).toBeTruthy();
    // Bare-icon back affordance (no text label, aria-labelled).
    expect(within(header).getByRole("button", { name: /back/i })).toBeTruthy();
  });

  it("shows a designed-empty state with NO create CTA when nothing is scheduled", async () => {
    clientMock.listAutomations.mockResolvedValue({
      automations: [],
      summary: {
        total: 0,
        coordinatorCount: 0,
        workflowCount: 0,
        scheduledCount: 0,
        draftCount: 0,
      },
      workflowStatus: null,
      workflowFetchError: null,
      executionFetchErrors: [],
    });

    render(<AutomationsFeed />);

    expect(await screen.findByText("Nothing scheduled yet")).toBeTruthy();
    const scrollRegion = screen.getByTestId("automations-scroll-region");
    expect(scrollRegion.className).toContain("overflow-y-auto");
    expect(scrollRegion.className).toContain(
      "pb-[var(--eliza-continuous-chat-clearance,5.25rem)]",
    );
    expect(scrollRegion.className).toContain(
      "pe-[var(--eliza-continuous-chat-side-clearance,0px)]",
    );
    expect(screen.getByTestId("automations-empty-state").className).toContain(
      "[@media(orientation:landscape)_and_(max-height:520px)]:py-3",
    );
    expect(
      screen.getByTestId("automations-empty-state").querySelector("svg")
        ?.className.baseVal,
    ).toContain(
      "[@media(orientation:landscape)_and_(max-height:520px)]:hidden",
    );
    // The empty state is unreachable in practice (a default is seeded on first
    // run); when it does render for the deleted-everything edge it must carry
    // NO create CTA — the agent offers re-creation from chat instead.
    expect(
      screen.queryByRole("button", { name: /create your first/i }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /create/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "New" })).toBeNull();
  });

  it("renders an explicit unavailable state when the workflow service is disabled", async () => {
    clientMock.listAutomations.mockResolvedValue({
      automations: [],
      summary: {
        total: 0,
        coordinatorCount: 0,
        workflowCount: 0,
        scheduledCount: 0,
        draftCount: 0,
      },
      workflowStatus: {
        mode: "disabled",
        host: "in-process",
        status: "error",
        cloudConnected: false,
        localEnabled: false,
      },
      workflowFetchError: "Workflow service is not registered",
      executionFetchErrors: [],
    });

    render(<AutomationsFeed />);

    expect(
      await screen.findByText("Workflow service unavailable"),
    ).toBeTruthy();
    expect(screen.getByText("Workflow service is not registered")).toBeTruthy();
    expect(screen.queryByText("Nothing scheduled yet")).toBeNull();
    expect(screen.queryByTestId("automation-stat-total")).toBeNull();
  });

  it("renders a 404 workflow route as unavailable instead of healthy-empty", async () => {
    clientMock.listAutomations.mockRejectedValue(
      new ApiError({
        kind: "http",
        path: "/api/automations",
        status: 404,
        message: "Not found",
      }),
    );

    render(<AutomationsFeed />);

    expect(
      await screen.findByText("Workflow service unavailable"),
    ).toBeTruthy();
    expect(
      screen.getByText(/workflow API is not available on this runtime/i),
    ).toBeTruthy();
    expect(screen.queryByText("Nothing scheduled yet")).toBeNull();
    expect(screen.queryByTestId("automation-stat-total")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Upgrade to Dedicated" }),
    ).toBeNull();
  });

  it("offers the existing dedicated-agent management flow for the typed capability gate", async () => {
    clientMock.listAutomations.mockRejectedValue(
      new ApiError({
        kind: "http",
        path: "/api/automations",
        status: 409,
        code: "workflow_requires_dedicated",
        message:
          "Workflows require a dedicated agent runtime. Upgrade this agent before managing workflows.",
      }),
    );

    render(<AutomationsFeed />);

    expect(await screen.findByText("Dedicated agent required")).toBeTruthy();
    expect(screen.queryByText("Nothing scheduled yet")).toBeNull();
    expect(screen.queryByTestId("automation-stat-total")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Upgrade to Dedicated" }),
    );

    expect(openExternalUrlMock.mock.calls).toContainEqual([
      "https://elizacloud.ai/dashboard/agents/de42b5ff-72d3-4a1a-8a16-19aee293bfea",
    ]);
  });

  it("renders a failed initial load as an exclusive retryable error state", async () => {
    clientMock.listAutomations
      .mockRejectedValueOnce(new Error("Workflow service disconnected"))
      .mockResolvedValueOnce(responseFixture());

    render(<AutomationsFeed />);

    expect(
      await screen.findByText("Automations couldn't be loaded"),
    ).toBeTruthy();
    expect(screen.getByText("Workflow service disconnected")).toBeTruthy();
    expect(screen.queryByText("Nothing scheduled yet")).toBeNull();
    expect(screen.queryByTestId("automation-stat-total")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Upgrade to Dedicated" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Nightly review")).toBeTruthy();
    expect(clientMock.listAutomations.mock.calls).toHaveLength(2);
    expect(screen.queryByText("Automations couldn't be loaded")).toBeNull();
  });

  it("surfaces a scheduled-task 500 instead of fabricating a healthy-empty supplement", async () => {
    clientMock.listAutomations.mockResolvedValue({
      automations: [],
      summary: {
        total: 0,
        coordinatorCount: 0,
        workflowCount: 0,
        scheduledCount: 0,
        draftCount: 0,
      },
      workflowStatus: null,
      workflowFetchError: null,
      executionFetchErrors: [],
    });
    clientMock.listScheduledTasks.mockRejectedValue(
      new ApiError({
        kind: "http",
        path: "/api/scheduled-tasks",
        status: 500,
        message: "Scheduled-task storage failed",
      }),
    );

    render(<AutomationsFeed />);

    expect(
      await screen.findByText("Automations couldn't be loaded"),
    ).toBeTruthy();
    expect(screen.getByText("Scheduled-task storage failed")).toBeTruthy();
    expect(screen.queryByText("Nothing scheduled yet")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("distinguishes unavailable execution history from a workflow that never ran", async () => {
    const response = responseFixture();
    response.automations = [
      automationItem({
        id: "automation-history-error",
        workflowId: "workflow-history-error",
        title: "History unavailable",
        lastExecution: undefined,
        executionFetchError: "execution store unavailable",
      }),
    ];
    response.executionFetchErrors = [
      {
        workflowId: "workflow-history-error",
        error: "execution store unavailable",
      },
    ];
    clientMock.listAutomations.mockResolvedValue(response);

    render(<AutomationsFeed />);

    expect(await screen.findByText("History unavailable")).toBeTruthy();
    expect(
      screen.getByText("Run history unavailable: execution store unavailable"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("automation-stat-passed")).getByText("0"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("automation-stat-failed")).getByText("0"),
    ).toBeTruthy();
  });
});
