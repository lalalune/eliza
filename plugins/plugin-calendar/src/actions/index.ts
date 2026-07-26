/** Barrel for the calendar actions: calendar CRUD/planning plus deterministic conflict detection. */
export {
  CALENDAR_PLAN_INSTRUCTIONS,
  type CalendarHandlerAction,
  type CalendarLlmPlan,
  createCalendarActionRunner,
  extractCalendarPlanWithLlm,
} from "./calendar-handler.js";
export {
  __resetConflictDetectLoaderForTests,
  type ConflictDetectActionDeps,
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
  conflictDetectAction,
  createCalendarFeedConflictLoader,
  createConflictDetectAction,
  setConflictDetectLoader,
} from "./conflict-detect.js";
export type {
  CalendarActionDeps,
  CalendarJsonModelResult,
  CalendarModelCallArgs,
  CalendarTravelBufferDep,
  CalendarTravelBufferResult,
  CalendarTravelIntent,
} from "./deps.js";
