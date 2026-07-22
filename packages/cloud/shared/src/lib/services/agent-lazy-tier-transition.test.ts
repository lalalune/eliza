/**
 * Exercises the lazy→always control-plane transaction against a real PGlite
 * database: CAS/job atomicity, lifecycle selection, and durable retry identity.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.TEST_DATABASE_URL ||= process.env.DATABASE_URL;
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { eq, sql } from "drizzle-orm";

const ORG_ID = "55555555-5555-4555-8555-555555555555";
const USER_ID = "eeeeeeee-5555-4555-8555-555555555555";
const RUNNING_ID = "dddddddd-1111-4111-8111-111111111111";
const SLEEPING_ID = "dddddddd-2222-4222-8222-222222222222";
const ALWAYS_ID = "dddddddd-3333-4333-8333-333333333333";
const PENDING_ID = "dddddddd-4444-4444-8444-444444444444";
const ROLLBACK_ID = "dddddddd-5555-4555-8555-555555555555";
const CONCURRENT_ID = "dddddddd-6666-4666-8666-666666666666";
const GENERIC_RESTART_ID = "dddddddd-7777-4777-8777-777777777777";
const FAILED_RESTART_ID = "dddddddd-8888-4888-8888-888888888888";
const STALE_RESTART_ID = "dddddddd-9999-4999-8999-999999999999";
const INTERRUPTED_RESTART_ID = "dddddddd-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ERROR_RECOVERY_ID = "dddddddd-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let ready = true;
let closeDb: (() => Promise<void>) | undefined;
let dbWrite: typeof import("../../db/client").dbWrite;
let agentSandboxes: typeof import("../../db/schemas/agent-sandboxes").agentSandboxes;
let jobs: typeof import("../../db/schemas/jobs").jobs;
let service: typeof import("./agent-lazy-tier-transition");
let provisioningJobService: typeof import("./provisioning-jobs").provisioningJobService;
let elizaSandboxService: typeof import("./eliza-sandbox").elizaSandboxService;

beforeAll(async () => {
  try {
    const client = await import("../../db/client");
    dbWrite = client.dbWrite;
    closeDb = client.closeDatabaseConnectionsForTests;
    const { organizations } = await import("../../db/schemas/organizations");
    const { users } = await import("../../db/schemas/users");
    ({ agentSandboxes } = await import("../../db/schemas/agent-sandboxes"));
    ({ jobs } = await import("../../db/schemas/jobs"));
    const { TIER_UPGRADE_TEST_TABLES } = await import("./__tests__/tier-upgrade-pglite-schema");
    for (const ddl of TIER_UPGRADE_TEST_TABLES) await dbWrite.execute(ddl);
    await dbWrite
      .insert(organizations)
      .values({
        id: ORG_ID,
        name: "Lazy Transition Org",
        slug: "lazy-transition-org",
        credit_balance: "100",
      })
      .onConflictDoNothing();
    await dbWrite
      .insert(users)
      .values({
        id: USER_ID,
        email: "lazy-transition@test.test",
        organization_id: ORG_ID,
        role: "owner",
        steward_user_id: `steward-${USER_ID}`,
      })
      .onConflictDoNothing();
    service = await import("./agent-lazy-tier-transition");
    ({ provisioningJobService } = await import("./provisioning-jobs"));
    ({ elizaSandboxService } = await import("./eliza-sandbox"));
  } catch (error) {
    ready = false;
    console.error("[agent-lazy-tier-transition.test] setup failed", error);
  }
}, 120_000);

afterAll(async () => {
  if (closeDb) await closeDb();
});

async function insertAgent(
  id: string,
  status: "running" | "sleeping" | "pending" | "provisioning" | "error",
  executionTier: "dedicated-lazy" | "dedicated-always" = "dedicated-lazy",
) {
  await dbWrite.insert(agentSandboxes).values({
    id,
    organization_id: ORG_ID,
    user_id: USER_ID,
    agent_name: `agent-${id.slice(0, 8)}`,
    execution_tier: executionTier,
    status,
    database_status: "none",
  });
}

async function jobsForAgent(agentId: string) {
  return dbWrite.select().from(jobs).where(eq(jobs.agent_id, agentId));
}

describe("dedicated-lazy to dedicated-always transition", () => {
  test("running promotion atomically CASes the tier, enqueues restart, and retries reattach", async () => {
    expect(ready).toBe(true);
    await insertAgent(RUNNING_ID, "running");

    const first = await service.promoteDedicatedLazyAgentToAlwaysOn({
      agentId: RUNNING_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });
    expect(first.kind).toBe("transition");
    if (first.kind !== "transition") throw new Error("transition not created");
    expect(first.created).toBe(true);
    expect(first.action).toBe("restart");
    expect(first.agent.execution_tier).toBe("dedicated-always");
    expect(first.job.type).toBe("agent_restart");
    expect(first.job.data.executionTierTransition).toBe(
      service.DEDICATED_LAZY_TO_ALWAYS_TRANSITION,
    );

    const retry = await service.promoteDedicatedLazyAgentToAlwaysOn({
      agentId: RUNNING_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });
    expect(retry.kind).toBe("transition");
    if (retry.kind !== "transition") throw new Error("retry did not reattach");
    expect(retry.created).toBe(false);
    expect(retry.job.id).toBe(first.job.id);
    expect(await jobsForAgent(RUNNING_ID)).toHaveLength(1);

    await dbWrite
      .update(jobs)
      .set({ status: "completed", completed_at: new Date() })
      .where(eq(jobs.id, first.job.id));
    const completed = await service.findDedicatedLazyTierTransition({
      agentId: RUNNING_ID,
      organizationId: ORG_ID,
    });
    expect(completed).toMatchObject({
      created: false,
      action: "restart",
      job: { id: first.job.id, status: "completed" },
    });
  });

  test("sleeping promotion uses a wake job", async () => {
    expect(ready).toBe(true);
    await insertAgent(SLEEPING_ID, "sleeping");
    const result = await service.promoteDedicatedLazyAgentToAlwaysOn({
      agentId: SLEEPING_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });
    expect(result.kind).toBe("transition");
    if (result.kind !== "transition") throw new Error("transition not created");
    expect(result.action).toBe("wake");
    expect(result.job.type).toBe("agent_wake");
  });

  test("an unmarked dedicated-always agent is never treated as a prior promotion", async () => {
    expect(ready).toBe(true);
    await insertAgent(ALWAYS_ID, "running", "dedicated-always");
    expect(
      await service.findDedicatedLazyTierTransition({
        agentId: ALWAYS_ID,
        organizationId: ORG_ID,
      }),
    ).toBeNull();
    const result = await service.promoteDedicatedLazyAgentToAlwaysOn({
      agentId: ALWAYS_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });
    expect(result).toMatchObject({
      kind: "not_promotable",
      executionTier: "dedicated-always",
    });
    expect(await jobsForAgent(ALWAYS_ID)).toHaveLength(0);
  });

  test("an ineligible lifecycle state leaves tier and jobs untouched", async () => {
    expect(ready).toBe(true);
    await insertAgent(PENDING_ID, "pending");
    const result = await service.promoteDedicatedLazyAgentToAlwaysOn({
      agentId: PENDING_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });
    expect(result).toMatchObject({
      kind: "not_promotable",
      executionTier: "dedicated-lazy",
      status: "pending",
    });
    const [row] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, PENDING_ID));
    expect(row?.execution_tier).toBe("dedicated-lazy");
    expect(await jobsForAgent(PENDING_ID)).toHaveLength(0);
  });

  test("an enqueue failure rolls back the tier CAS", async () => {
    expect(ready).toBe(true);
    await insertAgent(ROLLBACK_ID, "running");
    const enqueueSpy = spyOn(
      provisioningJobService,
      "enqueueAgentTierTransitionOnceInTx",
    ).mockRejectedValueOnce(new Error("simulated enqueue failure"));
    try {
      await expect(
        service.promoteDedicatedLazyAgentToAlwaysOn({
          agentId: ROLLBACK_ID,
          organizationId: ORG_ID,
          userId: USER_ID,
        }),
      ).rejects.toThrow("simulated enqueue failure");
    } finally {
      enqueueSpy.mockRestore();
    }
    const [row] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, ROLLBACK_ID));
    expect(row?.execution_tier).toBe("dedicated-lazy");
    expect(await jobsForAgent(ROLLBACK_ID)).toHaveLength(0);
  });

  test("an unrelated active restart is not reused as the transition relaunch", async () => {
    expect(ready).toBe(true);
    await insertAgent(GENERIC_RESTART_ID, "running");
    const generic = await provisioningJobService.enqueueAgentRestartOnce({
      agentId: GENERIC_RESTART_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });

    const result = await service.promoteDedicatedLazyAgentToAlwaysOn({
      agentId: GENERIC_RESTART_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });
    expect(result.kind).toBe("transition");
    if (result.kind !== "transition") throw new Error("transition not created");
    expect(result.job.id).not.toBe(generic.job.id);
    const rows = await jobsForAgent(GENERIC_RESTART_ID);
    expect(rows).toHaveLength(2);
    expect(
      rows.filter(
        (job) => job.data.executionTierTransition === service.DEDICATED_LAZY_TO_ALWAYS_TRANSITION,
      ),
    ).toHaveLength(1);
  });

  test("concurrent promotions converge on one tier mutation and one job", async () => {
    expect(ready).toBe(true);
    await insertAgent(CONCURRENT_ID, "running");
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        service.promoteDedicatedLazyAgentToAlwaysOn({
          agentId: CONCURRENT_ID,
          organizationId: ORG_ID,
          userId: USER_ID,
        }),
      ),
    );
    expect(results.every((result) => result.kind === "transition")).toBe(true);
    const transitions = results.filter(
      (result): result is Extract<typeof result, { kind: "transition" }> =>
        result.kind === "transition",
    );
    expect(transitions.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(transitions.map((result) => result.job.id)).size).toBe(1);
    expect(await jobsForAgent(CONCURRENT_ID)).toHaveLength(1);
  });

  test("a marked restart that exhausts normal execution atomically restores lazy and can rearm", async () => {
    expect(ready).toBe(true);
    await dbWrite
      .update(jobs)
      .set({ status: "completed", completed_at: new Date() })
      .where(sql`${jobs.status} IN ('pending', 'in_progress')`);
    await insertAgent(FAILED_RESTART_ID, "running");
    const first = await service.promoteDedicatedLazyAgentToAlwaysOn({
      agentId: FAILED_RESTART_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });
    expect(first.kind).toBe("transition");
    if (first.kind !== "transition") throw new Error("transition not created");
    await dbWrite
      .update(jobs)
      .set({ max_attempts: 1, scheduled_for: new Date(0) })
      .where(eq(jobs.id, first.job.id));

    const restartSpy = spyOn(elizaSandboxService, "executeRestart").mockResolvedValue({
      success: false,
      containerStopped: false,
      containerStarted: false,
      error: "simulated permanent relaunch failure",
    });
    try {
      const processed = await provisioningJobService.processPendingJobs(1, {
        jobTypes: ["agent_restart"],
      });
      expect(processed).toMatchObject({ claimed: 1, failed: 1 });
    } finally {
      restartSpy.mockRestore();
    }

    const [rolledBack] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, FAILED_RESTART_ID));
    expect(rolledBack?.execution_tier).toBe("dedicated-lazy");
    const failedRows = await jobsForAgent(FAILED_RESTART_ID);
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0]?.status).toBe("failed");

    const retryMarker = await service.findDedicatedLazyTierTransition({
      agentId: FAILED_RESTART_ID,
      organizationId: ORG_ID,
    });
    expect(retryMarker?.job.id).toBe(first.job.id);
    const retry = await service.promoteDedicatedLazyAgentToAlwaysOn({
      agentId: FAILED_RESTART_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });
    expect(retry.kind).toBe("transition");
    if (retry.kind !== "transition") throw new Error("transition not rearmed");
    expect(retry.created).toBe(true);
    expect(retry.job.id).not.toBe(first.job.id);
    expect(retry.agent.execution_tier).toBe("dedicated-always");
    const retriedRows = await jobsForAgent(FAILED_RESTART_ID);
    expect(retriedRows).toHaveLength(2);
    expect(
      retriedRows.filter((job) => job.status === "pending" || job.status === "in_progress"),
    ).toHaveLength(1);
  });

  test("stale-timeout terminalization atomically restores the lazy tier", async () => {
    expect(ready).toBe(true);
    await insertAgent(STALE_RESTART_ID, "running");
    const transition = await service.promoteDedicatedLazyAgentToAlwaysOn({
      agentId: STALE_RESTART_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });
    expect(transition.kind).toBe("transition");
    if (transition.kind !== "transition") throw new Error("transition not created");
    await dbWrite
      .update(jobs)
      .set({
        status: "in_progress",
        attempts: 2,
        max_attempts: 3,
        started_at: new Date(0),
      })
      .where(eq(jobs.id, transition.job.id));

    await provisioningJobService.processPendingJobs(0, {
      jobTypes: ["agent_restart"],
    });
    const [agent] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, STALE_RESTART_ID));
    const [job] = await jobsForAgent(STALE_RESTART_ID);
    expect(job?.status).toBe("failed");
    expect(agent?.execution_tier).toBe("dedicated-lazy");
  });

  test("worker-restart terminalization atomically restores the lazy tier", async () => {
    expect(ready).toBe(true);
    await insertAgent(INTERRUPTED_RESTART_ID, "running");
    const transition = await service.promoteDedicatedLazyAgentToAlwaysOn({
      agentId: INTERRUPTED_RESTART_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });
    expect(transition.kind).toBe("transition");
    if (transition.kind !== "transition") throw new Error("transition not created");
    await dbWrite
      .update(jobs)
      .set({
        status: "in_progress",
        attempts: 2,
        max_attempts: 3,
        started_at: new Date(0),
      })
      .where(eq(jobs.id, transition.job.id));

    await provisioningJobService.recoverInterruptedJobsOnStartup(new Date(), ["agent_restart"]);
    const [agent] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, INTERRUPTED_RESTART_ID));
    const [job] = await jobsForAgent(INTERRUPTED_RESTART_ID);
    expect(job?.status).toBe("failed");
    expect(agent?.execution_tier).toBe("dedicated-lazy");
  });

  test("error is restart-eligible only when recovering a failed marked transition", async () => {
    expect(ready).toBe(true);
    await insertAgent(ERROR_RECOVERY_ID, "error");
    expect(
      await service.promoteDedicatedLazyAgentToAlwaysOn({
        agentId: ERROR_RECOVERY_ID,
        organizationId: ORG_ID,
        userId: USER_ID,
      }),
    ).toMatchObject({ kind: "not_promotable", status: "error" });

    await dbWrite.insert(jobs).values({
      type: "agent_restart",
      status: "failed",
      data: {
        agentId: ERROR_RECOVERY_ID,
        organizationId: ORG_ID,
        userId: USER_ID,
        executionTierTransition: service.DEDICATED_LAZY_TO_ALWAYS_TRANSITION,
      },
      organization_id: ORG_ID,
      user_id: USER_ID,
      agent_id: ERROR_RECOVERY_ID,
      attempts: 3,
      max_attempts: 3,
    });
    const recovery = await service.promoteDedicatedLazyAgentToAlwaysOn({
      agentId: ERROR_RECOVERY_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });
    expect(recovery.kind).toBe("transition");
    if (recovery.kind !== "transition") throw new Error("recovery not created");
    expect(recovery.created).toBe(true);
    expect(recovery.action).toBe("restart");
  });
});
