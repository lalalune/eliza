import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { clearFeedAuthState } from "./feed-auth";

const feedPlugin: Plugin = {
  name: "@elizaos/plugin-feed",
  description: "Feed prediction market game operator surface.",
  views: [
    // One shipped GUI declaration. Future modalities should extend this entry
    // instead of duplicating the view.
    {
      id: "feed",
      // Preview-gated: the Feed operator surface is an early-stage, non-MVP
      // surface, hidden from a fresh user's launcher AND view manager until the
      // Preview toggle is on. `preview` keeps the manager grid in step with the
      // launcher's own preview-gating of this id (launcher-curation
      // LAUNCHER_PREVIEW_IDS), which previously diverged because the declaration
      // claimed `system`.
      viewKind: "preview",
      label: "Feed",
      description: "Feed prediction market operator dashboard",
      icon: "Gamepad2",
      path: "/feed",
      modalities: ["gui"],
      bundlePath: "dist/views/bundle.js",
      // First-party instrumented view (data-agent-id controls): grant the
      // agent-surface capability so the view broker admits agent-driven
      // fills/clicks (#13452 manifest gate).
      surface: { capabilities: ["agent-surface"] },
      componentExport: "FeedView",
      capabilities: [
        { id: "get-state", description: "Return Feed view state" },
        {
          id: "refresh-agent-status",
          description: "Refresh agent status, dashboard, and market state",
        },
        {
          id: "open-live-dashboard",
          description: "Return live Feed dashboard route and endpoints",
        },
        {
          id: "send-team-message",
          description: "Send a Feed team-chat message",
          params: {
            content: {
              type: "string",
              description: "Message to send to the Feed team chat",
            },
          },
        },
      ],
      tags: ["game", "prediction-market", "feed"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
  dispose(runtime: IAgentRuntime) {
    clearFeedAuthState(runtime);
  },
};

export default feedPlugin;
export * from "./routes.js";
export * from "./ui/feed-data.js";
// NOTE: only the pure proxy + data layers are re-exported here. The Node agent
// imports this entry to register the plugin's views; pulling React/UI in would
// break that bundle. The GUI view loads from the dedicated view bundle
// (src/ui/feed-view-bundle.ts -> FeedView).
