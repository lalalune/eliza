/**
 * Adopts a Cloud shared-runtime activation goal into canonical LifeOps state.
 *
 * The conversation import boundary calls this service after every transcript
 * row is durable. Adoption is first-write-wins and verifies both the FTU
 * lifecycle snapshot and typed owner fact before the shared source may be
 * deleted.
 */

import { type IAgentRuntime, Service } from "@elizaos/core";
import {
  ACTIVATION_GOAL_HANDOFF_SERVICE_TYPE,
  type ActivationGoalAdoptionResult,
  type ActivationGoalHandoffEnvelope,
  ActivationGoalHandoffEnvelopeSchema,
  type ActivationGoalHandoffService,
} from "@elizaos/shared";
import { createOwnerFactStore } from "../owner/fact-store.js";
import { createFtuGoalStateStore } from "./state.js";

export class LifeOpsActivationGoalHandoffService
  extends Service
  implements ActivationGoalHandoffService
{
  static override readonly serviceType = ACTIVATION_GOAL_HANDOFF_SERVICE_TYPE;

  override capabilityDescription =
    "Adopts a verified shared-runtime onboarding goal into durable LifeOps owner state.";

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<LifeOpsActivationGoalHandoffService> {
    return new LifeOpsActivationGoalHandoffService(runtime);
  }

  override async stop(): Promise<void> {}

  async adoptActivationGoal(
    envelopeInput: ActivationGoalHandoffEnvelope,
  ): Promise<ActivationGoalAdoptionResult> {
    const parsed = ActivationGoalHandoffEnvelopeSchema.safeParse(envelopeInput);
    if (!parsed.success || parsed.data.status !== "accepted") {
      throw new Error(
        "[lifeops:activation-handoff] an accepted, valid goal envelope is required",
      );
    }
    const envelope = parsed.data;
    if (!envelope.response || !envelope.goal) {
      throw new Error(
        "[lifeops:activation-handoff] accepted envelope lost required fields",
      );
    }
    const response = envelope.response;
    const goal = envelope.goal;

    const discoveredAt = new Date(goal.recordedAt).toISOString();
    const completion = await createFtuGoalStateStore(
      this.runtime,
    ).completeIfPending(
      {
        goal: goal.text,
        confidence: goal.confidence,
        discoveredAt,
        sourceMessageId: response.messageId,
      },
      async () => {
        await createOwnerFactStore(this.runtime).update(
          { primaryGoal: goal.text },
          {
            source: "agent_inferred",
            recordedAt: discoveredAt,
            note: `shared activation goal from message:${response.messageId} model:${goal.model}`,
          },
        );
      },
    );
    const [lifecycle, facts] = await Promise.all([
      createFtuGoalStateStore(this.runtime).read(),
      createOwnerFactStore(this.runtime).read(),
    ]);
    const verified =
      lifecycle.status === "complete" &&
      lifecycle.goal?.goal === goal.text &&
      facts.primaryGoal?.value === goal.text;
    if (!verified) {
      throw new Error(
        "[lifeops:activation-handoff] durable goal readback did not match the shared envelope",
      );
    }
    return {
      adopted: completion.didComplete,
      verified: true,
      goal: goal.text,
    };
  }
}
