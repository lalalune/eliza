/**
 * Deterministic action-coverage gate.
 *
 * The app exposes an action surface that we want exercised by zero-cost
 * (keyless) e2e scenarios in CI. This test keeps that promise honest:
 *
 *   - Surface integrity: the real action surface of each importable core plugin
 *     is read live (from `plugin.actions[].name`) and must match the checked-in
 *     manifest. A new/renamed/removed action breaks the build, forcing whoever
 *     changed it to acknowledge the action here.
 *   - Coverage classification: action coverage is derived from the loaded
 *     scenarios, and every stable-core gap or direct-only route carries an
 *     explicit reasoned exemption that fails once it becomes stale.
 *   - Wiring integrity: every scenario file is actually run by the deterministic
 *     CI script — a scenario that exists but never runs is larp.
 *
 * Plugins import is static (top of file) so the heavy source transform happens
 * at module load, not inside a test where it would race the per-test timeout.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@elizaos/core";
import agentSkillsPlugin from "@elizaos/plugin-agent-skills";
import appControlPlugin from "@elizaos/plugin-app-control";
import codingToolsPlugin from "@elizaos/plugin-coding-tools";
import commandsPlugin from "@elizaos/plugin-commands";
import facewearPlugin from "@elizaos/plugin-facewear";
import githubPlugin from "@elizaos/plugin-github";
import gitPathologyPlugin from "@elizaos/plugin-gitpathologist";
import localInferencePlugin from "@elizaos/plugin-local-inference";
import deviceFilesystemPlugin from "@elizaos/plugin-native-filesystem";
import shellPlugin from "@elizaos/plugin-shell";
import streamingPlugin from "@elizaos/plugin-streaming";
import todosPlugin from "@elizaos/plugin-todos";
import videoPlugin from "@elizaos/plugin-video";
import workflowPlugin from "@elizaos/plugin-workflow";
import type {
  ScenarioDefinition,
  ScenarioFinalCheck,
  ScenarioTurn,
} from "@elizaos/scenario-runner/schema";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import mcpPlugin from "../../../../plugins/plugin-mcp/src/index.ts";
import { loadAllScenarios } from "../loader";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const scenarioDir = resolve(
  repoRoot,
  "packages/scenario-runner/test/scenarios",
);

/** Stable core plugins whose action surface is read live by import. */
const IMPORTED_CORE_PLUGINS: Record<string, Plugin> = {
  "@elizaos/plugin-app-control": appControlPlugin,
  "@elizaos/plugin-coding-tools": codingToolsPlugin,
  "@elizaos/plugin-commands": commandsPlugin,
  "@elizaos/plugin-agent-skills": agentSkillsPlugin,
  "@elizaos/plugin-local-inference": localInferencePlugin,
  "@elizaos/plugin-gitpathologist": gitPathologyPlugin,
  "@elizaos/plugin-todos": todosPlugin,
  "@elizaos/plugin-streaming": streamingPlugin,
  "@elizaos/plugin-facewear": facewearPlugin,
  "@elizaos/plugin-mcp": mcpPlugin,
  "@elizaos/plugin-workflow": workflowPlugin,
  "@elizaos/plugin-github": githubPlugin,
};

/** Expected action names for each imported core plugin (verified against live imports). */
const CORE_ACTION_SURFACE: Record<string, readonly string[]> = {
  "@elizaos/plugin-app-control": [
    "AGENT_SWITCH",
    "APP",
    "BACKGROUND",
    "MODEL_SWITCH",
    "SETTINGS",
    "VIEWS",
  ],
  "@elizaos/plugin-coding-tools": [
    "FILE",
    "SHELL",
    "WEB_FETCH",
    "WEB_SEARCH",
    "WORKTREE",
  ],
  "@elizaos/plugin-commands": [
    "ACCOUNTS_COMMAND",
    "BACKEND_COMMAND",
    "COMMANDS_COMMAND",
    "COMPACT_COMMAND",
    "CONTEXT_COMMAND",
    "ELEVATED_COMMAND",
    "HELP_COMMAND",
    "MODEL_COMMAND",
    "NEW_COMMAND",
    "QUEUE_COMMAND",
    "REASONING_COMMAND",
    "RESET_COMMAND",
    "STATUS_COMMAND",
    "THINK_COMMAND",
    "TTS_COMMAND",
    "USAGE_COMMAND",
    "VERBOSE_COMMAND",
    "WHOAMI_COMMAND",
  ],
  "@elizaos/plugin-agent-skills": [
    "SKILL",
    "SKILL_DETAILS",
    "SKILL_INSTALL",
    "SKILL_SEARCH",
    "SKILL_SYNC",
    "SKILL_TOGGLE",
    "SKILL_UNINSTALL",
    "USE_SKILL",
  ],
  "@elizaos/plugin-local-inference": [
    "GENERATE_MEDIA",
    "IDENTIFY_SPEAKER",
    "LOCAL_INFERENCE",
    "REDACT_TRANSCRIPT",
    "SHARE_TRANSCRIPT",
    "START_TRANSCRIPTION",
    "STOP_TRANSCRIPTION",
  ],
  "@elizaos/plugin-gitpathologist": ["GIT_PATHOLOGY"],
  "@elizaos/plugin-todos": ["TODO"],
  "@elizaos/plugin-streaming": ["STREAM"],
  "@elizaos/plugin-facewear": [
    "FACEWEAR_CONNECT",
    "FACEWEAR_DEBUG",
    "SMARTGLASSES_CONTROL",
    "SMARTGLASSES_DISPLAY_TEXT",
    "SMARTGLASSES_MICROPHONE",
    "SMARTGLASSES_STATUS",
  ],
  "@elizaos/plugin-mcp": [
    "MCP",
    "MCP_CALL_TOOL",
    "MCP_LIST_CONNECTIONS",
    "MCP_READ_RESOURCE",
    "MCP_SEARCH_ACTIONS",
  ],
  "@elizaos/plugin-workflow": ["EVAL_CODE", "WORKFLOW"],
  "@elizaos/plugin-github": [
    "GITHUB",
    "GITHUB_ISSUE_ASSIGN",
    "GITHUB_ISSUE_CLOSE",
    "GITHUB_ISSUE_COMMENT",
    "GITHUB_ISSUE_CREATE",
    "GITHUB_ISSUE_LABEL",
    "GITHUB_ISSUE_REOPEN",
    "GITHUB_NOTIFICATION_TRIAGE",
    "GITHUB_PR_LIST",
    "GITHUB_PR_REVIEW",
  ],
};

/** Core plugins that intentionally expose no agent actions (service/registry only). */
const ACTIONLESS_CORE_PLUGINS: Record<string, Plugin> = {
  "@elizaos/plugin-shell": shellPlugin,
  "@elizaos/plugin-video": videoPlugin,
  "@elizaos/plugin-native-filesystem": deviceFilesystemPlugin,
};

/**
 * Core plugin actions that the keyless lane resolves from source instead of a
 * live import: the app-control VIEWS aliases are wired in source but are not
 * registered as top-level runtime actions in this lane, so the live action
 * surface never exposes them. Verified by source instead.
 */
const SOURCE_ONLY_ACTIONS: Record<string, readonly string[]> = {
  "plugins/plugin-app-control/src/actions/views.ts": [
    "CLOSE_ALL_VIEWS",
    "CLOSE_VIEW",
  ],
};

/**
 * These actions are wired by source, but package resolution can read either
 * stale local dist or source in different CI lanes. Verify them from source and
 * exclude them from the live import drift check so both environments enforce
 * the same action contract.
 */
const SOURCE_VERIFIED_IMPORTED_ACTIONS: Record<string, readonly string[]> = {
  "@elizaos/plugin-app-control": ["CLOSE_ALL_VIEWS", "CLOSE_VIEW"],
};

/**
 * The stable-core keyless surface the coverage classifier drives to completion:
 * importable core plugins plus the source-only VIEWS aliases. Big, volatile
 * surfaces (browser, lifeops) are NOT here — their coverage is tracked by the
 * coverage registry instead, so adding a lifeops scenario never has to edit a
 * 150-entry surface list.
 */
function stableCoreActions(): string[] {
  return sorted([
    ...Object.values(CORE_ACTION_SURFACE).flat(),
    ...Object.values(SOURCE_ONLY_ACTIONS).flat(),
  ]);
}

/**
 * Stable imported keyless actions that do not yet have a deterministic scenario.
 * Each exemption names why the real keyless scenario cannot exist yet. The gate
 * below rejects unknown, overlapping, empty-reason, and newly-covered entries,
 * so this is a classification boundary rather than a historical count ledger.
 */
const STABLE_CORE_COVERAGE_EXEMPTIONS = buildReasonedExemptions([
  {
    names: ["CLOSE_ALL_VIEWS", "CLOSE_VIEW"],
    reason:
      "The source-wired VIEWS aliases are not registered as top-level actions in the keyless scenario runtime.",
  },
  {
    names: ["WEB_FETCH", "WEB_SEARCH"],
    reason:
      "Coding-tools web access has no strict network-free provider fixture; its real integration remains credentialed.",
  },
  {
    names: ["IDENTIFY_SPEAKER"],
    reason:
      "Speaker diarization requires an audio/model fixture that exercises the on-device inference boundary.",
  },
  {
    names: ["START_TRANSCRIPTION", "STOP_TRANSCRIPTION"],
    reason:
      "On-device transcription lifecycle actions require a real capture/inference session.",
  },
  {
    names: ["REDACT_TRANSCRIPT", "SHARE_TRANSCRIPT"],
    reason:
      "Transcript permission actions require an authenticated transcript ownership fixture (#15606).",
  },
  {
    names: ["EVAL_CODE"],
    reason:
      "Workflow code evaluation requires a sandbox execution fixture that the keyless scenario runtime does not provide (#8914).",
  },
  {
    names: ["AGENT_SWITCH", "MODEL_SWITCH"],
    reason:
      "Agent and model switching require multiple booted runtime/model targets; dashboard unit coverage owns the keyless path.",
  },
  {
    names: ["LOCAL_INFERENCE"],
    reason:
      "Local inference management requires a running model daemon and downloaded model artifact.",
  },
  {
    names: [
      "FACEWEAR_CONNECT",
      "FACEWEAR_DEBUG",
      "SMARTGLASSES_CONTROL",
      "SMARTGLASSES_DISPLAY_TEXT",
      "SMARTGLASSES_MICROPHONE",
      "SMARTGLASSES_STATUS",
    ],
    reason:
      "Facewear and smartglasses actions cross a native device bridge that the keyless scenario runtime cannot emulate.",
  },
  {
    names: [
      "ACCOUNTS_COMMAND",
      "BACKEND_COMMAND",
      "COMMANDS_COMMAND",
      "COMPACT_COMMAND",
      "CONTEXT_COMMAND",
      "ELEVATED_COMMAND",
      "HELP_COMMAND",
      "MODEL_COMMAND",
      "NEW_COMMAND",
      "QUEUE_COMMAND",
      "REASONING_COMMAND",
      "RESET_COMMAND",
      "STATUS_COMMAND",
      "THINK_COMMAND",
      "TTS_COMMAND",
      "USAGE_COMMAND",
      "VERBOSE_COMMAND",
      "WHOAMI_COMMAND",
    ],
    reason:
      "Slash-command actions are dispatched by the command palette rather than the scenario action-planner pipeline.",
  },
]);

/**
 * Plugins whose remaining action surface needs live credentials, a real
 * browser, or a local model. Documented for honesty; the keyless mock LLM
 * cannot stand in for these without faking the integration. Note that browser
 * (web/JSDOM mode) and lifeops (scheduled tasks) ARE partially keyless-covered
 * — as discovered from loaded scenarios — so each reason describes only the
 * remainder.
 */
const LIVE_ONLY_REMAINDER: Record<string, string> = {
  "@elizaos/plugin-personal-assistant":
    "Beyond SCHEDULED_TASKS, actions need live connector creds (Gmail, calendar, messaging, owner data).",
  "@elizaos/plugin-browser":
    "Beyond web/JSDOM mode, actions need a real Chromium session or browser bridge.",
  "@elizaos/plugin-agent-orchestrator":
    "TASKS (+ TASKS_* virtuals) spawns and drives ACP coding sub-agents over PTY; the keyless mock cannot stand in for real sub-agent processes. Unit-covered in plugins/plugin-agent-orchestrator/__tests__.",
};

/**
 * Source-derived umbrella-action surface for the three booted plugins that the
 * gate deliberately does NOT live-import (their full surface is large, platform-
 * gated, and credential-heavy — see LIVE_ONLY_REMAINDER). Live import is the
 * wrong tool here: google needs OAuth, lifeops promotes a platform-dependent set
 * (`OWNER_SCREENTIME` only exists on darwin) and pulls `messagingTriageActions`
 * in from @elizaos/core, and browser needs a real Chromium/JSDOM stack.
 *
 * Without this manifest, adding a NEW action to one of these plugins would slip
 * through silently — it is neither live-imported (so CORE_ACTION_SURFACE can't
 * catch it) nor source-enumerated. This closes that gap by pinning the umbrella
 * action names each plugin declares in its own source. It is a drift-
 * acknowledgment surface, NOT a keyless-coverage mandate: a new umbrella forces
 * the author to classify it (add a real keyless scenario, or extend the
 * LIVE_ONLY_REMAINDER justification) — it does not demand a fake scenario.
 *
 * Each umbrella's promoted virtuals (`BROWSER_CLICK`, `BLOCK_LIST_ACTIVE`, ...)
 * are intentionally out of scope: their names are derived at runtime by
 * `promoteSubactionsToActions` from a discriminator enum, so enumerating them
 * from source would mean re-implementing that transform here. The umbrella set
 * is the right-sized signal — a brand-new action is always a new umbrella
 * (`const ACTION_NAME = "X"` or a top-level `name: "X"`), which this catches.
 *
 * `files` lists exactly the action sources each plugin wires into its `actions`
 * array (verified against each plugin's entry). `actions` is the umbrella-name
 * set those files declare. Google wires `actions: []`, so its set is empty and
 * the empty-array literal is asserted to stay put.
 */
const BOOTED_PLUGIN_ACTION_SURFACE: Record<
  string,
  { files: readonly string[]; actions: readonly string[] }
> = {
  "@elizaos/plugin-google": {
    files: ["plugins/plugin-google/src/index.ts"],
    actions: [],
  },
  "@elizaos/plugin-browser": {
    files: [
      "plugins/plugin-browser/src/actions/browser.ts",
      "plugins/plugin-browser/src/actions/manage-browser-bridge.ts",
    ],
    actions: ["BROWSER", "MANAGE_BROWSER_BRIDGE"],
  },
  "@elizaos/plugin-personal-assistant": {
    files: [
      "plugins/plugin-personal-assistant/src/actions/block.ts",
      "plugins/plugin-personal-assistant/src/actions/brief.ts",
      "plugins/plugin-personal-assistant/src/actions/calendar.ts",
      "plugins/plugin-personal-assistant/src/actions/conflict-detect.ts",
      "plugins/plugin-personal-assistant/src/actions/connector.ts",
      "plugins/plugin-personal-assistant/src/actions/credentials.ts",
      "plugins/plugin-personal-assistant/src/actions/document.ts",
      "plugins/plugin-personal-assistant/src/actions/entity.ts",
      "plugins/plugin-personal-assistant/src/actions/owner-surfaces.ts",
      "plugins/plugin-personal-assistant/src/actions/prioritize.ts",
      "plugins/plugin-personal-assistant/src/actions/resolve-request.ts",
      "plugins/plugin-personal-assistant/src/actions/scheduled-task.ts",
      "plugins/plugin-personal-assistant/src/actions/voice-call.ts",
      "plugins/plugin-personal-assistant/src/actions/work-thread.ts",
    ],
    actions: [
      "BLOCK",
      "BRIEF",
      "CALENDAR",
      "CONFLICT_DETECT",
      "CONNECTOR",
      "CREDENTIALS",
      "ENTITY",
      "OWNER_ALARMS",
      "OWNER_DOCUMENTS",
      "OWNER_FINANCES",
      "OWNER_GOALS",
      "OWNER_REMINDERS",
      "OWNER_ROUTINES",
      "OWNER_TODOS",
      "PERSONAL_ASSISTANT",
      "PRIORITIZE",
      "RESOLVE_REQUEST",
      "SCHEDULED_TASKS",
      "VOICE_CALL",
      "WORK_THREAD",
    ],
  },
};

type AppControlActionName = "APP" | "VIEWS";

/**
 * APP/VIEWS are intentionally unified actions, so top-level action-name
 * coverage is too coarse. This live-schema manifest fails when app-control
 * adds or removes a supported action mode.
 */
const APP_CONTROL_MODE_SURFACE: Record<
  AppControlActionName,
  readonly string[]
> = {
  APP: ["create", "launch", "list", "load_from_directory", "relaunch"],
  VIEWS: [
    "broadcast",
    "close",
    "create",
    "current",
    "delete",
    "edit",
    "icon",
    "interact",
    "list",
    "manager",
    "open",
    "pin",
    "remove",
    "rollback",
    "search",
    "show",
    "split",
    "tile",
    "window",
  ],
};

/**
 * Remaining APP/VIEWS modes without direct deterministic action turns. The
 * live schema, loaded turns, and these reasons form an exhaustive partition;
 * an exemption fails as soon as the mode disappears or gains real coverage.
 */
const APP_CONTROL_MODE_EXEMPTIONS = buildReasonedExemptions([
  {
    names: ["VIEWS:rollback"],
    reason:
      "Rollback has no deterministic persisted-view revision fixture with an asserted restore outcome.",
  },
]);

const REQUIRED_APP_CONTROL_MODE_TURNS: readonly {
  actionName: AppControlActionName;
  mode: string;
  label: string;
  requiredOptions?: Record<string, (value: unknown) => boolean>;
}[] = [
  {
    actionName: "APP",
    mode: "list",
    label: "APP list installed/running apps",
  },
  {
    actionName: "APP",
    mode: "launch",
    label: "APP launch",
    requiredOptions: { app: isNonEmptyString },
  },
  {
    actionName: "APP",
    mode: "relaunch",
    label: "APP relaunch",
    requiredOptions: { app: isNonEmptyString },
  },
  {
    actionName: "APP",
    mode: "load_from_directory",
    label: "APP load_from_directory",
    requiredOptions: { directory: isNonEmptyString },
  },
  {
    actionName: "APP",
    mode: "create",
    label: "APP create/edit existing app",
    requiredOptions: {
      editTarget: isNonEmptyString,
      intent: isNonEmptyString,
    },
  },
  {
    actionName: "VIEWS",
    mode: "list",
    label: "VIEWS list",
  },
  {
    actionName: "VIEWS",
    mode: "search",
    label: "VIEWS search",
    requiredOptions: { query: isNonEmptyString },
  },
  {
    actionName: "VIEWS",
    mode: "show",
    label: "VIEWS show",
    requiredOptions: { view: isNonEmptyString },
  },
  {
    actionName: "VIEWS",
    mode: "open",
    label: "VIEWS open alias",
    requiredOptions: { view: isNonEmptyString },
  },
  {
    actionName: "VIEWS",
    mode: "current",
    label: "VIEWS current view",
  },
  {
    actionName: "VIEWS",
    mode: "manager",
    label: "VIEWS manager",
  },
  {
    actionName: "VIEWS",
    mode: "broadcast",
    label: "VIEWS broadcast event",
    requiredOptions: { eventType: isNonEmptyString },
  },
  {
    actionName: "VIEWS",
    mode: "interact",
    label: "VIEWS mounted-view interact",
    requiredOptions: {
      capability: isNonEmptyString,
      view: isNonEmptyString,
    },
  },
  {
    actionName: "VIEWS",
    mode: "pin",
    label: "VIEWS pin desktop tab",
    requiredOptions: { view: isNonEmptyString },
  },
  {
    actionName: "VIEWS",
    mode: "window",
    label: "VIEWS detached window",
    requiredOptions: { view: isNonEmptyString },
  },
  {
    actionName: "VIEWS",
    mode: "create",
    label: "VIEWS create-mode edit existing view",
    requiredOptions: {
      editTarget: isNonEmptyString,
      intent: isNonEmptyString,
    },
  },
  {
    actionName: "VIEWS",
    mode: "edit",
    label: "VIEWS direct edit",
    requiredOptions: {
      intent: isNonEmptyString,
      view: isNonEmptyString,
    },
  },
  {
    actionName: "VIEWS",
    mode: "delete",
    label: "VIEWS confirmed delete",
    requiredOptions: {
      confirm: (value) => value === "true" || value === "yes",
      view: isNonEmptyString,
    },
  },
  {
    actionName: "VIEWS",
    mode: "remove",
    label: "VIEWS remove alias",
    requiredOptions: {
      confirm: (value) => value === "true" || value === "yes",
      view: isNonEmptyString,
    },
  },
];

const REQUIRED_APP_CONTROL_NL_TURNS: readonly string[] = [
  "natural language opens a view",
  "natural language searches views",
  "natural language launches an app",
  "natural language relaunches an app",
  "natural language loads apps from directory",
  "natural language enters app create choice flow",
  "natural language cancels pending app create flow",
  "natural language edits a view",
  "natural language edits an app",
  "natural language deletes a view with explicit confirmation",
];

/**
 * Scenarios exercised through real message turns using the strict deterministic
 * LLM proxy. Their action union is derived below; most other deterministic
 * coverage uses direct handler turns and must not be reported as NL routing.
 */
const STRICT_LLM_ROUTING_SCENARIO_IDS = [
  "deterministic-app-control-nl-routing",
  "deterministic-active-view-agent-surface",
  // live-only lane, but it pins ACTION_PLANNER fixtures for its VIEWS turn, so
  // it satisfies the strict fixture contract and is classified here rather
  // than the no-deterministic-fixture bucket.
  "live-active-view-agent-surface",
  "deterministic-agent-skills-actions",
  "deterministic-browser-actions",
  "deterministic-coding-tools-actions",
  "deterministic-github-actions-routes",
  "deterministic-gitpathology-actions",
  "deterministic-media-actions",
  "deterministic-lifeops-multiday-journey",
  "deterministic-lifeops-scheduled-tasks",
  "deterministic-mcp-actions-routes",
  "deterministic-streaming-actions",
  "deterministic-todos-actions",
  "deterministic-workflow-actions-routes",
] as const;

const PROSE_ONLY_LLM_SCENARIOS: Record<string, string> = {
  "deterministic-pr-smoke":
    "single TEXT_SMALL deterministic reply smoke; it does not route an action",
  "deterministic-inbound-attachment-actions":
    "inbound attachment flows through the pipeline to a deterministic reply; it does not route an action (the read tool is core ATTACHMENT, unit-tested in core)",
  "live-inbound-attachment":
    "live-lane real-LLM counterpart of deterministic-inbound-attachment-actions; the model reads the attachment and replies in prose, routing no action",
  "cloud-apps-read-core":
    "live-only real-LLM trajectory exercising LIST_CLOUD_APPS against the real Cloud API (#10277); it routes via the live model, NOT a deterministic ACTION_PLANNER fixture, so it cannot satisfy STRICT_LLM_ROUTING's fixture contract and is classified here (the no-deterministic-fixture bucket). Its gating proof is the keyless bun:test suite in plugins/plugin-cloud-apps/__tests__.",
  "background-live":
    "live-only real-LLM counterpart of deterministic-background-actions (#10694); a real model routes set/undo/redo/reset to BACKGROUND from natural phrasing, NOT a deterministic ACTION_PLANNER fixture, so it cannot satisfy STRICT_LLM_ROUTING's fixture contract and is classified here (the no-deterministic-fixture bucket). Its keyless gating proof is deterministic-background-actions in the pr-deterministic lane.",
  "live-background-actions":
    "live-only real-LLM counterpart of deterministic-background-actions (#10694); the live model routes BACKGROUND (color set, GLSL preset, undo) with no deterministic ACTION_PLANNER fixture, so it cannot satisfy STRICT_LLM_ROUTING's fixture contract. The deterministic twin pins the exact payload ledger on the keyless lane.",
  "live-chat-widgets-choice-roundtrip":
    "live-only real-LLM chat-widget choice roundtrip; widget emission/interaction is judged from the live reply with no deterministic ACTION_PLANNER fixture. Keyless gating proof: the chat-widget unit + fixture e2e suites in packages/ui.",
  "live-chat-widgets-config-emission":
    "live-only real-LLM chat-widget config emission; prose+widget reply, routes no deterministic fixture action. Keyless gating proof: the chat-widget unit + fixture e2e suites in packages/ui.",
  "live-chat-widgets-followups-restraint":
    "live-only real-LLM followups-restraint check; asserts the live reply withholds widgets, routing no action. Keyless gating proof: the chat-widget unit + fixture e2e suites in packages/ui.",
  "live-chat-widgets-form-roundtrip":
    "live-only real-LLM chat-widget form roundtrip; widget emission/interaction is judged from the live reply with no deterministic ACTION_PLANNER fixture. Keyless gating proof: the chat-widget unit + fixture e2e suites in packages/ui.",
  "live-document-delete":
    "live-only real-LLM counterpart of deterministic-document-actions (#16942); the live model routes DOCUMENT list/delete (owner wall included) with no deterministic ACTION_PLANNER fixture, so it cannot satisfy STRICT_LLM_ROUTING's fixture contract. The deterministic twin pins the delete payload contract on the keyless lane.",
  "live-experience-delete-by-topic":
    "live-only real-LLM EXPERIENCE deletion flow; the live model routes EXPERIENCE with no deterministic ACTION_PLANNER fixture, so it cannot satisfy STRICT_LLM_ROUTING's fixture contract. Keyless gating proof: the experience service unit suites.",
  "live-help-knowledge":
    "live-only real-LLM help-knowledge lane (#14360); the model answers from bundled help documents in prose, routing no action.",
  "live-lifeops-task-filter-due-window":
    "live-only real-LLM counterpart of the deterministic lifeops scheduled-task lanes; the live model routes SCHEDULED_TASKS with no deterministic ACTION_PLANNER fixture. The deterministic twins gate the keyless lane.",
  "live-missing-input-terminal-relay":
    "live-only real-LLM missing-input planner-loop regression; the live model routes OWNER_REMINDERS without a deterministic ACTION_PLANNER fixture, while the keyless planner-loop suite forces the erroneous evaluator-CONTINUE branch.",
  "live-plugin-enable-toggle-verb":
    "live-only real-LLM plugin enable/toggle verb routing; no deterministic ACTION_PLANNER fixture. Keyless gating proof: plugin-manager action unit suites in core.",
  "live-workflow-action-executions":
    "live-only real-LLM counterpart of deterministic-workflow-actions-routes; the live model routes WORKFLOW with no deterministic ACTION_PLANNER fixture. The deterministic twin gates the keyless lane.",
};

/**
 * Loaded-scenario actions intentionally covered only by direct action turns.
 * The gate derives the real direct-only set and rejects exemptions that are
 * unknown, empty, or stale after natural-language routing coverage lands.
 */
const DIRECT_ONLY_ACTION_EXEMPTIONS = buildReasonedExemptions([
  {
    names: ["BACKGROUND"],
    reason:
      "The keyless scenario asserts background state transitions through direct action turns; natural-language routing is exercised in the credentialed live twin.",
  },
  {
    names: ["DOCUMENT"],
    reason:
      "The keyless scenario asserts document CRUD and ownership outcomes through direct action turns; the live twin owns model routing.",
  },
  {
    names: ["SETTINGS"],
    reason:
      "Settings voice mutations are asserted directly because the deterministic lane does not boot the dashboard routing context.",
  },
  {
    names: ["BROWSER", "COMPUTER_USE", "COMPUTER_USE_AGENT"],
    reason:
      "The progress-stream scenario invokes these actions directly so it can assert callback ordering, approval payloads, and fake-device effects without conflating those contracts with planner selection.",
  },
  {
    names: ["BROWSER_NAVIGATE", "BROWSER_WAIT_FOR_URL"],
    reason:
      "The browser catalog drives its stateful OAuth polling and restoration steps directly; the remaining browser verbs have strict planner fixtures in the same deterministic scenario.",
  },
  {
    names: ["MULTI_DISPLAY_ROUTE", "CUA_VISION_LOOP"],
    reason:
      "These scenario-local harness actions expose coordinate-routing and vision-cache internals that are not agent-facing planner actions.",
  },
  {
    names: ["VISION", "WINDOW"],
    reason:
      "The deterministic OCR and computer-use parity scenarios call these device-boundary actions directly to assert normalized native results.",
  },
]);

function collectActionNames(plugin: Plugin): string[] {
  return sorted(
    (plugin.actions ?? [])
      .map((action) => action?.name)
      .filter((name): name is string => typeof name === "string"),
  );
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function buildReasonedExemptions(
  groups: readonly { names: readonly string[]; reason: string }[],
): Readonly<Record<string, string>> {
  const exemptions: Record<string, string> = {};
  for (const group of groups) {
    for (const name of group.names) {
      if (name in exemptions) {
        throw new Error(`duplicate coverage exemption: ${name}`);
      }
      exemptions[name] = group.reason;
    }
  }
  return exemptions;
}

function assertedScenarioActionClaims(
  scenario: Pick<ScenarioDefinition, "turns" | "finalChecks">,
): string[] {
  const names = new Set<string>();
  for (const turn of scenario.turns) {
    if (turn.kind !== "message" || typeof turn.assertTurn !== "function") {
      continue;
    }
    collectActionNameValue(turn.expectedActions, names);
  }
  for (const check of scenario.finalChecks ?? []) {
    if (
      check.type !== "actionCalled" &&
      check.type !== "selectedAction" &&
      check.type !== "selectedActionArguments"
    ) {
      continue;
    }
    collectActionNameValue(
      (check as ScenarioFinalCheck & { actionName?: unknown }).actionName,
      names,
    );
  }
  return sorted(names);
}

function messageExpectedActionClaims(
  scenario: Pick<ScenarioDefinition, "turns">,
): string[] {
  const names = new Set<string>();
  for (const turn of scenario.turns) {
    if (turn.kind !== "message" || typeof turn.assertTurn !== "function") {
      continue;
    }
    collectActionNameValue(turn.expectedActions, names);
  }
  return sorted(names);
}

function directActionClaims(
  scenario: Pick<ScenarioDefinition, "turns">,
): string[] {
  const names = new Set<string>();
  for (const turn of scenario.turns) {
    if (turn.kind !== "action") continue;
    collectActionNameValue(
      (turn as { actionName?: unknown }).actionName,
      names,
    );
  }
  return sorted(names);
}

function sourcePropertyName(
  property: ts.ObjectLiteralElementLike,
): string | null {
  if (
    !ts.isPropertyAssignment(property) &&
    !ts.isShorthandPropertyAssignment(property) &&
    !ts.isMethodDeclaration(property)
  ) {
    return null;
  }
  return ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
    ? property.name.text
    : null;
}

function collectUppercaseStringLiterals(
  node: ts.Node | undefined,
  names: Set<string>,
): void {
  if (!node) return;
  if (ts.isStringLiteralLike(node)) {
    if (/^[A-Z][A-Z0-9_]*$/.test(node.text)) names.add(node.text);
    return;
  }
  if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) {
      collectUppercaseStringLiterals(element, names);
    }
  }
}

/**
 * Reads executable strict-route declarations and ACTION_PLANNER fixtures.
 * Assertion objects are deliberately excluded: a finalCheck can claim what a
 * scenario expects, but only a registered route/planner fixture can satisfy
 * the deterministic model-routing half of the contract.
 */
function plannerFixtureActionNames(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    "scenario.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const names = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const properties = new Map(
        node.properties.map((property) => [
          sourcePropertyName(property),
          property,
        ]),
      );
      const actionProperty = properties.get("actionName");
      const isStrictRoute =
        actionProperty !== undefined &&
        properties.has("args") &&
        properties.has("input") &&
        properties.has("messageToUser");
      if (isStrictRoute && ts.isPropertyAssignment(actionProperty)) {
        collectUppercaseStringLiterals(actionProperty.initializer, names);
      }

      if (node.getText(sourceFile).includes("ModelType.ACTION_PLANNER")) {
        const collectPlannerNames = (descendant: ts.Node): void => {
          if (ts.isPropertyAssignment(descendant)) {
            const name = sourcePropertyName(descendant);
            if (
              name === "actionName" ||
              name === "toolName" ||
              name === "name"
            ) {
              collectUppercaseStringLiterals(descendant.initializer, names);
            }
          }
          ts.forEachChild(descendant, collectPlannerNames);
        };
        collectPlannerNames(node);
      }
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "plannerFixture"
    ) {
      for (const argument of node.arguments) {
        collectUppercaseStringLiterals(argument, names);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sorted(names);
}

function strictRoutingScenarioProblems(args: {
  id: string;
  scenario: Pick<ScenarioDefinition, "turns" | "finalChecks">;
  source: string;
  fixtureInfrastructureSource: string;
}): string[] {
  const problems: string[] = [];
  const assertedMessageTurns = args.scenario.turns.filter(
    (turn) => turn.kind === "message" && typeof turn.assertTurn === "function",
  );
  if (assertedMessageTurns.length === 0) {
    problems.push(
      `${args.id}: no message turn has an assertTurn outcome check`,
    );
  }

  const fixtureSource = `${args.source}\n${args.fixtureInfrastructureSource}`;
  if (!/scenarioLlmFixtures\?\.register\(/.test(fixtureSource)) {
    problems.push(`${args.id}: no scenarioLlmFixtures.register call`);
  }
  if (!fixtureSource.includes("ModelType.RESPONSE_HANDLER")) {
    problems.push(`${args.id}: no RESPONSE_HANDLER fixture`);
  }
  if (!fixtureSource.includes("ModelType.ACTION_PLANNER")) {
    problems.push(`${args.id}: no ACTION_PLANNER fixture`);
  }

  const assertedClaims = assertedScenarioActionClaims(args.scenario);
  if (assertedClaims.length === 0) {
    problems.push(
      `${args.id}: asserted turns/finalChecks claim no routed action`,
    );
  }
  const plannerActions = new Set(plannerFixtureActionNames(args.source));
  const directActions = new Set(directActionClaims(args.scenario));
  const messageClaims = new Set(messageExpectedActionClaims(args.scenario));
  for (const actionName of assertedClaims) {
    if (
      !plannerActions.has(actionName) &&
      (!directActions.has(actionName) || messageClaims.has(actionName))
    ) {
      problems.push(
        `${args.id}: executable route/planner fixtures do not declare routed action ${actionName}`,
      );
    }
  }
  return problems;
}

async function strictDeterministicLlmRoutedActions(): Promise<string[]> {
  const deterministicIds = new Set(ciScenarioList());
  const loaded = await loadDeterministicScenarios();
  return sorted(
    STRICT_LLM_ROUTING_SCENARIO_IDS.flatMap((id) =>
      deterministicIds.has(id)
        ? assertedScenarioActionClaims(
            loaded.find((entry) => entry.scenario.id === id)?.scenario ?? {
              turns: [],
            },
          ).filter((name) =>
            new Set(
              plannerFixtureActionNames(scenarioSourceById(id) ?? ""),
            ).has(name),
          )
        : [],
    ),
  );
}

/**
 * Derives the umbrella action names a plugin declares from source, reading the
 * exact files it wires into its `actions` array. Matches the two forms these
 * plugins use to name an action: a `const ACTION_NAME = "X"` constant and a
 * top-level `name: "X"` literal. Action/umbrella names are UPPER_SNAKE, so the
 * UPPER-only match skips lowercase parameter names (`name: "action"`) and
 * `{{templated}}` example names without enumerating the promoted virtuals.
 */
function umbrellaActionNamesFromSource(files: readonly string[]): string[] {
  const names = new Set<string>();
  for (const relPath of files) {
    const source = readFileSync(resolve(repoRoot, relPath), "utf8");
    for (const match of source.matchAll(
      /const\s+ACTION_NAME\s*=\s*"([A-Z][A-Z0-9_]*)"/g,
    )) {
      names.add(match[1]);
    }
    for (const match of source.matchAll(/\bname:\s*"([A-Z][A-Z0-9_]*)"/g)) {
      names.add(match[1]);
    }
  }
  return sorted(names);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function actionOptions(turn: ScenarioTurn): Record<string, unknown> {
  const options = toRecord(turn.options);
  const parameters = toRecord(options.parameters);
  return Object.keys(parameters).length > 0 ? parameters : options;
}

function readActionMode(turn: ScenarioTurn): string | null {
  const options = actionOptions(turn);
  const mode = options.action ?? options.mode;
  return isNonEmptyString(mode) ? mode.trim() : null;
}

function hasRequiredOptions(
  options: Record<string, unknown>,
  requirements: Record<string, (value: unknown) => boolean> | undefined,
): boolean {
  if (!requirements) return true;
  return Object.entries(requirements).every(([key, check]) =>
    check(options[key]),
  );
}

function appControlActionModes(actionName: AppControlActionName): string[] {
  const plugin = IMPORTED_CORE_PLUGINS["@elizaos/plugin-app-control"];
  const action = (plugin.actions ?? []).find(
    (candidate) => candidate.name === actionName,
  );
  const parameterWithEnum = (action?.parameters ?? []).find((param) => {
    if (param.name !== "action" && param.name !== "mode") return false;
    const schema = (param as { schema?: { enum?: unknown } }).schema;
    return Array.isArray(schema?.enum);
  }) as { schema?: { enum?: unknown } } | undefined;
  const modes = parameterWithEnum?.schema?.enum;
  const importedModes = Array.isArray(modes)
    ? modes.filter((mode): mode is string => typeof mode === "string")
    : [];
  const sourceModes =
    actionName === "VIEWS" ? appControlViewsModesFromSource() : [];
  return sorted([...importedModes, ...sourceModes]);
}

function appControlViewsModesFromSource(): string[] {
  const source = readFileSync(
    resolve(repoRoot, "plugins/plugin-app-control/src/actions/views.ts"),
    "utf8",
  );
  const modesMatch = source.match(
    /const\s+MODES:\s*readonly\s+ViewsMode\[\]\s*=\s*\[([\s\S]*?)\]\s+as\s+const;/,
  );
  if (!modesMatch?.[1]) return [];
  return sorted(
    [...modesMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]),
  );
}

async function scenarioActionModeTurns(): Promise<
  Array<{
    actionName: AppControlActionName;
    assertTurn: unknown;
    mode: string;
    options: Record<string, unknown>;
    scenarioId: string;
    turnName: string;
  }>
> {
  const turns: Array<{
    actionName: AppControlActionName;
    assertTurn: unknown;
    mode: string;
    options: Record<string, unknown>;
    scenarioId: string;
    turnName: string;
  }> = [];
  for (const { scenario } of await loadDeterministicScenarios()) {
    for (const turn of scenario.turns) {
      if (turn.kind !== "action") continue;
      const rawActionName = (turn as { actionName?: unknown }).actionName;
      if (rawActionName !== "APP" && rawActionName !== "VIEWS") continue;
      const actionName: AppControlActionName = rawActionName;
      const mode = readActionMode(turn);
      if (!mode) continue;
      turns.push({
        actionName,
        assertTurn: turn.assertTurn,
        mode,
        options: actionOptions(turn),
        scenarioId: scenario.id,
        turnName: turn.name,
      });
    }
  }
  return turns;
}

async function appControlNaturalLanguageTurnNames(): Promise<string[]> {
  const loaded = await loadDeterministicScenarios();
  const scenario = loaded.find(
    (entry) => entry.scenario.id === "deterministic-app-control-nl-routing",
  )?.scenario;
  if (!scenario) return [];
  return scenario.turns
    .filter(
      (turn) =>
        turn.kind === "message" && typeof turn.assertTurn === "function",
    )
    .map((turn) => turn.name);
}

function actionModeKey(actionName: AppControlActionName, mode: string): string {
  return `${actionName}:${mode}`;
}

function scenarioFiles(): string[] {
  return readdirSync(scenarioDir).filter((file) =>
    file.endsWith(".scenario.ts"),
  );
}

function collectActionNameValue(value: unknown, names: Set<string>): void {
  if (typeof value === "string") {
    names.add(value);
    return;
  }
  if (!Array.isArray(value)) return;
  for (const entry of value) {
    if (typeof entry === "string") names.add(entry);
  }
}

async function directScenarioActionNames(): Promise<string[]> {
  const names = new Set<string>();
  for (const { scenario } of await loadDeterministicScenarios()) {
    for (const turn of scenario.turns) {
      if (turn.kind !== "action") continue;
      collectActionNameValue(
        (turn as { actionName?: unknown }).actionName,
        names,
      );
    }
  }
  return sorted(names);
}

function loadDeterministicScenarios() {
  return loadAllScenarios(
    scenarioDir,
    undefined,
    undefined,
    false,
    "pr-deterministic",
  );
}

function declaredScenarioId(file: string): string | null {
  const source = readFileSync(resolve(scenarioDir, file), "utf8");
  return (
    source.match(/export\s+default\s+scenario\(\{\s*id:\s*"([^"]+)"/s)?.[1] ??
    null
  );
}

function scenarioSourceById(id: string): string | null {
  for (const file of scenarioFiles()) {
    const base = file.replace(/\.scenario\.ts$/, "");
    const declared = declaredScenarioId(file);
    if (declared === id || base === id) {
      return readFileSync(resolve(scenarioDir, file), "utf8");
    }
  }
  return null;
}

async function loadedScenarioById(id: string): Promise<{
  turns: readonly ScenarioTurn[];
  finalChecks?: ScenarioFinalCheck[];
} | null> {
  const loaded = await loadAllScenarios(scenarioDir);
  return loaded.find((entry) => entry.scenario.id === id)?.scenario ?? null;
}

function messageTurnCount(scenario: {
  turns: readonly ScenarioTurn[];
}): number {
  return scenario.turns.filter((turn) => turn.kind === "message").length;
}

async function messageScenarioIds(): Promise<string[]> {
  const loaded = await loadAllScenarios(scenarioDir);
  return sorted(
    loaded
      .filter(({ scenario }) => messageTurnCount(scenario) > 0)
      .map(({ scenario }) => scenario.id),
  );
}

// The deterministic CI run now selects by lane (`--lane pr-deterministic`)
// instead of a hand-maintained id list, so the "wired" set is every scenario
// file tagged `lane: "pr-deterministic"`.
function ciScenarioList(): string[] {
  return scenarioFiles()
    .filter((file) =>
      /lane:\s*["']pr-deterministic["']/.test(
        readFileSync(resolve(scenarioDir, file), "utf8"),
      ),
    )
    .map((file) => file.replace(/\.scenario\.ts$/, ""));
}

describe("deterministic action coverage", () => {
  it("stable-core plugin action surface matches the manifest (no drift, new actions caught)", () => {
    const drift: string[] = [];
    for (const [spec, plugin] of Object.entries(IMPORTED_CORE_PLUGINS)) {
      const sourceVerified = new Set(
        SOURCE_VERIFIED_IMPORTED_ACTIONS[spec] ?? [],
      );
      const actual = collectActionNames(plugin).filter(
        (name) => !sourceVerified.has(name),
      );
      const want = sorted(CORE_ACTION_SURFACE[spec] ?? []);
      if (JSON.stringify(actual) !== JSON.stringify(want)) {
        drift.push(
          `${spec}: real actions [${actual.join(", ")}] != manifest [${want.join(", ")}] — update CORE_ACTION_SURFACE or SOURCE_VERIFIED_IMPORTED_ACTIONS and classify any new action`,
        );
      }
    }
    expect(drift, drift.join("\n")).toEqual([]);
  });

  it("service/registry core plugins expose no agent actions", () => {
    const unexpected: string[] = [];
    for (const [spec, plugin] of Object.entries(ACTIONLESS_CORE_PLUGINS)) {
      const actions = collectActionNames(plugin);
      if (actions.length > 0) {
        unexpected.push(`${spec}: now exposes [${actions.join(", ")}]`);
      }
    }
    expect(unexpected, unexpected.join("\n")).toEqual([]);
  });

  it("source-only plugin actions are present in source", () => {
    const missing: string[] = [];
    for (const [relPath, actions] of Object.entries(SOURCE_ONLY_ACTIONS)) {
      const source = readFileSync(resolve(repoRoot, relPath), "utf8");
      for (const action of actions) {
        if (
          !source.includes(`name: "${action}"`) &&
          !source.includes(`"${action}"`)
        ) {
          missing.push(`${relPath}:${action}`);
        }
      }
    }
    expect(missing, missing.join("\n")).toEqual([]);
  });

  it("booted-plugin umbrella action surface matches the manifest (new actions caught from source)", () => {
    const drift: string[] = [];
    for (const [spec, { files, actions }] of Object.entries(
      BOOTED_PLUGIN_ACTION_SURFACE,
    )) {
      const actual = umbrellaActionNamesFromSource(files);
      const want = sorted(actions);
      if (JSON.stringify(actual) !== JSON.stringify(want)) {
        drift.push(
          `${spec}: source umbrellas [${actual.join(", ") || "(none)"}] != manifest [${want.join(", ") || "(none)"}]\n` +
            `    A new/renamed/removed action in ${spec} must be classified: add a real keyless scenario, ` +
            `or extend its LIVE_ONLY_REMAINDER justification — then update BOOTED_PLUGIN_ACTION_SURFACE to match.`,
        );
      }
    }
    // Google wires `actions: []`; assert the empty-array literal stays so the
    // empty manifest above can't be silently bypassed by wiring an action.
    const googleSource = readFileSync(
      resolve(repoRoot, "plugins/plugin-google/src/index.ts"),
      "utf8",
    );
    if (!/actions:\s*\[\s*\]/.test(googleSource)) {
      drift.push(
        "@elizaos/plugin-google: index.ts no longer declares `actions: []` — " +
          "it now wires an action surface that must be classified and added to BOOTED_PLUGIN_ACTION_SURFACE.",
      );
    }
    expect(drift, drift.join("\n")).toEqual([]);
  });

  it("app-control APP/VIEWS mode surface matches the live action schemas", () => {
    const drift: string[] = [];
    for (const [actionName, expectedModes] of Object.entries(
      APP_CONTROL_MODE_SURFACE,
    ) as Array<[AppControlActionName, readonly string[]]>) {
      const actual = appControlActionModes(actionName);
      const expected = sorted(expectedModes);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        drift.push(
          `${actionName}: real modes [${actual.join(", ")}] != manifest [${expected.join(", ")}]`,
        );
      }
    }
    expect(drift, drift.join("\n")).toEqual([]);
  });

  it("app-control APP/VIEWS mode coverage is loaded from real scenario turns", async () => {
    const turns = await scenarioActionModeTurns();
    const covered = new Set(
      turns.map((turn) => actionModeKey(turn.actionName, turn.mode)),
    );
    const liveModes = new Set(
      Object.entries(APP_CONTROL_MODE_SURFACE).flatMap(([actionName, modes]) =>
        modes.map((mode) =>
          actionModeKey(actionName as AppControlActionName, mode),
        ),
      ),
    );
    const exemptions = new Set(Object.keys(APP_CONTROL_MODE_EXEMPTIONS));
    const unclassified = [...liveModes].filter(
      (key) => !covered.has(key) && !exemptions.has(key),
    );
    const staleExemptions = [...exemptions].filter(
      (key) => !liveModes.has(key) || covered.has(key),
    );
    const outOfSurfaceTurns = [...covered].filter((key) => !liveModes.has(key));
    const emptyReasons = Object.entries(APP_CONTROL_MODE_EXEMPTIONS)
      .filter(([, reason]) => reason.trim().length === 0)
      .map(([key]) => key);

    expect(
      unclassified,
      `live APP/VIEWS modes need a loaded scenario turn or a reasoned exemption: ${unclassified.join(", ")}`,
    ).toEqual([]);
    expect(
      staleExemptions,
      `remove APP/VIEWS exemptions that disappeared or gained coverage: ${staleExemptions.join(", ")}`,
    ).toEqual([]);
    expect(
      outOfSurfaceTurns,
      `scenario turns reference APP/VIEWS modes absent from the live schema: ${outOfSurfaceTurns.join(", ")}`,
    ).toEqual([]);
    expect(emptyReasons).toEqual([]);
  });

  it("critical APP/VIEWS management modes have asserted deterministic action turns", async () => {
    const turns = await scenarioActionModeTurns();
    const missing = REQUIRED_APP_CONTROL_MODE_TURNS.filter((requirement) => {
      return !turns.some(
        (turn) =>
          turn.actionName === requirement.actionName &&
          turn.mode === requirement.mode &&
          typeof turn.assertTurn === "function" &&
          hasRequiredOptions(turn.options, requirement.requiredOptions),
      );
    }).map(
      (requirement) =>
        `${requirement.label} (${actionModeKey(requirement.actionName, requirement.mode)})`,
    );

    expect(
      missing,
      `critical APP/VIEWS modes must be backed by real loaded scenario turns with assertTurn checks: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("critical APP/VIEWS modes have asserted strict natural-language routing turns", async () => {
    const names = new Set(await appControlNaturalLanguageTurnNames());
    const missing = REQUIRED_APP_CONTROL_NL_TURNS.filter(
      (name) => !names.has(name),
    );

    expect(
      missing,
      `strict natural-language APP/VIEWS routing turns are missing assertTurn checks: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every deterministic message scenario is classified as strict-routed or prose-only", async () => {
    const actual = await messageScenarioIds();
    const expected = sorted([
      ...STRICT_LLM_ROUTING_SCENARIO_IDS,
      ...Object.keys(PROSE_ONLY_LLM_SCENARIOS),
    ]);

    expect(
      actual,
      `message scenarios must be explicitly classified.\n` +
        `  actual:   ${actual.join(", ") || "(none)"}\n` +
        `  expected: ${expected.join(", ") || "(none)"}`,
    ).toEqual(expected);
  });

  it("strict LLM-routed scenarios declare planner/response fixtures for their routed actions", async () => {
    const problems: string[] = [];
    const fixtureInfrastructureSource = readFileSync(
      resolve(repoRoot, "packages/test/harness/action-route-fixtures.ts"),
      "utf8",
    );

    for (const id of STRICT_LLM_ROUTING_SCENARIO_IDS) {
      const scenario = await loadedScenarioById(id);
      const source = scenarioSourceById(id);

      if (!scenario) {
        problems.push(`${id}: scenario is not loadable`);
        continue;
      }
      if (!source) {
        problems.push(`${id}: source file was not found`);
        continue;
      }
      problems.push(
        ...strictRoutingScenarioProblems({
          id,
          scenario,
          source,
          fixtureInfrastructureSource,
        }),
      );
    }

    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("fails when an executable strict route disappears but assertions still claim it", async () => {
    const id = "deterministic-gitpathology-actions";
    const scenario = await loadedScenarioById(id);
    const source = scenarioSourceById(id);
    if (!scenario || !source) {
      throw new Error(`${id} fixture was not loadable`);
    }
    const mutated = source.replace(
      'actionName: "GIT_PATHOLOGY",',
      'actionName: "REMOVED_ROUTE_FIXTURE",',
    );
    expect(mutated).not.toBe(source);

    const problems = strictRoutingScenarioProblems({
      id,
      scenario,
      source: mutated,
      fixtureInfrastructureSource: readFileSync(
        resolve(repoRoot, "packages/test/harness/action-route-fixtures.ts"),
        "utf8",
      ),
    });

    expect(problems).toContain(
      `${id}: executable route/planner fixtures do not declare routed action GIT_PATHOLOGY`,
    );
  });

  it("prose-only deterministic message scenarios do not declare action planner fixtures", () => {
    const problems: string[] = [];

    for (const id of Object.keys(PROSE_ONLY_LLM_SCENARIOS)) {
      const source = scenarioSourceById(id);
      if (!source) {
        problems.push(`${id}: source file was not found`);
        continue;
      }
      if (source.includes("ModelType.ACTION_PLANNER")) {
        problems.push(
          `${id}: classified as prose-only but declares ACTION_PLANNER fixtures`,
        );
      }
    }

    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("source-derived action coverage is strict-routed or explicitly direct-only", async () => {
    const direct = new Set(await directScenarioActionNames());
    const strictActions = await strictDeterministicLlmRoutedActions();
    const strict = new Set(strictActions);
    const directOnly = sorted([...direct].filter((name) => !strict.has(name)));
    const exemptions = new Set(Object.keys(DIRECT_ONLY_ACTION_EXEMPTIONS));
    const unclassified = directOnly.filter((name) => !exemptions.has(name));
    const staleExemptions = [...exemptions].filter(
      (name) => !direct.has(name) || strict.has(name),
    );
    const emptyReasons = Object.entries(DIRECT_ONLY_ACTION_EXEMPTIONS)
      .filter(([, reason]) => reason.trim().length === 0)
      .map(([name]) => name);

    expect(
      unclassified,
      `loaded actions without strict routing need a reasoned direct-only exemption: ${unclassified.join(", ")}`,
    ).toEqual([]);
    expect(
      staleExemptions,
      `remove direct-only exemptions that disappeared or gained strict routing: ${staleExemptions.join(", ")}`,
    ).toEqual([]);
    expect(emptyReasons).toEqual([]);
  });

  it("stable-core keyless actions are covered or explicitly and currently exempt", async () => {
    const covered = new Set([
      ...(await directScenarioActionNames()),
      ...(await strictDeterministicLlmRoutedActions()),
    ]);
    const liveActions = new Set(stableCoreActions());
    const exemptions = new Set(Object.keys(STABLE_CORE_COVERAGE_EXEMPTIONS));
    const unclassified = [...liveActions].filter(
      (name) => !covered.has(name) && !exemptions.has(name),
    );
    const staleExemptions = [...exemptions].filter(
      (name) => !liveActions.has(name) || covered.has(name),
    );
    const emptyReasons = Object.entries(STABLE_CORE_COVERAGE_EXEMPTIONS)
      .filter(([, reason]) => reason.trim().length === 0)
      .map(([name]) => name);

    expect(
      unclassified,
      `stable-core actions need loaded scenario coverage or a reasoned exemption: ${unclassified.join(", ")}`,
    ).toEqual([]);
    expect(
      staleExemptions,
      `remove stable-core exemptions that disappeared or gained coverage: ${staleExemptions.join(", ")}`,
    ).toEqual([]);
    expect(emptyReasons).toEqual([]);
  });

  it("every scenario file is wired into the deterministic CI run and named after its id", () => {
    const wired = new Set(ciScenarioList());
    const problems: string[] = [];
    for (const file of scenarioFiles()) {
      const base = file.replace(/\.scenario\.ts$/, "");
      const id = declaredScenarioId(file);
      if (id !== base) {
        problems.push(
          `${file}: declared id ${JSON.stringify(id)} != filename base ${JSON.stringify(base)}`,
        );
      }
      // Live-only counterparts (e.g. a real-LLM twin of a deterministic
      // scenario) live alongside their deterministic siblings but run in the
      // credentialed live lane, not the keyless deterministic CI lane — so they
      // are exempt from the pr-deterministic wiring requirement.
      const isLiveOnly = /lane:\s*["']live-only["']/.test(
        readFileSync(resolve(scenarioDir, file), "utf8"),
      );
      if (!isLiveOnly && !wired.has(base)) {
        problems.push(
          `${file}: missing 'lane: "pr-deterministic"' — tag it or it never runs in the deterministic CI lane`,
        );
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("documents the live-only remainder without overlapping the keyless surface", () => {
    for (const reason of Object.values(LIVE_ONLY_REMAINDER)) {
      expect(reason.length).toBeGreaterThan(0);
    }
    const overlap = Object.keys(LIVE_ONLY_REMAINDER).filter(
      (spec) => spec in IMPORTED_CORE_PLUGINS,
    );
    expect(
      overlap,
      `plugin both keyless-imported and live-only: ${overlap.join(", ")}`,
    ).toEqual([]);
  });
});
