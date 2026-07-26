/**
 * Back-compat re-export of the chat-native tutorial service. The tour used to
 * be a spotlight-overlay engine owned by this module; it now lives in
 * `src/tutorial/` as a conversational conductor that seeds turns into the
 * live chat. Callers that predate the move (the in-chat first-run conductor,
 * permission priming) keep importing from this path.
 */
export {
  advanceTutorial,
  getTutorialState,
  restartTutorial,
  startTutorial,
  stopTutorial,
  type TutorialState,
  type TutorialStatus,
  useTutorial,
} from "../../../tutorial/tutorial-service";
