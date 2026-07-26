/**
 * Personal-assistant adapter for the calendar-owned conflict action.
 *
 * PA contributes only its canonical owner authorization and owner-effective
 * timezone. Calendar owns provider loading, privacy, source health, and every
 * deterministic availability rule.
 */

import type { IAgentRuntime } from "@elizaos/core";
import {
  type ConflictDetectActionDeps,
  createConflictDetectAction,
} from "@elizaos/plugin-calendar";
import { hasLifeOpsAccess } from "../lifeops/access.js";
import { resolveOwnerTimeZone } from "../lifeops/owner/fact-store.js";

const personalAssistantConflictDeps: ConflictDetectActionDeps = {
  authorize: hasLifeOpsAccess,
  resolveTimeZone: (runtime: IAgentRuntime) =>
    resolveOwnerTimeZone(runtime, new Date()),
};

export const conflictDetectAction = createConflictDetectAction(
  personalAssistantConflictDeps,
);

export {
  __resetConflictDetectLoaderForTests,
  type ConflictDetectEvent,
  type ConflictDetectLoadBatch,
  type ConflictDetectLoader,
  type ConflictDetectLoadResult,
  type ConflictDetectLoadSnapshot,
  type ConflictDetectPair,
  type ConflictDetectProposal,
  type ConflictDetectResult,
  type ConflictRange,
  type ConflictSeverity,
  createCalendarFeedConflictLoader,
  setConflictDetectLoader,
} from "@elizaos/plugin-calendar";
