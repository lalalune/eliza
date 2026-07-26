/**
 * Shared workflow-route helpers for service lookup, owner-principal resolution,
 * and bounded query parsing. Local HTTP requests run under the same canonical
 * owner entity as client chat so both surfaces see one ownership scope.
 */
import { timingSafeEqual } from 'node:crypto';
import type { IAgentRuntime } from '@elizaos/core';
import { readAliasedEnv } from '@elizaos/shared';
import type { WorkflowService } from '../services/workflow-service';
import { WORKFLOW_SERVICE_TYPE } from '../services/workflow-service';
import { getLocalOwnerEntityId, isManagedCloudEnvironment } from '../utils/context';

/**
 * Extract WorkflowService from runtime services
 */
export function getService(runtime: IAgentRuntime): WorkflowService {
  const service = runtime.getService<WorkflowService>(WORKFLOW_SERVICE_TYPE);

  if (!service) {
    throw new Error('WorkflowService not available in runtime');
  }

  return service;
}

/**
 * Resolve the entity principal represented by the authenticated local route.
 * The server's legacy plugin-route boundary authenticates the request but does
 * not pass a session principal to handlers, so the local single-owner contract
 * uses the same canonical/fallback identity as client chat. Request actor
 * headers are deliberately ignored because they are caller-controlled.
 */
export function getRouteOwnerEntityId(runtime: IAgentRuntime): string {
  return getLocalOwnerEntityId(runtime);
}

/**
 * Cloud-provisioned containers are multi-user surfaces, so silently falling
 * back to the local owner would merge every paired Cloud user into one tenant.
 */
export function isCloudWorkflowPrincipalRequired(): boolean {
  return isManagedCloudEnvironment();
}

/**
 * Read the end-user principal installed by the authenticated Cloud gateway.
 * Managed browsers receive a scoped Cloud session, never the per-agent API
 * token. A separate proof header carrying that per-agent credential attests
 * that Cloud replaced the caller-controlled principal without distributing a
 * fleet-wide daemon secret to every tenant container.
 */
export function getForwardedWorkflowPrincipal(req: {
  headers: Record<string, string | string[] | undefined>;
}): string | undefined {
  const expectedToken = readAliasedEnv('ELIZA_API_TOKEN')?.trim();
  const suppliedToken = req.headers['x-eliza-principal-token'];
  if (!expectedToken || typeof suppliedToken !== 'string') return undefined;
  const expected = Buffer.from(expectedToken);
  const supplied = Buffer.from(suppliedToken.trim());
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return undefined;
  }
  const value = req.headers['x-eliza-user-id'];
  if (typeof value !== 'string') return undefined;
  const principalId = value.trim();
  return principalId || undefined;
}

/**
 * Validate and clamp limit parameter
 */
export function validateLimit(limitParam: unknown, defaultLimit = 20, maxLimit = 100): number {
  const limit = Number(limitParam);
  if (!Number.isFinite(limit) || limit <= 0) {
    return defaultLimit;
  }
  return Math.min(limit, maxLimit);
}
