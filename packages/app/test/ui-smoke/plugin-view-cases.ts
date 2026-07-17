/**
 * Plugin-view inventories for production coverage and stub-backed browser
 * scenarios. The complete matrix stays aligned with shipped plugin manifests;
 * the smoke subset stays aligned with app-core's `smokeViewDeclarations` so a
 * missing stub declaration cannot pass against the launcher fallback.
 */
export type ViewCase = {
  id: string;
  viewType: "gui";
  path: string;
  shellPill: "expected" | "suppressed";
};

type ViewCaseTuple = readonly [
  id: string,
  viewType: ViewCase["viewType"],
  path: string,
  options?: {
    shellPill: ViewCase["shellPill"];
  },
];

export const VIEW_CASES: ViewCase[] = (
  [
    // Shipped plugin views are GUI-only. The shared viewType contract still
    // accepts future modalities, but this smoke matrix tracks what the app can
    // render today.
    ["birdclaw", "gui", "/birdclaw"],
    ["cloud", "gui", "/cloud"],
    ["contacts", "gui", "/contacts"],
    ["hyperliquid", "gui", "/hyperliquid"],
    ["focus", "gui", "/focus"],
    ["calendar", "gui", "/calendar"],
    ["documents", "gui", "/documents"],
    ["finances", "gui", "/finances"],
    ["goals", "gui", "/goals"],
    ["lifeops-live-test", "gui", "/lifeops-live-test"],
    ["health", "gui", "/health"],
    ["inbox", "gui", "/inbox"],
    ["relationships", "gui", "/relationships"],
    ["todos", "gui", "/todos"],
    ["messages", "gui", "/messages"],
    ["model-tester", "gui", "/model-tester"],
    ["phone", "gui", "/phone"],
    ["polymarket", "gui", "/polymarket"],
    ["wallet", "gui", "/wallet"],
    ["vector-browser", "gui", "/vector-browser"],
    ["feed", "gui", "/feed"],
    ["views-manager", "gui", "/views"],
    ["screenshare", "gui", "/screenshare"],
    ["task-coordinator", "gui", "/task-coordinator"],
    ["orchestrator", "gui", "/orchestrator"],
    ["cockpit", "gui", "/cockpit"],
    ["trajectory-logger", "gui", "/trajectory-logger"],
    ["training", "gui", "/apps/fine-tuning"],
  ] satisfies ViewCaseTuple[]
).map(([id, viewType, viewPath, options]) => ({
  id,
  viewType,
  path: viewPath,
  shellPill: options?.shellPill === "suppressed" ? "suppressed" : "expected",
}));

// Dedicated flows cover these surfaces because the generic UI-smoke stub omits
// them: Documents collides with the shell-owned Knowledge route, while Cloud,
// LifeOps Live Test, and Cockpit require purpose-built state or live fixtures.
const GENERIC_SMOKE_OMITTED_VIEW_IDS = new Set([
  "cloud",
  "documents",
  "lifeops-live-test",
  "cockpit",
]);

export const SMOKE_VIEW_CASES = VIEW_CASES.filter(
  ({ id }) => !GENERIC_SMOKE_OMITTED_VIEW_IDS.has(id),
);
