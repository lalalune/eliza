/**
 * Verifies trigger-form target-kind preservation, request shaping, and
 * kind-specific validation without rendering the editor.
 */

import { describe, expect, it } from "vitest";
import type { TriggerSummary } from "../../api/client";
import {
  buildCreateRequest,
  buildUpdateRequest,
  emptyForm,
  formFromTrigger,
  type TranslateFn,
  validateTriggerKind,
} from "./trigger-form-utils";

const t: TranslateFn = (key, options) =>
  (options?.defaultValue as string | undefined) ?? key;

function trigger(overrides: Partial<TriggerSummary> = {}): TriggerSummary {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    taskId: "22222222-2222-4222-8222-222222222222",
    displayName: "Message triage",
    instructions: "Triage the incoming message",
    triggerType: "event",
    enabled: true,
    wakeMode: "inject_now",
    createdBy: "test",
    eventKind: "message.received",
    runCount: 0,
    kind: "prompt",
    ...overrides,
  };
}

describe("trigger-form target kinds", () => {
  it("preserves explicit prompt and workflow kinds while reading triggers", () => {
    expect(formFromTrigger(trigger({ kind: "prompt" })).kind).toBe("prompt");
    expect(
      formFromTrigger(
        trigger({
          kind: "workflow",
          workflowId: "daily-review",
          workflowName: "Daily review",
        }),
      ).kind,
    ).toBe("workflow");
  });

  it("infers prompt only for legacy summaries without a workflow target", () => {
    expect(formFromTrigger(trigger({ kind: undefined })).kind).toBe("prompt");
    expect(
      formFromTrigger(
        trigger({ kind: undefined, workflowId: "legacy-workflow" }),
      ).kind,
    ).toBe("workflow");
  });

  it.each([
    ["create", buildCreateRequest],
    ["update", buildUpdateRequest],
  ] as const)("builds a canonical prompt %s request", (_label, build) => {
    const request = build({
      ...emptyForm,
      kind: "prompt",
      displayName: " Message triage ",
      instructions: " Triage the incoming message ",
      workflowId: "must-not-leak",
      workflowName: "Must not leak",
      triggerType: "event",
      eventKind: "message.received",
    });

    expect(request).toMatchObject({
      kind: "prompt",
      displayName: "Message triage",
      instructions: "Triage the incoming message",
      triggerType: "event",
      eventKind: "message.received",
    });
    expect(request.workflowId).toBeUndefined();
    expect(request.workflowName).toBeUndefined();
  });

  it("keeps the selected workflow target in workflow requests", () => {
    const request = buildCreateRequest({
      ...emptyForm,
      kind: "workflow",
      displayName: "Daily review",
      instructions: "",
      workflowId: " daily-review ",
      workflowName: " Daily review workflow ",
    });

    expect(request).toMatchObject({
      kind: "workflow",
      workflowId: "daily-review",
      workflowName: "Daily review workflow",
    });
  });

  it("requires instructions, but not a workflow ID, for prompt triggers", () => {
    expect(
      validateTriggerKind(
        { ...emptyForm, kind: "prompt", instructions: "", workflowId: "" },
        t,
      ),
    ).toBe("Prompt is required.");
    expect(
      validateTriggerKind(
        {
          ...emptyForm,
          kind: "prompt",
          instructions: "Send a digest",
          workflowId: "",
        },
        t,
      ),
    ).toBeNull();
  });

  it("requires a workflow ID, but not instructions, for workflow triggers", () => {
    expect(
      validateTriggerKind(
        {
          ...emptyForm,
          kind: "workflow",
          instructions: "",
          workflowId: "",
        },
        t,
      ),
    ).toBe("triggers.workflowPlaceholder");
    expect(
      validateTriggerKind(
        {
          ...emptyForm,
          kind: "workflow",
          instructions: "",
          workflowId: "daily-review",
        },
        t,
      ),
    ).toBeNull();
  });
});
