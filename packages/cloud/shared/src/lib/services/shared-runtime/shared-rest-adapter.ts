/**
 * Shared-runtime REST adapter (mobile chat unblock).
 *
 * A Tier-0 "shared" agent runs in-Worker (run-shared-agent-turn) with NO agent
 * server, so it has no `/api/*` REST surface — only the JSON-RPC bridge
 * (`message.send`) + the SSE stream. The mobile/web chat client, however, speaks
 * the agent-server REST conversation contract (`/api/conversations`,
 * `/api/conversations/:id/messages`, …). This use-case maps that REST contract
 * onto the existing, proven shared-runtime primitives (the bridge engine, its
 * billing, and its KV turn-history) so a REST client can chat with a shared
 * agent unchanged. The cloud-api route at
 * `.../agents/:agentId/api/[...path]` is a thin caller of these functions.
 *
 * Launch model: ONE canonical conversation per agent (conversationId === agentId,
 * bridge roomId === conversationId). The list always has exactly one item, so no
 * conversation index is needed — every turn lands in the same KV channel the
 * bridge already writes.
 */

import { stringToUuid } from "@elizaos/core";
import {
  type ActivationGoalHandoffEnvelope,
  POST_SIGN_IN_ACTIVATION_GREETING,
  POST_SIGN_IN_ACTIVATION_VERSION as SHARED_POST_SIGN_IN_ACTIVATION_VERSION,
} from "@elizaos/shared/contracts";
import { agentActivationGreetingsRepository } from "../../../db/repositories/agent-activation-greetings";
import type { AgentSandbox } from "../../../db/repositories/agent-sandboxes";
import { sharedRuntimeHistoryRepository } from "../../../db/repositories/shared-runtime-history";
import { sharedRuntimeTurnClaimsRepository } from "../../../db/repositories/shared-runtime-turn-claims";
import type { AgentActivationGreeting } from "../../../db/schemas/agent-activation-greetings";
import type { SharedRuntimeHistoryMessage } from "../../../db/schemas/shared-runtime-history";
import type { RuntimeDurableObjectNamespace } from "../../../types/cloud-worker-env";
import { InsufficientCreditsError } from "../../api/errors";
import type { BridgeRequest } from "../eliza-sandbox-bridge";
import { coordinateSharedBridge, coordinateSharedHistory } from "./conversation-coordinator";
import type { SharedAgentCharacter } from "./run-shared-agent-turn";
import { type BridgeExecutionContext, sharedRuntimeChatService } from "./shared-runtime-chat";

const BRIDGE_INSUFFICIENT_CREDITS_CODE = -32002;

/** Minimal subset of the agent-server REST `Conversation` the chat client reads. */
export interface SharedRestConversation {
  id: string;
  title: string;
  roomId: string;
  createdAt: string;
  /**
   * The client's `isConversationRecord()` guard REQUIRES `updatedAt` — without
   * it the record is rejected, so there is no active conversation and every send
   * is silently dropped. A shared agent's canonical conversation is never
   * renamed/moved, so `updatedAt` === `createdAt`.
   */
  updatedAt: string;
}

/** Minimal subset of the agent-server REST `ConversationMessage`. */
export interface SharedRestMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  source?: string;
  greetingKind?: "conversation" | "post_sign_in_activation";
  activationVersion?: string;
}

export const SHARED_REST_AGENT_GREETING_SOURCE = "agent_greeting" as const;
export const POST_SIGN_IN_ACTIVATION_KIND = "post_sign_in_activation" as const;
export const POST_SIGN_IN_ACTIVATION_VERSION = SHARED_POST_SIGN_IN_ACTIVATION_VERSION;
export const POST_SIGN_IN_ACTIVATION_TEXT = POST_SIGN_IN_ACTIVATION_GREETING;

interface SharedRestGreetingResponse {
  text: string;
  agentName: string;
  generated: boolean;
  persisted: boolean;
}

export interface SharedRestActivationGreetingResponse extends SharedRestGreetingResponse {
  messageId: string;
  source: typeof SHARED_REST_AGENT_GREETING_SOURCE;
  timestamp: number;
  greetingKind: typeof POST_SIGN_IN_ACTIVATION_KIND;
  activationVersion: typeof POST_SIGN_IN_ACTIVATION_VERSION;
  conversationId: string;
}

/** The canonical (single) conversation id for a shared agent === its agent id. */
export function canonicalSharedRestConversationId(agentId: string): string {
  return agentId;
}

/** Reject stale or forged room ids before they can create hidden history. */
export function isCanonicalSharedRestConversation(
  agentId: string,
  conversationId: string,
): boolean {
  return conversationId === canonicalSharedRestConversationId(agentId);
}

async function sharedConversationChannelId(
  agentId: string,
  conversationId: string,
): Promise<string> {
  return await import("../eliza-sandbox").then(({ elizaSandboxService }) =>
    elizaSandboxService.getSharedConversationChannelId(agentId, conversationId),
  );
}

function makeConversation(
  agentId: string,
  agentName: string,
  createdAt: string,
): SharedRestConversation {
  const id = canonicalSharedRestConversationId(agentId);
  // updatedAt === createdAt: the canonical conversation is never renamed/moved.
  return { id, title: agentName || "Chat", roomId: id, createdAt, updatedAt: createdAt };
}

/** GET .../api/health — the agent is in-Worker; if it resolves, it's up. */
export function sharedRestHealth(): { status: "ok" } {
  return { status: "ok" };
}

/**
 * GET .../api/status — the startup-coordinator's FIRST hard gate: it calls
 * `getStatus()` before anything else and bails unless `state === "running"`.
 * A shared agent runs in-Worker, so if this resolves it is by definition up.
 *
 * `canRespond` is load-bearing too: the composer's send-gate is
 * `canRespond ?? (running && model)`, and a shared agent has no LOCAL model
 * (inference is hosted in-Worker), so without it the box would stay disabled.
 */
export function sharedRestStatus(agentName: string): {
  state: "running";
  agentName: string;
  canRespond: true;
} {
  return { state: "running", agentName: agentName || "Eliza", canRespond: true };
}

// ---------------------------------------------------------------------------
// Shell-endpoint defaults (mobile/web startup-coordinator unblock)
// ---------------------------------------------------------------------------
//
// A shared agent has no agent server, so it serves NONE of the shell endpoints
// the app's startup-coordinator probes after conversations/messages already
// 200: GET /api/first-run/status, GET /api/first-run, GET /api/views,
// GET /api/config. Without them every probe 404s and the app never boots into
// chat. These functions synthesize the "already-provisioned, no setup needed"
// answers the coordinator expects so a shared agent boots straight into chat.
//
// Contracts mirrored verbatim from the agent server:
//   first-run/status → packages/agent/src/api/first-run-routes.ts
//                      (cloud container branch: { complete, cloudProvisioned })
//   views            → packages/agent/src/api/views-routes.ts (`{ views }`) +
//                      the builtin chat entry from
//                      packages/agent/src/api/builtin-views.ts +
//                      registerBuiltinViews() in views-registry.ts
//   config           → packages/agent/src/api/config-routes.ts (open-ended object)

/** Minimal subset of the agent-server `ViewRegistryEntry` the chat client reads. */
interface SharedRestViewRegistration {
  id: string;
  label: string;
  viewType: "gui" | "tui" | "xr";
  description?: string;
  icon?: string;
  path?: string;
  available: boolean;
  pluginName: string;
  tags?: string[];
  visibleInManager?: boolean;
  desktopTabEnabled?: boolean;
  builtin: boolean;
  hasHeroImage?: boolean;
}

/**
 * GET .../api/first-run/status — a shared agent is cloud-provisioned and never
 * runs first-run, so it is always "complete". Mirrors the cloud-container branch
 * in first-run-routes.ts that responds `{ complete: true, cloudProvisioned: true }`.
 */
export function sharedRestFirstRunStatus(): {
  complete: true;
  cloudProvisioned: true;
} {
  return { complete: true, cloudProvisioned: true };
}

/**
 * GET .../api/first-run — "no setup needed". The app only fetches first-run
 * options when status reports incomplete; for a shared agent that never happens,
 * but return a benign already-complete payload so any probe degrades gracefully.
 */
export function sharedRestFirstRun(): { complete: true; ok: true } {
  return { complete: true, ok: true };
}

/**
 * POST .../api/first-run — onboarding "submit". A shared agent has no config to
 * persist, so this is a harmless no-op that echoes the agent-server success
 * shape (`{ ok: true }`) instead of 404'ing onboarding.
 */
export function sharedRestFirstRunSubmit(): { ok: true } {
  return { ok: true };
}

/** The single builtin chat view a shared agent exposes (a `gui` view). */
const SHARED_CHAT_VIEW: SharedRestViewRegistration = {
  id: "chat",
  label: "Chat",
  viewType: "gui",
  description: "Conversations with your agent, inbound messages from every connector",
  icon: "MessageSquare",
  path: "/chat",
  available: true,
  pluginName: "@elizaos/builtin",
  tags: ["messaging", "conversation", "agent"],
  visibleInManager: true,
  desktopTabEnabled: true,
  builtin: true,
  hasHeroImage: false,
};

/**
 * GET .../api/views — the shell's view registry. A shared agent ships only the
 * single builtin chat view so the app boots into a working chat surface. Shape
 * matches GET /api/views (`{ views: ViewRegistryEntry[] }`); the chat entry is
 * the builtin-views.ts "chat" declaration as registerBuiltinViews() annotates it
 * (pluginName "@elizaos/builtin", builtin:true, available:true).
 *
 * Honors `?viewType=` like the agent server: a request for a non-`gui` surface
 * (e.g. `tui`/`xr`) correctly returns an empty list rather than the gui chat
 * view, so the client's per-view-type probes get an honest answer.
 */
export function sharedRestViews(viewType?: string): {
  views: SharedRestViewRegistration[];
} {
  const requested = viewType?.trim();
  if (requested && requested !== SHARED_CHAT_VIEW.viewType) {
    return { views: [] };
  }
  return { views: [SHARED_CHAT_VIEW] };
}

/**
 * GET .../api/config — the dashboard's open-ended agent config. A shared agent
 * exposes no editable config through this adapter, but it DOES declare its
 * transport capabilities so the client adapts by negotiation instead of
 * URL-sniffing the agent base. A Tier-0 agent runs in a stateless Worker with no
 * persistent process, so it has:
 *  - `websocket: false` — no per-agent socket to connect; the client skips the
 *    WS (avoiding the doomed reconnect loop + "Lost backend connection" overlay
 *    that otherwise paints over a working chat).
 *  - `streaming: false` — kept conservative. A shared agent runs its turn in a
 *    single in-Worker call (no token-by-token generation), so even though
 *    `/messages/stream` IS now reachable (it emits the full reply as one SSE
 *    chunk via bridgeStream — see the messages/stream route), there is no
 *    incremental token stream to gain. Declaring `false` keeps the client on the
 *    non-stream `POST .../messages` (which returns the full reply) cleanly; flip
 *    to `true` only once the shared turn emits real token chunks.
 * The client still reads the rest of the object defensively (`ui`/`cloud`) and
 * falls back. These flags let the app delete its per-base special-casing.
 */
export function sharedRestConfig(): { websocket: false; streaming: false } {
  return { websocket: false, streaming: false };
}

/**
 * GET .../api/auth/me — the app's HARD startup gate (App.tsx auth gate →
 * useAuthStatus → authMe(), ui/src/api/auth-client.ts). A shared agent has no
 * agent server and no owner-password flow; it is reached purely through the
 * caller's authenticated API key, which the route already validated
 * (resolveSharedAgent → requireUserOrApiKeyWithOrg). So the caller is, by
 * construction, an authed machine identity — return it in the agent-server's
 * `bearer-agent` shape (auth-routes.ts authorized branch: identity.kind
 * "machine", session machine with no expiry, access mode "bearer"). Without an
 * `ok:true` body here, the client maps the 404 to status 503 →
 * "server_unavailable" → StartupFailureView and never reaches chat. The identity
 * is the agent itself (id = agentId, displayName = agentName) — the only stable
 * identity this adapter owns.
 */
export function sharedRestAuthMe(
  agentId: string,
  agentName: string,
): {
  identity: { id: string; displayName: string; kind: "machine" };
  session: { id: string; kind: "machine"; expiresAt: null };
  access: { mode: "bearer"; passwordConfigured: false; ownerConfigured: false };
} {
  return {
    identity: {
      id: agentId,
      displayName: agentName || "Eliza",
      kind: "machine",
    },
    session: { id: "bearer", kind: "machine", expiresAt: null },
    access: { mode: "bearer", passwordConfigured: false, ownerConfigured: false },
  };
}

/**
 * GET .../api/character — the character the app reads (getCharacter() →
 * `{ character, agentName }`, character-routes.ts GET /api/character). Reuse the
 * EXACT character the shared turn answers as: getSharedRuntimeCharacter resolves
 * the same `SharedAgentCharacter` buildSharedRuntimeCharacter feeds into
 * message.send. Falls back to an empty character object (the agent server's
 * "no runtime" branch shape) if the sandbox can't be resolved.
 */
export async function sharedRestCharacter(
  agentId: string,
  orgId: string,
  agentName: string,
  agent?: AgentSandbox,
): Promise<{ character: SharedAgentCharacter | Record<string, never>; agentName: string }> {
  const character = agent
    ? await sharedRuntimeChatService.getCharacter(agent)
    : await import("../eliza-sandbox").then(({ elizaSandboxService }) =>
        elizaSandboxService.getSharedRuntimeCharacter(agentId, orgId),
      );
  return { character: character ?? {}, agentName: agentName || "Eliza" };
}

/** GET .../api/conversations — always the one canonical conversation. */
export function sharedRestConversationsList(
  agentId: string,
  agentName: string,
  createdAt: string,
): { conversations: SharedRestConversation[] } {
  return { conversations: [makeConversation(agentId, agentName, createdAt)] };
}

/** POST .../api/conversations — returns the canonical conversation (idempotent). */
export function sharedRestConversationCreate(
  agentId: string,
  agentName: string,
  createdAt: string,
): { conversation: SharedRestConversation } {
  return { conversation: makeConversation(agentId, agentName, createdAt) };
}

/**
 * PATCH .../api/conversations/:id — shared-runtime agents expose one canonical
 * conversation and have no agent-server-side conversation index to mutate.
 * Accept title updates as a compatibility no-op so the app's background title
 * generation does not fail CORS on shared cloud agents.
 */
export function sharedRestConversationUpdate(
  agentId: string,
  agentName: string,
  createdAt: string,
  patch?: { title?: unknown } | null,
): { conversation: SharedRestConversation } {
  const title =
    typeof patch?.title === "string" && patch.title.trim() ? patch.title.trim() : agentName;
  return { conversation: makeConversation(agentId, title, createdAt) };
}

/**
 * DELETE .../api/conversations/:id — deleting the canonical shared-runtime
 * conversation is a no-op because it is derived from the agent identity.
 */
export function sharedRestConversationDelete(): { ok: true } {
  return { ok: true };
}

/**
 * Seed an ordinary per-room greeting only while that room is empty.
 *
 * This remains conversation-scoped and is intentionally separate from the
 * global activation ledger: opening another conversation may greet again, while
 * signing in must activate only once for the owner and contract version.
 */
export async function sharedRestConversationGreeting(
  agentId: string,
  conversationId: string,
  agentName: string,
): Promise<SharedRestGreetingResponse> {
  const normalizedName = agentName.trim() || "Eliza";
  const candidate = {
    role: "assistant" as const,
    content: `Hey, I'm ${normalizedName}. What can I help you with?`,
    id: stringToUuid(`conversation-greeting:${agentId}:${conversationId}`),
    source: SHARED_REST_AGENT_GREETING_SOURCE,
    greetingKind: "conversation" as const,
    createdAt: Date.now(),
  };
  const channelId = await sharedConversationChannelId(agentId, conversationId);
  const ensured = await sharedRuntimeHistoryRepository.ensureConversationGreeting(
    agentId,
    channelId,
    candidate,
  );
  return {
    text: ensured.greeting?.content ?? "",
    agentName: normalizedName,
    generated: ensured.greeting !== null,
    persisted: ensured.persisted,
  };
}

/**
 * Ensure the signed-in owner's activation message exactly once.
 *
 * The deterministic message id provides parity across runtimes, while the
 * database row is authoritative for the winning room and timestamp. The route
 * performs the owner check before calling this use-case.
 */
export async function sharedRestPostSignInActivation(
  agentId: string,
  ownerUserId: string,
  conversationId: string,
  agentName: string,
): Promise<SharedRestActivationGreetingResponse> {
  const normalizedName = agentName.trim() || "Eliza";
  const messageId = stringToUuid(
    `post-sign-in-activation:${agentId}:${ownerUserId}:${POST_SIGN_IN_ACTIVATION_VERSION}`,
  );
  const ensured = await agentActivationGreetingsRepository.ensure({
    agent_id: agentId,
    owner_user_id: ownerUserId,
    activation_version: POST_SIGN_IN_ACTIVATION_VERSION,
    conversation_id: conversationId,
    message_id: messageId,
    source: SHARED_REST_AGENT_GREETING_SOURCE,
    greeting_kind: POST_SIGN_IN_ACTIVATION_KIND,
    text: POST_SIGN_IN_ACTIVATION_TEXT,
    agent_name: normalizedName,
  });
  const greeting = ensured.greeting;
  let projected = false;
  if (greeting.projected_at === null) {
    const channelId = await sharedConversationChannelId(agentId, greeting.conversation_id);
    projected = await sharedRuntimeHistoryRepository.ensureMessage(agentId, channelId, {
      role: "assistant",
      content: greeting.text,
      id: greeting.message_id,
      source: greeting.source,
      greetingKind: POST_SIGN_IN_ACTIVATION_KIND,
      activationVersion: greeting.activation_version,
      createdAt: greeting.created_at.getTime(),
    });
    await agentActivationGreetingsRepository.markProjected(
      agentId,
      ownerUserId,
      POST_SIGN_IN_ACTIVATION_VERSION,
    );
  }
  return {
    text: projected ? greeting.text : "",
    agentName: greeting.agent_name,
    generated: projected,
    persisted: projected,
    messageId: greeting.message_id,
    source: SHARED_REST_AGENT_GREETING_SOURCE,
    timestamp: greeting.created_at.getTime(),
    greetingKind: POST_SIGN_IN_ACTIVATION_KIND,
    activationVersion: POST_SIGN_IN_ACTIVATION_VERSION,
    conversationId: greeting.conversation_id,
  };
}

function sharedRestMessageTimestamp(
  turn: { createdAt?: unknown },
  index: number,
  total: number,
): number {
  if (typeof turn.createdAt === "number" && Number.isFinite(turn.createdAt) && turn.createdAt > 0) {
    return turn.createdAt;
  }
  // Legacy shared-runtime history rows predate createdAt. Keep them finite but
  // safely older than the UI's "just sent" reconciliation window, so a repeated
  // failed send is still restored instead of being masked by an old same-text row.
  return Date.now() - 5 * 60_000 - (total - index);
}

function toSharedRestMessages(
  history: SharedRuntimeHistoryMessage[],
  conversationId: string,
  includeActivation: boolean,
): SharedRestMessage[] {
  const visibleHistory = includeActivation
    ? history
    : history.filter((turn) => turn.greetingKind !== POST_SIGN_IN_ACTIVATION_KIND);
  const messages = visibleHistory.map((turn, index) => ({
    id: typeof turn.id === "string" && turn.id.length > 0 ? turn.id : `${conversationId}:${index}`,
    role: turn.role,
    text: turn.content,
    timestamp: sharedRestMessageTimestamp(turn, index, visibleHistory.length),
    ...(typeof turn.source === "string" ? { source: turn.source } : {}),
    ...(turn.greetingKind === "conversation" || turn.greetingKind === POST_SIGN_IN_ACTIVATION_KIND
      ? { greetingKind: turn.greetingKind }
      : {}),
    ...(typeof turn.activationVersion === "string"
      ? { activationVersion: turn.activationVersion }
      : {}),
  }));
  messages.sort(
    (left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id),
  );
  return messages;
}

function activationGoalEnvelope(
  agentId: string,
  activation: AgentActivationGreeting | undefined,
): ActivationGoalHandoffEnvelope | undefined {
  if (!activation || activation.projected_at === null) return undefined;

  const response =
    activation.response_message_id && activation.response_text && activation.response_created_at
      ? {
          messageId: activation.response_message_id,
          text: activation.response_text,
          createdAt: activation.response_created_at.getTime(),
        }
      : undefined;
  const hasPartialResponse =
    Boolean(activation.response_message_id) ||
    Boolean(activation.response_text) ||
    Boolean(activation.response_created_at);
  if (hasPartialResponse && !response) {
    throw new Error(
      `[shared-runtime] activation response envelope is incomplete (agent=${agentId})`,
    );
  }

  if (activation.goal_status === "accepted") {
    if (
      !response ||
      !activation.goal_text ||
      typeof activation.goal_confidence !== "number" ||
      !activation.goal_model ||
      !activation.goal_recorded_at
    ) {
      throw new Error(
        `[shared-runtime] accepted activation goal envelope is incomplete (agent=${agentId})`,
      );
    }
    return {
      activationVersion: activation.activation_version,
      status: "accepted",
      response,
      goal: {
        text: activation.goal_text,
        confidence: activation.goal_confidence,
        model: activation.goal_model,
        recordedAt: activation.goal_recorded_at.getTime(),
      },
    };
  }
  return {
    activationVersion: activation.activation_version,
    status: "pending",
    ...(response ? { response } : {}),
  };
}

/**
 * GET .../api/conversations/:id/messages — read the bridge's persisted turn
 * history for this room and present it in the REST message shape. Ids are
 * positional+stable (the history is an ordered append-only list).
 */
export async function sharedRestMessagesGet(
  agentId: string,
  conversationId: string,
  namespace?: RuntimeDurableObjectNamespace,
  activationOwnerUserId?: string,
): Promise<{
  messages: SharedRestMessage[];
  activationGoal?: ActivationGoalHandoffEnvelope;
}> {
  const history = await coordinateSharedHistory(agentId, conversationId, { namespace });
  const messages = toSharedRestMessages(history, conversationId, Boolean(activationOwnerUserId));
  if (!activationOwnerUserId) return { messages };

  const activation = await agentActivationGreetingsRepository.find(
    agentId,
    activationOwnerUserId,
    POST_SIGN_IN_ACTIVATION_VERSION,
  );
  const activationGoal = activationGoalEnvelope(agentId, activation);
  return {
    messages,
    ...(activationGoal ? { activationGoal } : {}),
  };
}

/**
 * Establish a short-lived write fence and return one atomic handoff snapshot.
 *
 * The repository refuses to fence while any shared model turn is admitted.
 * Once fenced, later sends fail retryably until the client switches or a
 * failed handoff releases the token.
 */
export async function sharedRestHandoffSnapshot(input: {
  agentId: string;
  conversationId: string;
  ownerUserId: string;
  fenceToken: string;
  leaseMs: number;
}): Promise<
  | { ready: false; retryAfterMs: number }
  | {
      ready: true;
      messages: SharedRestMessage[];
      activationGoal?: ActivationGoalHandoffEnvelope;
    }
> {
  const channelId = await sharedConversationChannelId(input.agentId, input.conversationId);
  const snapshot = await sharedRuntimeTurnClaimsRepository.beginHandoffSnapshot({
    agentId: input.agentId,
    channelId,
    ownerUserId: input.ownerUserId,
    activationVersion: POST_SIGN_IN_ACTIVATION_VERSION,
    fenceToken: input.fenceToken,
    leaseMs: input.leaseMs,
  });
  if (!snapshot.ready) return snapshot;
  const activationGoal = activationGoalEnvelope(input.agentId, snapshot.activation);
  return {
    ready: true,
    messages: toSharedRestMessages(snapshot.messages, input.conversationId, true),
    ...(activationGoal ? { activationGoal } : {}),
  };
}

export async function releaseSharedRestHandoffFence(input: {
  agentId: string;
  conversationId: string;
  fenceToken: string;
}): Promise<boolean> {
  const channelId = await sharedConversationChannelId(input.agentId, input.conversationId);
  return await sharedRuntimeTurnClaimsRepository.releaseHandoffFence({
    agentId: input.agentId,
    channelId,
    fenceToken: input.fenceToken,
  });
}

/**
 * POST .../api/conversations/:id/messages — forward the user text to the shared
 * bridge `message.send` (which runs the turn, persists history, and bills), then
 * return the assistant reply in the REST send-result shape.
 */
export async function sharedRestMessageSend(
  agentId: string,
  orgId: string,
  conversationId: string,
  text: string,
  agentName: string,
  callerUserId = "",
  clientMessageId?: string,
  executionCtx?: BridgeExecutionContext,
  agent?: AgentSandbox,
  namespace?: RuntimeDurableObjectNamespace,
): Promise<{ text: string; agentName: string }> {
  const rpc: BridgeRequest = {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "message.send",
    params: {
      text,
      roomId: conversationId,
      userId: callerUserId,
      clientMessageId: clientMessageId ?? crypto.randomUUID(),
    },
  };
  // executionCtx (Workers only) lets the bridge defer the post-reply billing
  // tail off the response path; without it the turn settles inline as before.
  const response = agent
    ? await coordinateSharedBridge(agent, rpc, { executionCtx, namespace })
    : await import("../eliza-sandbox").then(({ elizaSandboxService }) =>
        elizaSandboxService.bridge(agentId, orgId, rpc, executionCtx),
      );
  if (response.error) {
    // A credit-reserve rejection is a permanent add-credits condition, not a
    // transient bridge failure — surface it typed so the route boundary can
    // return the canonical 402 instead of the generic retryable 503.
    if (response.error.code === BRIDGE_INSUFFICIENT_CREDITS_CODE) {
      throw new InsufficientCreditsError(response.error.message);
    }
    throw new Error(response.error.message || "shared message.send failed");
  }
  const result = (response.result ?? {}) as { text?: unknown };
  const replyText = typeof result.text === "string" ? result.text : "";
  return { text: replyText, agentName: agentName || "Eliza" };
}
