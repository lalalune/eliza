/**
 * Transparent wallpaper picker for the shared app background.
 *
 * This route bypasses the normal tab scroll wrapper so the live wallpaper can
 * show behind the controls; it therefore owns its own scroll region and bottom
 * chat-overlay clearance.
 */

import { BackgroundSettingsControls } from "../settings/BackgroundSettingsControls";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";

export function BackgroundView() {
  return (
    <ShellViewAgentSurface viewId="background">
      {/* This view renders WITHOUT a shell scroll wrapper (the `background` tab
          is full-bleed on the transparent shell), so it owns its own bottom
          clearance: the floating-composer + bottom-nav + safe-area stack, plus
          the standard `--view-pad-top` gutter. No magic `pb-28`. */}
      <div className="relative me-[var(--eliza-continuous-chat-side-clearance,0px)] mb-[var(--eliza-continuous-chat-clearance,5.25rem)] flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-4 pt-[var(--view-pad-top)] pb-4">
        <h1 className="sr-only">Background</h1>
        <BackgroundSettingsControls />
      </div>
    </ShellViewAgentSurface>
  );
}
