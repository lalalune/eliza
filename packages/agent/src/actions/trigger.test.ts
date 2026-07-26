/** Tests chat-trigger subscription gating with an in-memory task boundary. */
import type { IAgentRuntime, Memory, Task, UUID } from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { triggerAction } from "./trigger.ts";

const AGENT_ID = stringToUuid("trigger-action-tier-agent");
const OWNER_ID = stringToUuid("trigger-action-tier-owner");
const ROOM_ID = stringToUuid("trigger-action-tier-room");
const TASK_ID = stringToUuid("trigger-action-tier-task");
const FOREIGN_OWNER_ID = stringToUuid("trigger-action-tier-foreign-owner");

const message: Memory = {
  id: stringToUuid("trigger-action-tier-message"),
  agentId: AGENT_ID,
  entityId: OWNER_ID,
  roomId: ROOM_ID,
  content: { text: "Run my report" },
};

function storedTask(enabled: boolean, ownerEntityId = OWNER_ID): Task {
  return {
    id: TASK_ID,
    name: "TRIGGER_DISPATCH",
    metadata: {
      ownerEntityId,
      ownership: { ownerEntityId, sourceRoomId: ROOM_ID },
      trigger: {
        version: 1,
        triggerId: stringToUuid("trigger-action-tier-trigger"),
        displayName: "Report",
        instructions: "Run report",
        triggerType: "interval",
        enabled,
        wakeMode: "inject_now",
        createdBy: OWNER_ID,
        intervalMs: 60_000,
        runCount: 0,
        kind: "workflow",
        workflowId: "wf-report",
      },
    },
  } as Task;
}

function harness(
  settings: Record<string, unknown>,
  task?: Task,
  listedTasks?: Task[],
) {
  const created: Task[] = [];
  const updateTask = vi.fn(async () => undefined);
  const deleteTask = vi.fn(async () => undefined);
  const tasks = listedTasks ?? (task ? [task] : []);
  const runtime = {
    agentId: AGENT_ID,
    enableAutonomy: true,
    getSetting: (key: string) => settings[key] ?? null,
    getService: () => null,
    getTasks: async () => tasks,
    getTask: async (id: UUID) => (id === task?.id ? task : null),
    createTask: async (input: Task) => {
      created.push({ ...input, id: TASK_ID });
      return TASK_ID;
    },
    updateTask,
    deleteTask,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as IAgentRuntime;
  return { runtime, created, updateTask, deleteTask };
}

const lazySettings = {
  ELIZA_CLOUD_PROVISIONED: "1",
  ELIZA_CLOUD_EXECUTION_TIER: "dedicated-lazy",
};

async function invoke(
  runtime: IAgentRuntime,
  parameters: Record<string, unknown>,
) {
  if (!triggerAction.handler) throw new Error("TRIGGER handler unavailable");
  const result = await triggerAction.handler(runtime, message, undefined, {
    parameters: parameters as never,
  });
  if (!result) throw new Error("TRIGGER handler returned no result");
  return result;
}

describe("TRIGGER action subscription gating", () => {
  it("returns the actionable typed failure for active time-based creation on dedicated-lazy", async () => {
    const { runtime, created } = harness(lazySettings);

    const result = await invoke(runtime, {
      action: "create",
      triggerType: "interval",
      intervalMs: 60_000,
      workflowId: "wf-report",
      instructions: "Run report",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("workflow_requires_always_on");
    expect(result.data).toMatchObject({
      code: "workflow_requires_always_on",
      capability: "scheduled_workflows",
      currentExecutionTier: "dedicated-lazy",
      requiredExecutionTier: "dedicated-always",
      upgradeRequired: true,
    });
    expect(created).toHaveLength(0);
  });

  it("allows a disabled draft on dedicated-lazy without arming its real cadence", async () => {
    const { runtime, created } = harness(lazySettings);

    const result = await invoke(runtime, {
      action: "create",
      triggerType: "interval",
      intervalMs: 60_000,
      workflowId: "wf-report",
      instructions: "Run report",
      enabled: false,
    });

    expect(result.success).toBe(true);
    expect(created).toHaveLength(1);
    const metadata = created[0]?.metadata as {
      updateInterval?: number;
      trigger?: { enabled?: boolean };
    };
    expect(metadata.trigger?.enabled).toBe(false);
    expect(metadata.updateInterval).toBeGreaterThan(60_000);
  });

  it("rejects updating a disabled timer into an active timer on dedicated-lazy", async () => {
    const { runtime, updateTask } = harness(lazySettings, storedTask(false));

    const result = await invoke(runtime, {
      action: "update",
      taskId: TASK_ID,
      enabled: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("workflow_requires_always_on");
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("allows active creation on dedicated-always", async () => {
    const { runtime, created } = harness({
      ELIZA_CLOUD_PROVISIONED: true,
      ELIZA_CLOUD_EXECUTION_TIER: "dedicated-always",
    });

    const result = await invoke(runtime, {
      action: "create",
      triggerType: "interval",
      intervalMs: 60_000,
      workflowId: "wf-report",
      instructions: "Run report",
    });

    expect(result.success).toBe(true);
    expect(created).toHaveLength(1);
  });

  it("returns the uniform not-found failure for every foreign-owner UUID operation", async () => {
    for (const [action, parameters] of [
      ["update", { enabled: true }],
      ["delete", {}],
      ["run", {}],
      ["toggle", { enabled: true }],
    ] as const) {
      const { runtime, updateTask, deleteTask } = harness(
        {
          ELIZA_CLOUD_PROVISIONED: "true",
          ELIZA_CLOUD_EXECUTION_TIER: "dedicated-always",
        },
        storedTask(false, FOREIGN_OWNER_ID),
      );

      const result = await invoke(runtime, {
        action,
        taskId: TASK_ID,
        ...parameters,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("TRIGGER_NOT_FOUND");
      expect(updateTask).not.toHaveBeenCalled();
      expect(deleteTask).not.toHaveBeenCalled();
    }
  });

  it("does not apply foreign triggers to managed-owner duplicate checks", async () => {
    const foreignTask = storedTask(true, FOREIGN_OWNER_ID);
    const { runtime, created } = harness(
      {
        ELIZA_CLOUD_PROVISIONED: true,
        ELIZA_CLOUD_EXECUTION_TIER: "dedicated-always",
      },
      foreignTask,
    );

    const result = await invoke(runtime, {
      action: "create",
      triggerType: "interval",
      intervalMs: 60_000,
      workflowId: "wf-report",
      instructions: "Run report",
    });

    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty("duplicateTaskId");
    expect(created).toHaveLength(1);
  });

  it("does not apply foreign triggers to the managed-owner active limit", async () => {
    const foreignTasks = Array.from({ length: 100 }, () =>
      storedTask(true, FOREIGN_OWNER_ID),
    );
    const { runtime, created } = harness(
      {
        ELIZA_CLOUD_PROVISIONED: "1",
        ELIZA_CLOUD_EXECUTION_TIER: "dedicated-always",
      },
      undefined,
      foreignTasks,
    );

    const result = await invoke(runtime, {
      action: "create",
      triggerType: "interval",
      intervalMs: 60_000,
      workflowId: "wf-owner-limit",
      instructions: "Different owner report",
    });

    expect(result.success).toBe(true);
    expect(created).toHaveLength(1);
  });

  it("fails closed when flat and nested authoritative owners disagree", async () => {
    const mismatched = storedTask(false, FOREIGN_OWNER_ID);
    (mismatched.metadata as Record<string, unknown>).ownerEntityId = OWNER_ID;
    const { runtime, updateTask } = harness(
      {
        ELIZA_CLOUD_PROVISIONED: true,
        ELIZA_CLOUD_EXECUTION_TIER: "dedicated-always",
      },
      mismatched,
    );

    const result = await invoke(runtime, {
      action: "toggle",
      taskId: TASK_ID,
      enabled: true,
    });

    expect(result.error).toBe("TRIGGER_NOT_FOUND");
    expect(updateTask).not.toHaveBeenCalled();
  });
});
