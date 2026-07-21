/**
 * Exercises the production TASKS → durable task store → Smithers recovery
 * chokepoint across fresh service/ACP instances and a file-backed task store.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CodingAgentSelectorBridge,
  ElizaError,
  type IAgentRuntime,
  setCodingAgentSelectorBridge,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTaskAction } from "../../src/actions/tasks.js";
import {
  POOLED_ACCOUNT_RECOVERY_METADATA_KEY,
  POOLED_ACCOUNT_RECOVERY_UNAVAILABLE_CODE,
} from "../../src/services/coding-account-selection.js";
import { OrchestratorTaskService } from "../../src/services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../../src/services/orchestrator-task-store.js";
import {
  readSmithersDurableRunLink,
  SMITHERS_DURABLE_RUN_METADATA_KEY,
  type SmithersDurableRunLink,
  smithersDurableRunMetadata,
} from "../../src/services/smithers-task-integration.js";
import type {
  SessionEventName,
  SessionInfo,
  SpawnOptions,
  SpawnResult,
} from "../../src/services/types.js";
import {
  callback,
  memory,
  state,
} from "../../src/test-utils/action-test-utils.js";

const priorSmithers = process.env.ELIZA_ORCHESTRATOR_SMITHERS;
const priorGoalContract = process.env.ELIZA_REQUIRE_GOAL_CONTRACT;
const priorAutoVerify = process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;

beforeAll(() => {
  process.env.ELIZA_ORCHESTRATOR_SMITHERS = "1";
  process.env.ELIZA_REQUIRE_GOAL_CONTRACT = "0";
  process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = "0";
});

afterAll(() => {
  if (priorSmithers === undefined)
    delete process.env.ELIZA_ORCHESTRATOR_SMITHERS;
  else process.env.ELIZA_ORCHESTRATOR_SMITHERS = priorSmithers;
  if (priorGoalContract === undefined)
    delete process.env.ELIZA_REQUIRE_GOAL_CONTRACT;
  else process.env.ELIZA_REQUIRE_GOAL_CONTRACT = priorGoalContract;
  if (priorAutoVerify === undefined)
    delete process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
  else process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = priorAutoVerify;
});

type SessionEventHandler = (
  sessionId: string,
  event: SessionEventName,
  data: unknown,
) => void;

type SessionEventReceiver = {
  onSessionEvent(
    sessionId: string,
    event: SessionEventName,
    data: unknown,
  ): Promise<void>;
};

interface PersistedAcpState {
  sessions: Map<string, SessionInfo>;
  prompts: string[];
  nextId: number;
}

class RestartableAcp {
  readonly emitsPromptTerminalEvents = true;
  private readonly handlers = new Set<SessionEventHandler>();
  private readonly liveSessions = new Set<string>();

  constructor(private readonly persisted: PersistedAcpState) {}

  async spawnSession(opts: SpawnOptions): Promise<SpawnResult> {
    const id = `restart-session-${++this.persisted.nextId}`;
    const now = new Date();
    const session: SessionInfo = {
      id,
      name: id,
      agentType: opts.agentType ?? "codex",
      workdir: opts.workdir ?? tmpdir(),
      status: "ready",
      approvalPreset: opts.approvalPreset ?? "standard",
      createdAt: now,
      lastActivityAt: now,
      metadata: { ...(opts.metadata ?? {}) },
    };
    this.persisted.sessions.set(id, session);
    this.liveSessions.add(id);
    this.emitSessionEvent(id, "ready", { sessionId: id });
    return this.spawnResult(session);
  }

  spawnSessionForDurableRecovery(opts: SpawnOptions): Promise<SpawnResult> {
    return this.spawnSession(opts);
  }

  async sendPrompt(sessionId: string, text: string) {
    this.persisted.prompts.push(text);
    const session = this.persisted.sessions.get(sessionId);
    if (!session) throw new Error(`missing fake ACP session ${sessionId}`);
    session.status = "ready";
    session.lastActivityAt = new Date();
    const result = {
      sessionId,
      response: "restart-safe result",
      finalText: "restart-safe result",
      stopReason: "end_turn",
      durationMs: 1,
    };
    this.emitSessionEvent(sessionId, "task_complete", {
      response: result.finalText,
      stopReason: result.stopReason,
    });
    return result;
  }

  sendToSession(sessionId: string, text: string) {
    return this.sendPrompt(sessionId, text);
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = this.persisted.sessions.get(sessionId);
    if (!session) return;
    session.status = "stopped";
    session.lastActivityAt = new Date();
    this.liveSessions.delete(sessionId);
    this.emitSessionEvent(sessionId, "stopped", { sessionId });
  }

  async cancelSession(sessionId: string): Promise<void> {
    const session = this.persisted.sessions.get(sessionId);
    if (session) session.status = "cancelled";
  }

  async listSessions(): Promise<SessionInfo[]> {
    return [...this.persisted.sessions.values()];
  }

  async getSession(sessionId: string): Promise<SessionInfo | undefined> {
    return this.persisted.sessions.get(sessionId);
  }

  restoreLiveSession(session: SessionInfo): void {
    this.persisted.sessions.set(session.id, session);
    this.liveSessions.add(session.id);
  }

  async updateSessionMetadata(
    sessionId: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const session = this.persisted.sessions.get(sessionId);
    if (!session) throw new Error(`missing fake ACP session ${sessionId}`);
    session.metadata = { ...(session.metadata ?? {}), ...patch };
  }

  async prepareSessionForDurableRecovery(
    sessionId: string,
  ): Promise<SpawnResult> {
    const prior = this.persisted.sessions.get(sessionId);
    if (!prior) throw new Error(`missing fake ACP session ${sessionId}`);
    if (this.liveSessions.has(sessionId)) return this.spawnResult(prior);
    const replacement = await this.spawnSession({
      agentType: prior.agentType,
      workdir: prior.workdir,
      approvalPreset: prior.approvalPreset,
      metadata: { ...(prior.metadata ?? {}), reattachedFrom: prior.id },
    });
    prior.status = "stopped";
    return replacement;
  }

  onSessionEvent(handler: SessionEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emitSessionEvent(
    sessionId: string,
    event: SessionEventName,
    data: unknown,
  ): void {
    for (const handler of this.handlers) handler(sessionId, event, data);
  }

  async resolveAgentType(): Promise<string> {
    return "codex";
  }

  private spawnResult(session: SessionInfo): SpawnResult {
    return {
      sessionId: session.id,
      id: session.id,
      name: session.name ?? session.id,
      agentType: session.agentType,
      workdir: session.workdir,
      status: session.status,
      metadata: session.metadata,
    };
  }
}

class RevokedAccountAcp extends RestartableAcp {
  readonly recoveryOptions: SpawnOptions[] = [];

  override async spawnSessionForDurableRecovery(
    opts: SpawnOptions,
  ): Promise<SpawnResult> {
    this.recoveryOptions.push(opts);
    throw new ElizaError("linked account was revoked", {
      code: POOLED_ACCOUNT_RECOVERY_UNAVAILABLE_CODE,
      severity: "ephemeral",
    });
  }
}

const RESTORED_ACCOUNT = {
  providerId: "openai-codex",
  accountId: "restored-account",
  label: "Restored",
  source: "oauth",
  strategy: "least-used",
} as const;

class RestorableAccountAcp extends RestartableAcp {
  available = false;
  readonly recoveryOptions: SpawnOptions[] = [];

  override async spawnSessionForDurableRecovery(
    opts: SpawnOptions,
  ): Promise<SpawnResult> {
    this.recoveryOptions.push(opts);
    if (!this.available) {
      throw new ElizaError("linked account is temporarily unavailable", {
        code: POOLED_ACCOUNT_RECOVERY_UNAVAILABLE_CODE,
        severity: "ephemeral",
      });
    }
    const pinned = opts.metadata?.[POOLED_ACCOUNT_RECOVERY_METADATA_KEY];
    if (!pinned || typeof pinned !== "object") {
      throw new Error("expected a durable recovery account pin");
    }
    const metadata = { ...(opts.metadata ?? {}), account: pinned };
    delete metadata[POOLED_ACCOUNT_RECOVERY_METADATA_KEY];
    return this.spawnSession({ ...opts, metadata });
  }

  override async sendPrompt(sessionId: string, text: string) {
    this.emitSessionEvent(sessionId, "usage_update", {
      provider: "openai-codex",
      model: "gpt-5.4",
      inputTokens: 11,
      outputTokens: 7,
      reasoningTokens: 3,
      cacheTokens: 2,
      costUsd: 0.25,
      state: "measured",
      sourceEventId: "restored-account-turn",
    });
    return super.sendPrompt(sessionId, text);
  }
}

function runtimeFor(acp: RestartableAcp, taskService: unknown): IAgentRuntime {
  return {
    agentId: "restart-tenant",
    getService: vi.fn((serviceType: string) =>
      serviceType === "ORCHESTRATOR_TASK_SERVICE" ? taskService : acp,
    ),
    hasService: vi.fn(() => true),
    getRoom: vi.fn(async () => ({ id: "room1" })),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    reportError: vi.fn(),
    getSetting: vi.fn(() => undefined),
  } as never;
}

async function recoverWithoutAggregate(
  service: OrchestratorTaskService,
  acp: RestartableAcp,
): Promise<{ recovered: number; skipped: number }> {
  try {
    return await service.recoverInterruptedSmithersRuns(acp as never);
  } catch (error) {
    if (error instanceof AggregateError && error.errors[0]) {
      throw error.errors[0];
    }
    throw error;
  }
}

describe("TASKS Smithers restart recovery", () => {
  it("ignores foreign tenants and task/link ownership mismatches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tasks-smithers-tenant-"));
    const persistedAcp: PersistedAcpState = {
      sessions: new Map(),
      prompts: [],
      nextId: 0,
    };
    const acp = new RestartableAcp(persistedAcp);
    const store = new OrchestratorTaskStore({
      stateFile: join(dir, "orchestrator-tasks.json"),
    });
    const service = new OrchestratorTaskService(runtimeFor(acp, null), {
      store,
    });
    try {
      const foreignTask = await service.createTask({
        title: "Foreign tenant",
        goal: "Must not run here",
      });
      const foreignLink: SmithersDurableRunLink = {
        version: 1,
        orchestratorTaskId: foreignTask.id,
        taskId: `${foreignTask.id}:part:0`,
        runId: "foreign-run",
        tenantId: "another-agent",
        initialPrompt: "foreign secret prompt",
        state: "running",
        keepAliveAfterComplete: false,
      };
      await service.attachSession(foreignTask.id, {
        sessionId: "foreign-session",
        agentType: "codex",
        workdir: dir,
        status: "ready",
        metadata: {
          taskId: foreignTask.id,
          ...smithersDurableRunMetadata(foreignLink),
        },
        durableRun: foreignLink,
      });

      const ownerTask = await service.createTask({
        title: "Actual owner",
        goal: "Own the persisted session",
      });
      const targetTask = await service.createTask({
        title: "Wrong target",
        goal: "Must not receive another task's session",
      });
      const mismatchedLink: SmithersDurableRunLink = {
        version: 1,
        orchestratorTaskId: targetTask.id,
        taskId: `${targetTask.id}:part:0`,
        runId: "mismatched-run",
        tenantId: "restart-tenant",
        initialPrompt: "misbound secret prompt",
        state: "running",
        keepAliveAfterComplete: false,
      };
      await service.attachSession(ownerTask.id, {
        sessionId: "misbound-session",
        agentType: "codex",
        workdir: dir,
        status: "ready",
        metadata: {
          taskId: ownerTask.id,
          ...smithersDurableRunMetadata(mismatchedLink),
        },
        durableRun: mismatchedLink,
      });

      const metadataMismatchTask = await service.createTask({
        title: "Wrong metadata owner",
        goal: "Must not trust a conflicting metadata task id",
      });
      const metadataMismatchLink: SmithersDurableRunLink = {
        version: 1,
        orchestratorTaskId: metadataMismatchTask.id,
        taskId: `${metadataMismatchTask.id}:part:0`,
        runId: "metadata-mismatched-run",
        tenantId: "restart-tenant",
        initialPrompt: "misattributed metadata prompt",
        state: "running",
        keepAliveAfterComplete: false,
      };
      await service.attachSession(metadataMismatchTask.id, {
        sessionId: "metadata-misbound-session",
        agentType: "codex",
        workdir: dir,
        status: "ready",
        metadata: {
          taskId: ownerTask.id,
          ...smithersDurableRunMetadata(metadataMismatchLink),
        },
        durableRun: metadataMismatchLink,
      });

      await expect(
        service.recoverInterruptedSmithersRuns(acp as never),
      ).resolves.toEqual({ recovered: 0, skipped: 3 });
      expect(persistedAcp.prompts).toHaveLength(0);
      expect(persistedAcp.sessions.size).toBe(0);
    } finally {
      await service.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects present-invalid task ownership and a malformed sibling run contract", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tasks-smithers-malformed-"));
    const persistedAcp: PersistedAcpState = {
      sessions: new Map(),
      prompts: [],
      nextId: 0,
    };
    const acp = new RestartableAcp(persistedAcp);
    const store = new OrchestratorTaskStore({
      stateFile: join(dir, "orchestrator-tasks.json"),
    });
    const service = new OrchestratorTaskService(runtimeFor(acp, null), {
      store,
    });
    try {
      const malformedOwnerTask = await service.createTask({
        title: "Malformed owner",
        goal: "Never recover an unowned session",
      });
      const malformedOwnerLink: SmithersDurableRunLink = {
        version: 1,
        orchestratorTaskId: malformedOwnerTask.id,
        taskId: `${malformedOwnerTask.id}:part:0`,
        runId: "malformed-owner-run",
        tenantId: "restart-tenant",
        initialPrompt: "must remain stopped",
        state: "running",
        keepAliveAfterComplete: false,
      };
      await service.attachSession(malformedOwnerTask.id, {
        sessionId: "malformed-owner-session",
        agentType: "codex",
        workdir: dir,
        status: "ready",
        metadata: {
          taskId: "",
          ...smithersDurableRunMetadata(malformedOwnerLink),
        },
        durableRun: malformedOwnerLink,
      });

      const malformedContractTask = await service.createTask({
        title: "Malformed policy",
        goal: "Never normalize a corrupted policy to absence",
      });
      const validLink: SmithersDurableRunLink = {
        version: 1,
        orchestratorTaskId: malformedContractTask.id,
        taskId: `${malformedContractTask.id}:part:0`,
        runId: "malformed-policy-run",
        tenantId: "restart-tenant",
        initialPrompt: "must preserve readonly policy",
        state: "running",
        approvalPreset: "readonly",
        keepAliveAfterComplete: false,
      };
      const sessionId = "malformed-policy-session";
      await service.attachSession(malformedContractTask.id, {
        sessionId,
        agentType: "codex",
        workdir: dir,
        status: "ready",
        metadata: {
          taskId: malformedContractTask.id,
          ...smithersDurableRunMetadata(validLink),
        },
        durableRun: validLink,
      });
      const now = new Date();
      persistedAcp.sessions.set(sessionId, {
        id: sessionId,
        name: sessionId,
        agentType: "codex",
        workdir: dir,
        status: "ready",
        approvalPreset: "readonly",
        createdAt: now,
        lastActivityAt: now,
        metadata: {
          taskId: malformedContractTask.id,
          [SMITHERS_DURABLE_RUN_METADATA_KEY]: {
            ...validLink,
            approvalPreset: "root",
          },
        },
      });

      await expect(
        service.recoverInterruptedSmithersRuns(acp as never),
      ).resolves.toEqual({ recovered: 0, skipped: 2 });
      expect(persistedAcp.prompts).toHaveLength(0);
    } finally {
      await service.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a session when its ACP and task-store links name different runs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tasks-smithers-copy-link-"));
    const persistedAcp: PersistedAcpState = {
      sessions: new Map(),
      prompts: [],
      nextId: 0,
    };
    const acp = new RestartableAcp(persistedAcp);
    const store = new OrchestratorTaskStore({
      stateFile: join(dir, "orchestrator-tasks.json"),
    });
    const service = new OrchestratorTaskService(runtimeFor(acp, null), {
      store,
    });
    try {
      const task = await service.createTask({
        title: "Conflicting durable copies",
        goal: "Never choose between different persisted run identities",
      });
      const taskLink: SmithersDurableRunLink = {
        version: 1,
        orchestratorTaskId: task.id,
        taskId: `${task.id}:part:0`,
        runId: "task-store-run",
        tenantId: "restart-tenant",
        initialPrompt: "task store prompt",
        state: "running",
        keepAliveAfterComplete: false,
      };
      await service.attachSession(task.id, {
        sessionId: "conflicting-copy-session",
        agentType: "codex",
        workdir: dir,
        status: "ready",
        metadata: {
          taskId: task.id,
          ...smithersDurableRunMetadata(taskLink),
        },
        durableRun: taskLink,
      });
      const now = new Date();
      persistedAcp.sessions.set("conflicting-copy-session", {
        id: "conflicting-copy-session",
        name: "conflicting-copy-session",
        agentType: "codex",
        workdir: dir,
        status: "ready",
        approvalPreset: "standard",
        createdAt: now,
        lastActivityAt: now,
        metadata: {
          taskId: task.id,
          ...smithersDurableRunMetadata({
            ...taskLink,
            runId: "acp-store-run",
            initialPrompt: "ACP store prompt",
          }),
        },
      });

      await expect(
        service.recoverInterruptedSmithersRuns(acp as never),
      ).resolves.toEqual({ recovered: 0, skipped: 2 });
      expect(persistedAcp.prompts).toHaveLength(0);
    } finally {
      await service.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when duplicate durable copies drift on any immutable run field", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tasks-smithers-contract-"));
    const persistedAcp: PersistedAcpState = {
      sessions: new Map(),
      prompts: [],
      nextId: 0,
    };
    const acp = new RestartableAcp(persistedAcp);
    const store = new OrchestratorTaskStore({
      stateFile: join(dir, "orchestrator-tasks.json"),
    });
    const service = new OrchestratorTaskService(runtimeFor(acp, null), {
      store,
    });
    const drifts: Array<[string, Partial<SmithersDurableRunLink>]> = [
      ["initialPrompt", { initialPrompt: "changed prompt" }],
      ["approvalPreset", { approvalPreset: "approve-all" }],
      ["model", { model: "gpt-5.4-mini" }],
      ["timeoutMs", { timeoutMs: 90_000 }],
      ["maxTurns", { maxTurns: 9 }],
      ["keepAliveAfterComplete", { keepAliveAfterComplete: false }],
    ];
    try {
      for (const [field, drift] of drifts) {
        const task = await service.createTask({
          title: `Immutable ${field}`,
          goal: "Never choose between incompatible durable contracts",
        });
        const taskLink: SmithersDurableRunLink = {
          version: 1,
          orchestratorTaskId: task.id,
          taskId: `${task.id}:part:0`,
          runId: `contract-${field}`,
          tenantId: "restart-tenant",
          initialPrompt: "stable prompt",
          state: "running",
          approvalPreset: "readonly",
          model: "gpt-5.4",
          timeoutMs: 30_000,
          maxTurns: 4,
          keepAliveAfterComplete: true,
        };
        const sessionId = `contract-session-${field}`;
        await service.attachSession(task.id, {
          sessionId,
          agentType: "codex",
          workdir: dir,
          status: "ready",
          metadata: {
            taskId: task.id,
            ...smithersDurableRunMetadata(taskLink),
          },
          durableRun: taskLink,
        });
        const now = new Date();
        persistedAcp.sessions.set(sessionId, {
          id: sessionId,
          name: sessionId,
          agentType: "codex",
          workdir: dir,
          status: "ready",
          approvalPreset: "readonly",
          createdAt: now,
          lastActivityAt: now,
          metadata: {
            taskId: task.id,
            ...smithersDurableRunMetadata({ ...taskLink, ...drift }),
          },
        });
      }

      await expect(
        service.recoverInterruptedSmithersRuns(acp as never),
      ).resolves.toEqual({ recovered: 0, skipped: drifts.length });
      expect(persistedAcp.prompts).toHaveLength(0);
    } finally {
      await service.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("lets a terminal duplicate dominate stale active copies of the same run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tasks-smithers-terminal-"));
    const persistedAcp: PersistedAcpState = {
      sessions: new Map(),
      prompts: [],
      nextId: 0,
    };
    const acp = new RestartableAcp(persistedAcp);
    const store = new OrchestratorTaskStore({
      stateFile: join(dir, "orchestrator-tasks.json"),
    });
    const service = new OrchestratorTaskService(runtimeFor(acp, null), {
      store,
    });
    try {
      for (const terminalState of ["completed", "superseded"] as const) {
        const task = await service.createTask({
          title: `Terminal ${terminalState}`,
          goal: "Never replay a terminal Smithers run",
        });
        const link: SmithersDurableRunLink = {
          version: 1,
          orchestratorTaskId: task.id,
          taskId: `${task.id}:part:0`,
          runId: `terminal-${terminalState}`,
          tenantId: "restart-tenant",
          initialPrompt: "must run at most once",
          state: "running",
          keepAliveAfterComplete: false,
        };
        await service.attachSession(task.id, {
          sessionId: `stale-${terminalState}`,
          agentType: "codex",
          workdir: dir,
          status: "ready",
          metadata: {
            taskId: task.id,
            ...smithersDurableRunMetadata(link),
          },
          durableRun: link,
        });
        const terminalLink: SmithersDurableRunLink = {
          ...link,
          state: terminalState,
        };
        await service.attachSession(task.id, {
          sessionId: `terminal-${terminalState}`,
          agentType: "codex",
          workdir: dir,
          status: "stopped",
          metadata: {
            taskId: task.id,
            ...smithersDurableRunMetadata(terminalLink),
          },
          durableRun: terminalLink,
        });
      }

      await expect(
        service.recoverInterruptedSmithersRuns(acp as never),
      ).resolves.toEqual({ recovered: 0, skipped: 2 });
      expect(persistedAcp.prompts).toHaveLength(0);
      expect(persistedAcp.sessions.size).toBe(0);
    } finally {
      await service.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed account fields even when a sibling attribution is valid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tasks-smithers-account-shape-"));
    const persistedAcp: PersistedAcpState = {
      sessions: new Map(),
      prompts: [],
      nextId: 0,
    };
    const acp = new RestartableAcp(persistedAcp);
    const store = new OrchestratorTaskStore({
      stateFile: join(dir, "orchestrator-tasks.json"),
    });
    const service = new OrchestratorTaskService(runtimeFor(acp, null), {
      store,
    });
    try {
      const malformedPinTask = await service.createTask({
        title: "Malformed recovery pin",
        goal: "Do not inherit host authentication",
      });
      const malformedPinLink: SmithersDurableRunLink = {
        version: 1,
        orchestratorTaskId: malformedPinTask.id,
        taskId: `${malformedPinTask.id}:part:0`,
        runId: "malformed-pin-run",
        tenantId: "restart-tenant",
        initialPrompt: "subscription-only work",
        state: "running",
        keepAliveAfterComplete: false,
      };
      await service.attachSession(malformedPinTask.id, {
        sessionId: "malformed-pin-session",
        agentType: "codex",
        workdir: dir,
        status: "ready",
        metadata: {
          taskId: malformedPinTask.id,
          [POOLED_ACCOUNT_RECOVERY_METADATA_KEY]: {
            providerId: "   ",
            accountId: RESTORED_ACCOUNT.accountId,
          },
          ...smithersDurableRunMetadata(malformedPinLink),
        },
        durableRun: malformedPinLink,
      });
      await store.updateSession("malformed-pin-session", {
        accountProviderId: RESTORED_ACCOUNT.providerId,
        accountId: RESTORED_ACCOUNT.accountId,
        accountLabel: RESTORED_ACCOUNT.label,
      });

      const malformedAccountTask = await service.createTask({
        title: "Malformed ACP account",
        goal: "Do not ignore a corrupted serving identity",
      });
      const malformedAccountLink: SmithersDurableRunLink = {
        version: 1,
        orchestratorTaskId: malformedAccountTask.id,
        taskId: `${malformedAccountTask.id}:part:0`,
        runId: "malformed-account-run",
        tenantId: "restart-tenant",
        initialPrompt: "subscription-attributed work",
        state: "running",
        keepAliveAfterComplete: false,
      };
      const malformedAccountSessionId = "malformed-account-session";
      await service.attachSession(malformedAccountTask.id, {
        sessionId: malformedAccountSessionId,
        agentType: "codex",
        workdir: dir,
        status: "ready",
        metadata: {
          taskId: malformedAccountTask.id,
          account: RESTORED_ACCOUNT,
          ...smithersDurableRunMetadata(malformedAccountLink),
        },
        durableRun: malformedAccountLink,
      });
      const now = new Date();
      persistedAcp.sessions.set(malformedAccountSessionId, {
        id: malformedAccountSessionId,
        name: malformedAccountSessionId,
        agentType: "codex",
        workdir: dir,
        status: "ready",
        approvalPreset: "standard",
        createdAt: now,
        lastActivityAt: now,
        metadata: {
          taskId: malformedAccountTask.id,
          account: { providerId: RESTORED_ACCOUNT.providerId },
          ...smithersDurableRunMetadata(malformedAccountLink),
        },
      });

      let recoveryError: unknown;
      try {
        await service.recoverInterruptedSmithersRuns(acp as never);
      } catch (error) {
        recoveryError = error;
      }
      expect(recoveryError).toBeInstanceOf(AggregateError);
      if (!(recoveryError instanceof AggregateError)) {
        throw new Error("expected malformed account recovery failures");
      }
      expect(recoveryError.errors).toHaveLength(2);
      for (const error of recoveryError.errors) {
        expect(error).toMatchObject({
          code: "SMITHERS_RECOVERY_SESSION_PREPARE_FAILED",
          cause: { code: "SMITHERS_RECOVERY_ACCOUNT_METADATA_INVALID" },
        });
      }
      expect(persistedAcp.prompts).toHaveLength(0);
    } finally {
      await service.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("clears task billing attribution but retains the recovery pin when an account is revoked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tasks-smithers-revoked-"));
    const persistedAcp: PersistedAcpState = {
      sessions: new Map(),
      prompts: [],
      nextId: 0,
    };
    const acp = new RevokedAccountAcp(persistedAcp);
    const store = new OrchestratorTaskStore({
      stateFile: join(dir, "orchestrator-tasks.json"),
    });
    const service = new OrchestratorTaskService(runtimeFor(acp, null), {
      store,
    });
    try {
      const task = await service.createTask({
        title: "Revoked account",
        goal: "Must never use host auth",
      });
      const link: SmithersDurableRunLink = {
        version: 1,
        orchestratorTaskId: task.id,
        taskId: `${task.id}:part:0`,
        runId: "revoked-run",
        tenantId: "restart-tenant",
        initialPrompt: "subscription-only prompt",
        state: "running",
        keepAliveAfterComplete: false,
      };
      await service.attachSession(task.id, {
        sessionId: "revoked-session",
        agentType: "codex",
        workdir: dir,
        status: "ready",
        metadata: {
          taskId: task.id,
          account: {
            providerId: "openai-codex",
            accountId: "revoked-account",
            label: "Revoked",
            source: "oauth",
            strategy: "least-used",
          },
          ...smithersDurableRunMetadata(link),
        },
        durableRun: link,
      });
      const before = await store.getTask(task.id);
      const beforeSession = before?.sessions.find(
        (candidate) => candidate.sessionId === "revoked-session",
      );
      if (!beforeSession) throw new Error("expected attached task session");
      const metadataWithoutAccount = { ...beforeSession.metadata };
      delete metadataWithoutAccount.account;
      await store.updateSession("revoked-session", {
        metadata: metadataWithoutAccount,
      });
      const completedAt = Date.now() - 1_000;
      await store.updateSession("revoked-session", {
        status: "completed",
        stoppedAt: completedAt,
        taskDelivered: true,
        completionSummary: "completed before recovery failed",
      });

      await expect(
        service.recoverInterruptedSmithersRuns(acp as never),
      ).rejects.toBeInstanceOf(AggregateError);
      expect(persistedAcp.sessions.size).toBe(0);
      expect(persistedAcp.prompts).toHaveLength(0);
      expect(
        acp.recoveryOptions[0]?.metadata?.[
          POOLED_ACCOUNT_RECOVERY_METADATA_KEY
        ],
      ).toMatchObject({
        providerId: "openai-codex",
        accountId: "revoked-account",
      });

      const after = await store.getTask(task.id);
      const session = after?.sessions.find(
        (candidate) => candidate.sessionId === "revoked-session",
      );
      expect(session?.accountProviderId).toBeUndefined();
      expect(session?.accountId).toBeUndefined();
      expect(session?.accountLabel).toBeUndefined();
      expect(session?.status).toBe("completed");
      expect(session?.stoppedAt).toBe(completedAt);
      expect(session?.completionSummary).toBe(
        "completed before recovery failed",
      );
      expect(session?.metadata.account).toBeUndefined();
      expect(
        session?.metadata[POOLED_ACCOUNT_RECOVERY_METADATA_KEY],
      ).toMatchObject({
        providerId: "openai-codex",
        accountId: "revoked-account",
      });
    } finally {
      await service.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("restores a failed recovery pin and attributes the recovered turn to that subscription", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tasks-smithers-restored-"));
    const persistedAcp: PersistedAcpState = {
      sessions: new Map(),
      prompts: [],
      nextId: 0,
    };
    const acp = new RestorableAccountAcp(persistedAcp);
    const store = new OrchestratorTaskStore({
      stateFile: join(dir, "orchestrator-tasks.json"),
    });
    const runtime = runtimeFor(acp, null);
    const service = new OrchestratorTaskService(runtime, { store });
    const pendingEvents: Promise<void>[] = [];
    const unsubscribe = acp.onSessionEvent((sessionId, event, data) => {
      pendingEvents.push(
        (service as unknown as SessionEventReceiver).onSessionEvent(
          sessionId,
          event,
          data,
        ),
      );
    });
    const recordUsage = vi.fn(async () => undefined);
    const bridge: CodingAgentSelectorBridge = {
      describe: () => ({}),
      select: async () => null,
      markRateLimited: async () => undefined,
      markNeedsReauth: async () => undefined,
      recordUsage,
    };
    setCodingAgentSelectorBridge(bridge);
    try {
      const task = await service.createTask({
        title: "Restored subscription",
        goal: "Resume with the exact prior account",
      });
      const link: SmithersDurableRunLink = {
        version: 1,
        orchestratorTaskId: task.id,
        taskId: `${task.id}:part:0`,
        runId: "restored-subscription-run",
        tenantId: "restart-tenant",
        initialPrompt: "continue subscription-backed work",
        state: "running",
        model: "gpt-5.4",
        keepAliveAfterComplete: true,
      };
      await service.attachSession(task.id, {
        sessionId: "temporarily-unavailable-session",
        agentType: "codex",
        workdir: dir,
        status: "ready",
        metadata: {
          taskId: task.id,
          account: RESTORED_ACCOUNT,
          ...smithersDurableRunMetadata(link),
        },
        durableRun: link,
      });
      const before = await store.getTask(task.id);
      const beforeSession = before?.sessions[0];
      if (!beforeSession) throw new Error("expected attached task session");
      const metadataWithoutAccount = { ...beforeSession.metadata };
      delete metadataWithoutAccount.account;
      await store.updateSession(beforeSession.sessionId, {
        metadata: metadataWithoutAccount,
      });

      await expect(
        service.recoverInterruptedSmithersRuns(acp as never),
      ).rejects.toBeInstanceOf(AggregateError);
      const failed = await store.getTask(task.id);
      const failedSession = failed?.sessions.find(
        (session) => session.sessionId === beforeSession.sessionId,
      );
      expect(failedSession?.accountId).toBeUndefined();
      expect(
        failedSession?.metadata[POOLED_ACCOUNT_RECOVERY_METADATA_KEY],
      ).toEqual(RESTORED_ACCOUNT);

      acp.available = true;
      await expect(recoverWithoutAggregate(service, acp)).resolves.toEqual({
        recovered: 1,
        skipped: 0,
      });

      await Promise.all(pendingEvents);
      const recovered = await store.getTask(task.id);
      const serving = recovered?.sessions.find(
        (session) => session.sessionId !== beforeSession.sessionId,
      );
      expect(serving?.accountProviderId).toBe(RESTORED_ACCOUNT.providerId);
      expect(serving?.accountId).toBe(RESTORED_ACCOUNT.accountId);
      expect(serving?.metadata.account).toEqual(RESTORED_ACCOUNT);
      expect(
        serving?.metadata[POOLED_ACCOUNT_RECOVERY_METADATA_KEY],
      ).toBeUndefined();
      expect(serving?.inputTokens).toBe(11);
      expect(serving?.outputTokens).toBe(7);
      expect(serving?.reasoningTokens).toBe(3);
      expect(serving?.cacheTokens).toBe(2);
      expect(serving?.costUsd).toBe(0.25);
      expect(serving?.usageState).toBe("measured");
      expect(recordUsage).toHaveBeenCalledWith(
        RESTORED_ACCOUNT.providerId,
        RESTORED_ACCOUNT.accountId,
        { tokens: 23, ok: true, model: "gpt-5.4" },
      );
    } finally {
      unsubscribe();
      setCodingAgentSelectorBridge(null);
      await service.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("applies account_switched events to typed and metadata attribution and clears an obsolete pin", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tasks-smithers-switch-"));
    const persistedAcp: PersistedAcpState = {
      sessions: new Map(),
      prompts: [],
      nextId: 0,
    };
    const acp = new RestartableAcp(persistedAcp);
    const store = new OrchestratorTaskStore({
      stateFile: join(dir, "orchestrator-tasks.json"),
    });
    const runtime = runtimeFor(acp, null);
    const service = new OrchestratorTaskService(runtime, { store });
    try {
      const task = await service.createTask({
        title: "Account switch",
        goal: "Keep task attribution synchronized",
      });
      await service.attachSession(task.id, {
        sessionId: "account-switch-session",
        agentType: "codex",
        workdir: dir,
        status: "ready",
        metadata: {
          taskId: task.id,
          [POOLED_ACCOUNT_RECOVERY_METADATA_KEY]: RESTORED_ACCOUNT,
        },
      });

      await (service as unknown as SessionEventReceiver).onSessionEvent(
        "account-switch-session",
        "account_switched",
        {
          ...RESTORED_ACCOUNT,
          reason: "durable_recovery_restored",
        },
      );

      const after = await store.getTask(task.id);
      const session = after?.sessions.find(
        (candidate) => candidate.sessionId === "account-switch-session",
      );
      expect(session?.accountProviderId).toBe(RESTORED_ACCOUNT.providerId);
      expect(session?.accountId).toBe(RESTORED_ACCOUNT.accountId);
      expect(session?.accountLabel).toBe(RESTORED_ACCOUNT.label);
      expect(session?.metadata.account).toEqual(RESTORED_ACCOUNT);
      expect(
        session?.metadata[POOLED_ACCOUNT_RECOVERY_METADATA_KEY],
      ).toBeUndefined();
    } finally {
      await service.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves accumulated counters when restart recovery reattaches the same stored session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tasks-smithers-counters-"));
    const stateFile = join(dir, "orchestrator-tasks.json");
    const persistedAcp: PersistedAcpState = {
      sessions: new Map(),
      prompts: [],
      nextId: 0,
    };
    const acp = new RestartableAcp(persistedAcp);
    const firstStore = new OrchestratorTaskStore({ stateFile });
    const firstService = new OrchestratorTaskService(runtimeFor(acp, null), {
      store: firstStore,
    });
    let restartedService: OrchestratorTaskService | undefined;
    try {
      const task = await firstService.createTask({
        title: "Preserve recovery counters",
        goal: "Keep prior decisions and spend",
      });
      const link: SmithersDurableRunLink = {
        version: 1,
        orchestratorTaskId: task.id,
        taskId: `${task.id}:part:0`,
        runId: "counter-preservation-run",
        tenantId: "restart-tenant",
        initialPrompt: "finish without losing accounting",
        state: "running",
        keepAliveAfterComplete: true,
      };
      const sessionId = "counter-preservation-session";
      await firstService.attachSession(task.id, {
        sessionId,
        agentType: "codex",
        workdir: dir,
        status: "ready",
        metadata: {
          taskId: task.id,
          [POOLED_ACCOUNT_RECOVERY_METADATA_KEY]: RESTORED_ACCOUNT,
          ...smithersDurableRunMetadata(link),
        },
        durableRun: link,
      });
      await firstStore.updateSession(sessionId, {
        decisionCount: 5,
        autoResolvedCount: 3,
        idleCheckCount: 4,
        taskDelivered: true,
        lastSeenDecisionIndex: 8,
        retryCount: 2,
        inputTokens: 101,
        outputTokens: 43,
        reasoningTokens: 17,
        cacheTokens: 29,
        costUsd: 1.75,
        usageState: "measured",
        childTrajectoryIds: ["trajectory-before-restart"],
      });
      const now = new Date();
      acp.restoreLiveSession({
        id: sessionId,
        name: sessionId,
        agentType: "codex",
        workdir: dir,
        status: "ready",
        approvalPreset: "standard",
        createdAt: now,
        lastActivityAt: now,
        metadata: {
          taskId: task.id,
          account: RESTORED_ACCOUNT,
          ...smithersDurableRunMetadata(link),
        },
      });

      const restartedStore = new OrchestratorTaskStore({ stateFile });
      restartedService = new OrchestratorTaskService(runtimeFor(acp, null), {
        store: restartedStore,
      });
      await expect(
        recoverWithoutAggregate(restartedService, acp),
      ).resolves.toEqual({ recovered: 1, skipped: 0 });

      const recovered = await restartedStore.getTask(task.id);
      const session = recovered?.sessions.find(
        (candidate) => candidate.sessionId === sessionId,
      );
      expect(session).toMatchObject({
        decisionCount: 5,
        autoResolvedCount: 3,
        idleCheckCount: 4,
        taskDelivered: true,
        lastSeenDecisionIndex: 8,
        retryCount: 2,
        inputTokens: 101,
        outputTokens: 43,
        reasoningTokens: 17,
        cacheTokens: 29,
        costUsd: 1.75,
        usageState: "measured",
        childTrajectoryIds: ["trajectory-before-restart"],
      });
      expect(session?.accountProviderId).toBe(RESTORED_ACCOUNT.providerId);
      expect(session?.accountId).toBe(RESTORED_ACCOUNT.accountId);
      expect(session?.metadata.account).toEqual(RESTORED_ACCOUNT);
      expect(
        session?.metadata[POOLED_ACCOUNT_RECOVERY_METADATA_KEY],
      ).toBeUndefined();
    } finally {
      await restartedService?.stop();
      await firstService.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("persists linkage before the prompt and recovers a committed run without replaying it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tasks-smithers-restart-"));
    let firstTaskService: OrchestratorTaskService | undefined;
    let restartedService: OrchestratorTaskService | undefined;
    try {
      const stateFile = join(dir, "orchestrator-tasks.json");
      const persistedAcp: PersistedAcpState = {
        sessions: new Map(),
        prompts: [],
        nextId: 0,
      };
      const firstAcp = new RestartableAcp(persistedAcp);
      const firstStore = new OrchestratorTaskStore({ stateFile });
      const firstRuntime = runtimeFor(firstAcp, null);
      firstTaskService = new OrchestratorTaskService(firstRuntime, {
        store: firstStore,
      });
      firstRuntime.getService = vi.fn((serviceType: string) =>
        serviceType === "ORCHESTRATOR_TASK_SERVICE"
          ? firstTaskService
          : firstAcp,
      ) as never;
      await firstTaskService.start();

      let simulatedCrash = false;
      const actionTaskService = {
        createTask: firstTaskService.createTask.bind(firstTaskService),
        attachSession: firstTaskService.attachSession.bind(firstTaskService),
        updateSmithersDurableRun: async (
          sessionId: string,
          link: SmithersDurableRunLink,
        ) => {
          if (link.state === "completed" && !simulatedCrash) {
            simulatedCrash = true;
            throw new Error(
              "simulated host termination after Smithers committed",
            );
          }
          return firstTaskService.updateSmithersDurableRun(sessionId, link);
        },
      };
      const actionRuntime = runtimeFor(firstAcp, actionTaskService);

      const firstResult = await createTaskAction.handler(
        actionRuntime,
        memory({ text: "implement restart-safe work" }),
        state,
        {
          parameters: {
            action: "create",
            title: "Restart-safe task",
            goal: "Return one durable result",
            task: "implement restart-safe work",
            agentType: "codex",
            workdir: dir,
            approvalPreset: "readonly",
            timeout_ms: 30_000,
          },
        },
        callback(),
      );
      expect(firstResult?.success).toBe(false);
      expect(simulatedCrash).toBe(true);
      expect(persistedAcp.prompts).toEqual([
        expect.stringContaining("implement restart-safe work"),
      ]);

      const taskId = (
        await firstTaskService.listTasks({ includeArchived: true })
      )[0]?.id;
      expect(taskId).toBeTypeOf("string");
      const beforeRestart = await firstStore.getTask(taskId as string);
      const running = beforeRestart?.sessions
        .map((session) => readSmithersDurableRunLink(session.metadata))
        .find((link) => link?.state === "running");
      expect(running?.orchestratorTaskId).toBe(taskId);
      expect(running?.approvalPreset).toBe("readonly");
      expect(beforeRestart?.sessions[0]?.sessionId).toBe(
        [...persistedAcp.sessions.keys()][0],
      );
      await firstTaskService.stop();

      // Fresh instances model process restart: task data is reloaded from
      // disk. Dropping the ACP record forces recovery to reconstruct a fresh
      // transport solely from the task-session copy, including readonly policy.
      persistedAcp.sessions.clear();
      const restartedAcp = new RestartableAcp(persistedAcp);
      const restartedStore = new OrchestratorTaskStore({ stateFile });
      const restartedRuntime = runtimeFor(restartedAcp, null);
      restartedService = new OrchestratorTaskService(restartedRuntime, {
        store: restartedStore,
      });
      restartedRuntime.getService = vi.fn((serviceType: string) =>
        serviceType === "ORCHESTRATOR_TASK_SERVICE"
          ? restartedService
          : restartedAcp,
      ) as never;
      await restartedService.start();
      const recovery = await restartedService.recoverInterruptedSmithersRuns(
        restartedAcp as never,
      );

      expect(recovery).toEqual({ recovered: 1, skipped: 0 });
      // Smithers reads the terminal graph/result from its durable DB. The new
      // ACP transport is attached, but the initial prompt is never sent again.
      expect(persistedAcp.prompts).toHaveLength(1);
      expect(persistedAcp.sessions.size).toBe(1);
      expect([...persistedAcp.sessions.values()][0]?.approvalPreset).toBe(
        "readonly",
      );

      const afterRestart = await restartedStore.getTask(taskId as string);
      const links = afterRestart?.sessions
        .map((session) => readSmithersDurableRunLink(session.metadata))
        .filter((link): link is SmithersDurableRunLink => link !== undefined);
      expect(links?.some((link) => link.state === "completed")).toBe(true);
      expect(links?.some((link) => link.state === "superseded")).toBe(true);
    } finally {
      await restartedService?.stop();
      await firstTaskService?.stop();
      await rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  }, 60_000);
});
