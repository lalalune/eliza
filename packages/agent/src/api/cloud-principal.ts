/**
 * Resolves the end-user identity attested by the managed Cloud edge. The
 * per-agent API token proves the header was installed by Cloud without placing
 * a fleet-wide daemon credential inside tenant containers.
 */
import { timingSafeEqual } from "node:crypto";
import type http from "node:http";
import { stringToUuid, type UUID } from "@elizaos/core";
import { readAliasedEnv } from "@elizaos/shared";
import type { ConversationMeta } from "./server-types.ts";

type CloudRealtimeConversation = Pick<
  ConversationMeta,
  "id" | "roomId" | "cloudOwnerEntityId"
>;

export const CLOUD_PRINCIPAL_METADATA_KEY = "elizaCloudPrincipal";

export function isCloudPrincipalRequired(): boolean {
  const provisioned = readAliasedEnv("ELIZA_CLOUD_PROVISIONED");
  return provisioned === "1" || provisioned?.trim().toLowerCase() === "true";
}

export function resolveTrustedCloudPrincipal(
  req: Pick<http.IncomingMessage, "headers">,
): UUID | null {
  if (!isCloudPrincipalRequired()) return null;
  const expectedToken = readAliasedEnv("ELIZA_API_TOKEN")?.trim();
  const suppliedToken = req.headers["x-eliza-principal-token"];
  const suppliedPrincipal = req.headers["x-eliza-user-id"];
  if (
    !expectedToken ||
    typeof suppliedToken !== "string" ||
    typeof suppliedPrincipal !== "string"
  ) {
    return null;
  }
  const expected = Buffer.from(expectedToken);
  const supplied = Buffer.from(suppliedToken.trim());
  if (
    expected.length !== supplied.length ||
    !timingSafeEqual(expected, supplied)
  ) {
    return null;
  }
  const principal = suppliedPrincipal.trim();
  return principal ? stringToUuid(principal) : null;
}

/** Caller metadata is scrubbed before the server-owned attestation is added. */
export function withTrustedCloudPrincipalMetadata(
  metadata: Record<string, unknown> | undefined,
  principal: UUID | null,
): Record<string, unknown> | undefined {
  const next = metadata ? { ...metadata } : {};
  delete next[CLOUD_PRINCIPAL_METADATA_KEY];
  if (principal) {
    next[CLOUD_PRINCIPAL_METADATA_KEY] = {
      id: principal,
      attested: true,
    };
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/** A managed socket may select and receive only its own conversation. */
export function cloudPrincipalOwnsConversation(
  principal: UUID | null | undefined,
  conversation: Pick<ConversationMeta, "cloudOwnerEntityId"> | null | undefined,
): boolean {
  return Boolean(principal && conversation?.cloudOwnerEntityId === principal);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function findRealtimeConversation(
  conversations: Iterable<CloudRealtimeConversation>,
  payload: Record<string, unknown>,
): CloudRealtimeConversation | undefined {
  const embeddedConversation = asRecord(payload.conversation);
  const embeddedMessage = asRecord(payload.message);
  const conversationIds = new Set(
    [
      payload.conversationId,
      embeddedConversation?.id,
      embeddedMessage?.conversationId,
    ].filter((value): value is string => typeof value === "string"),
  );
  const roomIds = new Set(
    [
      payload.roomId,
      embeddedConversation?.roomId,
      embeddedMessage?.roomId,
    ].filter((value): value is string => typeof value === "string"),
  );

  if (conversationIds.size === 0 && roomIds.size === 0) return undefined;

  for (const conversation of conversations) {
    if (
      [...conversationIds].every(
        (conversationId) => conversation.id === conversationId,
      ) &&
      [...roomIds].every((roomId) => conversation.roomId === roomId)
    ) {
      return conversation;
    }
  }
  return undefined;
}

/**
 * Fail-closed routing policy for the process-global WebSocket bus. Agent-level
 * status is shared; every data-bearing frame must identify a persisted room or
 * conversation owned by the socket's attested Cloud principal.
 */
export function canCloudPrincipalReceiveRealtimePayload(
  principal: UUID | null | undefined,
  conversations: Iterable<CloudRealtimeConversation>,
  payload: unknown,
): boolean {
  if (!principal) return false;
  const record = asRecord(payload);
  if (!record) return false;
  if (record.type === "status" || record.type === "restart-required") {
    return true;
  }
  return cloudPrincipalOwnsConversation(
    principal,
    findRealtimeConversation(conversations, record),
  );
}
