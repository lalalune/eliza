/**
 * Cross-component event bus for Automations selection handoffs.
 *
 * Chat surfaces can select a workflow or clear the current editor back to the
 * list. AutomationsFeed consumes both commands without requiring a remount.
 */

export const VISUALIZE_WORKFLOW_EVENT = "eliza:automations:visualize-workflow";
export const SHOW_AUTOMATIONS_LIST_EVENT = "eliza:automations:show-list";

export interface VisualizeWorkflowEventDetail {
  workflowId: string;
}

export function dispatchVisualizeWorkflow(workflowId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<VisualizeWorkflowEventDetail>(VISUALIZE_WORKFLOW_EVENT, {
      detail: { workflowId },
    }),
  );
}

export function dispatchShowAutomationsList(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SHOW_AUTOMATIONS_LIST_EVENT));
}
