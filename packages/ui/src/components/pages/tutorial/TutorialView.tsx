/**
 * The /tutorial route — a thin launcher for the chat-native tour, kept so the
 * launcher tile, deep links, and agent navigation still have a view to land
 * on. Opening it starts the tour immediately (a no-op when one is already
 * running; a restart after a completed/stopped run) and pops the floating
 * chat, where the tour actually happens. The panel itself just says so and
 * offers a start/restart affordance for chat- and voice-driven activation.
 */

import { Sparkles } from "lucide-react";
import * as React from "react";

import { useAgentElement } from "../../../agent-surface";
import { dispatchChatOpen } from "../../../events";
import {
  restartTutorial,
  startTutorial,
  useTutorial,
} from "../../../tutorial/tutorial-service";
import { Button } from "../../ui/button";
import { ShellViewAgentSurface } from "../../views/ShellViewAgentSurface";

export function TutorialView(): React.ReactElement {
  return (
    <ShellViewAgentSurface viewId="tutorial">
      <TutorialViewBody />
    </ShellViewAgentSurface>
  );
}

function TutorialViewBody(): React.ReactElement {
  const { status } = useTutorial();

  // Arriving here IS the start signal (the tile/deep-link already expressed
  // intent), so the tour begins without another tap. The floating chat overlay
  // renders over this view too, so the seeded tour turns are visible in place.
  React.useEffect(() => {
    startTutorial();
    dispatchChatOpen();
  }, []);

  const begin = React.useCallback(() => {
    // The button is the explicit re-run affordance: restart a finished or
    // stopped tour from the top; just re-open the chat when one is running.
    if (status === "active") startTutorial();
    else restartTutorial();
    dispatchChatOpen();
  }, [status]);

  const start = useAgentElement<HTMLButtonElement>({
    id: "tutorial-start",
    role: "button",
    label: status === "active" ? "Reopen the tour chat" : "Start the tour",
    description: "Run the conversational walkthrough of the basics, in chat",
    onActivate: begin,
  });

  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center overflow-y-auto px-6 py-6 text-center"
      data-testid="tutorial-launcher"
    >
      <div className="flex max-w-xs flex-col items-center">
        <Sparkles className="mb-3 h-7 w-7 text-accent" aria-hidden />
        <p className="text-sm text-txt-strong">
          The tour runs in the chat — it's open below.
        </p>
        <p className="mt-1 text-xs text-txt/60">
          Reply Next to step through, or type "stop tutorial" anytime.
        </p>

        <Button
          ref={start.ref}
          {...start.agentProps}
          onClick={begin}
          data-testid="tutorial-start"
          size="lg"
          className="mt-4 text-[15px] font-semibold"
        >
          {status === "active" ? "Reopen the tour" : "Start the tour"}
        </Button>
      </div>
    </div>
  );
}
