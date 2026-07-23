/**
 * Live goal extraction for the lightweight shared runtime.
 *
 * Tier-0 does not run the Personal Assistant plugin. It uses the same shared
 * schema and prompt for the narrow first-goal handoff, then stores the typed
 * result for durable shared context and later verified PA adoption.
 */

import {
  buildFtuGoalExtractionPrompt,
  type FtuGoalDiscoveryOutput,
  FtuGoalDiscoveryOutputSchema,
  parseFtuGoalDiscoveryOutput,
} from "@elizaos/shared/contracts";
import { generateObject } from "ai";
import { getInteractiveCerebrasLanguageModel } from "../../providers/language-model";
import { SHARED_TURN_MAX_RETRIES, type SharedAgentTurnUsage } from "./run-shared-agent-turn";

export interface SharedFtuGoalExtraction {
  output: FtuGoalDiscoveryOutput;
  model: string;
  usage?: SharedAgentTurnUsage;
}

export async function extractSharedFtuGoal(input: {
  model: string;
  ownerMessage: string;
  assistantReply: string;
}): Promise<SharedFtuGoalExtraction> {
  const result = await generateObject({
    model: getInteractiveCerebrasLanguageModel(input.model),
    schema: FtuGoalDiscoveryOutputSchema,
    prompt: buildFtuGoalExtractionPrompt({
      ownerMessage: input.ownerMessage,
      assistantReply: input.assistantReply,
    }),
    temperature: 0,
    maxRetries: SHARED_TURN_MAX_RETRIES,
  });
  const output = parseFtuGoalDiscoveryOutput(result.object);
  if (!output) {
    throw new Error(
      `[shared-runtime] FTU goal extractor returned an invalid object (model=${input.model})`,
    );
  }
  return {
    output,
    model: input.model,
    ...(result.usage ? { usage: result.usage } : {}),
  };
}
