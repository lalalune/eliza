/**
 * `ftu_goal_discovery` — post-turn evaluator that extracts the owner's
 * primary goal (what they value / want the assistant's help with) from the
 * conversation once first-run setup is complete.
 *
 * Runs inside the runtime's single merged, schema-constrained SMALL-model
 * evaluation call (`EvaluatorService`), so it adds no extra model round-trip
 * to the turn. `shouldRun` is the no-reprocessing gate: it is `false` the
 * moment the `FtuGoalStateStore` records a goal, so completed discovery never
 * re-evaluates the same conversation. The processor persists the goal as the
 * typed `primaryGoal` owner fact (with `agent_inferred` provenance) and flips
 * the lifecycle to `complete` only when extraction confidence clears
 * {@link FTU_GOAL_CONFIDENCE_THRESHOLD}.
 */

import { hasOwnerAccess } from "@elizaos/agent";
import type { Evaluator, JSONSchema } from "@elizaos/core";
import {
  FTU_GOAL_CONFIDENCE_THRESHOLD,
  FTU_GOAL_DISCOVERY_PROMPT,
  type FtuGoalDiscoveryOutput,
  parseFtuGoalDiscoveryOutput,
} from "@elizaos/shared";
import { createFirstRunStateStore } from "../first-run/state.js";
import { createOwnerFactStore } from "../owner/fact-store.js";
import { createFtuGoalStateStore } from "./state.js";

export type { FtuGoalDiscoveryOutput };
export { FTU_GOAL_CONFIDENCE_THRESHOLD };

const ftuGoalSchema: JSONSchema = {
  type: "object",
  properties: {
    goalFound: { type: "boolean" },
    goal: { type: "string" },
    confidence: { type: "number" },
  },
  required: ["goalFound", "goal", "confidence"],
  additionalProperties: false,
};

export function parseFtuGoalOutput(
  output: unknown,
): FtuGoalDiscoveryOutput | null {
  return parseFtuGoalDiscoveryOutput(output);
}

export const ftuGoalDiscoveryEvaluator: Evaluator<FtuGoalDiscoveryOutput> = {
  name: "ftu_goal_discovery",
  description:
    "Extracts the owner's primary goal — what they value or want the assistant's help with — from the conversation after first-run setup completes.",
  priority: 140,
  schema: ftuGoalSchema,

  async shouldRun({ runtime, message }) {
    if (!message.content.text || message.entityId === runtime.agentId) {
      return false;
    }
    if (!(await hasOwnerAccess(runtime, message))) {
      return false;
    }
    const firstRun = await createFirstRunStateStore(runtime).read();
    if (firstRun.status !== "complete") {
      return false;
    }
    const ftuGoal = await createFtuGoalStateStore(runtime).read();
    return ftuGoal.status === "pending";
  },

  prompt() {
    return FTU_GOAL_DISCOVERY_PROMPT;
  },

  parse: parseFtuGoalOutput,

  processors: [
    {
      name: "persistDiscoveredGoal",
      async process({ runtime, message, output }) {
        if (
          !output.goalFound ||
          output.goal.length === 0 ||
          output.confidence < FTU_GOAL_CONFIDENCE_THRESHOLD
        ) {
          return undefined;
        }
        const discoveredAt = new Date().toISOString();
        const sourceMessageId =
          typeof message.id === "string" && message.id.length > 0
            ? message.id
            : undefined;
        const completion = await createFtuGoalStateStore(
          runtime,
        ).completeIfPending(
          {
            goal: output.goal,
            confidence: output.confidence,
            discoveredAt,
            ...(sourceMessageId ? { sourceMessageId } : {}),
          },
          async () => {
            await createOwnerFactStore(runtime).update(
              { primaryGoal: output.goal },
              {
                source: "agent_inferred",
                recordedAt: discoveredAt,
                note: `ftu goal discovery from message:${sourceMessageId ?? "(unknown)"}`,
              },
            );
          },
        );
        if (!completion.didComplete) {
          return undefined;
        }
        return {
          success: true,
          values: {
            ftuGoalDiscovered: true,
            ftuGoalConfidence: output.confidence,
          },
        };
      },
    },
  ],
};
