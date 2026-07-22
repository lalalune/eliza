/**
 * Changes a hosted agent's execution tier behind the owner-authenticated Cloud
 * boundary. Shared agents migrate to a separate always-on record and hand off
 * their conversation only after provisioning. Scale-to-zero dedicated agents
 * become always-on in place after explicit continuous-billing confirmation.
 *
 * Both paths enforce dedicated-hosting credit runway and durable single-flight
 * jobs. The in-place path commits its tier CAS with a marked restart/wake job;
 * the shared path commits its migration target with a provision job. Retries
 * reattach to those exact records, and another organization's id remains a 404.
 */

import { Hono } from "hono";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { AGENT_PRICING } from "@/lib/constants/agent-pricing";
import { getMaxNonTerminalAgentsForOrg } from "@/lib/constants/agent-sandbox-quota";
import { checkAgentTierUpgradeCreditGate } from "@/lib/services/agent-billing-gate";
import { insufficientCredits402 } from "@/lib/services/agent-billing-gate-402";
import {
  type DedicatedLazyTierTransition,
  findDedicatedLazyTierTransition,
  promoteDedicatedLazyAgentToAlwaysOn,
} from "@/lib/services/agent-lazy-tier-transition";
import {
  createTierUpgradeTargetWithProvision,
  findLiveTierUpgradeTarget,
} from "@/lib/services/agent-tier-upgrade-target";
import {
  AgentQuotaExceededError,
  elizaSandboxService,
} from "@/lib/services/eliza-sandbox";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import {
  checkProvisioningWorkerHealth,
  provisioningWorkerFailureBody,
} from "@/lib/services/provisioning-worker-health";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { stripReservedEnvKeys } from "@/lib/services/reserved-env-keys";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "POST, OPTIONS";

type AgentRow = NonNullable<
  Awaited<ReturnType<typeof elizaSandboxService.getAgentForWrite>>
>;

type AuthedUser = Awaited<
  ReturnType<typeof requireAuthOrApiKeyWithOrg>
>["user"];

function json(body: unknown, status = 200): Response {
  return applyCorsHeaders(Response.json(body, { status }), CORS_METHODS);
}

function pollingBody(jobId: string) {
  return {
    endpoint: `/api/v1/jobs/${jobId}`,
    intervalMs: 5000,
    expectedDurationMs: 90000,
  };
}

function asConfigRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asEnvRecord(value: unknown): Record<string, string> {
  const record = asConfigRecord(value);
  return Object.fromEntries(
    Object.entries(record).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function continuousBillingConfirmationRequired(): Response {
  return json(
    {
      success: false,
      code: "continuous_billing_confirmation_required",
      error: "Confirm continuous billing to upgrade this agent to always-on.",
    },
    400,
  );
}

async function requireContinuousBillingConfirmation(
  request: Request,
): Promise<Response | null> {
  const raw = await request.text();
  if (!raw.trim()) return continuousBillingConfirmationRequired();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    // error-policy:J3 untrusted request JSON becomes an explicit invalid result.
    return json(
      { success: false, code: "invalid_request", error: "Invalid JSON body" },
      400,
    );
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return continuousBillingConfirmationRequired();
  }
  const record = body as Record<string, unknown>;
  if (record.confirmContinuousBilling !== true) {
    return continuousBillingConfirmationRequired();
  }
  if (Object.keys(record).some((key) => key !== "confirmContinuousBilling")) {
    return json(
      {
        success: false,
        code: "invalid_request",
        error: "Unrecognized request field",
      },
      400,
    );
  }
  return null;
}

function respondToInPlaceTransition(
  transition: DedicatedLazyTierTransition,
): Response {
  const alreadyInProgress =
    !transition.created &&
    (transition.job.status === "pending" ||
      transition.job.status === "in_progress");
  return json(
    {
      success: true,
      created: transition.created,
      reattached: !transition.created,
      alreadyInProgress,
      completed: transition.job.status === "completed",
      transition: "in_place",
      data: {
        id: transition.agent.id,
        agentId: transition.agent.id,
        previousExecutionTier: "dedicated-lazy",
        executionTier: transition.agent.execution_tier,
        action: transition.action,
        status: transition.job.status,
        jobId: transition.job.id,
        estimatedCompletionAt: transition.job.estimated_completion_at,
      },
      polling: pollingBody(transition.job.id),
    },
    202,
  );
}

async function promoteDedicatedLazyAgent(
  request: Request,
  agent: AgentRow,
  user: AuthedUser,
  env: AppEnv["Bindings"],
  options: { priorConfirmationRecorded?: boolean } = {},
): Promise<Response> {
  if (!options.priorConfirmationRecorded) {
    const confirmationError =
      await requireContinuousBillingConfirmation(request);
    if (confirmationError) return confirmationError;
  }

  const creditCheck = await checkAgentTierUpgradeCreditGate(
    user.organization_id,
  );
  if (!creditCheck.allowed) {
    return json(
      insufficientCredits402(
        creditCheck,
        "[agent-upgrade-tier] Always-on transition blocked: insufficient hosting runway",
        { agentId: agent.id, orgId: user.organization_id },
        { requiredBalance: AGENT_PRICING.UPGRADE_MINIMUM_BALANCE },
      ),
      402,
    );
  }

  const workerHealth = await checkProvisioningWorkerHealth();
  if (!workerHealth.ok) {
    logger.warn(
      "[agent-upgrade-tier] Always-on transition blocked: provisioning worker unavailable",
      {
        agentId: agent.id,
        orgId: user.organization_id,
        code: workerHealth.code,
      },
    );
    return json(
      provisioningWorkerFailureBody(workerHealth),
      workerHealth.status,
    );
  }

  const result = await promoteDedicatedLazyAgentToAlwaysOn({
    agentId: agent.id,
    organizationId: user.organization_id,
    userId: user.id,
  });
  if (result.kind === "not_found") {
    return json({ success: false, error: "Agent not found" }, 404);
  }
  if (result.kind === "not_promotable") {
    if (options.priorConfirmationRecorded) {
      return json(
        {
          success: false,
          code: "agent_transition_not_ready",
          error: `Agent cannot retry its always-on transition while its status is ${result.status}.`,
        },
        409,
      );
    }
    if (result.executionTier !== "dedicated-lazy") {
      return json(
        {
          success: false,
          code: "not_shared_tier",
          error:
            "Only shared-tier agents can be upgraded to dedicated. This agent already runs on its own container.",
        },
        409,
      );
    }
    return json(
      {
        success: false,
        code: "agent_transition_not_ready",
        error: `Agent cannot transition to always-on while its status is ${result.status}.`,
      },
      409,
    );
  }

  if (result.created) {
    void provisioningJobService.triggerImmediate(env).catch(() => {
      // error-policy:J5 the durable job is observable and the provisioning cron retries it.
    });
  }
  logger.info("[agent-upgrade-tier] In-place always-on transition accepted", {
    agentId: result.agent.id,
    orgId: user.organization_id,
    action: result.action,
    jobId: result.job.id,
    created: result.created,
    balance: creditCheck.balance,
  });
  return respondToInPlaceTransition(result);
}

/**
 * Respond for a live migration target that already owns this upgrade — both
 * the pre-checked reattach and the race loser whose single-flight call
 * returned another request's committed target. Running and
 * already-provisioning targets reattach without a second credit gate: nothing
 * new starts billing. Resuming a stopped/sleeping target does start compute
 * again, so that path must prove the same dedicated runway as a fresh upgrade
 * before it may enqueue work. The enqueue is safe from any state because a
 * committed target's environment was fully prepared at creation — re-arming a
 * dead job never re-mints credentials.
 */
async function respondToLiveTarget(
  target: AgentRow,
  sharedAgentId: string,
  user: AuthedUser,
  env: AppEnv["Bindings"],
): Promise<Response> {
  logger.info("[agent-upgrade-tier] Reattaching to in-flight upgrade", {
    sharedAgentId,
    dedicatedAgentId: target.id,
    orgId: user.organization_id,
    status: target.status,
  });
  if (target.status === "running") {
    return json({
      success: true,
      created: false,
      alreadyInProgress: true,
      data: {
        id: target.id,
        agentId: target.id,
        dedicatedAgentId: target.id,
        sharedAgentId,
        agentName: target.agent_name,
        status: target.status,
        executionTier: target.execution_tier,
      },
    });
  }
  if (target.status === "stopped" || target.status === "sleeping") {
    const resumeCreditCheck = await checkAgentTierUpgradeCreditGate(
      user.organization_id,
    );
    if (!resumeCreditCheck.allowed) {
      return json(
        insufficientCredits402(
          resumeCreditCheck,
          "[agent-upgrade-tier] Resume blocked: insufficient hosting runway",
          {
            sharedAgentId,
            dedicatedAgentId: target.id,
            orgId: user.organization_id,
          },
          { requiredBalance: AGENT_PRICING.UPGRADE_MINIMUM_BALANCE },
        ),
        402,
      );
    }
  }
  // pending/provisioning (or stopped/sleeping after an interrupted boot):
  // hand back the active provision job — enqueue reuses an in-flight job
  // and only mints a new one when the previous attempt died.
  const reattach = await provisioningJobService.enqueueAgentProvisionOnce({
    agentId: target.id,
    organizationId: user.organization_id,
    userId: user.id,
    agentName: target.agent_name ?? target.id,
  });
  if (reattach.created) {
    void provisioningJobService.triggerImmediate(env).catch(() => {
      // error-policy:J5 fire-and-forget nudge; the job is persisted and the
      // provisioning cron is the safety net (failure logged in the service).
    });
  }
  return json(
    {
      success: true,
      created: false,
      alreadyInProgress: true,
      data: {
        id: target.id,
        agentId: target.id,
        dedicatedAgentId: target.id,
        sharedAgentId,
        agentName: target.agent_name,
        status: reattach.job.status,
        jobId: reattach.job.id,
        estimatedCompletionAt: reattach.job.estimated_completion_at,
        executionTier: target.execution_tier,
      },
      polling: pollingBody(reattach.job.id),
    },
    202,
  );
}

async function __hono_POST(
  request: Request,
  env: AppEnv["Bindings"],
  { params }: { params: Promise<{ agentId: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { agentId } = await params;

    const shared = await elizaSandboxService.getAgentForWrite(
      agentId,
      user.organization_id,
    );
    if (!shared) {
      return json({ success: false, error: "Agent not found" }, 404);
    }

    if (
      shared.execution_tier === "dedicated-always" ||
      shared.execution_tier === "dedicated-lazy"
    ) {
      const existingTransition = await findDedicatedLazyTierTransition({
        agentId,
        organizationId: user.organization_id,
      });
      if (existingTransition) {
        if (existingTransition.job.status === "failed") {
          // The server-owned marker proves the owner already confirmed
          // continuous billing. A transport retry after terminal failure may
          // therefore be bodyless, but it must re-prove current credit runway
          // and worker health before a fresh relaunch job is committed.
          return await promoteDedicatedLazyAgent(request, shared, user, env, {
            priorConfirmationRecorded: true,
          });
        }
        if (shared.execution_tier === "dedicated-always") {
          return respondToInPlaceTransition(existingTransition);
        }
      }
    }

    if (shared.execution_tier === "dedicated-lazy") {
      return await promoteDedicatedLazyAgent(request, shared, user, env);
    }

    if (shared.execution_tier !== "shared") {
      return json(
        {
          success: false,
          code: "not_shared_tier",
          error:
            "Only shared-tier agents can be upgraded to dedicated. This agent already runs on its own container.",
        },
        409,
      );
    }

    // A shared row is `running` from creation; anything else (deletion in
    // flight, error) is not a healthy source to migrate a user off of.
    if (shared.status !== "running") {
      return json(
        {
          success: false,
          code: "agent_not_running",
          error: "Agent is not running and cannot be upgraded right now.",
        },
        409,
      );
    }

    // ── Reattach: an upgrade for this shared agent is already under way. ──
    const existingTarget = await findLiveTierUpgradeTarget(
      user.organization_id,
      agentId,
    );
    if (existingTarget) {
      return await respondToLiveTarget(existingTarget, agentId, user, env);
    }

    // ── Credit gate: N days of dedicated hosting runway, not the bare create
    // minimum. Same canonical 402 body every other gate emits, carrying the
    // stricter threshold so clients render the real number.
    const creditCheck = await checkAgentTierUpgradeCreditGate(
      user.organization_id,
    );
    if (!creditCheck.allowed) {
      return json(
        insufficientCredits402(
          creditCheck,
          "[agent-upgrade-tier] Upgrade blocked: insufficient hosting runway",
          { sharedAgentId: agentId, orgId: user.organization_id },
          { requiredBalance: AGENT_PRICING.UPGRADE_MINIMUM_BALANCE },
        ),
        402,
      );
    }

    // ── Worker health, BEFORE anything durable is minted. The single-flight
    // service commits the target together with its provision job, so a dead
    // worker checked here means nothing gets created at all — no fresh row to
    // roll back, no compensation window. (A worker dying between this check
    // and the commit leaves a valid job the recovering worker picks up.)
    const workerHealth = await checkProvisioningWorkerHealth();
    if (!workerHealth.ok) {
      logger.warn(
        "[agent-upgrade-tier] Upgrade blocked: provisioning worker unavailable",
        {
          sharedAgentId: agentId,
          orgId: user.organization_id,
          code: workerHealth.code,
        },
      );
      return json(
        provisioningWorkerFailureBody(workerHealth),
        workerHealth.status,
      );
    }

    // ── Mint the dedicated migration target, copying identity server-side. ──
    // Reserved platform env keys are stripped from the copy so the new agent
    // gets ITS OWN minted tokens/identity (ELIZA_API_TOKEN, ELIZA_CLOUD_AGENT_ID,
    // PUBLIC_BASE_URL, …) while the user's BYO env — including `enc:v1:`
    // ciphertext, which the storage encryptor passes through untouched and the
    // same-org materialization path decrypts — survives verbatim. Environment
    // preparation, target insert, and provision enqueue all happen inside the
    // service's single-flight boundary.
    const sourceConfig = asConfigRecord(shared.agent_config);
    const sourceEnv = stripReservedEnvKeys(
      asEnvRecord(shared.environment_vars),
    );
    let result: Awaited<
      ReturnType<typeof createTierUpgradeTargetWithProvision>
    >;
    try {
      result = await createTierUpgradeTargetWithProvision({
        sourceAgentId: agentId,
        organizationId: user.organization_id,
        userId: user.id,
        agentName: shared.agent_name ?? agentId,
        ...(shared.character_id ? { characterId: shared.character_id } : {}),
        agentConfig: sourceConfig,
        environmentVars: sourceEnv,
        maxNonTerminalAgents: getMaxNonTerminalAgentsForOrg(
          creditCheck.balance,
        ),
      });
    } catch (error) {
      if (error instanceof AgentQuotaExceededError) {
        logger.warn("[agent-upgrade-tier] Upgrade blocked: org quota", {
          sharedAgentId: agentId,
          orgId: user.organization_id,
          count: error.count,
          max: error.max,
        });
        return json(
          {
            success: false,
            code: "agent_quota_exceeded",
            error: error.message,
            currentAgents: error.count,
            maxAgents: error.max,
          },
          429,
        );
      }
      throw error;
    }

    // Race loser: another request committed the target (and its job) while
    // this one was in flight — reattach to that durable state.
    if (!result.created) {
      return await respondToLiveTarget(result.agent, agentId, user, env);
    }
    const dedicated = result.agent;
    const job = result.job;

    void provisioningJobService.triggerImmediate(env).catch(() => {
      // error-policy:J5 fire-and-forget nudge; the job is persisted and the
      // provisioning cron is the safety net (failure logged in the service).
    });

    logger.info("[agent-upgrade-tier] Upgrade started", {
      sharedAgentId: agentId,
      dedicatedAgentId: dedicated.id,
      orgId: user.organization_id,
      jobId: job.id,
      balance: creditCheck.balance,
    });

    return json(
      {
        success: true,
        created: true,
        message:
          "Dedicated agent created. Provisioning job started — poll the job endpoint, then run the conversation handoff.",
        data: {
          id: dedicated.id,
          agentId: dedicated.id,
          dedicatedAgentId: dedicated.id,
          sharedAgentId: agentId,
          agentName: dedicated.agent_name,
          status: job.status,
          jobId: job.id,
          estimatedCompletionAt: job.estimated_completion_at,
          executionTier: dedicated.execution_tier,
        },
        polling: pollingBody(job.id),
      },
      202,
    );
  } catch (error) {
    return applyCorsHeaders(errorToResponse(error), CORS_METHODS);
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.options("/", () => handleCorsOptions(CORS_METHODS));
__hono_app.post("/", async (c) =>
  __hono_POST(c.req.raw, c.env, {
    params: Promise.resolve({ agentId: c.req.param("agentId")! }),
  }),
);
export default __hono_app;
