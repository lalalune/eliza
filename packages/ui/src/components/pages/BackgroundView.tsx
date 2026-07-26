/**
 * BackgroundView — the "Background" view.
 *
 * A minimal, wordless shell around the shared Appearance settings background
 * controls. The view stays transparent so the live wallpaper shows behind the
 * controls and updates the instant a choice is made — the same background Home,
 * Launcher, Settings, and this route share.
 */

import { BackgroundSettingsControls } from "../settings/BackgroundSettingsControls";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";

export function BackgroundView() {
  return (
    <ShellViewAgentSurface viewId="background">
      {/* This view renders WITHOUT a shell scroll wrapper (the `background` tab
          is full-bleed on the transparent shell), so it owns its own bottom
          clearance. The scrollport ends above the floating composer so the
          lower swatches remain tappable while the wallpaper still bleeds behind
          the native home/gesture area. */}
      <div className="eliza-continuous-chat-scroll relative mb-[calc(var(--eliza-continuous-chat-clearance,5.25rem)+0.75rem)] flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-4 pt-[var(--view-pad-top)] pb-4">
        <h1 className="sr-only">Background</h1>
        <BackgroundSettingsControls />
      </div>
    </ShellViewAgentSurface>
  );
}
