import { findBackgroundRegions } from "/Users/shawwalters/.codex/worktrees/b205/eliza/packages/ui/src/components/chat/message-background-parser.ts";
import { BackgroundWidget } from "/Users/shawwalters/.codex/worktrees/b205/eliza/packages/ui/src/components/chat/widgets/background-widget.tsx";
import { registerInlineWidget } from "/Users/shawwalters/.codex/worktrees/b205/eliza/packages/ui/src/components/chat/widgets/inline-registry.tsx";

registerInlineWidget({
  kind: "background",
  parse: (text) => findBackgroundRegions(text).map((match) => ({ ...match, data: match })),
  keyFor: (match) => `background:${match.start}`,
  render: (_match, _ctx, key) => <BackgroundWidget key={key} />,
});
