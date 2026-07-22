// @vitest-environment jsdom

/**
 * jsdom tests for the workflow action-handoff helpers: `findWorkflowIdForActionHandoff`
 * (resolving the target workflow from a chat action result) and
 * `dispatchWorkflowActionHandoff` (emitting the handoff event).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatActionResultSummary } from "../../api/client-types-chat";
import { NAVIGATE_VIEW_EVENT } from "../../events";
import {
  dispatchWorkflowActionHandoff,
  findWorkflowIdForActionHandoff,
} from "./workflow-action-handoff";
import { VISUALIZE_WORKFLOW_EVENT } from "./workflow-graph-events";

describe("workflow action handoff", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("selects the latest successful workflow id from streamed action summaries", () => {
    const actionResults: ChatActionResultSummary[] = [
      {
        actionName: "WORKFLOW",
        success: true,
        values: { workflowId: "workflow-old" },
      },
      {
        actionName: "WORKFLOW",
        success: false,
        values: { workflowId: "workflow-failed" },
      },
      {
        actionName: "WORKFLOW",
        success: true,
        values: { workflowId: "workflow-new" },
      },
    ];

    expect(findWorkflowIdForActionHandoff(actionResults)).toBe("workflow-new");
  });

  it("ignores workflow-shaped values from non-WORKFLOW actions", () => {
    expect(
      findWorkflowIdForActionHandoff([
        {
          actionName: "VIEWS",
          success: true,
          values: { workflowId: "not-a-workflow-handoff" },
        },
      ]),
    ).toBeNull();
  });

  it("navigates to the workflow deep-link and dispatches the existing visualize event", () => {
    const events: CustomEvent[] = [];
    const navigations: CustomEvent[] = [];
    const handler = (event: Event) => events.push(event as CustomEvent);
    const navigationHandler = (event: Event) =>
      navigations.push(event as CustomEvent);
    window.addEventListener(VISUALIZE_WORKFLOW_EVENT, handler);
    window.addEventListener(NAVIGATE_VIEW_EVENT, navigationHandler);

    const dispatched = dispatchWorkflowActionHandoff([
      {
        actionName: "WORKFLOW",
        success: true,
        values: { workflowId: "workflow-1" },
      },
    ]);

    window.removeEventListener(VISUALIZE_WORKFLOW_EVENT, handler);
    window.removeEventListener(NAVIGATE_VIEW_EVENT, navigationHandler);
    expect(dispatched).toBe(true);
    expect(navigations).toHaveLength(1);
    expect(navigations[0]?.detail).toEqual({
      viewId: "automations",
      viewPath: "/automations#automations/workflow-1",
    });
    expect(events).toHaveLength(1);
    expect(events[0].detail).toEqual({ workflowId: "workflow-1" });
  });

  it("opens the Automations feed for a successful workflow lifecycle result without an id", () => {
    const dispatchNavigate = vi.fn();
    const dispatchShowList = vi.fn();
    const dispatchVisualize = vi.fn();

    const dispatched = dispatchWorkflowActionHandoff(
      [
        {
          actionName: "WORKFLOW",
          success: true,
          values: { count: 3 },
        },
      ],
      { dispatchNavigate, dispatchShowList, dispatchVisualize },
    );

    expect(dispatched).toBe(true);
    expect(dispatchNavigate).toHaveBeenCalledWith({
      viewId: "automations",
      viewPath: "/automations",
    });
    expect(dispatchShowList).toHaveBeenCalledTimes(1);
    expect(dispatchVisualize).not.toHaveBeenCalled();
  });

  it("does not navigate for a failed workflow result", () => {
    const dispatchNavigate = vi.fn();

    expect(
      dispatchWorkflowActionHandoff(
        [{ actionName: "WORKFLOW", success: false }],
        { dispatchNavigate },
      ),
    ).toBe(false);
    expect(dispatchNavigate).not.toHaveBeenCalled();
  });

  it.each([
    "canceled",
    "no_pending_draft",
  ])("keeps chat open for a %s clarification-draft result", (status) => {
    const dispatchNavigate = vi.fn();

    expect(
      dispatchWorkflowActionHandoff(
        [
          {
            actionName: "WORKFLOW",
            success: true,
            values: { status },
          },
        ],
        { dispatchNavigate },
      ),
    ).toBe(false);
    expect(dispatchNavigate).not.toHaveBeenCalled();
  });
});
