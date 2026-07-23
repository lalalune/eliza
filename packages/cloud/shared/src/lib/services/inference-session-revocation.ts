/**
 * Revokes one Steward credential at the strong inference boundary.
 *
 * Cookie and remote-cache deletion are hygiene. The per-user Steward JWT
 * not-before revision in the organization Durable Object prevents replay of
 * every token minted before logout, including an eventually consistent
 * positive authorization entry that is re-read after cache deletion.
 */

import { ElizaError } from "@elizaos/core";
import { type StewardVerifyEnv, verifyStewardTokenCached } from "../auth/steward-client";
import { usersService } from "./users";

export async function revokeInferenceStewardSession(
  token: string,
  env: StewardVerifyEnv,
): Promise<{
  userId: string;
  organizationId: string;
} | null> {
  const claims = await verifyStewardTokenCached(env, token, {
    localOnly: true,
  });
  if (!claims) return null;
  const user = await usersService.getByStewardIdForWrite(claims.userId);
  if (!user?.organization_id) {
    throw new ElizaError("Verified Steward session has no inference authorization identity", {
      code: "INFERENCE_SESSION_IDENTITY_MISSING",
      context: { stewardUserId: claims.userId },
      severity: "fatal",
    });
  }
  const revisioned = await usersService.revokeInferenceSessions(
    user.id,
    claims.issuedAt,
  );
  return {
    userId: revisioned.id,
    organizationId: revisioned.organization_id ?? user.organization_id,
  };
}
