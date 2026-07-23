/**
 * Maps every shipped plugin view to executable interaction evidence or a
 * reasoned, current exemption.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const VIEW_CASES_SOURCE = path.join(HERE, "ui-smoke", "plugin-view-cases.ts");
const KEYLESS_WORKFLOW = path.join(
  REPO_ROOT,
  ".github/workflows/scenario-pr.yml",
);
const UI_SMOKE_DENY_LIST = path.join(HERE, "ui-smoke", ".pr-deny-list.json");

type ViewType = "gui" | "tui";

type VisualViewCase = {
  id: string;
  viewType: ViewType;
  path: string;
};

type InteractionOwner = {
  spec: string;
  proves: string;
  signals: readonly string[];
};

const VISUAL_BASELINE_OWNER: InteractionOwner = {
  spec: "packages/app/test/ui-smoke/plugin-views-visual.spec.ts",
  proves:
    "Captures screenshots and audits rendered visible text/controls for every shipped plugin view.",
  signals: ["captureScreenshotWithQualityRetry", "visibleText"],
};

const DECOMPOSED_PA_SPEC =
  "packages/app/test/ui-smoke/apps-personal-assistant-decomposed-interactions.spec.ts";

const GUI_INTERACTION_OWNERS: Readonly<
  Record<string, readonly InteractionOwner[]>
> = {
  birdclaw: [
    {
      spec: "plugins/plugin-birdclaw/src/plugin.test.ts",
      proves:
        "Locks the Birdclaw view manifest path, bundle, component export, shipped modality, and manager visibility contract.",
      signals: [
        "declares the birdclaw view exactly as the bundle build emits it",
        "BirdclawView",
      ],
    },
    {
      spec: "plugins/plugin-birdclaw/src/components/birdclaw/BirdclawView.test.tsx",
      proves:
        "Exercises tab switching (home/likes/bookmarks/inbox), the sync trigger with in-place reload, sync-failure surfacing, and the setup/error/retry states through the injected fetcher seam.",
      signals: [
        "switches tabs: likes uses the liked filter, inbox hits the inbox route",
        "syncs the active tab's collection and reloads in place",
        "renders the error state and recovers on retry",
      ],
    },
  ],
  calendar: [
    {
      spec: DECOMPOSED_PA_SPEC,
      proves: "Drives the calendar day/week/month tab switcher.",
      signals: ["calendar decomposed view", "/calendar"],
    },
  ],
  finances: [
    {
      spec: DECOMPOSED_PA_SPEC,
      proves: "Renders the finances summary scaffold.",
      signals: ["finances decomposed view", "/finances"],
    },
  ],
  focus: [
    {
      spec: DECOMPOSED_PA_SPEC,
      proves: "Renders the focus/blocker scaffold.",
      signals: ["focus decomposed view", "/focus"],
    },
  ],
  goals: [
    {
      spec: DECOMPOSED_PA_SPEC,
      proves: "Renders the goals scaffold.",
      signals: ["goals decomposed view", "/goals"],
    },
  ],
  health: [
    {
      spec: DECOMPOSED_PA_SPEC,
      proves: "Renders the health regions.",
      signals: ["health decomposed view", "/health"],
    },
  ],
  inbox: [
    {
      spec: DECOMPOSED_PA_SPEC,
      proves: "Toggles the inbox channel filters.",
      signals: ["inbox decomposed view", "/inbox"],
    },
  ],
  relationships: [
    {
      spec: DECOMPOSED_PA_SPEC,
      proves:
        "Renders the relationships knowledge graph and toggles an entity-kind filter.",
      signals: ["relationships decomposed view", "/relationships"],
    },
  ],
  todos: [
    {
      spec: DECOMPOSED_PA_SPEC,
      proves: "Renders the todo lanes.",
      signals: ["todos decomposed view", "/todos"],
    },
  ],
  contacts: [
    {
      spec: "packages/app/test/ui-smoke/apps-comms-device-interactions.spec.ts",
      proves:
        "Exercises the Android contacts create form and fixture persistence.",
      signals: [
        "contacts deterministic controls",
        "contacts-create-display-name",
        "contacts-create-submit",
      ],
    },
  ],
  cloud: [
    {
      spec: "plugins/plugin-elizacloud/src/components/cloud/CloudView.test.tsx",
      proves:
        "Exercises loading, signed-out, error/retry, ready account data, and designed section-level degradation for the Cloud account view.",
      signals: [
        "CloudView state-machine suite",
        "cloud-credit-balance",
        "Connect your Eliza Cloud account",
      ],
    },
  ],
  hyperliquid: [
    {
      spec: "packages/app/test/ui-smoke/apps-utility-interactions.spec.ts",
      proves: "Verifies markets, positions, and orders.",
      signals: [
        "market utility controls show fixture data on load",
        "market-BTC",
        "position-BTC",
      ],
    },
  ],
  "lifeops-live-test": [
    {
      spec: "plugins/plugin-scheduling/src/components/lifeops-live-test/LifeOpsLiveTestSpatialView.tsx",
      proves:
        "Owns the LifeOps live-test readiness, run, retry, and fire-now agent controls consumed by the visual matrix.",
      signals: ["run-reminder", "run-checkin", "retry"],
    },
  ],
  messages: [
    {
      spec: "packages/app/test/ui-smoke/apps-comms-device-interactions.spec.ts",
      proves:
        "Exercises rendered SMS history, compose fields, send action, and fixture persistence.",
      signals: [
        "messages deterministic controls",
        "messages-send",
        "messages-body",
      ],
    },
  ],
  "model-tester": [
    {
      spec: "packages/app/test/ui-smoke/apps-model-training-interactions.spec.ts",
      proves:
        "Runs deterministic text and image model probes through visible form controls.",
      signals: [
        "model tester route runs deterministic visible probes",
        "run text probe",
      ],
    },
  ],
  notes: [
    {
      spec: "plugins/plugin-simple-views/src/views/simple-views.e2e.test.tsx",
      proves:
        "Creates, edits, and preserves a note through the real Notes surface and filesystem-backed service.",
      signals: [
        "creates, edits, and preserves a note while creating an event across view switches",
        "Demo briefing ready",
      ],
    },
  ],
  phone: [
    {
      spec: "packages/app/test/ui-smoke/apps-comms-device-interactions.spec.ts",
      proves:
        "Exercises the dialer keypad, contact dialing, call action, and native fixture persistence.",
      signals: ["phone deterministic controls", "dialpad-", "dialer-call"],
    },
  ],
  polymarket: [
    {
      spec: "packages/app/test/ui-smoke/apps-utility-interactions.spec.ts",
      proves: "Verifies the Polymarket route shell.",
      signals: [
        "market utility controls show fixture data on load",
        "polymarket-root",
      ],
    },
  ],
  wallet: [
    {
      spec: "packages/app/test/ui-smoke/apps-utility-interactions.spec.ts",
      proves:
        "Exercises wallet refresh, sidebar tabs, NFT/token state, hide, and RPC settings navigation.",
      signals: [
        "wallet inventory interactions",
        "Hide USDC",
        "Open RPC settings",
      ],
    },
  ],
  "vector-browser": [
    {
      spec: "packages/app/test/ui-smoke/apps-utility-interactions.spec.ts",
      proves:
        "Exercises vector memory search, list/detail state, and 2D/3D projection mode controls.",
      signals: ["vector browser controls", "vector 2D projection"],
    },
  ],
  feed: [
    {
      spec: "packages/app/test/ui-smoke/apps-personal-assistant-feed-interactions.spec.ts",
      proves:
        "Exercises feed GUI no-run state through deterministic app routes.",
      signals: ["feed gui no-run state"],
    },
  ],
  "views-manager": [
    // The standalone 'Dynamic view management' form (and its
    // view-manager-actual-flow spec) left with the springboard->launcher
    // curation, and #11523 then made the launcher a read-only single page
    // (no edit mode, no drag-to-reorder, no pin/delete affordances). View
    // management now lives in the registered plugin-view lifecycle. Residual
    // gap: an e2e for CREATING a dynamic view through the current product flow.
    {
      spec: "packages/ui/src/components/pages/__e2e__/run-launcher-e2e.mjs",
      proves:
        "The read-only launcher (the surface that replaced the dynamic-view manager form): real tap-launch with telemetry, a stationary long-press that must NOT enter any edit mode, and the swipe-home rail gesture.",
      signals: [
        "a long-press never enters edit mode",
        "telemetry ring recorded the tap launch",
      ],
    },
    {
      spec: "packages/app/test/ui-smoke/plugin-views-lifecycle.spec.ts",
      proves:
        "Registered plugin views load, unmount, reopen, and reload cleanly across the view lifecycle.",
      signals: [
        "registered plugin view lifecycle",
        "loads, unmounts, reopens, and reloads",
      ],
    },
  ],
  orchestrator: [
    {
      spec: "packages/app/test/ui-smoke/orchestrator-gui-workbench.spec.ts",
      proves:
        "Exercises the read-only empty workbench and the rich build-room rail/timeline/inspector controls plus the add-agent form submit. (The GUI create-task/composer affordances moved to chat in the overlay-only redesign.)",
      signals: ["orchestrator-workbench", "orchestrator-add-agent-submit"],
    },
  ],
  screenshare: [
    {
      spec: "packages/app/test/ui-smoke/screenshare-gui-interactions.spec.ts",
      proves:
        "Exercises host start/open/copy/stop, remote connect, capability refresh, and request payloads.",
      signals: ["host lifecycle", "capability refresh", "screen-token-1"],
    },
  ],
  "simple-calendar": [
    {
      spec: "plugins/plugin-simple-views/src/views/simple-views.e2e.test.tsx",
      proves:
        "Creates a calendar event through the real Calendar surface and verifies persistence across a view switch.",
      signals: [
        "creates, edits, and preserves a note while creating an event across view switches",
        "Create calendar event",
      ],
    },
  ],
  "task-coordinator": [
    {
      spec: "packages/app/test/ui-smoke/task-coordinator-gui-interactions.spec.ts",
      proves:
        "Exercises task-thread search, detail expansion, sessions, artifacts, pending input, archive, and reopen flows.",
      signals: [
        "task coordinator GUI searches",
        "archiveRequests",
        "reopenRequests",
      ],
    },
  ],
  "trajectory-logger": [
    {
      spec: "packages/app/test/ui-smoke/apps-model-training-interactions.spec.ts",
      proves: "Exercises detail selection, stage filtering, and search.",
      signals: ["trajectory viewer route refreshes"],
    },
  ],
  training: [
    {
      spec: "packages/app/test/ui-smoke/apps-model-training-interactions.spec.ts",
      proves:
        "Exercises trajectory selection, dataset build, training job start, and cancel flow.",
      signals: ["fine-tuning route selects trajectories", "start training job"],
    },
  ],
  cockpit: [
    {
      spec: "plugins/plugin-task-coordinator/src/CockpitRoute.test.tsx",
      proves:
        "Exercises the developer-only cockpit route through spawn wiring and deck/session-pane navigation.",
      signals: [
        "CockpitRoute — live spawn wiring",
        "spawning creates the task AND spawns the agent",
      ],
    },
  ],
};

// Every decomposed personal-assistant view has a dedicated interaction owner
// (apps-personal-assistant-decomposed-interactions.spec.ts) EXCEPT "documents":
// its `/documents` view path collides with the built-in "documents" tab
// (App.tsx findView matches `/${tab}`), so registering it in the ui-smoke stub
// hijacks the `/character/documents` route. It stays tracked debt until that
// view path is disambiguated.
const INTERACTION_DEBT: Readonly<Record<string, string>> = {
  "documents:gui":
    "The decomposed documents view path `/documents` collides with the built-in " +
    "`documents` tab (/character/documents) via App.tsx findView, so it cannot be " +
    "registered in the ui-smoke stub without hijacking that route. Needs a " +
    "disambiguated view path before a keyless interaction spec can drive it.",
};

function viewKey(view: Pick<VisualViewCase, "id" | "viewType">) {
  return `${view.id}:${view.viewType}`;
}

function readVisualMatrixCases(): VisualViewCase[] {
  const source = readFileSync(VIEW_CASES_SOURCE, "utf8");
  const match = source.match(
    /const VIEW_CASES: ViewCase\[] = \(?\s*\[([\s\S]*?)\]\s*(?:satisfies[\s\S]*?)?\)?\s*\.map/,
  );
  expect(match?.[1], "VIEW_CASES declaration was not found").toBeTruthy();
  const viewCasesSource = match?.[1] ?? "";

  return Array.from(
    viewCasesSource.matchAll(
      /\["([^"]+)",\s*"(gui|tui|xr)",\s*"([^"]+)"(?:,\s*\{[^}\]]*\})?\]/g,
    ),
  ).flatMap((caseMatch) => {
    const id = caseMatch[1];
    const viewType = caseMatch[2];
    const viewPath = caseMatch[3];
    expect(
      viewType,
      `Plugin visual matrix must stay GUI-only; remove ${id}:${viewType} from VIEW_CASES`,
    ).toBe("gui");
    if (!id || viewType !== "gui" || !viewPath) {
      return [];
    }
    return [{ id, viewType, path: viewPath }];
  });
}

function interactionOwners(view: VisualViewCase): readonly InteractionOwner[] {
  return [VISUAL_BASELINE_OWNER, ...(GUI_INTERACTION_OWNERS[view.id] ?? [])];
}

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function uiSmokeSpecName(spec: string): string | null {
  const match = spec.match(/^packages\/app\/test\/ui-smoke\/(.+\.spec\.ts)$/);
  return match?.[1] ?? null;
}

describe("plugin view interaction coverage", () => {
  it("classifies every live visual-matrix view exactly once", () => {
    const visualCases = readVisualMatrixCases();
    const visualKeys = visualCases.map(viewKey);
    const liveViewIds = new Set(visualCases.map((view) => view.id));
    const ownerIds = Object.keys(GUI_INTERACTION_OWNERS);
    const debtKeys = Object.keys(INTERACTION_DEBT);
    const ownerKeys = visualCases
      .filter((view) => (GUI_INTERACTION_OWNERS[view.id]?.length ?? 0) > 0)
      .map(viewKey);
    const duplicateVisualKeys = visualKeys.filter(
      (key, index) => visualKeys.indexOf(key) !== index,
    );
    const staleOwners = ownerIds.filter((id) => !liveViewIds.has(id));
    const staleDebt = debtKeys.filter((key) => !visualKeys.includes(key));
    const blankDebtReasons = debtKeys.filter(
      (key) => INTERACTION_DEBT[key]?.trim().length === 0,
    );
    const multiplyClassified = ownerKeys.filter((key) =>
      debtKeys.includes(key),
    );
    const classifiedKeys = new Set([...ownerKeys, ...debtKeys]);
    const unclassified = visualCases.filter(
      (view) => !classifiedKeys.has(viewKey(view)),
    );

    expect(duplicateVisualKeys, "Visual view keys must be unique.").toEqual([]);
    expect(
      staleOwners,
      "Remove interaction-owner entries for views no longer in the live matrix.",
    ).toEqual([]);
    expect(
      staleDebt,
      "Remove exemptions for deleted or renamed views.",
    ).toEqual([]);
    expect(
      blankDebtReasons,
      "Every interaction exemption must explain its current blocker.",
    ).toEqual([]);
    expect(
      multiplyClassified,
      "A view with executable interaction evidence cannot remain exempt.",
    ).toEqual([]);
    expect(
      unclassified.map((view) => `${viewKey(view)} ${view.path}`),
      "Add an interaction owner or an explicit debt reason for each view case.",
    ).toEqual([]);
    expect(
      [...classifiedKeys].sort(),
      "The interaction authority must exactly partition the live visual matrix.",
    ).toEqual([...visualKeys].sort());
  });

  it("references real owner specs with the declared coverage signals", () => {
    const owners = new Map<string, InteractionOwner>();
    for (const view of readVisualMatrixCases()) {
      for (const owner of interactionOwners(view)) {
        owners.set(`${owner.spec}:${owner.proves}`, owner);
      }
    }

    const missingSpecs: string[] = [];
    const missingSignals: string[] = [];
    const invalidMetadata: string[] = [];
    for (const owner of owners.values()) {
      if (owner.proves.trim().length === 0 || owner.signals.length === 0) {
        invalidMetadata.push(owner.spec);
      }
      const absolutePath = path.join(REPO_ROOT, owner.spec);
      if (!existsSync(absolutePath)) {
        missingSpecs.push(owner.spec);
        continue;
      }
      const source = readRepoFile(owner.spec);
      const absent = owner.signals.filter((signal) => !source.includes(signal));
      if (absent.length > 0) {
        missingSignals.push(`${owner.spec}: ${absent.join(", ")}`);
      }
    }

    expect(missingSpecs).toEqual([]);
    expect(missingSignals).toEqual([]);
    expect(
      invalidMetadata,
      "Every interaction owner must state what it proves and name source signals.",
    ).toEqual([]);
  });

  it("keeps ui-smoke interaction-owner specs wired into keyless CI", () => {
    const owners = new Map<string, InteractionOwner>();
    for (const view of readVisualMatrixCases()) {
      for (const owner of interactionOwners(view)) {
        owners.set(owner.spec, owner);
      }
    }

    const denyList = JSON.parse(readFileSync(UI_SMOKE_DENY_LIST, "utf8")) as {
      specs?: Array<{ spec?: string }>;
    };
    expect(
      Array.isArray(denyList.specs),
      "The UI-smoke deny-list must expose a specs array.",
    ).toBe(true);
    const denied = new Set(
      (denyList.specs ?? []).flatMap((entry) =>
        typeof entry.spec === "string" ? [entry.spec] : [],
      ),
    );
    const excludedOwners = [...owners.keys()]
      .map((spec) => ({
        spec,
        uiSmokeName: uiSmokeSpecName(spec),
      }))
      .filter(
        (owner): owner is { spec: string; uiSmokeName: string } =>
          owner.uiSmokeName !== null,
      )
      .filter((owner) => denied.has(owner.uiSmokeName))
      .map((owner) => owner.spec);

    expect(
      excludedOwners,
      "Every Playwright ui-smoke interaction owner must run in keyless scenario-pr CI.",
    ).toEqual([]);

    const workflow = readFileSync(KEYLESS_WORKFLOW, "utf8");
    expect(
      workflow.includes("ui-smoke-pr-specs.mjs --list-auto"),
      "Keyless CI must retain the directory-driven job that runs non-denied owner specs.",
    ).toBe(true);
  });
});
