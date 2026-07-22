/**
 * Bridges successful WORKFLOW chat actions into Automations. Results carrying
 * a workflow id open its editor; lifecycle results without an id open the feed.
 * The URL deep-link survives a view remount while the visualization event
 * updates an Automations feed that is already mounted.
 */

import type { ChatActionResultSummary } from "../../api/client-types-chat";
import { dispatchNavigateViewEvent } from "../../events";
import { formatAutomationHash } from "../../hooks/useAutomationDeepLink";
import {
  dispatchShowAutomationsList,
  dispatchVisualizeWorkflow,
} from "./workflow-graph-events";

function readWorkflowId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isPendingDraftOnlyResult(result: ChatActionResultSummary): boolean {
  return (
    result.values?.status === "canceled" ||
    result.values?.status === "no_pending_draft"
  );
}

function findSuccessfulWorkflowAction(
  actionResults: readonly ChatActionResultSummary[] | undefined,
): ChatActionResultSummary | null {
  if (!Array.isArray(actionResults)) return null;
  for (let index = actionResults.length - 1; index >= 0; index--) {
    const result = actionResults[index];
    if (
      result?.success === true &&
      result.actionName?.toUpperCase() === "WORKFLOW"
    ) {
      return result;
    }
  }
  return null;
}

export function findWorkflowIdForActionHandoff(
  actionResults: readonly ChatActionResultSummary[] | undefined,
): string | null {
  return readWorkflowId(
    findSuccessfulWorkflowAction(actionResults)?.values?.workflowId,
  );
}

export function dispatchWorkflowActionHandoff(
  actionResults: readonly ChatActionResultSummary[] | undefined,
  dependencies: {
    dispatchNavigate?: typeof dispatchNavigateViewEvent;
    dispatchShowList?: typeof dispatchShowAutomationsList;
    dispatchVisualize?: typeof dispatchVisualizeWorkflow;
  } = {},
): boolean {
  const workflowAction = findSuccessfulWorkflowAction(actionResults);
  if (!workflowAction || isPendingDraftOnlyResult(workflowAction)) return false;
  const workflowId = readWorkflowId(workflowAction.values?.workflowId);
  const workflowHash = workflowId
    ? formatAutomationHash({ kind: "workflow", id: workflowId })
    : "";
  const dispatchNavigate =
    dependencies.dispatchNavigate ?? dispatchNavigateViewEvent;
  dispatchNavigate({
    viewId: "automations",
    viewPath: `/automations${workflowHash}`,
  });
  if (workflowId) {
    // The URL deep-link opens the editor when AutomationsFeed mounts. The event
    // covers the already-mounted case because pushState emits popstate rather
    // than hashchange, so the existing feed can update without a remount.
    const dispatchVisualize =
      dependencies.dispatchVisualize ?? dispatchVisualizeWorkflow;
    dispatchVisualize(workflowId);
  } else {
    const dispatchShowList =
      dependencies.dispatchShowList ?? dispatchShowAutomationsList;
    dispatchShowList();
  }
  return true;
}
