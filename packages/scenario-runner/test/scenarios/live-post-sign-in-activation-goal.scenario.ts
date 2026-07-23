/**
 * Live-model proof of the post-authentication activation handoff.
 *
 * The production activation helper persists its stable greeting, then the
 * owner's problem enters the real message loop. Pass/fail reads the durable FTU
 * goal lifecycle and owner-fact records written by the response evaluator; no
 * scenario helper invokes that evaluator or writes the discovered goal.
 */

import type { AgentRuntime } from "@elizaos/core";
import {
  createFirstRunStateStore,
  createFtuGoalStateStore,
  createOwnerFactStore,
  FTU_GOAL_CONFIDENCE_THRESHOLD,
} from "@elizaos/plugin-personal-assistant/plugin";
import {
  type ScenarioContext,
  scenario,
} from "@elizaos/scenario-runner/schema";
import {
  POST_SIGN_IN_ACTIVATION_GREETING,
  POST_SIGN_IN_ACTIVATION_VERSION,
} from "@elizaos/shared";

const USER_PROBLEM =
  "The problem I want us to solve is shipping the iOS version of my app by the end of September without breaking the Android release. Please acknowledge that you understand; we'll plan it next.";
const POST_TURN_GOAL_TIMEOUT_MS = 60_000;
const POST_TURN_GOAL_POLL_MS = 100;

type ActivationBody = {
  text?: unknown;
  generated?: unknown;
  persisted?: unknown;
  messageId?: unknown;
  source?: unknown;
  timestamp?: unknown;
  greetingKind?: unknown;
  activationVersion?: unknown;
  conversationId?: unknown;
};

function runtimeOf(ctx: ScenarioContext): AgentRuntime {
  if (!ctx.runtime || typeof ctx.runtime !== "object") {
    throw new Error("scenario runtime is unavailable");
  }
  return ctx.runtime as AgentRuntime;
}

function activationBodyOf(ctx: ScenarioContext, index: number): ActivationBody {
  const body = ctx.turns?.[index]?.responseBody;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }
  return body as ActivationBody;
}

async function resetGoalDiscovery(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = runtimeOf(ctx);
  const firstRun = await createFirstRunStateStore(runtime).read();
  if (firstRun.status !== "complete") {
    return `signed-in scenario requires completed app first-run state; saw ${firstRun.status}`;
  }
  await Promise.all([
    createFtuGoalStateStore(runtime).reset(),
    createOwnerFactStore(runtime).clear(),
  ]);
  return undefined;
}

function assertActivationTurn(text: string): string | undefined {
  if (text !== POST_SIGN_IN_ACTIVATION_GREETING) {
    return `expected the exact post-sign-in activation copy, saw ${JSON.stringify(text)}`;
  }
  return undefined;
}

function assertSuppressedActivationRetry(text: string): string | undefined {
  if (text !== "") {
    return `activation retry must not replay visible text, saw ${JSON.stringify(text)}`;
  }
  return undefined;
}

function assertProblemAcknowledgement(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return "the live model returned no acknowledgement";
  }
  if (!/\b(iOS|app|release|shipping|ship)\b/i.test(trimmed)) {
    return `the response did not acknowledge the stated app-release problem: ${JSON.stringify(text)}`;
  }
  if (
    /what (?:problem|would you like|do you want).*(?:help|solve|get started)/i.test(
      trimmed,
    )
  ) {
    return `the response repeated the initial discovery question instead of acknowledging the answer: ${JSON.stringify(text)}`;
  }
  return undefined;
}

async function assertDurableActivationAndGoal(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = runtimeOf(ctx);
  const firstActivation = activationBodyOf(ctx, 0);
  const repeatedActivation = activationBodyOf(ctx, 1);

  if (
    firstActivation.greetingKind !== "post_sign_in_activation" ||
    firstActivation.activationVersion !== POST_SIGN_IN_ACTIVATION_VERSION ||
    firstActivation.source !== "agent_greeting" ||
    firstActivation.generated !== true ||
    firstActivation.persisted !== true
  ) {
    return `activation metadata was not the production contract: ${JSON.stringify(firstActivation)}`;
  }
  if (
    typeof firstActivation.messageId !== "string" ||
    firstActivation.messageId.length === 0
  ) {
    return "activation response did not carry a durable messageId";
  }
  if (
    firstActivation.messageId !== repeatedActivation.messageId ||
    firstActivation.timestamp !== repeatedActivation.timestamp ||
    firstActivation.conversationId !== repeatedActivation.conversationId
  ) {
    return `repeated activation request changed durable identity: first=${JSON.stringify(firstActivation)} repeated=${JSON.stringify(repeatedActivation)}`;
  }
  if (
    repeatedActivation.text !== "" ||
    repeatedActivation.generated !== false ||
    repeatedActivation.persisted !== false
  ) {
    return `activation retry replayed visible output or reported a write: ${JSON.stringify(repeatedActivation)}`;
  }

  const storedActivation = await runtime.getMemoryById(
    firstActivation.messageId,
  );
  if (
    !storedActivation ||
    storedActivation.content.text !== POST_SIGN_IN_ACTIVATION_GREETING ||
    storedActivation.content.greetingKind !== "post_sign_in_activation"
  ) {
    return `durable activation memory was missing or malformed: ${JSON.stringify(storedActivation?.content)}`;
  }
  if (!ctx.primaryRoomId) {
    return "scenario did not expose its primary room";
  }
  const roomMessages = await runtime.getMemories({
    roomId: ctx.primaryRoomId,
    tableName: "messages",
    limit: 100,
  });
  const activationRows = roomMessages.filter(
    (memory) =>
      memory.content.greetingKind === "post_sign_in_activation" &&
      memory.content.activationVersion === POST_SIGN_IN_ACTIVATION_VERSION,
  );
  if (activationRows.length !== 1) {
    return `expected exactly one durable activation row after two requests, saw ${activationRows.length}`;
  }

  const goalStore = createFtuGoalStateStore(runtime);
  const deadline = Date.now() + POST_TURN_GOAL_TIMEOUT_MS;
  let goalRecord = await goalStore.read();
  while (goalRecord.status !== "complete" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POST_TURN_GOAL_POLL_MS));
    goalRecord = await goalStore.read();
  }
  if (goalRecord.status !== "complete" || !goalRecord.goal) {
    return `the real response evaluator did not persist FTU goal completion within ${POST_TURN_GOAL_TIMEOUT_MS}ms: ${JSON.stringify(goalRecord)}`;
  }
  if (goalRecord.goal.confidence < FTU_GOAL_CONFIDENCE_THRESHOLD) {
    return `persisted goal confidence ${goalRecord.goal.confidence} was below ${FTU_GOAL_CONFIDENCE_THRESHOLD}`;
  }
  if (!/\b(iOS|app|release|shipping|ship)\b/i.test(goalRecord.goal.goal)) {
    return `persisted FTU goal lost the owner's app-release problem: ${JSON.stringify(goalRecord.goal)}`;
  }
  if (!goalRecord.goal.sourceMessageId) {
    return "persisted FTU goal did not retain the source user-message id";
  }

  const ownerFacts = await createOwnerFactStore(runtime).read();
  if (!ownerFacts.primaryGoal) {
    return "FTU completion did not persist the canonical primaryGoal owner fact";
  }
  if (ownerFacts.primaryGoal.value !== goalRecord.goal.goal) {
    return `goal lifecycle and owner fact diverged: lifecycle=${JSON.stringify(goalRecord.goal.goal)} fact=${JSON.stringify(ownerFacts.primaryGoal.value)}`;
  }
  if (ownerFacts.primaryGoal.provenance.source !== "agent_inferred") {
    return `primaryGoal provenance must be agent_inferred, saw ${ownerFacts.primaryGoal.provenance.source}`;
  }
  return undefined;
}

export default scenario({
  id: "live-post-sign-in-activation-goal",
  lane: "live-only",
  title: "Post-sign-in activation leads into durable goal discovery",
  domain: "lifeops.onboarding",
  description:
    "A signed-in owner receives the one-time activation invitation, states a durable problem through chat, and the live response evaluator persists it as the FTU goal and canonical owner fact.",
  tags: [
    "live",
    "real-llm",
    "onboarding",
    "post-sign-in",
    "lifeops",
    "ftu-goal",
  ],
  status: "active",
  tier: "T2",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Signed-in owner",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "reset only the post-sign-in goal-discovery state",
      apply: resetGoalDiscovery,
    },
  ],
  turns: [
    {
      kind: "post_sign_in_activation",
      room: "main",
      name: "signed-in owner receives activation invitation",
      assertResponse: assertActivationTurn,
    },
    {
      kind: "post_sign_in_activation",
      room: "main",
      name: "startup retry preserves identity without replaying visible text",
      assertResponse: assertSuppressedActivationRetry,
    },
    {
      kind: "message",
      room: "main",
      name: "owner states the problem they want to solve",
      text: USER_PROBLEM,
      assertResponse: assertProblemAcknowledgement,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "activation is exactly-once and live evaluator persisted the goal",
      predicate: assertDurableActivationAndGoal,
    },
    {
      type: "modelCallOccurred",
      name: "live response model saw the invitation and owner's answer",
      includesAll: [
        "shipping the iOS version of my app",
        POST_SIGN_IN_ACTIVATION_GREETING,
      ],
      minCount: 1,
    },
    {
      type: "modelCallOccurred",
      name: "merged live evaluator assessed the owner's primary goal",
      includesAll: [
        "shipping the iOS version of my app",
        "Decide whether this turn reveals the owner's PRIMARY goal",
      ],
      minCount: 1,
    },
  ],
});
