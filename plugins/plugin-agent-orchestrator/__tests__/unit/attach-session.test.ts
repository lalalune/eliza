/**
 * Pins {@link OrchestratorTaskService.attachSession} — the public API used by
 * `TASKS:create` to bind ACP sessions it spawned via `AcpService.spawnSession`
 * directly (with its own multi-part label / prefix / model routing) into an
 * existing task thread's session index. Without this the store's
 * `sessionTaskIndex` never learns about those sessions, `resolveTaskId`
 * returns undefined, the event bridge drops their events, and DTOs report
 * `0/0 agents` with no token attribution.
 *
 * Pinned surfaces:
 *   1. Attaching a LIVE session indexes it against the task (sessionCount
 *      goes up, latestSessionId flips, activeSessionCount reflects it) AND
 *      promotes the task status from `open` → `active`.
 *   2. Attaching a TERMINAL-ON-ARRIVAL session (the chat create action's
 *      `runPromptAndClose` has already stopped it before mint) still indexes
 *      it for history + future token attribution, but does NOT falsely claim
 *      liveness (task status stays `open`, activeSessionCount stays 0).
 *   3. `resolveTaskId` (exercised via the ACP event bridge) resolves the
 *      attached session back to its task, so post-attach session events land
 *      as task events and token usage rolls up onto the session record.
 *   4. Idempotent: attaching the same sessionId twice is a no-op — no
 *      duplicate rows, no double-status-advance.
 *   5. Unknown taskId returns `false` without throwing (attach failure in
 *      the create action must be logged, not demote the action's success).
 */

import type { IAgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POOLED_ACCOUNT_RECOVERY_METADATA_KEY } from "../../src/services/coding-account-selection.js";
import { OrchestratorTaskService } from "../../src/services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../../src/services/orchestrator-task-store.js";
import { readSmithersDurableRunLink } from "../../src/services/smithers-task-integration.js";

// Suppress default-acceptance-criteria auto-fill so `task_complete` events in
// these tests don't fire the auto-verifier (matches the pattern used in
// orchestrator-task-service.test.ts).
const PREV_GOAL_CONTRACT = process.env.ELIZA_REQUIRE_GOAL_CONTRACT;
beforeAll(() => {
  process.env.ELIZA_REQUIRE_GOAL_CONTRACT = "0";
});
afterAll(() => {
  if (PREV_GOAL_CONTRACT === undefined)
    delete process.env.ELIZA_REQUIRE_GOAL_CONTRACT;
  else process.env.ELIZA_REQUIRE_GOAL_CONTRACT = PREV_GOAL_CONTRACT;
});

/**
 * Minimal ACP stand-in: captures the orchestrator's event-subscription hook
 * so a test can drive session events after attach (to exercise resolveTaskId
 * via the bridge) without needing a real ACP subprocess.
 */
class FakeAcp {
  private handler:
    | ((sessionId: string, event: string, data: unknown) => void)
    | null = null;

  onSessionEvent(
    cb: (sessionId: string, event: string, data: unknown) => void,
  ): () => void {
    this.handler = cb;
    return () => {
      this.handler = null;
    };
  }

  emit(sessionId: string, event: string, data: unknown = {}): void {
    this.handler?.(sessionId, event, data);
  }
}

function runtime(acp?: FakeAcp): IAgentRuntime {
  return {
    getService: () => acp ?? null,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as never;
}

async function makeService(acp?: FakeAcp): Promise<{
  service: OrchestratorTaskService;
  taskId: string;
}> {
  const store = new OrchestratorTaskStore({ backend: "memory" });
  const service = new OrchestratorTaskService(runtime(acp), { store });
  await service.start();
  const task = await service.createTask({
    title: "Ship widget",
    goal: "Bind chat-spawned sessions to the durable thread",
  });
  return { service, taskId: task.id };
}

/** Yield a macrotask so the event bridge's async work settles. */
const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe("OrchestratorTaskService.attachSession", () => {
  it("indexes a live session on the task and promotes status open→active", async () => {
    const { service, taskId } = await makeService();

    const before = await service.getTask(taskId);
    expect(before?.status).toBe("open");
    expect(before?.sessionCount).toBe(0);
    expect(before?.activeSessionCount).toBe(0);

    const ok = await service.attachSession(taskId, {
      sessionId: "chat-sess-1",
      agentType: "codex",
      workdir: "/tmp/workdir",
      status: "ready",
      label: "planner",
      originalTask: "wire attach",
      model: "gpt-5.5",
    });
    expect(ok).toBe(true);

    const after = await service.getTask(taskId);
    expect(after?.sessionCount).toBe(1);
    expect(after?.activeSessionCount).toBe(1);
    expect(after?.latestSessionId).toBe("chat-sess-1");
    expect(after?.status).toBe("active");
    const attached = after?.sessions[0];
    expect(attached?.sessionId).toBe("chat-sess-1");
    expect(attached?.framework).toBe("codex");
    expect(attached?.label).toBe("planner");
    expect(attached?.model).toBe("gpt-5.5");
    expect(attached?.originalTask).toBe("wire attach");
  });

  it("persists the stable Smithers run link on the task-session row", async () => {
    const { service, taskId } = await makeService();
    await service.attachSession(taskId, {
      sessionId: "chat-smithers-durable",
      agentType: "codex",
      workdir: "/tmp/workdir",
      status: "ready",
      metadata: {
        label: "subscription-backed",
        account: {
          providerId: "openai-codex-subscription",
          accountId: "acct-1",
          label: "Work subscription",
        },
      },
      durableRun: {
        version: 1,
        orchestratorTaskId: taskId,
        taskId: `${taskId}:part:0`,
        runId: "stable-run",
        tenantId: "agent-tenant",
        initialPrompt: "perform exactly once",
        state: "pending",
        approvalPreset: "readonly",
        keepAliveAfterComplete: false,
      },
    });

    const detail = await service.getTask(taskId);
    const link = readSmithersDurableRunLink(
      detail?.sessions[0]?.metadata as Record<string, unknown> | undefined,
    );
    expect(link).toMatchObject({
      orchestratorTaskId: taskId,
      runId: "stable-run",
      state: "pending",
      approvalPreset: "readonly",
    });
    expect(detail?.sessions[0]?.metadata.account).toEqual({
      providerId: "openai-codex-subscription",
      accountId: "acct-1",
      label: "Work subscription",
    });
    expect(detail?.sessions[0]?.accountId).toBe("acct-1");
  });

  it("indexes a terminal-on-arrival session without falsely advancing status", async () => {
    // Mirrors the real chat-create path: `runPromptAndClose` has already
    // stopped the session before we mint the thread, so the SpawnResult's
    // status is terminal by the time attach runs. We still want the session
    // linked (for the widget's history + future token attribution), but the
    // task should NOT be lied to about liveness.
    const { service, taskId } = await makeService();

    const ok = await service.attachSession(taskId, {
      sessionId: "chat-sess-terminal",
      agentType: "codex",
      workdir: "/tmp/workdir",
      status: "completed",
      label: "planner",
    });
    expect(ok).toBe(true);

    const detail = await service.getTask(taskId);
    expect(detail?.sessionCount).toBe(1);
    expect(detail?.activeSessionCount).toBe(0);
    expect(detail?.status).toBe("open"); // NOT promoted
    expect(detail?.sessions[0]?.status).toBe("completed");
    expect(detail?.sessions[0]?.stoppedAt).toBeTypeOf("number");
  });

  it("makes resolveTaskId route post-attach session events onto the task", async () => {
    // The event bridge's `resolveTaskId` is the whole reason this API exists.
    // Attach → emit a session event on the fake ACP → the orchestrator
    // resolves the session back to its task and records the event on the
    // task's event log. Without attach the event would be dropped.
    const acp = new FakeAcp();
    const { service, taskId } = await makeService(acp);
    await service.attachSession(taskId, {
      sessionId: "chat-sess-2",
      agentType: "codex",
      workdir: "/tmp/workdir",
      status: "ready",
      label: "planner",
    });

    acp.emit("chat-sess-2", "message", { text: "hello from sub-agent" });
    await flush();

    const detail = await service.getTask(taskId);
    const messageFromSubAgent = detail?.messages.find(
      (m) => m.senderKind === "sub_agent" && m.sessionId === "chat-sess-2",
    );
    expect(messageFromSubAgent?.content).toBe("hello from sub-agent");
  });

  it("is idempotent: attaching the same sessionId twice does not duplicate rows", async () => {
    const { service, taskId } = await makeService();
    const first = await service.attachSession(taskId, {
      sessionId: "chat-sess-3",
      agentType: "codex",
      workdir: "/tmp/workdir",
      status: "ready",
      label: "planner",
    });
    const second = await service.attachSession(taskId, {
      sessionId: "chat-sess-3",
      agentType: "codex",
      workdir: "/tmp/workdir",
      status: "ready",
      label: "planner-2",
    });
    expect(first).toBe(true);
    expect(second).toBe(true);

    const detail = await service.getTask(taskId);
    expect(detail?.sessionCount).toBe(1);
    // The store's addSession upserts by sessionId — one row, regardless.
    expect(
      detail?.sessions.filter((s) => s.sessionId === "chat-sess-3").length,
    ).toBe(1);
  });

  it("preserves a terminal session when a later live attach reuses its id", async () => {
    const { service, taskId } = await makeService();
    await service.attachSession(taskId, {
      sessionId: "chat-sess-terminal-reattach",
      agentType: "codex",
      workdir: "/tmp/workdir",
      status: "completed",
      label: "finished",
      durableRun: {
        version: 1,
        orchestratorTaskId: taskId,
        taskId: `${taskId}:part:0`,
        runId: "terminal-run",
        tenantId: "agent-tenant",
        initialPrompt: "finish exactly once",
        state: "completed",
        keepAliveAfterComplete: false,
      },
    });
    const terminal = await service.getTask(taskId);
    const stoppedAt = terminal?.sessions[0]?.stoppedAt;

    await service.attachSession(taskId, {
      sessionId: "chat-sess-terminal-reattach",
      agentType: "codex",
      workdir: "/tmp/workdir",
      status: "ready",
      label: "late-reconnect",
      durableRun: {
        version: 1,
        orchestratorTaskId: taskId,
        taskId: `${taskId}:part:0`,
        runId: "terminal-run",
        tenantId: "agent-tenant",
        initialPrompt: "finish exactly once",
        state: "running",
        keepAliveAfterComplete: false,
      },
    });

    const after = await service.getTask(taskId);
    expect(after?.sessions[0]?.status).toBe("completed");
    expect(after?.sessions[0]?.stoppedAt).toBe(stoppedAt);
    expect(after?.activeSessionCount).toBe(0);
    expect(after?.status).toBe("open");
    expect(
      readSmithersDurableRunLink(after?.sessions[0]?.metadata)?.state,
    ).toBe("completed");
  });

  it("serializes an attach refresh with a racing terminal account-clear event", async () => {
    const acp = new FakeAcp();
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const service = new OrchestratorTaskService(runtime(acp), { store });
    await service.start();
    const task = await service.createTask({
      title: "Ship widget",
      goal: "Preserve the first terminal result",
    });
    const sessionId = "chat-sess-attach-race";
    await service.attachSession(task.id, {
      sessionId,
      agentType: "codex",
      workdir: "/tmp/workdir",
      status: "ready",
      metadata: {
        durableMarker: "before-race",
        account: {
          providerId: "openai-codex-subscription",
          accountId: "acct-race",
          label: "Race account",
        },
      },
    });

    let releaseWrite: (() => void) | undefined;
    const writeReleased = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let markWriteReached: (() => void) | undefined;
    const writeReached = new Promise<void>((resolve) => {
      markWriteReached = resolve;
    });
    const updateSession = store.updateSession.bind(store);
    let delayed = false;
    vi.spyOn(store, "updateSession").mockImplementation(
      async (candidateSessionId, patch) => {
        if (
          !delayed &&
          candidateSessionId === sessionId &&
          patch.label === "stale-refresh"
        ) {
          delayed = true;
          markWriteReached?.();
          await writeReleased;
        }
        await updateSession(candidateSessionId, patch);
      },
    );

    const attaching = service.attachSession(task.id, {
      sessionId,
      agentType: "codex",
      workdir: "/tmp/workdir",
      status: "ready",
      label: "stale-refresh",
      metadata: { attachMarker: "refresh-applied" },
    });
    await writeReached;
    acp.emit(sessionId, "account_cleared", {
      providerId: "openai-codex-subscription",
      accountId: "acct-race",
      label: "Race account",
    });
    await flush();
    releaseWrite?.();
    await attaching;
    await service.stop();

    const after = await service.getTask(task.id);
    const session = after?.sessions[0];
    expect(session?.status).toBe("errored");
    expect(session?.stoppedAt).toBeTypeOf("number");
    expect(session?.accountId).toBeNull();
    expect(session?.metadata).toMatchObject({
      durableMarker: "before-race",
      attachMarker: "refresh-applied",
      [POOLED_ACCOUNT_RECOVERY_METADATA_KEY]: {
        providerId: "openai-codex-subscription",
        accountId: "acct-race",
      },
    });
    expect(session?.metadata.account).toBeUndefined();
  });

  it("keeps a completed result while a late account clear removes attribution and retains its recovery pin", async () => {
    const acp = new FakeAcp();
    const { service, taskId } = await makeService(acp);
    const sessionId = "chat-sess-terminal-account-clear";
    await service.attachSession(taskId, {
      sessionId,
      agentType: "codex",
      workdir: "/tmp/workdir",
      status: "completed",
      metadata: {
        completionProof: "sha256:proof",
        account: {
          providerId: "openai-codex-subscription",
          accountId: "acct-terminal",
          label: "Terminal account",
        },
      },
    });
    const stoppedAt = (await service.getTask(taskId))?.sessions[0]?.stoppedAt;

    acp.emit(sessionId, "account_cleared", {
      providerId: "openai-codex-subscription",
      accountId: "acct-terminal",
      label: "Terminal account",
    });
    await service.stop();

    const after = await service.getTask(taskId);
    const session = after?.sessions[0];
    expect(session?.status).toBe("completed");
    expect(session?.stoppedAt).toBe(stoppedAt);
    expect(session?.accountProviderId).toBeNull();
    expect(session?.accountId).toBeNull();
    expect(session?.accountLabel).toBeNull();
    expect(session?.metadata).toMatchObject({
      completionProof: "sha256:proof",
      [POOLED_ACCOUNT_RECOVERY_METADATA_KEY]: {
        providerId: "openai-codex-subscription",
        accountId: "acct-terminal",
      },
    });
    expect(session?.metadata.account).toBeUndefined();
    expect(after?.activeSessionCount).toBe(0);
  });

  it("records late ACP events without reviving a terminal session", async () => {
    const acp = new FakeAcp();
    const { service, taskId } = await makeService(acp);
    const sessionId = "chat-sess-terminal-events";
    await service.attachSession(taskId, {
      sessionId,
      agentType: "codex",
      workdir: "/tmp/workdir",
      status: "completed",
      label: "finished",
    });
    const before = await service.getTask(taskId);
    const stoppedAt = before?.sessions[0]?.stoppedAt;

    for (const event of [
      "ready",
      "reconnected",
      "tool_running",
      "blocked",
      "login_required",
      "stopped",
    ]) {
      acp.emit(sessionId, event, { toolCall: { title: "late" } });
    }
    await service.stop();

    const after = await service.getTask(taskId);
    expect(after?.sessions[0]?.status).toBe("completed");
    expect(after?.sessions[0]?.stoppedAt).toBe(stoppedAt);
    expect(after?.activeSessionCount).toBe(0);
    expect(after?.status).toBe("open");
    expect(after?.events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "ready",
        "reconnected",
        "tool_running",
        "blocked",
        "login_required",
        "stopped",
      ]),
    );
  });

  it("returns false on unknown taskId without throwing", async () => {
    const { service } = await makeService();
    const ok = await service.attachSession("no-such-task", {
      sessionId: "chat-sess-4",
      agentType: "codex",
      workdir: "/tmp/workdir",
      status: "ready",
    });
    expect(ok).toBe(false);
  });
});
