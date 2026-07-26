/**
 * Cache-admitted provisioning agent chat.
 *
 * Conversation state and the sandbox-status projection come from cache; exact
 * organization rate, spend, and app-session authorization are serialized by
 * the inference Durable Object before Cerebras. Authoritative provisioning
 * refresh and history persistence continue under waitUntil.
 */

import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import type { AgentSandboxStatus } from "../../db/repositories/agent-sandboxes";
import { cache } from "../cache/client";
import { CEREBRAS_DEFAULT_TEXT_MODEL } from "../models";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { logger } from "../utils/logger";
import { runElizaAppTextInference } from "./eliza-app/inference-hot-path";
import type {
  ElizaAppInferenceExecutionContext,
  ElizaAppInferenceIdentity,
} from "./eliza-app/inference-session-auth";
import { resolveElizaAppProvisioningCache } from "./eliza-app/provisioning-cache";

const HISTORY_CACHE_KEY = (userId: string) => `prov-chat:${userId}`;
const HISTORY_TTL_SECONDS = 604800; // 7 days
const MAX_HISTORY_MESSAGES = 20; // 10 turns (user + assistant)

const CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1";
const CEREBRAS_MODEL = CEREBRAS_DEFAULT_TEXT_MODEL;
const MAX_OUTPUT_TOKENS = 500;

export class ProvisioningAgentChatWarmingError extends Error {
  constructor() {
    super("Eliza App provisioning status cache is warming");
    this.name = "ProvisioningAgentChatWarmingError";
  }
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ProvisioningChatResult {
  reply: string;
  containerStatus: AgentSandboxStatus | "none";
  bridgeUrl: string | null;
  agentId: string | null;
  history: ChatMessage[];
}

function buildSystemPrompt(status: AgentSandboxStatus | "none"): string {
  let statusBlock: string;

  if (status === "running") {
    statusBlock =
      "Current container status: running. The user's dedicated container is ready! You can let them know their agent is available and they'll be transferred automatically.";
  } else if (status === "provisioning" || status === "pending") {
    statusBlock = `Current container status: ${status}. The container is still being set up (typically 2–5 minutes total). Mention this warmly once if the topic comes up, but don't repeat it on every turn. Focus on being genuinely helpful.`;
  } else if (status === "error") {
    statusBlock =
      "Current container status: error. There was an issue provisioning the container. Be empathetic, let the user know the team is aware, and suggest they refresh or contact support if it persists.";
  } else {
    statusBlock = "Current container status: unknown. A container is being set up for the user.";
  }

  return `You are Eliza, a warm and knowledgeable AI assistant for the elizaOS platform. You're a serverless instance running on Cloudflare while the user's dedicated AI container is being provisioned.

${statusBlock}

You have comprehensive knowledge of elizaOS capabilities: agents, plugins, actions, providers, evaluators, connectors (Telegram, Discord, WhatsApp, iMessage), skills, the Eliza Cloud platform, billing, app creation, and more.

Be conversational, warm, and genuinely helpful. If the user asks what you can do while waiting, offer to:
- Explain elizaOS capabilities and what their agent will be able to do
- Help them think through which connectors to set up (Telegram, Discord, iMessage, etc.)
- Discuss their use cases and how elizaOS can help
- Answer questions about the platform, pricing, or features
- Just have a friendly conversation

Keep responses concise and natural. Don't repeat status information unless directly asked.`;
}

function getCerebrasClient(): ReturnType<typeof createOpenAI> {
  const env = getCloudAwareEnv();
  const apiKey = env.CEREBRAS_API_KEY;
  if (!apiKey) {
    throw new Error("CEREBRAS_API_KEY is not configured");
  }
  return createOpenAI({
    apiKey,
    baseURL: CEREBRAS_BASE_URL,
  });
}

async function loadHistory(userId: string): Promise<ChatMessage[]> {
  const cached = await cache.get<ChatMessage[]>(HISTORY_CACHE_KEY(userId));
  return cached ?? [];
}

async function saveHistory(userId: string, history: ChatMessage[]): Promise<void> {
  const capped =
    history.length > MAX_HISTORY_MESSAGES
      ? history.slice(history.length - MAX_HISTORY_MESSAGES)
      : history;
  await cache.set(HISTORY_CACHE_KEY(userId), capped, HISTORY_TTL_SECONDS);
}

function isContainerStatus(value: string): value is AgentSandboxStatus {
  return (
    value === "pending" ||
    value === "provisioning" ||
    value === "running" ||
    value === "stopped" ||
    value === "sleeping" ||
    value === "disconnected" ||
    value === "error"
  );
}

export async function provisioningAgentChat(params: {
  identity: ElizaAppInferenceIdentity;
  userMessage: string;
  agentId?: string;
  requestId: string;
  executionCtx: ElizaAppInferenceExecutionContext;
}): Promise<ProvisioningChatResult> {
  const statusResolution = await resolveElizaAppProvisioningCache({
    organizationId: params.identity.organizationId,
    userId: params.identity.userId,
    ensure: false,
    executionCtx: params.executionCtx,
  });
  if (statusResolution.kind !== "ready") {
    throw new ProvisioningAgentChatWarmingError();
  }
  const projected = statusResolution.status;
  if (projected.status !== "none" && !isContainerStatus(projected.status)) {
    throw new Error(`Invalid provisioning status projection: ${projected.status}`);
  }
  const containerStatus = projected.status;
  const bridgeUrl = projected.bridgeUrl;
  const resolvedAgentId = params.agentId ?? projected.agentId;
  const history = await loadHistory(params.identity.userId);
  const updatedHistory: ChatMessage[] = [...history, { role: "user", content: params.userMessage }];
  const systemPrompt = buildSystemPrompt(containerStatus);
  const result = await runElizaAppTextInference({
    identity: params.identity,
    model: CEREBRAS_MODEL,
    requestId: params.requestId,
    promptText: `${systemPrompt}\n${updatedHistory
      .map((message) => `${message.role}: ${message.content}`)
      .join("\n")}`,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    description: "Eliza App provisioning chat",
    executionCtx: params.executionCtx,
    dispatch: () =>
      generateText({
        model: getCerebrasClient().chat(CEREBRAS_MODEL),
        system: systemPrompt,
        messages: updatedHistory,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      }),
  });
  const reply = result.text;
  const finalHistory: ChatMessage[] = [...updatedHistory, { role: "assistant", content: reply }];
  params.executionCtx.waitUntil(
    saveHistory(params.identity.userId, finalHistory).catch((error) => {
      // error-policy:J7 the response is already generated; history persistence
      // failure is visible and the next turn remains a valid new cache turn.
      logger.error("[ProvisioningAgentChat] History persistence failed", {
        userId: params.identity.userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }),
  );

  return {
    reply,
    containerStatus,
    bridgeUrl,
    agentId: resolvedAgentId,
    history: finalHistory,
  };
}
