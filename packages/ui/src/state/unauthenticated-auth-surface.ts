/**
 * Resolves the unauthenticated shell surface without depending on browser
 * rendering, so native managed-Cloud sessions can never regress to the local
 * owner-password form while their Cloud session is being repaired.
 */

import type { AgentSessionRecoveryStatus } from "../hooks/useAgentSessionRecovery";

export type UnauthenticatedAuthSurface =
  | "recovering"
  | "cloud-sign-in"
  | "local-login";

export function resolveUnauthenticatedAuthSurface(
  recoveryStatus: AgentSessionRecoveryStatus,
  isCloudHostedLocation: boolean,
): UnauthenticatedAuthSurface {
  if (recoveryStatus === "recovering") return "recovering";
  if (recoveryStatus === "cloud-sign-in-required" || isCloudHostedLocation) {
    return "cloud-sign-in";
  }
  return "local-login";
}
