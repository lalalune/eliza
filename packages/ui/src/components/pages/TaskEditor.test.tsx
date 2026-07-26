// @vitest-environment jsdom
/**
 * Verifies that every editable prompt automation uses trigger CRUD, including
 * one-time future-date validation and read-only legacy Workbench rows.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client-types-core";

const { createTriggerMock, updateTriggerMock } = vi.hoisted(() => ({
  createTriggerMock: vi.fn(),
  updateTriggerMock: vi.fn(),
}));

vi.mock("../../api", () => ({
  client: {
    createTrigger: createTriggerMock,
    updateTrigger: updateTriggerMock,
  },
}));
vi.mock("../../state/TranslationContext.hooks", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? key,
  }),
}));

import { TaskEditor } from "./TaskEditor";

const FUTURE_LOCAL = "2099-01-02T03:04";

function save() {
  fireEvent.click(screen.getByTestId("task-editor-save"));
}

describe("TaskEditor prompt-trigger persistence", () => {
  beforeEach(() => {
    createTriggerMock.mockReset().mockResolvedValue({ trigger: {} });
    updateTriggerMock.mockReset().mockResolvedValue({ trigger: {} });
  });

  afterEach(() => cleanup());

  it("creates a one-time prompt trigger with a canonical future ISO timestamp", async () => {
    const onSaved = vi.fn();
    render(
      <TaskEditor
        initial={{
          name: "Follow up",
          prompt: "Send me the follow-up checklist",
          scheduleKind: "once",
        }}
        onSaved={onSaved}
      />,
    );

    fireEvent.change(screen.getByTestId("task-editor-scheduled-at"), {
      target: { value: FUTURE_LOCAL },
    });
    save();

    await waitFor(() => expect(createTriggerMock).toHaveBeenCalledTimes(1));
    expect(createTriggerMock).toHaveBeenCalledWith({
      kind: "prompt",
      displayName: "Follow up",
      instructions: "Send me the follow-up checklist",
      triggerType: "once",
      scheduledAtIso: new Date(FUTURE_LOCAL).toISOString(),
      cronExpression: undefined,
      eventKind: undefined,
      wakeMode: "inject_now",
      enabled: true,
    });
    expect(updateTriggerMock).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("requires a one-time schedule to be in the future", async () => {
    render(
      <TaskEditor
        initial={{
          name: "Expired reminder",
          prompt: "This must not run immediately",
          scheduleKind: "once",
          scheduledAtIso: "2000-01-02T03:04:00.000Z",
        }}
      />,
    );

    save();

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Choose a future date and time.",
    );
    expect(createTriggerMock).not.toHaveBeenCalled();
    expect(updateTriggerMock).not.toHaveBeenCalled();
  });

  it("requires a date and time for a one-time schedule", async () => {
    render(
      <TaskEditor
        initial={{
          name: "Undated reminder",
          prompt: "Wait until I choose a time",
          scheduleKind: "once",
        }}
      />,
    );

    save();

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Choose a date and time to run this automation.",
    );
    expect(createTriggerMock).not.toHaveBeenCalled();
  });

  it("creates a recurring prompt trigger with its cron expression", async () => {
    render(
      <TaskEditor
        initial={{
          name: "Morning digest",
          prompt: "Summarize my calendar",
          scheduleKind: "recurring",
          cronExpression: "0 9 * * *",
        }}
      />,
    );

    save();

    await waitFor(() => expect(createTriggerMock).toHaveBeenCalledTimes(1));
    expect(createTriggerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "prompt",
        triggerType: "cron",
        cronExpression: "0 9 * * *",
        scheduledAtIso: undefined,
        eventKind: undefined,
      }),
    );
  });

  it("turns an always-on tier rejection into a continuous-billing action", async () => {
    createTriggerMock.mockRejectedValueOnce(
      new ApiError({
        kind: "http",
        path: "/api/triggers",
        status: 409,
        code: "workflow_requires_always_on",
        message:
          "Scheduled prompt automations require an always-on agent runtime.",
      }),
    );
    const onEnableAlwaysOn = vi.fn();

    render(
      <TaskEditor
        initial={{
          name: "Morning digest",
          prompt: "Summarize my calendar",
          scheduleKind: "once",
          scheduledAtIso: new Date(FUTURE_LOCAL).toISOString(),
        }}
        cloudAgentId="agent-lazy-1"
        onEnableAlwaysOn={onEnableAlwaysOn}
      />,
    );

    save();

    const alert = await screen.findByTestId("task-always-on-required");
    expect(alert.textContent).toContain("Always-on agent required");
    expect(alert.textContent).toContain("continuous hourly credit usage");
    expect(createTriggerMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /enable always-on/i }));
    expect(onEnableAlwaysOn).toHaveBeenCalledWith("agent-lazy-1");
  });

  it("keeps ordinary trigger failures in the generic error state", async () => {
    createTriggerMock.mockRejectedValueOnce(new Error("Trigger store offline"));

    render(
      <TaskEditor
        initial={{
          name: "Morning digest",
          prompt: "Summarize my calendar",
          scheduleKind: "once",
          scheduledAtIso: new Date(FUTURE_LOCAL).toISOString(),
        }}
      />,
    );

    save();

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Trigger store offline",
    );
    expect(screen.queryByTestId("task-always-on-required")).toBeNull();
  });

  it("creates an event prompt trigger with its selected event", async () => {
    render(
      <TaskEditor
        initial={{
          name: "Message triage",
          prompt: "Triage the incoming message",
          scheduleKind: "event",
          eventName: "message.received",
        }}
        availableEvents={[
          { id: "message.received", label: "Message received" },
        ]}
      />,
    );

    save();

    await waitFor(() => expect(createTriggerMock).toHaveBeenCalledTimes(1));
    expect(createTriggerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "prompt",
        triggerType: "event",
        eventKind: "message.received",
        scheduledAtIso: undefined,
        cronExpression: undefined,
      }),
    );
  });

  it("updates the same trigger when its schedule changes to once", async () => {
    render(
      <TaskEditor
        initial={{
          triggerId: "trigger-1",
          name: "Morning digest",
          prompt: "Summarize my calendar",
          scheduleKind: "recurring",
          cronExpression: "0 9 * * *",
        }}
      />,
    );

    fireEvent.click(screen.getByText("Once"));
    fireEvent.change(screen.getByTestId("task-editor-scheduled-at"), {
      target: { value: FUTURE_LOCAL },
    });
    save();

    await waitFor(() => expect(updateTriggerMock).toHaveBeenCalledTimes(1));
    expect(updateTriggerMock).toHaveBeenCalledWith(
      "trigger-1",
      expect.objectContaining({
        kind: "prompt",
        triggerType: "once",
        scheduledAtIso: new Date(FUTURE_LOCAL).toISOString(),
      }),
    );
    expect(createTriggerMock).not.toHaveBeenCalled();
  });

  it("keeps legacy Workbench rows read-only", () => {
    const onCancel = vi.fn();
    render(
      <TaskEditor
        initial={{
          name: "Legacy reminder",
          prompt: "Existing Workbench content",
          scheduleKind: "once",
        }}
        readOnly
        onCancel={onCancel}
      />,
    );

    expect(screen.getByText(/legacy automation is read-only/i)).toBeTruthy();
    expect(
      screen.getByTestId("task-editor-name").hasAttribute("readonly"),
    ).toBe(true);
    expect(screen.queryByTestId("task-editor-save")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(createTriggerMock).not.toHaveBeenCalled();
    expect(updateTriggerMock).not.toHaveBeenCalled();
  });
});
