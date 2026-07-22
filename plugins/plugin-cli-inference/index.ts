/**
 * Sanctioned CLI/SDK model handlers for subscription-backed chat and planning.
 * The plugin is inert until ELIZA_CHAT_VIA_CLI selects a backend, registers only
 * configured text/planner tiers, isolates every SDK request, and confines ambient
 * or pooled authentication to a backend-specific subprocess environment.
 */

import { createHash } from "node:crypto";
import type { GenerateTextParams, IAgentRuntime, Plugin, ToolDefinition } from "@elizaos/core";
import {
  HANDLE_RESPONSE_TOOL_NAME,
  isTruthyEnvValue,
  logger,
  ModelType,
  parseBooleanValue,
} from "@elizaos/core";
import {
  type RotationSubprocessEnv,
  rotationEnabled,
  withAccountRotation,
} from "./src/account-rotation";
import { ClaudeCli } from "./src/claude-cli";
import {
  ClaudeSdkSession,
  type EnvelopeFieldSchemas,
  type SdkSessionMode,
} from "./src/claude-sdk-session";
import {
  appendTextDirective,
  buildCleanRoutingParams,
  buildEnvelopeBody,
  buildRouterBody,
  frameTextSystemPrompt,
  ROUTER_SYSTEM_PROMPT,
  STAGE1_ENVELOPE_SYSTEM_PROMPT,
} from "./src/clean-routing-planner";
import { CodexCli } from "./src/codex-cli-exec";
import { CodexSdkSession } from "./src/codex-sdk-session";
import { flattenPrompt } from "./src/prompt-flatten";

/** Large-tier free-text model types this plugin registers (when enabled). */
const LARGE_TIER_MODEL_TYPES: readonly string[] = [
  ModelType.TEXT_LARGE,
  ModelType.TEXT_MEGA,
  ModelType.RESPONSE_HANDLER,
];

/**
 * The planner. Registered ONLY in text-planner mode so the SAFE/CLI route can
 * run standalone. The free-text CLI can emit the XML `<actions>` block but cannot
 * honor GBNF/native-tool enforcement, so this REQUIRES `ELIZA_PLANNER_NATIVE_TOOLS=0`.
 */
const PLANNER_MODEL_TYPES: readonly string[] = [ModelType.ACTION_PLANNER];

/**
 * High-frequency triage tiers — the should-respond gate, media-description, and
 * the action-callback voice rewrite. NOT registered by default (they'd spend a
 * subscription call on every inbound message, including ignored ones); serving
 * them on the cheap configured provider bounds cost. Registered only in ALL-TIERS
 * mode for operators who want a single-brain, no-fallthrough deployment — where
 * leaving triage on a weak provider mangles action-result rewrites into
 * "couldn't format" placeholder text.
 */
const SMALL_TIER_MODEL_TYPES: readonly string[] = [
  ModelType.TEXT_SMALL,
  ModelType.TEXT_NANO,
  ModelType.TEXT_MEDIUM,
];

/** True when the runtime is set for the XML text planner the free-text CLI can serve. */
function textPlannerEnabled(): boolean {
  return readEnv("ELIZA_PLANNER_NATIVE_TOOLS")?.trim() === "0";
}

/**
 * ALL-TIERS mode: also serve the high-frequency triage tiers on this route so
 * the ENTIRE text brain (not just the heavy tiers) runs on the one Claude/Codex
 * subscription — no cerebras/gemma fallthrough. Opt-in because triage volume is
 * high; the triage model defaults to the cheaper large-tier model, not the
 * planner tier, so the should-respond gate doesn't run on opus.
 */
function allTiersEnabled(): boolean {
  return isTruthyEnvValue(readEnv("ELIZA_CLI_CLAUDE_ALL_TIERS"));
}

/**
 * Stage-1 ENVELOPE mode (claude-sdk only): serve RESPONSE_HANDLER through the
 * native `handle_response` MCP tool so the routing envelope is structurally
 * captured instead of prompt-begged from free text. Default ON — it is the
 * lane's parity fix with every other Stage-1 backend; ELIZA_CLI_CLAUDE_STAGE1_ENVELOPE=0
 * reverts to the plain text session (core's tolerant parse chain).
 */
function stage1EnvelopeEnabled(): boolean {
  return parseBooleanValue(readEnv("ELIZA_CLI_CLAUDE_STAGE1_ENVELOPE")) ?? true;
}

/**
 * Locate core's Stage-1 HANDLE_RESPONSE tool on a RESPONSE_HANDLER call. Core
 * attaches it (with toolChoice "required") to exactly the Stage-1 ROUTING
 * call, and to no other — the post-tool evaluator and the failure-reply
 * helper reuse the same model type WITHOUT the tool, and they expect plain
 * JSON/text, so they must stay on the text session (observed live: routing
 * the evaluator through envelope mode posted the raw envelope JSON to the
 * channel as the reply). The returned tool's composed parameter schema is the
 * authoritative per-turn envelope field set (core's field REGISTRY lets any
 * plugin add fields, and the set varies by channel shape).
 */
export function findHandleResponseTool(
  tools: GenerateTextParams["tools"]
): ToolDefinition | undefined {
  return (Array.isArray(tools) ? tools : []).find(
    (tool) => tool.name?.trim().toUpperCase() === HANDLE_RESPONSE_TOOL_NAME
  );
}

/** Declared field schemas from the composed HANDLE_RESPONSE tool parameters. */
function envelopeFieldSchemas(tool: ToolDefinition): EnvelopeFieldSchemas {
  const properties =
    (tool.parameters as { properties?: Record<string, { type?: string }> })?.properties ?? {};
  const fields: EnvelopeFieldSchemas = {};
  for (const [name, schema] of Object.entries(properties)) {
    fields[name] = { type: typeof schema?.type === "string" ? schema.type : undefined };
  }
  return fields;
}

// "claude"      → cold `claude --print` per call (TOS-clean, but ~5-15s/call).
// "claude-sdk"  → isolated Claude Agent SDK query (TOS-clean + sanctioned).
// "codex"       → cold `codex exec` per call (TOS-clean ChatGPT OAuth).
// "codex-sdk"   → isolated Codex SDK threads (TOS-clean ChatGPT OAuth); the
//                 codex peer of claude-sdk. ROUTE mode uses native outputSchema.
type CliBackend = "claude" | "claude-sdk" | "codex" | "codex-sdk";

function readEnv(name: string): string | undefined {
  if (typeof process === "undefined") return undefined;
  return process.env[name];
}

function getSetting(runtime: IAgentRuntime, key: string): string | undefined {
  const value = runtime.getSetting(key);
  return value === undefined || value === null ? readEnv(key) : String(value);
}

/** Resolve the configured backend, or undefined when the plugin is inert. */
export function resolveCliBackend(source: { ELIZA_CHAT_VIA_CLI?: string }): CliBackend | undefined {
  const raw = source.ELIZA_CHAT_VIA_CLI?.trim().toLowerCase();
  if (raw === "claude" || raw === "claude-sdk" || raw === "codex" || raw === "codex-sdk") {
    return raw;
  }
  return undefined;
}

// Claude's streaming-input query is a continuing conversation with no supported
// history reset. Track only currently-running one-call sessions for lifecycle
// teardown; never cache one across Eliza model calls or hidden SDK context could
// cross rooms, users, and system prompts.
const activeClaudeSdkSessions = new WeakMap<IAgentRuntime, Set<ClaudeSdkSession>>();

/** The Claude model for a given tier (planner/small can differ from large). */
function resolveSdkModel(runtime: IAgentRuntime, modelType: string): string {
  const large = getSetting(runtime, "ELIZA_CLI_CLAUDE_MODEL");
  const planner = getSetting(runtime, "ELIZA_CLI_CLAUDE_PLANNER_MODEL");
  const fallback = (large || "claude-opus-4-8").trim();
  // The planner tier keeps its own (typically heavier) model.
  if (modelType === ModelType.ACTION_PLANNER) {
    return (planner || fallback).trim();
  }
  // ALL-TIERS triage: use the dedicated cheap model, else the large-tier model
  // (NOT the planner tier) so the high-frequency should-respond gate doesn't
  // run on opus.
  if (SMALL_TIER_MODEL_TYPES.includes(modelType)) {
    return (getSetting(runtime, "ELIZA_CLI_CLAUDE_SMALL_MODEL") || fallback).trim();
  }
  return fallback;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * Stable account-affinity key for an isolated SDK request shape.
 * "route" builds the native `route_action` MCP-tool session (the planner);
 * "envelope" builds the native `handle_response` session (Stage-1 routing);
 * "text" builds a plain text-generation session (reply/large tiers).
 */
function claudeSessionKey(
  model: string,
  systemPrompt: string,
  mode: SdkSessionMode,
  envelopeFields?: EnvelopeFieldSchemas
): string {
  // Envelope sessions also freeze their tool schema at query() start, so the
  // composed field set is part of the identity (direct vs group channel
  // shapes compose different sets; registry plugins add more).
  const fieldsPart = envelopeFields ? shortHash(Object.keys(envelopeFields).sort().join(",")) : "";
  return `${model}\u001f${mode}\u001f${shortHash(systemPrompt)}\u001f${fieldsPart}`;
}

/**
 * Reasoning effort for a Claude SDK session, forwarded to the SDK's `effort`
 * option (== `claude --effort`). The planner (route mode) reads
 * ELIZA_CLI_CLAUDE_PLANNER_EFFORT first so routing depth can be tuned
 * independently of reply depth; everything else falls back to ELIZA_CLI_CLAUDE_EFFORT, then
 * to the SDK default (high) when unset. Validation lives in the session
 * (normalizeEffort) so an unknown value is dropped, never forwarded.
 */
export function resolveSdkEffort(runtime: IAgentRuntime, mode: SdkSessionMode): string | undefined {
  const shared = getSetting(runtime, "ELIZA_CLI_CLAUDE_EFFORT");
  if (mode === "route") {
    return getSetting(runtime, "ELIZA_CLI_CLAUDE_PLANNER_EFFORT") ?? shared;
  }
  return shared;
}

/**
 * Construct one isolated Claude SDK session. The SDK has no history-reset API,
 * so the session must be disposed after exactly one Eliza model call.
 */
function createSdkSession(
  runtime: IAgentRuntime,
  model: string,
  systemPrompt: string,
  mode: SdkSessionMode,
  subprocessEnv?: RotationSubprocessEnv,
  envelopeFields?: EnvelopeFieldSchemas
): ClaudeSdkSession {
  return new ClaudeSdkSession({
    model,
    systemPrompt,
    mode,
    envelopeFields,
    claudeExecutablePath: getSetting(runtime, "ELIZA_CLI_CLAUDE_BIN"),
    turnTimeoutMs:
      parseTurnTimeout(getSetting(runtime, "ELIZA_CLI_SDK_TURN_TIMEOUT_MS")) ??
      parseTurnTimeout(getSetting(runtime, "ELIZA_CLI_TIMEOUT_MS")),
    effort: resolveSdkEffort(runtime, mode),
    subprocessEnv,
  });
}

async function runIsolatedSdkSession(
  runtime: IAgentRuntime,
  session: ClaudeSdkSession,
  body: string
): Promise<string> {
  let active = activeClaudeSdkSessions.get(runtime);
  if (!active) {
    active = new Set<ClaudeSdkSession>();
    activeClaudeSdkSessions.set(runtime, active);
  }
  active.add(session);
  try {
    return await session.send(body);
  } finally {
    active.delete(session);
    if (active.size === 0) activeClaudeSdkSessions.delete(runtime);
    await session.dispose();
  }
}

/** Tear down this runtime's isolated Claude calls during plugin shutdown. */
export async function disposeSdkSessions(runtime: IAgentRuntime): Promise<void> {
  const active = activeClaudeSdkSessions.get(runtime);
  if (!active) return;
  const all = [...active];
  active.clear();
  activeClaudeSdkSessions.delete(runtime);
  await Promise.all(all.map((s) => s.dispose()));
}

/** The codex model for a given tier (planner/small can differ from large). */
function resolveCodexModel(runtime: IAgentRuntime, modelType: string): string {
  const large = getSetting(runtime, "ELIZA_CLI_CODEX_MODEL");
  const small = getSetting(runtime, "ELIZA_CLI_CODEX_PLANNER_MODEL");
  const isSmallTier = modelType === ModelType.ACTION_PLANNER || modelType === ModelType.TEXT_SMALL;
  return ((isSmallTier ? small : large) || large || "gpt-5.5").trim();
}

function codexSessionKey(model: string, router: boolean): string {
  return `${model}\u001f${router ? "route" : "text"}`;
}

/**
 * Construct a stateless Codex adapter for one Eliza model call. Even the adapter
 * is request-owned so runtime-specific binary, effort, and account settings can
 * never be inherited from another AgentRuntime.
 */
function createCodexSdkSession(
  runtime: IAgentRuntime,
  model: string,
  router: boolean,
  subprocessEnv?: RotationSubprocessEnv
): CodexSdkSession {
  return new CodexSdkSession({
    model,
    router,
    reasoningEffort: getSetting(runtime, "ELIZA_CLI_CODEX_REASONING_EFFORT"),
    codexBinPath: getSetting(runtime, "ELIZA_CLI_CODEX_BIN"),
    subprocessEnv,
  });
}

function parseTimeout(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Turn-timeout parse (#16553): like {@link parseTimeout}, but an explicit
 *  `"0"` passes through as 0 — the documented operator opt-out to an
 *  unbounded turn. Unset/invalid still return undefined so the session's
 *  bounded default applies. Exported for tests. */
export function parseTurnTimeout(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

// One binary setting covers both SDK and cold backends so container images can
// pin executables outside the launcher allowlist. Blank settings retain the
// allowlisted PATH lookup used by unmanaged installations.
function resolveBinaryPin(runtime: IAgentRuntime, key: string): string | undefined {
  const value = getSetting(runtime, key)?.trim();
  return value ? value : undefined;
}

function buildClaude(runtime: IAgentRuntime): ClaudeCli {
  return new ClaudeCli({
    model: getSetting(runtime, "ELIZA_CLI_CLAUDE_MODEL"),
    timeoutMs: parseTimeout(getSetting(runtime, "ELIZA_CLI_TIMEOUT_MS")),
    binaryPath: resolveBinaryPin(runtime, "ELIZA_CLI_CLAUDE_BIN"),
  });
}

function buildCodex(runtime: IAgentRuntime): CodexCli {
  return new CodexCli({
    model: getSetting(runtime, "ELIZA_CLI_CODEX_MODEL"),
    timeoutMs: parseTimeout(getSetting(runtime, "ELIZA_CLI_TIMEOUT_MS")),
    binaryPath: resolveBinaryPin(runtime, "ELIZA_CLI_CODEX_BIN"),
  });
}

async function generateViaCli(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
  modelType: string
): Promise<string> {
  const backend = resolveCliBackend({
    ELIZA_CHAT_VIA_CLI: getSetting(runtime, "ELIZA_CHAT_VIA_CLI"),
  });
  if (!backend) {
    // Should be unreachable: the handlers are only registered when a backend is
    // set. Throw so useModel/AccountPool treat it as a provider failure rather
    // than silently returning empty.
    throw new Error(
      "[cli-inference] ELIZA_CHAT_VIA_CLI is not set to claude|claude-sdk|codex|codex-sdk"
    );
  }
  const generateParams = {
    system: params.system,
    prompt: params.prompt,
    messages: params.messages,
  };
  logger.debug(`[cli-inference] ${modelType} via ${backend}`);
  const handleResponseTool =
    backend === "claude-sdk" && modelType === ModelType.RESPONSE_HANDLER && stage1EnvelopeEnabled()
      ? findHandleResponseTool(params.tools)
      : undefined;
  if (backend === "claude-sdk" && handleResponseTool) {
    // Stage-1 routing envelope via the native `handle_response` MCP tool.
    // Every other Stage-1 lane structurally forces the envelope (anthropic
    // native tool_use, cloud tool_choice:required, local GBNF); serving it as
    // free text let the model answer live-info asks in prose, which core's
    // tolerance accepted as a finished "simple reply" — no planner, no fetch
    // (observed live: 49 of 54 live-info turns prose-shaped). The captured
    // envelope returns as a JSON string core parses identically to a native
    // tool call; off-contract prose falls back to the tolerant text chain.
    const model = resolveSdkModel(runtime, modelType);
    const fields = envelopeFieldSchemas(handleResponseTool);
    const { system, body } = flattenPrompt(generateParams);
    const envelopeBody = buildEnvelopeBody(system, body);
    const key = claudeSessionKey(model, STAGE1_ENVELOPE_SYSTEM_PROMPT, "envelope", fields);
    return withAccountRotation(
      (env) =>
        runIsolatedSdkSession(
          runtime,
          createSdkSession(runtime, model, STAGE1_ENVELOPE_SYSTEM_PROMPT, "envelope", env, fields),
          envelopeBody
        ),
      {
        backend,
        getValue: (k) => getSetting(runtime, k),
        sessionKey: `cli-inference:${key}`,
        scope: runtime,
      }
    );
  }
  if (backend === "claude-sdk") {
    // The Agent SDK freezes `systemPrompt` at query start, so we flatten
    // system+messages and hand the isolated query a self-contained request.
    const model = resolveSdkModel(runtime, modelType);
    const { system, body } = flattenPrompt(generateParams);
    // Reframe the agentic SDK model as a pure completion engine (system) AND close
    // the body with a directive that cancels any stale "call a tool" instruction,
    // so it synthesizes the final reply from already-executed tool results instead
    // of narrating intent ("I'll fetch it…"). Both are needed (proven live: 4/4 vs
    // 2/4). The key below is account affinity only; the SDK query is not reused.
    const framedSystem = frameTextSystemPrompt(system);
    const framedBody = appendTextDirective(body);
    const key = claudeSessionKey(model, framedSystem, "text");
    // Pool-first auth selects and refreshes a healthy pooled Claude account when
    // one exists (ambient ~/.claude is the fallback). On a subscription limit,
    // retry a fresh query on the next healthy account before provider failover.
    return withAccountRotation(
      (env) =>
        runIsolatedSdkSession(
          runtime,
          createSdkSession(runtime, model, framedSystem, "text", env),
          framedBody
        ),
      {
        backend,
        getValue: (k) => getSetting(runtime, k),
        sessionKey: `cli-inference:${key}`,
        scope: runtime,
      }
    );
  }
  if (backend === "codex-sdk") {
    // Codex SDK folds the system into the body, so frame the body the same way
    // (the SDK model is agentic too) and run TEXT mode on an isolated thread.
    const model = resolveCodexModel(runtime, modelType);
    const { system, body } = flattenPrompt(generateParams);
    const framedBody = appendTextDirective(`${frameTextSystemPrompt(system)}\n\n${body}`);
    const key = codexSessionKey(model, false);
    return withAccountRotation(
      (env) =>
        createCodexSdkSession(runtime, model, false, env).generate(
          framedBody,
          params.responseSchema
        ),
      {
        backend,
        getValue: (k) => getSetting(runtime, k),
        sessionKey: `cli-inference:${key}`,
        scope: runtime,
      }
    );
  }
  const cli = backend === "claude" ? buildClaude(runtime) : buildCodex(runtime);
  return cli.generate(generateParams);
}

/**
 * ACTION_PLANNER handler for the SAFE/CLI route.
 *
 * Two implementations, picked by backend:
 *
 *  - **claude-sdk (native router):** the model is given ONE in-process MCP tool
 *    (`route_action`) and emits a real `tool_use` the isolated query captures as
 *    `{action, params}`. This matches the stealth/native path's full
 *    functionality (live-info → WEB_FETCH, sub-agents) with no free-text JSON
 *    parsing and no required-tool retry loop. The per-turn action menu +
 *    transcript + persona ride in the BODY (system stays the constant
 *    `ROUTER_SYSTEM_PROMPT`; each planner turn gets a fresh query).
 *
 *  - **claude / codex CLI:** the free-text CLI cannot honor native tools, so we
 *    rebuild the call into the proven CLEAN text-routing form (pick ONE action,
 *    emit compact `{action, params}` JSON) via `buildCleanRoutingParams`.
 *
 * Both return the bare `{action, params}` shape the loop's text-mode parser
 * (`parseJsonPlannerOutput` → `normalizeBarePlannerAction`) accepts directly, so
 * no core change is needed.
 */
async function planViaCli(runtime: IAgentRuntime, params: GenerateTextParams): Promise<string> {
  const backend = resolveCliBackend({
    ELIZA_CHAT_VIA_CLI: getSetting(runtime, "ELIZA_CHAT_VIA_CLI"),
  });
  if (backend === "claude-sdk") {
    const model = resolveSdkModel(runtime, ModelType.ACTION_PLANNER);
    const routerBody = buildRouterBody(params);
    const key = claudeSessionKey(model, ROUTER_SYSTEM_PROMPT, "route");
    return withAccountRotation(
      (env) =>
        runIsolatedSdkSession(
          runtime,
          createSdkSession(runtime, model, ROUTER_SYSTEM_PROMPT, "route", env),
          routerBody
        ),
      {
        backend,
        getValue: (k) => getSetting(runtime, k),
        sessionKey: `cli-inference:${key}`,
        scope: runtime,
      }
    );
  }
  if (backend === "codex-sdk") {
    // codex routes via NATIVE structured output (outputSchema) for a reliable
    // {action, params} shape. The clean-routing prompt (menu + transcript +
    // persona) is folded into the body (codex-sdk has no thread-level system
    // prompt); the session applies the schema + parses the result.
    const model = resolveCodexModel(runtime, ModelType.ACTION_PLANNER);
    const clean = buildCleanRoutingParams(params);
    const routeBody = `${clean.system ?? ""}\n\n${clean.prompt ?? ""}`;
    const key = codexSessionKey(model, true);
    return withAccountRotation(
      (env) => createCodexSdkSession(runtime, model, true, env).route(routeBody),
      {
        backend,
        getValue: (k) => getSetting(runtime, k),
        sessionKey: `cli-inference:${key}`,
        scope: runtime,
      }
    );
  }
  return generateViaCli(runtime, buildCleanRoutingParams(params), ModelType.ACTION_PLANNER);
}

/**
 * Build the models map. When no backend is configured the map is EMPTY so the
 * plugin registers nothing and the cheap configured provider keeps serving
 * every tier.
 */
export function buildModels(
  source: { ELIZA_CHAT_VIA_CLI?: string } = { ELIZA_CHAT_VIA_CLI: readEnv("ELIZA_CHAT_VIA_CLI") }
): Plugin["models"] {
  if (!resolveCliBackend(source)) return {};
  const models: Record<
    string,
    (runtime: IAgentRuntime, params: GenerateTextParams) => Promise<string>
  > = {};
  const textTiers = allTiersEnabled()
    ? [...LARGE_TIER_MODEL_TYPES, ...SMALL_TIER_MODEL_TYPES]
    : LARGE_TIER_MODEL_TYPES;
  for (const modelType of textTiers) {
    models[modelType] = (runtime, params) => generateViaCli(runtime, params, modelType);
  }
  if (textPlannerEnabled()) {
    for (const modelType of PLANNER_MODEL_TYPES) {
      models[modelType] = (runtime, params) => planViaCli(runtime, params);
    }
  }
  return models as Plugin["models"];
}

/**
 * Declare the same runtime-setting precedence used by the handlers. Metadata is
 * intentionally serializable and handler-free, but it must not snapshot host
 * environment values: character settings can differ for every agent sharing a
 * process and are resolved by RUNTIME_MODEL_CONTEXT at provider execution time.
 */
export function buildModelMetadata(
  source: { ELIZA_CHAT_VIA_CLI?: string } = {
    ELIZA_CHAT_VIA_CLI: readEnv("ELIZA_CHAT_VIA_CLI"),
  }
): Plugin["modelMetadata"] {
  const backend = resolveCliBackend(source);
  if (!backend) return undefined;
  const isCodex = backend === "codex" || backend === "codex-sdk";
  const isSdk = backend === "claude-sdk" || backend === "codex-sdk";
  const largeSetting = isCodex ? "ELIZA_CLI_CODEX_MODEL" : "ELIZA_CLI_CLAUDE_MODEL";
  const plannerSetting = isCodex
    ? "ELIZA_CLI_CODEX_PLANNER_MODEL"
    : "ELIZA_CLI_CLAUDE_PLANNER_MODEL";
  const defaultModel = isCodex ? "gpt-5.5" : "claude-opus-4-8";
  const metadata: NonNullable<Plugin["modelMetadata"]> = {};
  const declaration = (settings: string[]) => ({
    displayModelSettings: settings,
    displayModelDefault: defaultModel,
  });

  for (const modelType of LARGE_TIER_MODEL_TYPES) {
    metadata[modelType] = declaration([largeSetting]);
  }
  if (allTiersEnabled()) {
    for (const modelType of SMALL_TIER_MODEL_TYPES) {
      const settings =
        backend === "claude-sdk"
          ? ["ELIZA_CLI_CLAUDE_SMALL_MODEL", largeSetting]
          : backend === "codex-sdk" && modelType === ModelType.TEXT_SMALL
            ? [plannerSetting, largeSetting]
            : [largeSetting];
      metadata[modelType] = declaration(settings);
    }
  }
  if (textPlannerEnabled()) {
    for (const modelType of PLANNER_MODEL_TYPES) {
      metadata[modelType] = declaration(isSdk ? [plannerSetting, largeSetting] : [largeSetting]);
    }
  }
  return metadata;
}

export const cliInferencePlugin: Plugin = {
  name: "cli-inference",
  description:
    "TOS-clean SAFE/CLOUD inference: serves large-tier model handlers through sanctioned claude, claude-sdk, codex, or codex-sdk routes; each route reads its own creds. Inert unless ELIZA_CHAT_VIA_CLI selects one of those backends.",
  modelMetadata: buildModelMetadata(),
  // High priority so that, when ELIZA_CHAT_VIA_CLI is set, this plugin
  // deterministically wins the tiers it registers (TEXT_LARGE / TEXT_MEGA /
  // RESPONSE_HANDLER) over default-priority (0) model providers like
  // plugin-anthropic that would otherwise tie and resolve non-deterministically.
  priority: 100,
  config: {
    ELIZA_CHAT_VIA_CLI: readEnv("ELIZA_CHAT_VIA_CLI") ?? null,
    ELIZA_CLI_CLAUDE_MODEL: readEnv("ELIZA_CLI_CLAUDE_MODEL") ?? null,
    ELIZA_CLI_CLAUDE_PLANNER_MODEL: readEnv("ELIZA_CLI_CLAUDE_PLANNER_MODEL") ?? null,
    ELIZA_CLI_CLAUDE_BIN: readEnv("ELIZA_CLI_CLAUDE_BIN") ?? null,
    ELIZA_CLI_SDK_TURN_TIMEOUT_MS: readEnv("ELIZA_CLI_SDK_TURN_TIMEOUT_MS") ?? null,
    ELIZA_CLI_CODEX_MODEL: readEnv("ELIZA_CLI_CODEX_MODEL") ?? null,
    ELIZA_CLI_CODEX_BIN: readEnv("ELIZA_CLI_CODEX_BIN") ?? null,
    ELIZA_CLI_TIMEOUT_MS: readEnv("ELIZA_CLI_TIMEOUT_MS") ?? null,
    ELIZA_CLI_INFERENCE_ACCOUNT_ROTATION: readEnv("ELIZA_CLI_INFERENCE_ACCOUNT_ROTATION") ?? null,
  },
  async init(): Promise<void> {
    const backend = resolveCliBackend({ ELIZA_CHAT_VIA_CLI: readEnv("ELIZA_CHAT_VIA_CLI") });
    if (!backend) {
      logger.info("[cli-inference] ELIZA_CHAT_VIA_CLI unset — plugin inert (no models registered)");
      return;
    }
    // Double-activation guard: the in-process claude-code-stealth interceptor and
    // this CLI-spawn path are two colliding claude routes. This guard lives HERE
    // (not in credentials.ts, which is skip-worktree on the live branch).
    const stealth = readEnv("ELIZA_ENABLE_CLAUDE_STEALTH")?.trim().toLowerCase();
    const stealthOn =
      stealth === "1" || stealth === "true" || stealth === "yes" || stealth === "on";
    if ((backend === "claude" || backend === "claude-sdk") && stealthOn) {
      throw new Error(
        `[cli-inference] ELIZA_CHAT_VIA_CLI=${backend} collides with ELIZA_ENABLE_CLAUDE_STEALTH. ` +
          "Pick one claude inference route (CLI/SDK spawn vs in-process stealth interceptor)."
      );
    }
    logger.info(
      backend === "claude-sdk"
        ? "[cli-inference] enabled via ELIZA_CHAT_VIA_CLI=claude-sdk — isolated Agent SDK queries (TOS-clean, sanctioned)"
        : `[cli-inference] enabled via ELIZA_CHAT_VIA_CLI=${backend} — large-tier handlers use the ${backend} route`
    );
    if (textPlannerEnabled()) {
      logger.info(
        "[cli-inference] text-planner mode (ELIZA_PLANNER_NATIVE_TOOLS=0) — ACTION_PLANNER also served via this route (standalone SAFE stack)"
      );
    }
    if ((backend === "claude-sdk" || backend === "codex-sdk") && rotationEnabled(readEnv)) {
      logger.info(
        "[cli-inference] multi-account rotation ON — a subscription limit rotates to the next healthy pooled account before provider failover (opt out: ELIZA_CLI_INFERENCE_ACCOUNT_ROTATION=0)"
      );
    }
  },
  async dispose(runtime: IAgentRuntime): Promise<void> {
    await disposeSdkSessions(runtime);
  },
  models: buildModels(),
};

export {
  buildRotatedSubprocessEnv,
  isSubscriptionLimitError,
  rotationAgentTypeForBackend,
  rotationEnabled,
  withAccountRotation,
} from "./src/account-rotation";
export { ClaudeCli } from "./src/claude-cli";
export { ClaudeSdkSession, type SdkSessionMode } from "./src/claude-sdk-session";
export {
  appendTextDirective,
  buildCleanRoutingBody,
  buildCleanRoutingParams,
  buildCleanRoutingSystemPrompt,
  buildEnvelopeBody,
  buildRouterBody,
  frameTextSystemPrompt,
  ROUTER_SYSTEM_PROMPT,
  STAGE1_ENVELOPE_SYSTEM_PROMPT,
  TEXT_COMPLETION_DIRECTIVE,
  TEXT_COMPLETION_FRAMING,
} from "./src/clean-routing-planner";
export { CodexCli, parseCodexJsonl } from "./src/codex-cli-exec";
export { CodexSdkSession } from "./src/codex-sdk-session";
export { flattenPrompt } from "./src/prompt-flatten";
export { LARGE_TIER_MODEL_TYPES, PLANNER_MODEL_TYPES, textPlannerEnabled };

export default cliInferencePlugin;
