// Exercises workflow route behavior for triggers and workbench task lists.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { IAgentRuntime, Task, TriggerConfig } from '@elizaos/core';
import {
  handleTriggerRoutes,
  type TriggerRouteContext,
  type TriggerSummary,
} from '../../../src/trigger-routes';

/**
 * WI-2 (#12177): the `/api/heartbeats` alias is retired. `handleTriggerRoutes`
 * must NOT claim `/api/heartbeats` (returns false so the server 404s it), and
 * `/api/triggers` must still work and respond with only the `triggers` key
 * (no duplicate `heartbeats` key).
 */

interface CapturedResponse {
  status: number;
  body: unknown;
}

function makeCtx(
  overrides: Partial<TriggerRouteContext> & {
    method: string;
    pathname: string;
  }
): { ctx: TriggerRouteContext; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, body: undefined };
  const res = {} as TriggerRouteContext['res'];

  const summary: TriggerSummary = {
    id: '00000000-0000-0000-0000-000000000001' as TriggerSummary['id'],
    taskId: '00000000-0000-0000-0000-000000000002' as TriggerSummary['taskId'],
    displayName: 'Morning report',
    instructions: 'Run workflow wf-1',
    triggerType: 'cron',
    enabled: true,
    wakeMode: 'inject_now',
    createdBy: 'api',
    runCount: 0,
    kind: 'workflow',
    workflowId: 'wf-1',
  };

  const task = { id: summary.taskId, name: 'TRIGGER_DISPATCH' } as Task;

  const ctx: TriggerRouteContext = {
    method: overrides.method,
    pathname: overrides.pathname,
    req: {} as TriggerRouteContext['req'],
    res,
    runtime: {} as IAgentRuntime,
    readJsonBody: async () => ({}),
    json: (_res, body, status = 200) => {
      captured.status = status;
      captured.body = body;
    },
    error: (_res, message, status = 500) => {
      captured.status = status;
      captured.body = { error: message };
    },
    executeTriggerTask: async () => ({ status: 'success', taskDeleted: false }),
    getTriggerHealthSnapshot: async () => ({
      triggersEnabled: true,
      activeTriggers: 1,
      disabledTriggers: 0,
      totalExecutions: 0,
      totalFailures: 0,
      totalSkipped: 0,
    }),
    getTriggerLimit: () => 100,
    listTriggerTasks: async () => [task],
    readTriggerConfig: () => null,
    readTriggerRuns: () => [],
    taskToTriggerSummary: () => summary,
    triggersFeatureEnabled: () => true,
    buildTriggerConfig: () => summary as never,
    buildTriggerMetadata: () => ({}),
    normalizeTriggerDraft: () => ({ draft: undefined }),
    DISABLED_TRIGGER_INTERVAL_MS: 60_000,
    TRIGGER_TASK_NAME: 'TRIGGER_DISPATCH',
    TRIGGER_TASK_TAGS: ['queue', 'repeat', 'trigger'],
    ...overrides,
  };

  return { ctx, captured };
}

describe('handleTriggerRoutes — heartbeat alias retired (WI-2)', () => {
  test('GET /api/heartbeats is not claimed (falls through to 404)', async () => {
    const { ctx, captured } = makeCtx({
      method: 'GET',
      pathname: '/api/heartbeats',
    });
    const handled = await handleTriggerRoutes(ctx);
    expect(handled).toBe(false);
    // Nothing was written — the server layer produces the 404.
    expect(captured.status).toBe(0);
  });

  test('GET /api/heartbeats/health is not claimed either', async () => {
    const { ctx, captured } = makeCtx({
      method: 'GET',
      pathname: '/api/heartbeats/health',
    });
    const handled = await handleTriggerRoutes(ctx);
    expect(handled).toBe(false);
    expect(captured.status).toBe(0);
  });

  test('GET /api/triggers still works and returns only the triggers key', async () => {
    const { ctx, captured } = makeCtx({
      method: 'GET',
      pathname: '/api/triggers',
    });
    const handled = await handleTriggerRoutes(ctx);
    expect(handled).toBe(true);
    expect(captured.status).toBe(200);
    const body = captured.body as { triggers?: unknown; heartbeats?: unknown };
    expect(Array.isArray(body.triggers)).toBe(true);
    expect((body.triggers as unknown[]).length).toBe(1);
    // The retired dual key must be gone.
    expect('heartbeats' in body).toBe(false);
  });

  test('GET /api/triggers/health still works', async () => {
    const { ctx, captured } = makeCtx({
      method: 'GET',
      pathname: '/api/triggers/health',
    });
    const handled = await handleTriggerRoutes(ctx);
    expect(handled).toBe(true);
    expect(captured.status).toBe(200);
    expect((captured.body as { triggersEnabled: boolean }).triggersEnabled).toBe(true);
  });
});

describe('POST /api/triggers — kind parsing (WI-3)', () => {
  test("rejects an unknown kind with a 'workflow' or 'prompt' message", async () => {
    const { ctx, captured } = makeCtx({
      method: 'POST',
      pathname: '/api/triggers',
      readJsonBody: async () => ({ kind: 'text', workflowId: 'wf-1' }) as never,
    });
    const handled = await handleTriggerRoutes(ctx);
    expect(handled).toBe(true);
    expect(captured.status).toBe(400);
    expect((captured.body as { error: string }).error).toContain("'workflow' or 'prompt'");
  });

  test("requires workflowId when kind is 'workflow'", async () => {
    const { ctx, captured } = makeCtx({
      method: 'POST',
      pathname: '/api/triggers',
      readJsonBody: async () => ({ kind: 'workflow' }) as never,
    });
    const handled = await handleTriggerRoutes(ctx);
    expect(handled).toBe(true);
    expect(captured.status).toBe(400);
    expect((captured.body as { error: string }).error).toContain('workflowId is required');
  });

  test("requires instructions when kind is 'prompt'", async () => {
    const { ctx, captured } = makeCtx({
      method: 'POST',
      pathname: '/api/triggers',
      readJsonBody: async () =>
        ({ kind: 'prompt', triggerType: 'cron', cronExpression: '0 9 * * *' }) as never,
    });
    const handled = await handleTriggerRoutes(ctx);
    expect(handled).toBe(true);
    expect(captured.status).toBe(400);
    expect((captured.body as { error: string }).error).toContain('instructions is required');
  });
});

describe('PUT /api/triggers/:id — switching to prompt kind (WI-3 review fix #1)', () => {
  // A stored workflow trigger whose instructions are the synthesized default.
  const workflowCurrent = {
    version: 1,
    triggerId: '00000000-0000-0000-0000-000000000002',
    displayName: 'Morning report',
    instructions: 'Run workflow wf-1',
    triggerType: 'cron',
    enabled: true,
    wakeMode: 'inject_now',
    createdBy: 'api',
    cronExpression: '0 9 * * *',
    runCount: 0,
    kind: 'workflow',
    workflowId: 'wf-1',
  };

  function putCtx(
    body: Record<string, unknown>,
    current: Record<string, unknown> = workflowCurrent
  ) {
    const built = makeCtx({
      method: 'PUT',
      pathname: '/api/triggers/00000000-0000-0000-0000-000000000002',
      readJsonBody: async () => body as never,
      readTriggerConfig: () => current as never,
    });
    return built;
  }

  test('switching a workflow trigger to prompt WITHOUT instructions → 400', async () => {
    const { ctx, captured } = putCtx({ kind: 'prompt' });
    const handled = await handleTriggerRoutes(ctx);
    expect(handled).toBe(true);
    expect(captured.status).toBe(400);
    expect((captured.body as { error: string }).error).toContain(
      "instructions is required when kind is 'prompt'"
    );
  });

  test('switching a workflow trigger to prompt WITH instructions passes the kind guard', async () => {
    // normalizeTriggerDraft is stubbed to return no draft, so the handler stops
    // at the generic "Invalid update" 400 AFTER the instructions guard — proving
    // the instructions guard did NOT trip.
    const { ctx, captured } = putCtx({
      kind: 'prompt',
      instructions: 'Summarize my calendar every morning',
    });
    const handled = await handleTriggerRoutes(ctx);
    expect(handled).toBe(true);
    expect(captured.status).toBe(400);
    expect((captured.body as { error: string }).error).not.toContain(
      "instructions is required when kind is 'prompt'"
    );
  });

  test('a same-kind prompt→prompt update without instructions does NOT trip the guard', async () => {
    const promptCurrent = {
      ...workflowCurrent,
      instructions: 'Existing prompt instructions',
      kind: 'prompt',
      workflowId: undefined,
    };
    const { ctx, captured } = putCtx({ kind: 'prompt' }, promptCurrent);
    const handled = await handleTriggerRoutes(ctx);
    expect(handled).toBe(true);
    // Falls through to the generic invalid-update path, not the instructions 400.
    expect((captured.body as { error: string }).error).not.toContain(
      "instructions is required when kind is 'prompt'"
    );
  });
});

const OWNER_A = '00000000-0000-4000-8000-00000000000a';
const OWNER_B = '00000000-0000-4000-8000-00000000000b';

function ownedTask(ownerEntityId: string, suffix: string, eventKind?: string): Task {
  return {
    id: `00000000-0000-4000-8000-0000000000${suffix}` as Task['id'],
    name: 'TRIGGER_DISPATCH',
    metadata: {
      ownerEntityId,
      ownership: { ownerEntityId },
      trigger: {
        version: 1,
        triggerId: `10000000-0000-4000-8000-0000000000${suffix}`,
        displayName: `Trigger ${suffix}`,
        instructions: 'Run workflow',
        triggerType: eventKind ? 'event' : 'interval',
        enabled: true,
        wakeMode: 'inject_now',
        createdBy: ownerEntityId,
        intervalMs: eventKind ? undefined : 60_000,
        eventKind,
        runCount: 0,
        kind: 'workflow',
        workflowId: `wf-${suffix}`,
      },
      triggerRuns: [
        {
          triggerRunId: `20000000-0000-4000-8000-0000000000${suffix}`,
          triggerId: `10000000-0000-4000-8000-0000000000${suffix}`,
          taskId: `00000000-0000-4000-8000-0000000000${suffix}`,
          startedAt: 1,
          finishedAt: Number(suffix),
          status: ownerEntityId === OWNER_A ? 'success' : 'error',
          latencyMs: 1,
          source: 'manual',
        },
      ],
    },
  } as Task;
}

function taskConfig(task: Task): TriggerConfig | null {
  const trigger = (task.metadata as { trigger?: unknown } | undefined)?.trigger;
  return trigger && typeof trigger === 'object' ? (trigger as TriggerConfig) : null;
}

function taskSummary(task: Task): TriggerSummary | null {
  const trigger = taskConfig(task) as {
    triggerId: TriggerSummary['id'];
    displayName: string;
    instructions: string;
    triggerType: TriggerSummary['triggerType'];
    enabled: boolean;
    wakeMode: TriggerSummary['wakeMode'];
    createdBy: string;
    runCount: number;
    kind: TriggerSummary['kind'];
    workflowId: string;
  };
  if (!task.id || !trigger) return null;
  return {
    id: trigger.triggerId,
    taskId: task.id,
    displayName: trigger.displayName,
    instructions: trigger.instructions,
    triggerType: trigger.triggerType,
    enabled: trigger.enabled,
    wakeMode: trigger.wakeMode,
    createdBy: trigger.createdBy,
    runCount: trigger.runCount,
    kind: trigger.kind,
    workflowId: trigger.workflowId,
  };
}

function createPolicyRoute(options: {
  triggerType: 'once' | 'interval' | 'cron' | 'event';
  enabled: boolean;
  settings?: Record<string, unknown>;
  principalId?: string;
}) {
  let createdTask: Task | undefined;
  const taskId = '30000000-0000-4000-8000-000000000001' as Task['id'];
  const runtime = {
    getSetting: (key: string) => options.settings?.[key] ?? null,
    getService: () => null,
    createTask: async (task: Task) => {
      createdTask = { ...task, id: taskId };
      return taskId;
    },
    getTask: async () => createdTask ?? null,
  } as unknown as IAgentRuntime;
  const draft = {
    displayName: 'Tier policy trigger',
    instructions: 'Run workflow',
    triggerType: options.triggerType,
    wakeMode: 'inject_now' as const,
    enabled: options.enabled,
    createdBy: options.principalId ?? 'api',
    intervalMs: options.triggerType === 'interval' ? 60_000 : undefined,
    scheduledAtIso:
      options.triggerType === 'once' ? new Date(Date.now() + 60_000).toISOString() : undefined,
    cronExpression: options.triggerType === 'cron' ? '0 9 * * *' : undefined,
    eventKind: options.triggerType === 'event' ? 'mail.received' : undefined,
    kind: 'workflow' as const,
    workflowId: 'wf-policy',
  };
  const built = makeCtx({
    method: 'POST',
    pathname: '/api/triggers',
    principalId: options.principalId,
    runtime,
    readJsonBody: async () =>
      ({
        kind: 'workflow',
        workflowId: 'wf-policy',
        triggerType: options.triggerType,
        enabled: options.enabled,
      }) as never,
    normalizeTriggerDraft: () => ({ draft }),
    listTriggerTasks: async () => [],
    buildTriggerConfig: ({ triggerId }) =>
      ({
        version: 1,
        triggerId,
        ...draft,
        runCount: 0,
      }) as never,
    buildTriggerMetadata: ({ trigger }) => ({ trigger }),
    readTriggerConfig: taskConfig,
    taskToTriggerSummary: taskSummary,
  });
  return { ...built, createdTask: () => createdTask };
}

const ALWAYS_ON_CONTRACT = {
  success: false,
  code: 'workflow_requires_always_on',
  error:
    'Scheduled workflows require an always-on agent runtime. Confirm continuous billing before activating this workflow.',
  capability: 'scheduled_workflows',
  currentExecutionTier: 'dedicated-lazy',
  requiredExecutionTier: 'dedicated-always',
  upgradeRequired: true,
  upgrade: {
    automatic: false,
    available: true,
    requiresContinuousBillingConfirmation: true,
  },
};

describe('handleTriggerRoutes — managed Cloud principal isolation', () => {
  const previousProvisioned = process.env.ELIZA_CLOUD_PROVISIONED;

  beforeEach(() => {
    process.env.ELIZA_CLOUD_PROVISIONED = '1';
  });

  afterEach(() => {
    if (previousProvisioned === undefined) delete process.env.ELIZA_CLOUD_PROVISIONED;
    else process.env.ELIZA_CLOUD_PROVISIONED = previousProvisioned;
  });

  test('rejects a missing attested principal before returning trigger data', async () => {
    const { ctx, captured } = makeCtx({ method: 'GET', pathname: '/api/triggers' });
    await expect(handleTriggerRoutes(ctx)).resolves.toBe(true);
    expect(captured.status).toBe(401);
    expect(captured.body).toEqual({
      success: false,
      code: 'workflow_principal_required',
      error: 'Workflow user principal is required',
    });
  });

  test('requires a principal when the managed environment uses the string true', async () => {
    process.env.ELIZA_CLOUD_PROVISIONED = 'true';
    const { ctx, captured } = makeCtx({ method: 'GET', pathname: '/api/triggers' });

    await handleTriggerRoutes(ctx);

    expect(captured.status).toBe(401);
    expect(captured.body).toMatchObject({ code: 'workflow_principal_required' });
  });

  test('requires a principal for runtime-setting-only managed Cloud', async () => {
    delete process.env.ELIZA_CLOUD_PROVISIONED;
    const { ctx, captured } = makeCtx({
      method: 'GET',
      pathname: '/api/triggers',
      runtime: {
        getSetting: (key: string) => (key === 'ELIZA_CLOUD_PROVISIONED' ? true : null),
      } as unknown as IAgentRuntime,
    });

    await handleTriggerRoutes(ctx);

    expect(captured.status).toBe(401);
    expect(captured.body).toMatchObject({ code: 'workflow_principal_required' });
  });

  test('filters list and health counters to the attested owner', async () => {
    const tasks = [ownedTask(OWNER_A, '11'), ownedTask(OWNER_B, '12')];
    const list = makeCtx({
      method: 'GET',
      pathname: '/api/triggers',
      principalId: OWNER_A,
      listTriggerTasks: async () => tasks,
      readTriggerConfig: taskConfig,
      taskToTriggerSummary: taskSummary,
    });
    await handleTriggerRoutes(list.ctx);
    expect((list.captured.body as { triggers: TriggerSummary[] }).triggers).toHaveLength(1);
    expect((list.captured.body as { triggers: TriggerSummary[] }).triggers[0]?.createdBy).toBe(
      OWNER_A
    );

    const health = makeCtx({
      method: 'GET',
      pathname: '/api/triggers/health',
      principalId: OWNER_A,
      listTriggerTasks: async () => tasks,
      readTriggerConfig: taskConfig,
      readTriggerRuns: (task) =>
        ((task.metadata as { triggerRuns?: unknown[] }).triggerRuns ?? []) as never,
    });
    await handleTriggerRoutes(health.ctx);
    expect(health.captured.body).toMatchObject({
      activeTriggers: 1,
      totalExecutions: 1,
      totalFailures: 0,
    });
  });

  test('returns the same 404 for every foreign-owner item operation', async () => {
    const foreign = ownedTask(OWNER_B, '13');
    for (const [method, suffix] of [
      ['GET', ''],
      ['GET', '/runs'],
      ['POST', '/execute'],
      ['PUT', ''],
      ['DELETE', ''],
    ] as const) {
      const { ctx, captured } = makeCtx({
        method,
        pathname: `/api/triggers/${foreign.id}${suffix}`,
        principalId: OWNER_A,
        listTriggerTasks: async () => [foreign],
        readTriggerConfig: taskConfig,
      });
      await handleTriggerRoutes(ctx);
      expect(captured.status).toBe(404);
      expect(captured.body).toEqual({ error: 'Trigger not found' });
    }
  });

  test('event delivery executes only matching triggers owned by the principal', async () => {
    const owned = ownedTask(OWNER_A, '14', 'mail.received');
    const foreign = ownedTask(OWNER_B, '15', 'mail.received');
    const executed: Task[] = [];
    const { ctx, captured } = makeCtx({
      method: 'POST',
      pathname: '/api/triggers/events/mail.received',
      principalId: OWNER_A,
      listTriggerTasks: async () => [owned, foreign],
      readTriggerConfig: taskConfig,
      readJsonBody: async () => ({ payload: { subject: 'hello' } }) as never,
      executeTriggerTask: async (_runtime, task) => {
        executed.push(task);
        return { status: 'success', taskDeleted: false };
      },
      runtime: { getTask: async () => null } as never,
    });
    await handleTriggerRoutes(ctx);
    expect(executed.map((task) => task.id)).toEqual([owned.id]);
    expect((captured.body as { matched: number }).matched).toBe(1);
  });

  test('ignores spoofed createdBy and stamps the attested owner into task metadata', async () => {
    let createdTask: Task | undefined;
    const taskId = '00000000-0000-4000-8000-000000000016' as Task['id'];
    const runtime = {
      getService: () => null,
      createTask: async (task: Task) => {
        createdTask = { ...task, id: taskId };
        return taskId;
      },
      getTask: async () => createdTask ?? null,
    } as unknown as IAgentRuntime;
    const foreignTask = ownedTask(OWNER_B, '17');
    const foreignTrigger = taskConfig(foreignTask);
    if (foreignTrigger) foreignTrigger.createdBy = OWNER_A;
    const { ctx, captured } = makeCtx({
      method: 'POST',
      pathname: '/api/triggers',
      principalId: OWNER_A,
      runtime,
      listTriggerTasks: async () => [foreignTask],
      getTriggerLimit: () => 1,
      readJsonBody: async () =>
        ({
          kind: 'workflow',
          workflowId: 'wf-16',
          displayName: 'Cloud trigger',
          createdBy: OWNER_B,
          triggerType: 'interval',
          intervalMs: 60_000,
        }) as never,
      normalizeTriggerDraft: ({ input }) => ({ draft: input as never }),
      buildTriggerConfig: ({ draft, triggerId }) =>
        ({
          version: 1,
          triggerId,
          displayName: draft.displayName,
          instructions: draft.instructions,
          triggerType: draft.triggerType,
          enabled: draft.enabled,
          wakeMode: draft.wakeMode,
          createdBy: draft.createdBy,
          runCount: 0,
          intervalMs: draft.intervalMs,
          kind: 'workflow',
          workflowId: draft.workflowId as string,
        }) as never,
      buildTriggerMetadata: ({ trigger }) => ({ trigger }),
      readTriggerConfig: taskConfig,
      taskToTriggerSummary: taskSummary,
    });
    await handleTriggerRoutes(ctx);
    expect(captured.status).toBe(201);
    expect(createdTask).toBeDefined();
    expect(taskConfig(createdTask as Task).createdBy).toBe(OWNER_A);
    const createdMetadata = (createdTask as Task).metadata as {
      ownerEntityId?: string;
      ownership?: { ownerEntityId?: string };
    };
    expect(createdMetadata.ownerEntityId).toBe(OWNER_A);
    expect(createdMetadata.ownership?.ownerEntityId).toBe(OWNER_A);
  });

  test('rejects active timer creation on dedicated-lazy with the typed upgrade contract', async () => {
    const { ctx, captured, createdTask } = createPolicyRoute({
      triggerType: 'interval',
      enabled: true,
      principalId: OWNER_A,
      settings: {
        ELIZA_CLOUD_PROVISIONED: '1',
        ELIZA_CLOUD_EXECUTION_TIER: 'dedicated-lazy',
      },
    });

    await handleTriggerRoutes(ctx);
    expect(captured.status).toBe(409);
    expect(captured.body).toEqual(ALWAYS_ON_CONTRACT);
    expect(createdTask()).toBeUndefined();
  });

  test('uses environment execution-tier fallback when runtime settings are absent', async () => {
    const previousTier = process.env.ELIZA_CLOUD_EXECUTION_TIER;
    process.env.ELIZA_CLOUD_EXECUTION_TIER = 'dedicated-lazy';
    try {
      const { ctx, captured } = createPolicyRoute({
        triggerType: 'once',
        enabled: true,
        principalId: OWNER_A,
      });
      await handleTriggerRoutes(ctx);
      expect(captured.status).toBe(409);
      expect(captured.body).toEqual(ALWAYS_ON_CONTRACT);
    } finally {
      if (previousTier === undefined) delete process.env.ELIZA_CLOUD_EXECUTION_TIER;
      else process.env.ELIZA_CLOUD_EXECUTION_TIER = previousTier;
    }
  });

  test('allows disabled timer drafts, events, and dedicated-always timers', async () => {
    const cases = [
      { triggerType: 'interval' as const, enabled: false, tier: 'dedicated-lazy' },
      { triggerType: 'event' as const, enabled: true, tier: 'dedicated-lazy' },
      { triggerType: 'cron' as const, enabled: true, tier: 'dedicated-always' },
    ];
    for (const testCase of cases) {
      const { ctx, captured, createdTask } = createPolicyRoute({
        triggerType: testCase.triggerType,
        enabled: testCase.enabled,
        principalId: OWNER_A,
        settings: {
          ELIZA_CLOUD_PROVISIONED: true,
          ELIZA_CLOUD_EXECUTION_TIER: testCase.tier,
        },
      });
      await handleTriggerRoutes(ctx);
      expect(captured.status).toBe(201);
      expect(createdTask()).toBeDefined();
    }
  });

  test('rejects an update that enables a timer on dedicated-lazy', async () => {
    const task = ownedTask(OWNER_A, '18');
    const current = taskConfig(task);
    if (!current) throw new Error('test trigger missing');
    current.enabled = false;
    const updateTask = mock(async () => undefined);
    const runtime = {
      getSetting: (key: string) => {
        if (key === 'ELIZA_CLOUD_PROVISIONED') return '1';
        if (key === 'ELIZA_CLOUD_EXECUTION_TIER') return 'dedicated-lazy';
        return null;
      },
      updateTask,
    } as unknown as IAgentRuntime;
    const { ctx, captured } = makeCtx({
      method: 'PUT',
      pathname: `/api/triggers/${task.id}`,
      principalId: OWNER_A,
      runtime,
      listTriggerTasks: async () => [task],
      readTriggerConfig: taskConfig,
      readJsonBody: async () => ({ enabled: true }) as never,
      normalizeTriggerDraft: () => ({
        draft: {
          displayName: current.displayName,
          instructions: current.instructions,
          triggerType: current.triggerType,
          wakeMode: current.wakeMode,
          enabled: true,
          createdBy: current.createdBy,
          intervalMs: current.intervalMs,
          kind: current.kind,
          workflowId: current.kind === 'workflow' ? current.workflowId : undefined,
        },
      }),
      buildTriggerConfig: () => ({ ...current, enabled: true }),
    });

    await handleTriggerRoutes(ctx);
    expect(captured.status).toBe(409);
    expect(captured.body).toEqual(ALWAYS_ON_CONTRACT);
    expect(updateTask).not.toHaveBeenCalled();
  });
});

test('local headerless trigger routes preserve createdBy compatibility', async () => {
  const previousProvisioned = process.env.ELIZA_CLOUD_PROVISIONED;
  delete process.env.ELIZA_CLOUD_PROVISIONED;
  try {
    const { ctx, captured } = makeCtx({ method: 'GET', pathname: '/api/triggers' });
    await handleTriggerRoutes(ctx);
    expect(captured.status).toBe(200);
    expect((captured.body as { triggers: TriggerSummary[] }).triggers[0]?.createdBy).toBe('api');
  } finally {
    if (previousProvisioned === undefined) delete process.env.ELIZA_CLOUD_PROVISIONED;
    else process.env.ELIZA_CLOUD_PROVISIONED = previousProvisioned;
  }
});

test('local headerless active timer creation remains allowed', async () => {
  const previousProvisioned = process.env.ELIZA_CLOUD_PROVISIONED;
  const previousTier = process.env.ELIZA_CLOUD_EXECUTION_TIER;
  delete process.env.ELIZA_CLOUD_PROVISIONED;
  delete process.env.ELIZA_CLOUD_EXECUTION_TIER;
  try {
    const { ctx, captured } = createPolicyRoute({ triggerType: 'once', enabled: true });
    await handleTriggerRoutes(ctx);
    expect(captured.status).toBe(201);
  } finally {
    if (previousProvisioned === undefined) delete process.env.ELIZA_CLOUD_PROVISIONED;
    else process.env.ELIZA_CLOUD_PROVISIONED = previousProvisioned;
    if (previousTier === undefined) delete process.env.ELIZA_CLOUD_EXECUTION_TIER;
    else process.env.ELIZA_CLOUD_EXECUTION_TIER = previousTier;
  }
});
