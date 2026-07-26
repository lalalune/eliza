/**
 * Resolves connector identities to one owned Eliza runtime and dispatches the
 * resulting message. Strong-auth Worker requests serve target decisions from a
 * bounded shared cache; cold authoritative lookups run under waitUntil so a
 * connector turn never reaches Postgres before paid-provider dispatch.
 */
import { createHash, randomUUID } from "crypto";
import { and, desc, eq } from "drizzle-orm";
import { dbWrite } from "../../db/client";
import { type AgentSandbox, agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import { usersRepository } from "../../db/repositories/users";
import { agentPhoneContacts, agentPhoneNumbers, phoneMessageLog } from "../../db/schemas";
import { cache } from "../cache/client";
import { logger } from "../utils/logger";
import { normalizePhoneNumber } from "../utils/phone-normalization";
import { type AgentGatewayRelaySession, agentGatewayRelayService } from "./agent-gateway-relay";
import {
  readManagedAgentDiscordBinding,
  readManagedAgentDiscordGateway,
} from "./eliza-agent-config";
import { runOnboardingChat } from "./eliza-app/onboarding-chat";
import type { BridgeExecutionContext, BridgeRequest, BridgeResponse } from "./eliza-sandbox";
import { BRIDGE_CACHE_WARMING_CODE, elizaSandboxService } from "./eliza-sandbox";
import { isInferenceAuthCacheEnabled } from "./inference-hot-path-caches";
import {
  type CachedAgentSandbox,
  rehydrateCachedAgentDates,
} from "./shared-runtime/cached-agent-dates";

export type AgentGatewayRouteReason =
  | "not_linked"
  | "unknown_owner"
  | "owner_org_mismatch"
  | "sender_not_guild_owner"
  | "owner_agent_not_running"
  | "ambiguous_target"
  | "target_cache_warming"
  | "bridge_failed";

export interface AgentGatewaySender {
  id: string;
  username: string;
  displayName?: string;
  avatar?: string | null;
}

export interface AgentGatewayRouteResult {
  handled: boolean;
  replyText?: string | null;
  reason?: AgentGatewayRouteReason;
  agentId?: string;
  organizationId?: string;
  userId?: string;
  roomId?: string;
  retryable?: boolean;
}

interface ResolvedAgentTarget {
  kind: "sandbox" | "local-session";
  sandbox?: AgentSandbox;
  session?: AgentGatewayRelaySession;
  sessions?: AgentGatewayRelaySession[];
}

type PhoneTargetResolution = {
  target?: ResolvedAgentTarget;
  reason?: AgentGatewayRouteReason;
  agentId?: string;
  userId?: string;
  organizationId?: string;
  source?: "owner" | "contact";
  retryable?: boolean;
};

const PHONE_TARGET_CACHE_TTL_MS = 5_000;
const CONNECTOR_TARGET_FRESH_MS = 30_000;
const CONNECTOR_TARGET_PHYSICAL_TTL_SECONDS = 5 * 60;
const CONNECTOR_TARGET_REFRESH_TTL_SECONDS = 60;

interface CachedResolvedAgentTarget {
  kind: ResolvedAgentTarget["kind"];
  sandbox?: CachedAgentSandbox;
  session?: AgentGatewayRelaySession;
  sessions?: AgentGatewayRelaySession[];
}

interface CachedConnectorTargetResolution extends Omit<PhoneTargetResolution, "target"> {
  target?: CachedResolvedAgentTarget;
  hydratedAtMs: number;
}

function connectorTargetCacheKey(parts: readonly string[]): string {
  const fingerprint = createHash("sha256").update(parts.join("\u0000")).digest("hex");
  return `agent-gateway-target:${fingerprint}:v1`;
}

function cacheConnectorTargetResolution(
  resolution: PhoneTargetResolution,
): CachedConnectorTargetResolution {
  return {
    ...resolution,
    ...(resolution.target
      ? {
          target: {
            kind: resolution.target.kind,
            ...(resolution.target.sandbox ? { sandbox: resolution.target.sandbox } : {}),
            ...(resolution.target.session ? { session: resolution.target.session } : {}),
            ...(resolution.target.sessions ? { sessions: resolution.target.sessions } : {}),
          },
        }
      : {}),
    hydratedAtMs: Date.now(),
  };
}

function restoreConnectorTargetResolution(
  cached: CachedConnectorTargetResolution,
): PhoneTargetResolution | null {
  if (
    !cached ||
    typeof cached !== "object" ||
    typeof cached.hydratedAtMs !== "number" ||
    !Number.isFinite(cached.hydratedAtMs)
  ) {
    return null;
  }
  try {
    const { target, hydratedAtMs: _hydratedAtMs, ...resolution } = cached;
    return {
      ...resolution,
      ...(target
        ? {
            target: {
              kind: target.kind,
              ...(target.sandbox
                ? {
                    sandbox: rehydrateCachedAgentDates(target.sandbox),
                  }
                : {}),
              ...(target.session ? { session: target.session } : {}),
              ...(target.sessions ? { sessions: target.sessions } : {}),
            },
          }
        : {}),
    };
  } catch (error) {
    logger.warn("[AgentGatewayRouter] Invalid cached connector target", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function targetCacheWarming(): PhoneTargetResolution {
  return {
    reason: "target_cache_warming",
    retryable: true,
  };
}

function isUndefinedAgentPhoneContactsTableError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && (error as { code?: unknown }).code === "42P01") {
    return true;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (cause && cause !== error) {
    return isUndefinedAgentPhoneContactsTableError(cause);
  }
  const message = (error as { message?: unknown }).message;
  return (
    typeof message === "string" &&
    message.includes('relation "agent_phone_contacts" does not exist')
  );
}

function asConfigRecord(
  value: AgentSandbox["agent_config"],
): Record<string, unknown> | null | undefined {
  return (value as Record<string, unknown> | null | undefined) ?? null;
}

function isNonGatewayRunningSandbox(sandbox: AgentSandbox): boolean {
  return (
    sandbox.status === "running" &&
    !readManagedAgentDiscordGateway(asConfigRecord(sandbox.agent_config))
  );
}

function chooseSingleSandboxTarget(sandboxes: AgentSandbox[]): {
  target?: ResolvedAgentTarget;
  reason?: AgentGatewayRouteReason;
  agentId?: string;
} {
  const running = sandboxes.filter(isNonGatewayRunningSandbox);
  if (running.length === 1) {
    return {
      target: {
        kind: "sandbox",
        sandbox: running[0]!,
      },
    };
  }

  if (running.length > 1) {
    return {
      reason: "ambiguous_target",
    };
  }

  if (sandboxes.length > 0) {
    return {
      reason: "owner_agent_not_running",
      agentId: sandboxes[0]?.id,
    };
  }

  return {
    reason: "owner_agent_not_running",
  };
}

function hashToUuid(input: string): string {
  const hex = createHash("sha256").update(input).digest("hex").slice(0, 32);
  const chars = hex.split("");
  chars[12] = "4";
  chars[16] = ((Number.parseInt(chars[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return [
    chars.slice(0, 8).join(""),
    chars.slice(8, 12).join(""),
    chars.slice(12, 16).join(""),
    chars.slice(16, 20).join(""),
    chars.slice(20, 32).join(""),
  ].join("-");
}

function buildDirectConversationRoomId(
  agentId: string,
  platform: string,
  a: string,
  b: string,
): string {
  const normalized = [normalizePhoneNumber(a), normalizePhoneNumber(b)].sort().join("-");
  return hashToUuid(`room:${agentId}:${platform}:${normalized}`);
}

function buildDirectConversationRoomIdFromIds(
  agentId: string,
  platform: string,
  a: string,
  b: string,
): string {
  const normalized = [a.trim(), b.trim()].sort().join("-");
  return hashToUuid(`room:${agentId}:${platform}:${normalized}`);
}

function buildMediaAttachments(
  mediaUrls?: string[],
): Array<{ type: "image"; url: string }> | undefined {
  if (!mediaUrls?.length) {
    return undefined;
  }
  return mediaUrls.map((url) => ({
    type: "image" as const,
    url,
  }));
}

function extractReplyText(response: BridgeResponse): string | null {
  if (
    response.result &&
    typeof response.result === "object" &&
    typeof response.result.text === "string"
  ) {
    return response.result.text;
  }

  return null;
}

function extractRoomId(rpc: BridgeRequest): string | undefined {
  const params = rpc.params;
  if (!params || typeof params !== "object") {
    return undefined;
  }

  const roomId = (params as Record<string, unknown>).roomId;
  return typeof roomId === "string" && roomId.trim() ? roomId.trim() : undefined;
}

export class AgentGatewayRouterService {
  private phoneTargetCache = new Map<string, { value: PhoneTargetResolution; cachedAt: number }>();
  private phoneTargetRequests = new Map<string, Promise<PhoneTargetResolution>>();
  private readonly runOnboardingChat: typeof runOnboardingChat;

  constructor(options: { runOnboardingChat?: typeof runOnboardingChat } = {}) {
    this.runOnboardingChat = options.runOnboardingChat ?? runOnboardingChat;
  }

  private scheduleConnectorTargetHydration(
    cacheKey: string,
    executionCtx: BridgeExecutionContext | undefined,
    hydrate: () => Promise<PhoneTargetResolution>,
  ): void {
    if (!executionCtx) return;
    const refreshWindow = Math.floor(Date.now() / CONNECTOR_TARGET_FRESH_MS);
    const refreshKey = `${cacheKey}:refresh:${refreshWindow}`;
    const hydration = cache
      .getOrSet(
        refreshKey,
        CONNECTOR_TARGET_REFRESH_TTL_SECONDS,
        async () => {
          const resolved = cacheConnectorTargetResolution(await hydrate());
          await cache.set(cacheKey, resolved, CONNECTOR_TARGET_PHYSICAL_TTL_SECONDS);
          return { hydratedAtMs: resolved.hydratedAtMs };
        },
        { singleflight: true },
      )
      .then(() => undefined)
      .catch((error) => {
        // error-policy:J7 the cold request already returned an explicit
        // retryable result; diagnostics record why its background fill failed.
        logger.warn("[AgentGatewayRouter] Connector target hydration failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    executionCtx.waitUntil(hydration);
  }

  private async resolveConnectorTarget(
    identity: readonly string[],
    executionCtx: BridgeExecutionContext | undefined,
    hydrate: () => Promise<PhoneTargetResolution>,
  ): Promise<PhoneTargetResolution> {
    if (!isInferenceAuthCacheEnabled()) {
      return await hydrate();
    }

    const cacheKey = connectorTargetCacheKey(identity);
    let cached: CachedConnectorTargetResolution | null = null;
    try {
      cached = await cache.get<CachedConnectorTargetResolution>(cacheKey);
    } catch (error) {
      // error-policy:J4 cache loss is a visible retryable connector result;
      // it never falls through to response-path repository resolution.
      logger.warn("[AgentGatewayRouter] Connector target cache read failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const restored = cached ? restoreConnectorTargetResolution(cached) : null;
    if (restored && cached) {
      if (Date.now() - cached.hydratedAtMs >= CONNECTOR_TARGET_FRESH_MS) {
        this.scheduleConnectorTargetHydration(cacheKey, executionCtx, hydrate);
      }
      return restored;
    }

    this.scheduleConnectorTargetHydration(cacheKey, executionCtx, hydrate);
    return targetCacheWarming();
  }

  async resolveServiceAgent(args: {
    agentId: string;
    executionCtx?: BridgeExecutionContext;
  }): Promise<{
    agent?: AgentSandbox;
    retryable?: boolean;
  }> {
    const resolved = await this.resolveConnectorTarget(
      ["service", args.agentId],
      args.executionCtx,
      async () => {
        const agent = await elizaSandboxService.getAgentById(args.agentId);
        return agent
          ? {
              target: {
                kind: "sandbox",
                sandbox: agent,
              },
              agentId: agent.id,
              userId: agent.user_id,
              organizationId: agent.organization_id,
            }
          : {
              reason: "owner_agent_not_running",
              agentId: args.agentId,
            };
      },
    );
    return {
      ...(resolved.target?.sandbox ? { agent: resolved.target.sandbox } : {}),
      ...(resolved.retryable ? { retryable: true } : {}),
    };
  }

  private async listOwnedSandboxes(orgId: string, userId: string): Promise<AgentSandbox[]> {
    const sandboxes = await agentSandboxesRepository.listByOrganization(orgId);
    return sandboxes.filter((sandbox) => sandbox.user_id === userId);
  }

  private async resolveOwnedRuntimeTarget(
    organizationId: string,
    userId: string,
    sandboxes?: AgentSandbox[],
  ): Promise<{
    target?: ResolvedAgentTarget;
    reason?: AgentGatewayRouteReason;
    agentId?: string;
    userId?: string;
  }> {
    const localSessions = await agentGatewayRelayService.listOwnerSessions(organizationId, userId);
    if (localSessions.length >= 1) {
      return {
        target: {
          kind: "local-session",
          session: localSessions[0],
          sessions: localSessions,
        },
        userId,
      };
    }

    const ownedSandboxes = sandboxes ?? (await this.listOwnedSandboxes(organizationId, userId));
    const resolved = chooseSingleSandboxTarget(ownedSandboxes);
    return {
      ...resolved,
      userId,
    };
  }

  private async resolveDiscordTarget(args: {
    guildId?: string | null;
    senderDiscordUserId: string;
  }): Promise<{
    target?: ResolvedAgentTarget;
    reason?: AgentGatewayRouteReason;
    agentId?: string;
    userId?: string;
  }> {
    const senderDiscordUserId = args.senderDiscordUserId.trim();

    if (args.guildId?.trim()) {
      const linkedSandboxes = await agentSandboxesRepository.findByManagedDiscordGuildId(
        args.guildId.trim(),
      );
      const ownedLinkedSandboxes = linkedSandboxes.filter((sandbox) => {
        const binding = readManagedAgentDiscordBinding(asConfigRecord(sandbox.agent_config));
        return binding?.adminDiscordUserId === senderDiscordUserId;
      });

      if (ownedLinkedSandboxes.length === 0) {
        return {
          reason: linkedSandboxes.length > 0 ? "sender_not_guild_owner" : "not_linked",
        };
      }

      const directlyBoundSandboxes = ownedLinkedSandboxes.filter(
        (sandbox) => !readManagedAgentDiscordGateway(asConfigRecord(sandbox.agent_config)),
      );
      if (directlyBoundSandboxes.length > 0) {
        return chooseSingleSandboxTarget(directlyBoundSandboxes);
      }

      const owner = await usersRepository.findByDiscordIdWithOrganization(senderDiscordUserId);
      if (!owner?.organization_id) {
        return {
          reason: "unknown_owner",
        };
      }

      return this.resolveOwnedRuntimeTarget(owner.organization_id, owner.id);
    }

    const owner = await usersRepository.findByDiscordIdWithOrganization(senderDiscordUserId);
    if (!owner) {
      return {
        reason: "unknown_owner",
      };
    }

    if (!owner.organization_id) {
      return {
        reason: "unknown_owner",
      };
    }

    const sandboxes = await this.listOwnedSandboxes(owner.organization_id, owner.id);
    const exactBoundMatches = sandboxes.filter((sandbox) => {
      const binding = readManagedAgentDiscordBinding(asConfigRecord(sandbox.agent_config));
      return binding?.adminDiscordUserId === senderDiscordUserId;
    });

    const preferred = exactBoundMatches.length > 0 ? exactBoundMatches : sandboxes;
    return this.resolveOwnedRuntimeTarget(owner.organization_id, owner.id, preferred);
  }

  private async resolvePhoneTarget(args: {
    organizationId: string;
    provider: "twilio" | "blooio" | "whatsapp";
    senderId: string;
  }): Promise<PhoneTargetResolution> {
    const senderId = args.senderId.trim();
    if (!senderId) {
      return {
        reason: "unknown_owner",
      };
    }

    const lookupId = senderId.includes("@")
      ? senderId.toLowerCase()
      : normalizePhoneNumber(senderId);
    const cacheKey = `${args.organizationId}:${args.provider}:${lookupId}`;
    const cached = this.phoneTargetCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < PHONE_TARGET_CACHE_TTL_MS) {
      return cached.value;
    }

    const pending = this.phoneTargetRequests.get(cacheKey);
    if (pending) return pending;

    const request = this.resolvePhoneTargetUncached({
      organizationId: args.organizationId,
      provider: args.provider,
      senderId,
      lookupId,
    })
      .then((value) => {
        this.phoneTargetCache.set(cacheKey, { value, cachedAt: Date.now() });
        return value;
      })
      .finally(() => {
        this.phoneTargetRequests.delete(cacheKey);
      });
    this.phoneTargetRequests.set(cacheKey, request);
    return request;
  }

  private async resolvePhoneTargetUncached(args: {
    organizationId: string;
    provider: "twilio" | "blooio" | "whatsapp";
    senderId: string;
    lookupId: string;
  }): Promise<PhoneTargetResolution> {
    const owner = args.senderId.includes("@")
      ? await usersRepository.findByEmailWithOrganization(args.lookupId)
      : await usersRepository.findByPhoneNumberWithOrganization(args.lookupId);

    if (!owner) {
      const contact = await this.resolveLoggedPhoneContactTarget(args.lookupId, args.provider);
      return contact.target ? contact : { reason: "unknown_owner" };
    }

    if (!owner.organization_id) {
      return {
        reason: "unknown_owner",
        userId: owner.id,
      };
    }

    let owned: Awaited<ReturnType<AgentGatewayRouterService["resolveOwnedRuntimeTarget"]>>;
    try {
      owned = await this.resolveOwnedRuntimeTarget(owner.organization_id, owner.id);
    } catch (error) {
      logger.error("[AgentGatewayRouter] Failed to resolve phone sender's own runtime", {
        provider: args.provider,
        userId: owner.id,
        organizationId: owner.organization_id,
        error: error instanceof Error ? error.message : String(error),
      });
      owned = {
        reason: "owner_agent_not_running",
        userId: owner.id,
      };
    }

    if (owned.target) {
      return {
        ...owned,
        organizationId: owner.organization_id,
        source: "owner",
      };
    }

    const contact = await this.resolveLoggedPhoneContactTarget(args.lookupId, args.provider);
    if (contact.target) return contact;

    return {
      ...owned,
      organizationId: owner.organization_id,
      source: "owner",
    };
  }

  private async resolveLoggedPhoneContactTarget(
    lookupId: string,
    provider: "twilio" | "blooio" | "whatsapp",
  ): Promise<PhoneTargetResolution> {
    const normalizedPhone = lookupId.includes("@")
      ? lookupId.toLowerCase()
      : normalizePhoneNumber(lookupId);
    if (!normalizedPhone) {
      return { reason: "unknown_owner" };
    }

    try {
      const [latestContact] = await dbWrite
        .select({
          agentId: agentPhoneContacts.agent_id,
          organizationId: agentPhoneContacts.organization_id,
          userId: agentPhoneContacts.user_id,
        })
        .from(agentPhoneContacts)
        .where(
          and(
            eq(agentPhoneContacts.provider, provider),
            eq(agentPhoneContacts.contact_identifier, normalizedPhone),
            eq(agentPhoneContacts.is_active, true),
          ),
        )
        .orderBy(desc(agentPhoneContacts.last_contacted_at))
        .limit(1);

      if (latestContact) {
        await this.markPhoneContactInbound({
          provider,
          contactIdentifier: normalizedPhone,
          agentId: latestContact.agentId,
        });
        return this.resolvePhoneContactAgentTarget({
          agentId: latestContact.agentId,
          organizationId: latestContact.organizationId,
          userId: latestContact.userId,
        });
      }
    } catch (error) {
      if (!isUndefinedAgentPhoneContactsTableError(error)) {
        throw error;
      }
      logger.warn("[AgentGatewayRouter] agent_phone_contacts table is not migrated yet");
    }

    const [latestOutbound] = await dbWrite
      .select({
        agentId: agentPhoneNumbers.agent_id,
        organizationId: agentPhoneNumbers.organization_id,
      })
      .from(phoneMessageLog)
      .innerJoin(agentPhoneNumbers, eq(phoneMessageLog.phone_number_id, agentPhoneNumbers.id))
      .where(
        and(
          eq(phoneMessageLog.direction, "outbound"),
          eq(phoneMessageLog.to_number, normalizedPhone),
          eq(agentPhoneNumbers.is_active, true),
        ),
      )
      .orderBy(desc(phoneMessageLog.created_at))
      .limit(1);

    if (!latestOutbound) {
      return { reason: "unknown_owner" };
    }

    return this.resolvePhoneContactAgentTarget({
      agentId: latestOutbound.agentId,
      organizationId: latestOutbound.organizationId,
    });
  }

  private async markPhoneContactInbound(args: {
    provider: "twilio" | "blooio" | "whatsapp";
    contactIdentifier: string;
    agentId: string;
  }): Promise<void> {
    const now = new Date();
    try {
      await dbWrite
        .update(agentPhoneContacts)
        .set({
          last_contacted_at: now,
          last_inbound_at: now,
          updated_at: now,
        })
        .where(
          and(
            eq(agentPhoneContacts.provider, args.provider),
            eq(agentPhoneContacts.contact_identifier, args.contactIdentifier),
            eq(agentPhoneContacts.agent_id, args.agentId),
          ),
        );
    } catch (error) {
      if (isUndefinedAgentPhoneContactsTableError(error)) {
        logger.warn("[AgentGatewayRouter] agent_phone_contacts table is not migrated yet");
        return;
      }
      logger.warn("[AgentGatewayRouter] failed to update phone contact inbound timestamp", {
        provider: args.provider,
        agentId: args.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async resolvePhoneContactAgentTarget(args: {
    agentId: string;
    organizationId: string;
    userId?: string | null;
  }): Promise<PhoneTargetResolution> {
    const sandbox = await agentSandboxesRepository.findRunningSandbox(
      args.agentId,
      args.organizationId,
    );
    if (!sandbox || !isNonGatewayRunningSandbox(sandbox)) {
      return {
        reason: "owner_agent_not_running",
        agentId: args.agentId,
        userId: args.userId ?? undefined,
        organizationId: args.organizationId,
        source: "contact",
      };
    }

    return {
      target: {
        kind: "sandbox",
        sandbox,
      },
      agentId: args.agentId,
      userId: sandbox.user_id,
      organizationId: args.organizationId,
      source: "contact",
    };
  }

  private async routeToTarget(
    target: ResolvedAgentTarget,
    rpc: BridgeRequest,
    executionCtx?: BridgeExecutionContext,
  ): Promise<AgentGatewayRouteResult> {
    if (target.kind === "local-session" && target.session) {
      const sessions = target.sessions ?? [target.session];
      const responses = await Promise.all(
        sessions.map(async (session) => ({
          session,
          response: await agentGatewayRelayService.routeToSession(session, rpc),
        })),
      );

      const successful = responses.filter((entry) => !entry.response.error);
      for (const entry of responses) {
        if (!entry.response.error) {
          continue;
        }
        logger.warn("[agent-gateway] Local relay rejected inbound message", {
          agentId: entry.session.runtimeAgentId,
          organizationId: entry.session.organizationId,
          method: rpc.method,
          error: entry.response.error.message,
        });
      }

      if (successful.length === 0) {
        return {
          handled: false,
          reason: "bridge_failed",
          agentId: sessions[0]?.runtimeAgentId,
          organizationId: sessions[0]?.organizationId,
          roomId: extractRoomId(rpc),
        };
      }

      const primary =
        successful.find((entry) => extractReplyText(entry.response) !== null) ?? successful[0]!;

      return {
        handled: true,
        replyText: extractReplyText(primary.response),
        agentId: primary.session.runtimeAgentId,
        organizationId: primary.session.organizationId,
        roomId: extractRoomId(rpc),
      };
    }

    if (!target.sandbox) {
      return {
        handled: false,
        reason: "bridge_failed",
        roomId: extractRoomId(rpc),
      };
    }

    const response =
      target.sandbox.execution_tier === "shared"
        ? await elizaSandboxService.bridgeResolvedShared(target.sandbox, rpc, executionCtx)
        : await elizaSandboxService.bridge(
            target.sandbox.id,
            target.sandbox.organization_id,
            rpc,
            executionCtx,
          );

    if (response.error) {
      logger.warn("[agent-gateway] Sandbox bridge rejected inbound message", {
        agentId: target.sandbox.id,
        organizationId: target.sandbox.organization_id,
        method: rpc.method,
        error: response.error.message,
      });
      return {
        handled: false,
        reason: "bridge_failed",
        agentId: target.sandbox.id,
        organizationId: target.sandbox.organization_id,
        roomId: extractRoomId(rpc),
        ...(response.error.code === BRIDGE_CACHE_WARMING_CODE ? { retryable: true } : {}),
      };
    }

    return {
      handled: true,
      replyText: extractReplyText(response),
      agentId: target.sandbox.id,
      organizationId: target.sandbox.organization_id,
      roomId: extractRoomId(rpc),
    };
  }

  async routeDiscordMessage(args: {
    guildId?: string | null;
    channelId: string;
    messageId: string;
    content: string;
    sender: AgentGatewaySender;
    executionCtx?: BridgeExecutionContext;
  }): Promise<AgentGatewayRouteResult> {
    const resolved = await this.resolveConnectorTarget(
      ["discord", args.guildId?.trim() || "dm", args.sender.id.trim()],
      args.executionCtx,
      () =>
        this.resolveDiscordTarget({
          guildId: args.guildId ?? null,
          senderDiscordUserId: args.sender.id,
        }),
    );

    if (!resolved.target) {
      return {
        handled: false,
        reason: resolved.reason,
        agentId: resolved.agentId,
        userId: resolved.userId,
        retryable: resolved.retryable,
      };
    }

    const rpcRequest: BridgeRequest = {
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "message.send",
      params: {
        text: args.content,
        roomId: args.guildId?.trim()
          ? `discord-guild:${args.guildId.trim()}:channel:${args.channelId}`
          : `discord-dm:${args.sender.id}:channel:${args.channelId}`,
        channelType: args.guildId?.trim() ? "GROUP" : "DM",
        source: "discord",
        sender: {
          id: args.sender.id,
          username: args.sender.username,
          ...(args.sender.displayName ? { displayName: args.sender.displayName } : {}),
          metadata: {
            discord: {
              userId: args.sender.id,
              username: args.sender.username,
              ...(args.sender.displayName ? { globalName: args.sender.displayName } : {}),
              ...(args.sender.avatar ? { avatar: args.sender.avatar } : {}),
            },
          },
        },
        metadata: {
          discord: {
            ...(args.guildId?.trim() ? { guildId: args.guildId.trim() } : {}),
            channelId: args.channelId,
            messageId: args.messageId,
          },
        },
      },
    };

    const routed = await this.routeToTarget(resolved.target, rpcRequest, args.executionCtx);
    return {
      ...routed,
      userId: resolved.userId,
    };
  }

  async routePhoneMessage(args: {
    organizationId: string;
    provider: "twilio" | "blooio";
    from: string;
    to: string;
    body: string;
    providerMessageId?: string;
    mediaUrls?: string[];
    metadata?: Record<string, unknown>;
    executionCtx?: BridgeExecutionContext;
  }): Promise<AgentGatewayRouteResult> {
    let resolved: Awaited<ReturnType<AgentGatewayRouterService["resolvePhoneTarget"]>>;
    try {
      resolved = await this.resolveConnectorTarget(
        [
          "phone",
          args.organizationId,
          args.provider,
          args.from.includes("@")
            ? args.from.trim().toLowerCase()
            : normalizePhoneNumber(args.from),
        ],
        args.executionCtx,
        () =>
          this.resolvePhoneTarget({
            organizationId: args.organizationId,
            provider: args.provider,
            senderId: args.from,
          }),
      );
    } catch (error) {
      logger.error("[AgentGatewayRouter] Failed to resolve phone target", {
        provider: args.provider,
        from: args.from,
        to: args.to,
        error: error instanceof Error ? error.message : String(error),
      });
      const onboarding = await this.runOnboardingChat(
        {
          message: args.body,
          platform: args.provider,
          platformUserId: args.from,
          sessionId: `platform:${args.provider}:${args.from}`,
          trustedPlatformIdentity: true,
        },
        args.executionCtx
          ? {
              executionCtx: args.executionCtx,
              requestId: randomUUID(),
            }
          : undefined,
      );

      return {
        handled: true,
        replyText: onboarding.reply,
        reason: "bridge_failed",
        userId: onboarding.session.userId,
        organizationId: onboarding.session.organizationId,
        agentId: onboarding.provisioning.agentId ?? undefined,
      };
    }

    if (!resolved.target) {
      if (resolved.reason === "unknown_owner") {
        const onboarding = await this.runOnboardingChat(
          {
            message: args.body,
            platform: args.provider,
            platformUserId: args.from,
            sessionId: `platform:${args.provider}:${args.from}`,
            trustedPlatformIdentity: true,
          },
          args.executionCtx
            ? {
                executionCtx: args.executionCtx,
                requestId: randomUUID(),
              }
            : undefined,
        );

        return {
          handled: true,
          replyText: onboarding.reply,
          reason: resolved.reason,
          userId: onboarding.session.userId,
          organizationId: onboarding.session.organizationId,
          agentId: onboarding.provisioning.agentId ?? undefined,
        };
      }

      if (
        resolved.reason === "owner_agent_not_running" &&
        resolved.userId &&
        resolved.organizationId &&
        !resolved.agentId
      ) {
        const onboarding = await this.runOnboardingChat(
          {
            message: args.body,
            platform: args.provider,
            platformUserId: args.from,
            sessionId: `platform:${args.provider}:${args.from}`,
            authenticatedUser: {
              userId: resolved.userId,
              organizationId: resolved.organizationId,
            },
          },
          args.executionCtx
            ? {
                executionCtx: args.executionCtx,
                requestId: randomUUID(),
              }
            : undefined,
        );

        return {
          handled: true,
          replyText: onboarding.reply,
          reason: resolved.reason,
          userId: resolved.userId,
          organizationId: resolved.organizationId,
          agentId: onboarding.provisioning.agentId ?? undefined,
        };
      }

      return {
        handled: false,
        reason: resolved.reason,
        agentId: resolved.agentId,
        userId: resolved.userId,
        organizationId: resolved.organizationId,
        retryable: resolved.retryable,
      };
    }

    const targetAgentId =
      resolved.target.kind === "local-session" && resolved.target.session
        ? resolved.target.session.runtimeAgentId
        : (resolved.target.sandbox?.id ?? "unknown-agent");
    const normalizedFrom = normalizePhoneNumber(args.from);
    const normalizedTo = normalizePhoneNumber(args.to);
    const attachments = buildMediaAttachments(args.mediaUrls);
    const rpcRequest: BridgeRequest = {
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "message.send",
      params: {
        text: args.body,
        roomId: buildDirectConversationRoomId(
          targetAgentId,
          args.provider,
          normalizedFrom,
          normalizedTo,
        ),
        channelType: "DM",
        source: args.provider,
        sender: {
          id: normalizedFrom,
          username: normalizedFrom,
          metadata: {
            [args.provider]: {
              sender: normalizedFrom,
              recipient: normalizedTo,
            },
          },
        },
        ...(attachments ? { attachments } : {}),
        metadata: {
          provider: args.provider,
          from: normalizedFrom,
          to: normalizedTo,
          ...(args.providerMessageId ? { providerMessageId: args.providerMessageId } : {}),
          ...(args.metadata ? args.metadata : {}),
        },
      },
    };

    let routed: AgentGatewayRouteResult;
    try {
      routed = await this.routeToTarget(resolved.target, rpcRequest, args.executionCtx);
    } catch (error) {
      logger.error("[AgentGatewayRouter] Phone target route threw", {
        provider: args.provider,
        from: normalizedFrom,
        to: normalizedTo,
        agentId: resolved.agentId,
        userId: resolved.userId,
        organizationId: resolved.organizationId,
        source: resolved.source,
        error: error instanceof Error ? error.message : String(error),
      });
      routed = {
        handled: false,
        reason: "bridge_failed",
        agentId: resolved.agentId,
        organizationId: resolved.organizationId,
        roomId: extractRoomId(rpcRequest),
      };
    }

    if (
      !routed.handled &&
      routed.reason === "bridge_failed" &&
      !routed.retryable &&
      resolved.source === "owner" &&
      resolved.userId &&
      resolved.organizationId
    ) {
      const onboarding = await this.runOnboardingChat(
        {
          message: args.body,
          platform: args.provider,
          platformUserId: args.from,
          sessionId: `platform:${args.provider}:${args.from}`,
          authenticatedUser: {
            userId: resolved.userId,
            organizationId: resolved.organizationId,
          },
        },
        args.executionCtx
          ? {
              executionCtx: args.executionCtx,
              requestId: randomUUID(),
            }
          : undefined,
      );

      return {
        handled: true,
        replyText: onboarding.reply,
        reason: "bridge_failed",
        userId: resolved.userId,
        organizationId: resolved.organizationId,
        agentId: onboarding.provisioning.agentId ?? routed.agentId,
        roomId: routed.roomId,
      };
    }

    return {
      ...routed,
      userId: resolved.userId,
      organizationId: routed.organizationId ?? resolved.organizationId,
    };
  }

  async routeTelegramMessage(args: {
    organizationId: string;
    chatId: string;
    messageId: string;
    content: string;
    sender: AgentGatewaySender;
    executionCtx?: BridgeExecutionContext;
  }): Promise<AgentGatewayRouteResult> {
    const senderTelegramId = args.sender.id.trim();
    const resolved = await this.resolveConnectorTarget(
      ["telegram", args.organizationId, senderTelegramId],
      args.executionCtx,
      async () => {
        const owner = await usersRepository.findByTelegramIdWithOrganization(senderTelegramId);
        if (!owner) {
          return {
            reason: "unknown_owner",
          };
        }
        if (owner.organization_id !== args.organizationId) {
          return {
            reason: "owner_org_mismatch",
            userId: owner.id,
            organizationId: owner.organization_id ?? undefined,
          };
        }
        const owned = await this.resolveOwnedRuntimeTarget(owner.organization_id, owner.id);
        return {
          ...owned,
          organizationId: owner.organization_id,
        };
      },
    );
    if (!resolved.target) {
      return {
        handled: false,
        reason: resolved.reason,
        agentId: resolved.agentId,
        userId: resolved.userId,
        organizationId: resolved.organizationId,
        retryable: resolved.retryable,
      };
    }

    const targetAgentId =
      resolved.target.kind === "local-session" && resolved.target.session
        ? resolved.target.session.runtimeAgentId
        : (resolved.target.sandbox?.id ?? resolved.userId ?? senderTelegramId);
    const roomId = buildDirectConversationRoomIdFromIds(
      targetAgentId,
      "telegram",
      senderTelegramId,
      args.chatId,
    );
    const rpcRequest: BridgeRequest = {
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "message.send",
      params: {
        text: args.content,
        roomId,
        channelType: "DM",
        source: "telegram",
        sender: {
          id: senderTelegramId,
          username: args.sender.username,
          ...(args.sender.displayName ? { displayName: args.sender.displayName } : {}),
          metadata: {
            telegram: {
              userId: senderTelegramId,
              username: args.sender.username,
              ...(args.sender.displayName ? { displayName: args.sender.displayName } : {}),
            },
          },
        },
        metadata: {
          telegram: {
            chatId: args.chatId,
            messageId: args.messageId,
          },
        },
      },
    };

    const routed = await this.routeToTarget(resolved.target, rpcRequest, args.executionCtx);
    return {
      ...routed,
      userId: resolved.userId,
    };
  }

  async routeWhatsAppMessage(args: {
    organizationId: string;
    from: string;
    to: string;
    body: string;
    providerMessageId?: string;
    mediaUrls?: string[];
    metadata?: Record<string, unknown>;
    senderName?: string;
    executionCtx?: BridgeExecutionContext;
  }): Promise<AgentGatewayRouteResult> {
    const senderWhatsAppId = args.from.trim();
    const normalizedPhone = normalizePhoneNumber(senderWhatsAppId);
    const resolved = await this.resolveConnectorTarget(
      ["whatsapp", args.organizationId, normalizedPhone || senderWhatsAppId],
      args.executionCtx,
      async () => {
        const owner =
          (await usersRepository.findByWhatsAppIdWithOrganization(senderWhatsAppId)) ??
          (normalizedPhone
            ? await usersRepository.findByPhoneNumberWithOrganization(normalizedPhone)
            : undefined);

        if (owner?.organization_id) {
          const owned = await this.resolveOwnedRuntimeTarget(owner.organization_id, owner.id);
          const target = owned.target
            ? { ...owned, organizationId: owner.organization_id }
            : await this.resolveLoggedPhoneContactTarget(
                normalizedPhone || senderWhatsAppId,
                "whatsapp",
              );
          return target.target
            ? target
            : {
                ...owned,
                organizationId: owner.organization_id,
              };
        }
        return await this.resolveLoggedPhoneContactTarget(
          normalizedPhone || senderWhatsAppId,
          "whatsapp",
        );
      },
    );

    if (!resolved.target) {
      return {
        handled: false,
        reason: resolved.reason,
        agentId: resolved.agentId,
        userId: resolved.userId,
        organizationId: resolved.organizationId,
        retryable: resolved.retryable,
      };
    }

    const targetAgentId =
      resolved.target.kind === "local-session" && resolved.target.session
        ? resolved.target.session.runtimeAgentId
        : (resolved.target.sandbox?.id ?? resolved.agentId ?? normalizedPhone ?? senderWhatsAppId);
    const roomId = buildDirectConversationRoomIdFromIds(
      targetAgentId,
      "whatsapp",
      normalizedPhone || senderWhatsAppId,
      args.to.trim(),
    );
    const attachments = buildMediaAttachments(args.mediaUrls);
    const rpcRequest: BridgeRequest = {
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "message.send",
      params: {
        text: args.body,
        roomId,
        channelType: "DM",
        source: "whatsapp",
        sender: {
          id: normalizedPhone || senderWhatsAppId,
          username: normalizedPhone || senderWhatsAppId,
          ...(args.senderName ? { displayName: args.senderName } : {}),
          metadata: {
            whatsapp: {
              sender: normalizedPhone || senderWhatsAppId,
              recipient: args.to.trim(),
            },
          },
        },
        ...(attachments ? { attachments } : {}),
        metadata: {
          provider: "whatsapp",
          from: normalizedPhone || senderWhatsAppId,
          to: args.to.trim(),
          ...(args.providerMessageId ? { providerMessageId: args.providerMessageId } : {}),
          ...(args.metadata ? args.metadata : {}),
        },
      },
    };

    const routed = await this.routeToTarget(resolved.target, rpcRequest, args.executionCtx);
    return {
      ...routed,
      userId: resolved.userId,
      organizationId: routed.organizationId ?? resolved.organizationId,
    };
  }
}

export const agentGatewayRouterService = new AgentGatewayRouterService();
