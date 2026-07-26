// @vitest-environment jsdom

/**
 * jsdom tests for `WorkflowEditor` over a mocked `client` API: renders the graph,
 * runs a saved workflow and shows node output, keeps the editor open after a new
 * save, and restores a selected version from history.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "../../api";
import type {
  WorkflowDefinition,
  WorkflowExecution,
} from "../../api/client-types-chat";
import { ApiError } from "../../api/client-types-core";
import { WorkflowEditor } from "./WorkflowEditor";

vi.mock("../../api", () => ({
  client: {
    activateWorkflowDefinition: vi.fn(),
    createWorkflowDefinition: vi.fn(),
    deactivateWorkflowDefinition: vi.fn(),
    generateWorkflowDefinition: vi.fn(),
    getWorkflowEvaluationSamples: vi.fn(),
    getWorkflowExecutions: vi.fn(),
    getWorkflowRevisions: vi.fn(),
    runWorkflowDefinition: vi.fn(),
    restoreWorkflowRevision: vi.fn(),
    updateWorkflowDefinition: vi.fn(),
  },
}));

const clientMock = client as unknown as {
  activateWorkflowDefinition: ReturnType<typeof vi.fn>;
  createWorkflowDefinition: ReturnType<typeof vi.fn>;
  deactivateWorkflowDefinition: ReturnType<typeof vi.fn>;
  generateWorkflowDefinition: ReturnType<typeof vi.fn>;
  getWorkflowEvaluationSamples: ReturnType<typeof vi.fn>;
  getWorkflowExecutions: ReturnType<typeof vi.fn>;
  getWorkflowRevisions: ReturnType<typeof vi.fn>;
  runWorkflowDefinition: ReturnType<typeof vi.fn>;
  restoreWorkflowRevision: ReturnType<typeof vi.fn>;
  updateWorkflowDefinition: ReturnType<typeof vi.fn>;
};

const clipboardWriteText = vi.fn();

vi.mock("./WorkflowGraphViewer", () => ({
  WorkflowGraphViewer: ({
    workflow,
  }: {
    workflow: WorkflowDefinition | null;
  }) => (
    <div data-testid="workflow-graph">
      {workflow?.nodes?.map((node) => node.name).join(" -> ") || "empty graph"}
    </div>
  ),
}));

function workflowFixture(): WorkflowDefinition {
  return {
    id: "workflow-1",
    name: "Cerebras review workflow",
    active: false,
    versionId: "version-current",
    nodes: [
      {
        id: "manual",
        name: "Manual Trigger",
        type: "workflows-nodes-base.manualTrigger",
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
      {
        id: "set",
        name: "Add Review Fields",
        type: "workflows-nodes-base.set",
        typeVersion: 1,
        position: [220, 0],
        parameters: {
          assignments: {
            assignments: [
              { name: "source", value: "cerebras" },
              { name: "verified", value: true },
            ],
          },
        },
      },
    ],
    connections: {
      "Manual Trigger": {
        main: [[{ node: "Add Review Fields", type: "main", index: 0 }]],
      },
    },
  };
}

function executionFixture(
  overrides: Partial<WorkflowExecution> = {},
): WorkflowExecution {
  return {
    id: "execution-1",
    workflowId: "workflow-1",
    mode: "manual",
    status: "success",
    startedAt: "2026-06-19T19:01:00.000Z",
    stoppedAt: "2026-06-19T19:01:01.500Z",
    data: {
      resultData: {
        engine: {
          provider: "smithers",
          nodes: 2,
          levels: 2,
          maxConcurrency: 1,
          started: 2,
          finished: 2,
          failed: 0,
          skipped: 0,
          retries: 0,
        },
        runData: {
          "Add Review Fields": [
            {
              startTime: "2026-06-19T19:01:00.500Z",
              executionTime: 8,
              data: {
                main: [
                  [
                    {
                      json: {
                        source: "cerebras",
                        verified: true,
                      },
                    },
                  ],
                ],
              },
            },
          ],
        },
      },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboardWriteText },
  });
  clientMock.getWorkflowExecutions.mockResolvedValue([]);
  clientMock.getWorkflowEvaluationSamples.mockResolvedValue({
    workflowId: "workflow-1",
    workflowName: "Cerebras review workflow",
    workflowVersionId: "version-current",
    generatedAt: "2026-06-20T12:00:00.000Z",
    sampleCount: 1,
    samples: [],
    jsonl: '{"id":"workflow-1:execution-1"}',
    optimizer: {
      engine: "smithers-gepa",
      target: "workflow-generation",
      suiteName: "cerebras-review-workflow",
      caseFile: "evals/cerebras-review-workflow.jsonl",
      recommendedCommand:
        "bunx smithers-orchestrator eval <workflow.tsx> --cases evals/cerebras-review-workflow.jsonl --suite cerebras-review-workflow",
      recommendedEvalCommand:
        "bunx smithers-orchestrator eval <workflow.tsx> --cases evals/cerebras-review-workflow.jsonl --suite cerebras-review-workflow",
      recommendedOptimizeCommand: "bunx smithers-orchestrator optimize",
      recommendedObservabilityCommand:
        "bunx smithers-orchestrator observability --detach",
      recommendedMetricsCommand:
        "bunx smithers-orchestrator up <workflow.tsx> --serve --metrics",
      notes: [],
    },
  });
  clientMock.getWorkflowRevisions.mockResolvedValue({
    currentVersionId: "version-current",
    revisions: [],
  });
  clientMock.runWorkflowDefinition.mockResolvedValue(executionFixture());
});

afterEach(() => cleanup());

describe("WorkflowEditor", () => {
  it("renders the graph, runs a saved workflow, and shows node output", async () => {
    render(<WorkflowEditor initial={workflowFixture()} />);

    expect(screen.getByTestId("workflow-graph").textContent).toContain(
      "Manual Trigger -> Add Review Fields",
    );
    expect(screen.getByRole("button", { name: /run now/i })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /generate from prompt/i }),
    ).toBeNull();

    const editPrefill = vi.fn();
    window.addEventListener("eliza:chat:prefill", editPrefill as EventListener);
    fireEvent.click(screen.getByRole("button", { name: /edit in chat/i }));
    expect(editPrefill).toHaveBeenCalledTimes(1);
    const editEvent = editPrefill.mock.calls[0]?.[0] as CustomEvent<{
      text: string;
      select: boolean;
    }>;
    expect(editEvent.detail.select).toBe(false);
    expect(editEvent.detail.text).toBe(
      "Modify workflow workflow-1 (Cerebras review workflow). ",
    );
    window.removeEventListener(
      "eliza:chat:prefill",
      editPrefill as EventListener,
    );

    fireEvent.click(screen.getByRole("button", { name: /run now/i }));

    await waitFor(() => {
      expect(clientMock.runWorkflowDefinition.mock.calls).toContainEqual([
        "workflow-1",
      ]);
    });
    expect(await screen.findByText("Add Review Fields")).toBeTruthy();
    expect(
      screen.getByText('{"source":"cerebras","verified":true}'),
    ).toBeTruthy();
    expect(
      screen.getByText(/2 nodes \/ 2 levels \/ 1 max parallel/),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /copy diagnostics/i }));

    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith(
        expect.stringContaining("Workflow execution execution-1"),
      );
    });
    expect(clipboardWriteText.mock.calls[0]?.[0]).toContain(
      "Engine: 2 nodes / 2 levels / 1 max parallel",
    );
    expect(clipboardWriteText.mock.calls[0]?.[0]).toContain(
      "Add Review Fields: success; 1 item",
    );

    const chatPrefill = vi.fn();
    window.addEventListener("eliza:chat:prefill", chatPrefill as EventListener);
    fireEvent.click(
      screen.getByRole("button", { name: /troubleshoot run in chat/i }),
    );
    expect(chatPrefill).toHaveBeenCalledTimes(1);
    const event = chatPrefill.mock.calls[0]?.[0] as CustomEvent<{
      text: string;
      select: boolean;
    }>;
    expect(event.detail.select).toBe(false);
    expect(event.detail.text).toContain(
      "Troubleshoot workflow workflow-1 execution execution-1.",
    );
    expect(event.detail.text).toContain(
      "Engine: 2 nodes / 2 levels / 1 max parallel",
    );
    window.removeEventListener(
      "eliza:chat:prefill",
      chatPrefill as EventListener,
    );

    clipboardWriteText.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /copy eval samples/i }));

    await waitFor(() => {
      expect(clientMock.getWorkflowEvaluationSamples.mock.calls).toContainEqual(
        ["workflow-1", 10],
      );
    });
    expect(clipboardWriteText).toHaveBeenCalledWith(
      '{"id":"workflow-1:execution-1"}',
    );
  });

  it("keeps the editor open after saving a new workflow so it can be inspected", async () => {
    const saved = workflowFixture();
    clientMock.createWorkflowDefinition.mockResolvedValue(saved);
    const onSaved = vi.fn();

    render(<WorkflowEditor onSaved={onSaved} />);

    fireEvent.change(screen.getByTestId("workflow-editor-json"), {
      target: { value: JSON.stringify(saved, null, 2) },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(clientMock.createWorkflowDefinition.mock.calls).toHaveLength(1);
    });
    expect(onSaved).toHaveBeenCalledWith(saved);
    expect(
      await screen.findByRole("button", { name: /run now/i }),
    ).toBeTruthy();
  });

  it("revalidates the parent feed after activate and run mutations", async () => {
    const activated = { ...workflowFixture(), active: true };
    clientMock.activateWorkflowDefinition.mockResolvedValue(activated);
    const onChanged = vi.fn();

    render(
      <WorkflowEditor initial={workflowFixture()} onChanged={onChanged} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /activate/i }));
    await waitFor(() => {
      expect(clientMock.activateWorkflowDefinition.mock.calls).toContainEqual([
        "workflow-1",
      ]);
    });
    expect(onChanged).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /run now/i }));
    await waitFor(() => {
      expect(clientMock.runWorkflowDefinition.mock.calls).toContainEqual([
        "workflow-1",
      ]);
    });
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it("turns the scheduled-workflow tier rejection into an always-on management action", async () => {
    clientMock.activateWorkflowDefinition.mockRejectedValue(
      new ApiError({
        kind: "http",
        path: "/api/workflow/workflows/workflow-1/activate",
        status: 409,
        code: "workflow_requires_always_on",
        message:
          "Scheduled workflows require an always-on agent runtime. Confirm continuous billing before activating this workflow.",
      }),
    );
    const onEnableAlwaysOn = vi.fn();

    render(
      <WorkflowEditor
        initial={workflowFixture()}
        cloudAgentId="agent-lazy-1"
        onEnableAlwaysOn={onEnableAlwaysOn}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /activate/i }));

    const alert = await screen.findByTestId("workflow-always-on-required");
    expect(alert.textContent).toContain("Always-on agent required");
    expect(alert.textContent).toContain("continuous hourly credit usage");
    fireEvent.click(screen.getByRole("button", { name: /enable always-on/i }));
    expect(onEnableAlwaysOn).toHaveBeenCalledWith("agent-lazy-1");
  });

  it("requires a run-status refresh after an ambiguous timeout", async () => {
    clientMock.runWorkflowDefinition.mockRejectedValueOnce(
      new ApiError({
        kind: "timeout",
        path: "/api/workflow/workflows/workflow-1/run",
        message: "Request timed out",
      }),
    );

    render(<WorkflowEditor initial={workflowFixture()} />);

    fireEvent.click(screen.getByRole("button", { name: /run now/i }));

    expect(
      await screen.findByText(
        /may still be processing; refresh workflow runs/i,
      ),
    ).toBeTruthy();
    const blockedRunButton = screen.getByRole("button", {
      name: /refresh runs first/i,
    }) as HTMLButtonElement;
    expect(blockedRunButton.disabled).toBe(true);
    fireEvent.click(blockedRunButton);
    expect(clientMock.runWorkflowDefinition.mock.calls).toHaveLength(1);

    fireEvent.click(
      screen.getByRole("button", { name: /refresh workflow runs/i }),
    );
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: /run now/i }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
  });

  it("restores a selected saved workflow version from history", async () => {
    const restored = {
      ...workflowFixture(),
      name: "Restored workflow",
      versionId: "version-restored",
    };
    clientMock.getWorkflowRevisions.mockResolvedValue({
      currentVersionId: "version-current",
      revisions: [
        {
          id: "revision-2",
          workflowId: "workflow-1",
          versionId: "version-newer",
          name: "Newer workflow",
          active: false,
          createdAt: "2026-06-19T19:00:00.000Z",
          updatedAt: "2026-06-19T19:02:00.000Z",
          capturedAt: "2026-06-19T19:07:00.000Z",
          operation: "activate",
        },
        {
          id: "revision-1",
          workflowId: "workflow-1",
          versionId: "version-previous",
          name: "Previous workflow",
          active: false,
          createdAt: "2026-06-19T19:00:00.000Z",
          updatedAt: "2026-06-19T19:00:00.000Z",
          capturedAt: "2026-06-19T19:05:00.000Z",
          operation: "update",
        },
      ],
    });
    clientMock.restoreWorkflowRevision.mockResolvedValue(restored);

    render(<WorkflowEditor initial={workflowFixture()} />);

    const restoreButton = await screen.findByRole("button", {
      name: "Restore Previous workflow",
    });
    fireEvent.click(restoreButton);

    await waitFor(() => {
      expect(clientMock.restoreWorkflowRevision.mock.calls).toContainEqual([
        "workflow-1",
        "version-previous",
      ]);
    });
    expect(await screen.findByText("Restored workflow")).toBeTruthy();
  });
});
