/**
 * Authenticates Cloud workflow requests, verifies agent ownership, and proxies
 * them to the dedicated container that serves the agent's canonical chat and
 * workflow runtime. Unavailable runtimes produce typed upgrade, wake, or retry
 * responses without exposing Cloud credentials to the container.
 */
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { checkAgentCreditGate } from "@/lib/services/agent-billing-gate";
import { insufficientCredits402 } from "@/lib/services/agent-billing-gate-402";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import {
  checkProvisioningWorkerHealth,
  provisioningWorkerFailureBody,
} from "@/lib/services/provisioning-worker-health";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import type { AppContext } from "@/types/cloud-worker-env";

const WORKFLOW_CORS_METHODS = "GET, POST, PUT, DELETE, OPTIONS";
const WORKFLOW_PROXY_DEFAULT_TIMEOUT_MS = 120_000;
const WORKFLOW_PROXY_GENERATION_TIMEOUT_MS = 5 * 60_000;
const WORKFLOW_PROXY_RUN_TIMEOUT_MS = 10 * 60_000;
const WORKFLOW_PROXY_RETRY_AFTER_SECONDS = 5;
const WORKFLOW_PROXY_PATH_SEGMENT_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const DEDICATED_LAZY_WAKEABLE_STATUSES = new Set([
  "stopped",
  "sleeping",
  "disconnected",
]);

type WorkflowAgentExecutionTier =
  | "shared"
  | "dedicated-lazy"
  | "dedicated-always"
  | "custom";

export function workflowRuntimeUnavailableResponse(
  agentId: string,
  executionTier: WorkflowAgentExecutionTier,
): Response {
  if (executionTier === "shared") {
    return Response.json(
      {
        success: false,
        code: "workflow_requires_dedicated",
        error:
          "Workflows require a dedicated agent runtime. Upgrade this agent before managing workflows.",
        capability: "workflows",
        currentExecutionTier: executionTier,
        requiredExecutionTier: "dedicated-always",
        upgradeRequired: true,
        upgrade: {
          automatic: false,
          method: "POST",
          endpoint: `/api/v1/eliza/agents/${encodeURIComponent(agentId)}/upgrade-tier`,
        },
      },
      { status: 409 },
    );
  }

  return Response.json(
    {
      success: false,
      code: "workflow_runtime_unavailable",
      error: "The agent workflow runtime is temporarily unavailable.",
      capability: "workflows",
      currentExecutionTier: executionTier,
      upgradeRequired: false,
      retryable: true,
    },
    { status: 503 },
  );
}

function workflowProxyTimeoutResponse(): Response {
  const response = Response.json(
    {
      success: false,
      code: "agent_timeout",
      error:
        "Agent did not start responding in time. The workflow may still be processing; retry shortly.",
      retryable: true,
    },
    { status: 504 },
  );
  response.headers.set(
    "Retry-After",
    String(WORKFLOW_PROXY_RETRY_AFTER_SECONDS),
  );
  return response;
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function normalizeWorkflowProxySuffix(
  suffix: string | undefined,
): string | null {
  if (suffix === undefined) return null;
  const normalized = suffix.replace(/^\/+|\/+$/g, "");
  if (!normalized) return "";
  const segments = normalized.split("/");
  return segments.every((segment) =>
    WORKFLOW_PROXY_PATH_SEGMENT_PATTERN.test(segment),
  )
    ? segments.join("/")
    : null;
}

function invalidWorkflowProxyPathResponse(origin: string | null): Response {
  return applyCorsHeaders(
    Response.json(
      {
        success: false,
        code: "invalid_workflow_path",
        error: "Invalid agent or workflow path.",
      },
      { status: 400 },
    ),
    WORKFLOW_CORS_METHODS,
    origin,
  );
}

/** Maps the Cloud workflow collection shape to plugin-workflow's raw routes. */
export function workflowContainerPath(suffix: string): string {
  if (!suffix) return "workflows";
  if (
    suffix === "status" ||
    suffix === "runtime/start" ||
    suffix.startsWith("executions/")
  ) {
    return suffix;
  }
  return `workflows/${suffix}`;
}

/** Keeps long generation/run calls alive while bounding ordinary proxy work. */
export function workflowProxyTimeoutMs(method: string, suffix: string): number {
  if (method.toUpperCase() !== "POST") {
    return WORKFLOW_PROXY_DEFAULT_TIMEOUT_MS;
  }
  const normalizedSuffix = suffix.replace(/^\/+|\/+$/g, "");
  if (/(?:^|\/)run$/.test(normalizedSuffix)) {
    return WORKFLOW_PROXY_RUN_TIMEOUT_MS;
  }
  if (
    normalizedSuffix === "generate" ||
    normalizedSuffix === "resolve-clarification"
  ) {
    return WORKFLOW_PROXY_GENERATION_TIMEOUT_MS;
  }
  return WORKFLOW_PROXY_DEFAULT_TIMEOUT_MS;
}

async function wakeDedicatedLazyRuntime(params: {
  ctx: AppContext;
  agentId: string;
  user: { id: string; organization_id: string };
}): Promise<Response> {
  const creditCheck = await checkAgentCreditGate(params.user.organization_id);
  if (!creditCheck.allowed) {
    return Response.json(
      insufficientCredits402(
        creditCheck,
        "[workflow-proxy] Wake blocked: insufficient credits",
        {
          agentId: params.agentId,
          orgId: params.user.organization_id,
        },
      ),
      { status: 402 },
    );
  }
  const workerHealth = await checkProvisioningWorkerHealth();
  if (!workerHealth.ok) {
    return Response.json(provisioningWorkerFailureBody(workerHealth), {
      status: workerHealth.status,
    });
  }
  const wake = await provisioningJobService.enqueueAgentWakeOnce({
    agentId: params.agentId,
    organizationId: params.user.organization_id,
    userId: params.user.id,
  });
  void provisioningJobService.triggerImmediate(params.ctx.env).catch(() => {
    // error-policy:J5 the provisioning service logs trigger failures; the
    // durable wake job remains observable and retryable through its id.
  });
  return Response.json(
    {
      success: false,
      code: "workflow_runtime_waking",
      error:
        "The dedicated agent is waking. Retry the workflow request when the wake job completes.",
      capability: "workflows",
      currentExecutionTier: "dedicated-lazy",
      retryable: true,
      wake: {
        jobId: wake.job.id,
        status: wake.job.status,
        created: wake.created,
      },
      polling: {
        endpoint: `/api/v1/jobs/${encodeURIComponent(wake.job.id)}`,
        intervalMs: 5000,
      },
    },
    { status: 503 },
  );
}

async function forwardWorkflowToDedicatedRuntime(params: {
  ctx: AppContext;
  request: Request;
  agentId: string;
  suffix: string;
  user: { id: string; organization_id: string };
  executionTier: WorkflowAgentExecutionTier;
  runtimeStatus: string;
}): Promise<Response> {
  // Tier and durable runtime state are authoritative and must be checked before
  // container lookup so shared agents cannot bypass the capability response and
  // scale-to-zero agents cannot bypass the paid-compute wake gate.
  if (params.executionTier === "shared") {
    return workflowRuntimeUnavailableResponse(
      params.agentId,
      params.executionTier,
    );
  }
  if (
    params.executionTier === "dedicated-lazy" &&
    DEDICATED_LAZY_WAKEABLE_STATUSES.has(params.runtimeStatus)
  ) {
    return wakeDedicatedLazyRuntime(params);
  }

  const method = params.request.method.toUpperCase();
  if (
    method !== "GET" &&
    method !== "POST" &&
    method !== "PUT" &&
    method !== "DELETE"
  ) {
    return Response.json(
      { success: false, error: "Method not allowed" },
      { status: 405 },
    );
  }
  const body =
    method === "POST" || method === "PUT"
      ? await params.request.arrayBuffer()
      : undefined;
  try {
    const requestUrl = new URL(params.request.url);
    const response = await elizaSandboxService.proxyWorkflowRequest(
      params.agentId,
      params.user.organization_id,
      workflowContainerPath(params.suffix),
      method,
      body,
      requestUrl.search.slice(1),
      {
        principalId: params.user.id,
        timeoutMs: workflowProxyTimeoutMs(method, params.suffix),
        protocolHeaders: params.request.headers,
      },
    );
    return (
      response ??
      workflowRuntimeUnavailableResponse(params.agentId, params.executionTier)
    );
  } catch (error) {
    // error-policy:J1 the upstream workflow transport owns timeout translation;
    // callers need an unambiguous retryable 504 instead of a generic Cloud 500.
    if (isTimeoutError(error)) return workflowProxyTimeoutResponse();
    throw error;
  }
}

export async function handleWorkflowProxyRequest(
  request: Request,
  agentId: string | undefined,
  suffix: string | undefined,
  ctx: AppContext,
): Promise<Response> {
  const origin = request.headers.get("origin");
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const normalizedAgentId = agentId?.trim();
    const normalizedSuffix = normalizeWorkflowProxySuffix(suffix);
    if (
      !normalizedAgentId ||
      !WORKFLOW_PROXY_PATH_SEGMENT_PATTERN.test(normalizedAgentId) ||
      normalizedSuffix === null
    ) {
      return invalidWorkflowProxyPathResponse(origin);
    }
    // Confirm the caller's org owns this agent before proxying — otherwise any
    // authenticated user could drive workflow ops (suspend/resume/state) on
    // another org's agent just by knowing its id. Matches the suspend/resume
    // routes, which gate on getAgent(agentId, organization_id).
    const agent = await elizaSandboxService.getAgent(
      normalizedAgentId,
      user.organization_id,
    );
    if (!agent) {
      return applyCorsHeaders(
        Response.json(
          { success: false, error: "Agent not found" },
          { status: 404 },
        ),
        WORKFLOW_CORS_METHODS,
        origin,
      );
    }
    const forwarded = await forwardWorkflowToDedicatedRuntime({
      ctx,
      request,
      agentId: normalizedAgentId,
      suffix: normalizedSuffix,
      user,
      executionTier: agent.execution_tier,
      runtimeStatus: agent.status,
    });
    return applyCorsHeaders(forwarded, WORKFLOW_CORS_METHODS, origin);
  } catch (error) {
    // error-policy:J1 this is the outer Cloud transport boundary; translate
    // authentication, ownership, and proxy failures into the standard response.
    return applyCorsHeaders(
      errorToResponse(error),
      WORKFLOW_CORS_METHODS,
      origin,
    );
  }
}

export function handleWorkflowProxyOptions(origin?: string | null): Response {
  return handleCorsOptions(WORKFLOW_CORS_METHODS, origin);
}
