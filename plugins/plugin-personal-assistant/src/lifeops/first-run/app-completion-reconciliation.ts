/**
 * Reconciles the app's persisted setup completion into LifeOps first-run
 * state during plugin initialization. The app config remains the authority
 * for deployment/provider setup; LifeOps adopts that fact without fabricating
 * onboarding messages or interrupting an active customize/replay flow.
 */

import { isAppFirstRunComplete, loadElizaConfig } from "@elizaos/agent";
import type { IAgentRuntime } from "@elizaos/core";
import { createFirstRunStateStore, type FirstRunRecord } from "./state.js";

export async function reconcilePersistedAppFirstRunCompletion(
  runtime: IAgentRuntime,
  config: ReturnType<typeof loadElizaConfig> = loadElizaConfig(),
): Promise<FirstRunRecord> {
  const store = createFirstRunStateStore(runtime);
  if (!isAppFirstRunComplete(config)) {
    return await store.read();
  }
  return await store.adoptAppCompletion();
}
