/**
 * BackgroundView — the "Background" view.
 *
 * A minimal, wordless shell around the shared background picker. The route uses
 * the condensed filmstrip variant so the chat composer remains the primary
 * bottom affordance; Settings still owns the full gallery.
 */

import { BackgroundSettingsControls } from "../settings/BackgroundSettingsControls";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";

const backgroundViewportHeight =
  "calc(100dvh - var(--eliza-continuous-chat-clearance, 5.25rem) - 0.5rem)";

export function BackgroundView() {
  return (
    <ShellViewAgentSurface viewId="background">
      {/* This view renders WITHOUT a shell scroll wrapper (the `background` tab
          is full-bleed on the transparent shell), so it owns both the scroll
          clipping edge and the scroll-to-end padding for the ambient composer. */}
      <div
        data-testid="background-scroll-viewport"
        className="relative flex min-h-0 w-full flex-col items-center justify-center overflow-y-auto overscroll-contain px-4 pt-[var(--view-pad-top)] pb-[calc(var(--eliza-mobile-nav-offset,0px)+max(var(--safe-area-bottom,0px),var(--android-gesture-inset-bottom,0px))+1rem)] scroll-pb-[calc(var(--eliza-mobile-nav-offset,0px)+max(var(--safe-area-bottom,0px),var(--android-gesture-inset-bottom,0px))+1rem)]"
        style={{ height: backgroundViewportHeight }}
      >
        <h1 className="sr-only">Background</h1>
        <BackgroundSettingsControls variant="filmstrip" />
      </div>
    </ShellViewAgentSurface>
  );
}
