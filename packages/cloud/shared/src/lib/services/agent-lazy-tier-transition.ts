/**
 * Promotes a scale-to-zero dedicated agent to the always-on execution tier.
 * The tier CAS, lifecycle job, and durable retry marker share the agent's
 * provisioning advisory lock and one transaction, so concurrent requests
 * either create the transition once or reattach to its exact job.
 */

import { ElizaError } from "@elizaos/core";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import { dbWrite } from "../../db/helpers";
import {
  type AgentExecutionTier,
  type AgentSandbox,
  type AgentSandboxStatus,
  agentSandboxes,
} from "../../db/schemas/agent-sandboxes";
import { type Job, jobs } from "../../db/schemas/jobs";
import { elizaProvisionAdvisoryLockSql } from "./eliza-provision-lock";
import { DEDICATED_LAZY_TO_ALWAYS_TRANSITION, JOB_TYPES } from "./provisioning-job-types";
import { provisioningJobService } from "./provisioning-jobs";

export { DEDICATED_LAZY_TO_ALWAYS_TRANSITION } from "./provisioning-job-types";

export type DedicatedLazyTierTransitionAction = "restart" | "wake";

export interface DedicatedLazyTierTransition {
  agent: AgentSandbox;
  job: Job;
  action: DedicatedLazyTierTransitionAction;
  created: boolean;
}

export type PromoteDedicatedLazyAgentResult =
  | ({ kind: "transition" } & DedicatedLazyTierTransition)
  | { kind: "not_found" }
  | {
      kind: "not_promotable";
      executionTier: AgentExecutionTier;
      status: AgentSandboxStatus;
    };

const TRANSITION_JOB_TYPES = [JOB_TYPES.AGENT_RESTART, JOB_TYPES.AGENT_WAKE];

function transitionActionForJob(job: Job): DedicatedLazyTierTransitionAction {
  if (job.type === JOB_TYPES.AGENT_RESTART) return "restart";
  if (job.type === JOB_TYPES.AGENT_WAKE) return "wake";
  throw new ElizaError("Invalid lazy-tier transition job type", {
    code: "TIER_TRANSITION_JOB_TYPE_INVALID",
    context: { jobId: job.id, jobType: job.type },
  });
}

function transitionActionForStatus(
  status: AgentSandboxStatus,
): DedicatedLazyTierTransitionAction | null {
  if (status === "running") return "restart";
  if (status === "stopped" || status === "sleeping" || status === "disconnected") {
    return "wake";
  }
  return null;
}

function transitionActionForRecoveryStatus(
  status: AgentSandboxStatus,
): DedicatedLazyTierTransitionAction | null {
  if (status === "error") return "restart";
  return transitionActionForStatus(status);
}

async function findTransitionJobInTx(
  tx: DbTransaction,
  organizationId: string,
  agentId: string,
): Promise<Job | null> {
  const [job] = await tx
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.organization_id, organizationId),
        eq(jobs.agent_id, agentId),
        inArray(jobs.type, TRANSITION_JOB_TYPES),
        sql`${jobs.data} ->> 'executionTierTransition' = ${DEDICATED_LAZY_TO_ALWAYS_TRANSITION}`,
      ),
    )
    .orderBy(desc(jobs.created_at), desc(jobs.updated_at))
    .limit(1);
  return job ?? null;
}

async function findAgentInTx(
  tx: DbTransaction,
  organizationId: string,
  agentId: string,
): Promise<AgentSandbox | null> {
  const [agent] = await tx
    .select()
    .from(agentSandboxes)
    .where(
      and(
        eq(agentSandboxes.id, agentId),
        eq(agentSandboxes.organization_id, organizationId),
        sql`${agentSandboxes.deleted_at} IS NULL`,
      ),
    )
    .limit(1);
  return agent ?? null;
}

/** Read a previously committed transition without creating lifecycle work. */
export async function findDedicatedLazyTierTransition(params: {
  agentId: string;
  organizationId: string;
}): Promise<DedicatedLazyTierTransition | null> {
  return dbWrite.transaction(async (tx) => {
    await tx.execute(elizaProvisionAdvisoryLockSql(params.organizationId, params.agentId));
    const agent = await findAgentInTx(tx, params.organizationId, params.agentId);
    if (
      !agent ||
      (agent.execution_tier !== "dedicated-always" && agent.execution_tier !== "dedicated-lazy")
    ) {
      return null;
    }
    const job = await findTransitionJobInTx(tx, params.organizationId, params.agentId);
    if (!job) return null;
    // Permanent job failure atomically restores the lazy tier so billing and
    // the dashboard remain honest. Only that failed marker may prove the
    // earlier billing confirmation while the row is lazy; any other marked
    // job beside a lazy row is inconsistent and must not bypass confirmation.
    if (agent.execution_tier === "dedicated-lazy" && job.status !== "failed") {
      return null;
    }
    return {
      agent,
      job,
      action: transitionActionForJob(job),
      created: false,
    };
  });
}

/**
 * Atomically change a lazy agent's tier and enqueue the lifecycle work that
 * relaunches it under always-on configuration. A stale caller that lost the
 * race reattaches to the winner's committed job under the same lock.
 */
export async function promoteDedicatedLazyAgentToAlwaysOn(params: {
  agentId: string;
  organizationId: string;
  userId: string;
}): Promise<PromoteDedicatedLazyAgentResult> {
  return dbWrite.transaction(async (tx) => {
    await tx.execute(elizaProvisionAdvisoryLockSql(params.organizationId, params.agentId));
    const agent = await findAgentInTx(tx, params.organizationId, params.agentId);
    if (!agent) return { kind: "not_found" } as const;

    const existing = await findTransitionJobInTx(tx, params.organizationId, params.agentId);

    if (agent.execution_tier === "dedicated-always") {
      if (existing && existing.status !== "failed") {
        return {
          kind: "transition",
          agent,
          job: existing,
          action: transitionActionForJob(existing),
          created: false,
        } as const;
      }
      if (!existing) {
        return {
          kind: "not_promotable",
          executionTier: agent.execution_tier,
          status: agent.status,
        } as const;
      }
    }

    const recoveringFailedTransition = existing?.status === "failed";
    const action = recoveringFailedTransition
      ? transitionActionForRecoveryStatus(agent.status)
      : transitionActionForStatus(agent.status);
    if (agent.execution_tier !== "dedicated-lazy" || !action) {
      if (agent.execution_tier === "dedicated-always" && action) {
        const enqueue = await provisioningJobService.enqueueAgentTierTransitionOnceInTx(tx, {
          agentId: params.agentId,
          organizationId: params.organizationId,
          userId: params.userId,
          action,
        });
        return {
          kind: "transition",
          agent,
          job: enqueue.job,
          action,
          created: enqueue.created,
        } as const;
      }
      return {
        kind: "not_promotable",
        executionTier: agent.execution_tier,
        status: agent.status,
      } as const;
    }

    const enqueue = await provisioningJobService.enqueueAgentTierTransitionOnceInTx(tx, {
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      action,
    });
    const [updated] = await tx
      .update(agentSandboxes)
      .set({ execution_tier: "dedicated-always", updated_at: new Date() })
      .where(
        and(
          eq(agentSandboxes.id, params.agentId),
          eq(agentSandboxes.organization_id, params.organizationId),
          eq(agentSandboxes.execution_tier, "dedicated-lazy"),
          sql`${agentSandboxes.deleted_at} IS NULL`,
        ),
      )
      .returning();
    if (!updated) {
      throw new ElizaError("Failed to promote dedicated-lazy agent", {
        code: "TIER_TRANSITION_CAS_FAILED",
        context: {
          agentId: params.agentId,
          organizationId: params.organizationId,
          jobId: enqueue.job.id,
        },
      });
    }

    return {
      kind: "transition",
      agent: updated,
      job: enqueue.job,
      action,
      created: enqueue.created,
    } as const;
  });
}
