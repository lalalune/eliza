/**
 * Isolated Codex SDK transport for subscription-backed Eliza model calls.
 * Every call owns a fresh read-only, offline thread because callers provide the
 * complete transcript and SDK thread reuse would retain hidden context across
 * rooms or users. Text calls support provider-neutral response schemas; planner
 * calls use Codex structured output and restore JSON-encoded dynamic values.
 */

import { type JSONSchema, logger } from "@elizaos/core";
import type { RotationSubprocessEnv } from "./account-rotation";

const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_REASONING_EFFORT = "high";
const VALID_REASONING_EFFORTS: ReadonlySet<string> = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

/**
 * Resolve the SDK effort independently of the operator's ambient Codex config.
 * The system CLI accepts host-only aliases such as `ultra`, but its Responses
 * transport rejects the resulting `max` value. Pinning a supported default and
 * translating the two highest-effort aliases keeps subscription chat portable
 * without mutating the user's `~/.codex/config.toml`.
 */
export function normalizeCodexReasoningEffort(value: string | null | undefined): string {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return DEFAULT_REASONING_EFFORT;
  if (normalized === "max" || normalized === "ultra") return "xhigh";
  if (VALID_REASONING_EFFORTS.has(normalized)) return normalized;
  throw new Error(
    `[cli-inference:codex-sdk] unsupported reasoning effort "${normalized}" ` +
      `(supported: minimal, low, medium, high, xhigh)`
  );
}

/** The model's captured routing decision (ROUTE mode). */
export interface CodexRouteDecision {
  action: string;
  params: Record<string, unknown>;
}

/**
 * Output schema constraining ROUTE-mode output to `{action, params}` where
 * `params` is a JSON STRING. OpenAI strict structured-output forbids open-ended
 * objects (every nested object must declare all properties + additionalProperties:
 * false), so an arbitrary params object is impossible — encoding params as a JSON
 * string sidesteps that while still guaranteeing the shape.
 */
const ROUTE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "params"],
  properties: {
    action: { type: "string" },
    params: { type: "string", description: "JSON-encoded params object" },
  },
} as const;

interface CodexTurn {
  items?: Array<{ type?: string; text?: string }>;
  finalResponse?: string;
  usage?: unknown;
}
interface CodexThread {
  run(input: string, turnOptions?: { outputSchema?: unknown }): Promise<CodexTurn>;
}
interface CodexInstance {
  startThread(options?: Record<string, unknown>): CodexThread;
}
/** Minimal shape of the `@openai/codex-sdk` module we load lazily. */
export interface CodexModule {
  Codex: new (options?: Record<string, unknown>) => CodexInstance;
}

export interface CodexSdkSessionConfig {
  model?: string | null;
  /** ROUTE mode (free-text `{action,params}` JSON) vs TEXT mode (plain completion). */
  router?: boolean;
  /** `modelReasoningEffort` for the thread (minimal|low|medium|high|xhigh). */
  reasoningEffort?: string | null;
  /**
   * Optional path to the codex binary the SDK should drive
   * (`codexPathOverride`). Omit it to use the binary pinned by the SDK package;
   * set it when a deployment intentionally manages a system binary separately.
   */
  codexBinPath?: string | null;
  /**
   * Optional subprocess-only env for a pooled account. Passed to the Codex SDK
   * constructor; never written to the parent process env.
   */
  subprocessEnv?: RotationSubprocessEnv | null;
  /** Injected for tests; defaults to the real SDK. */
  codexModule?: CodexModule;
}

const SDK_PACKAGE = "@openai/codex-sdk";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const CODEX_UNSUPPORTED_SCHEMA_CONSTRAINTS = [
  "maxItems",
  "minItems",
  "maxLength",
  "minLength",
  "pattern",
  "format",
  "minProperties",
  "maxProperties",
] as const;

const CODEX_JSON_VALUE_KEY = "__eliza_json";

function schemaAllowsNull(value: Record<string, unknown>): boolean {
  if (value.nullable === true) return true;
  const type = value.type;
  if (type === "null") return true;
  if (Array.isArray(type) && type.includes("null")) return true;
  for (const unionKey of ["anyOf", "oneOf"] as const) {
    const union = value[unionKey];
    if (
      Array.isArray(union) &&
      union.some((branch) => isRecord(branch) && schemaAllowsNull(branch))
    ) {
      return true;
    }
  }
  return false;
}

function isUnconstrainedSchema(value: Record<string, unknown>): boolean {
  return (
    value.type === undefined &&
    value.properties === undefined &&
    value.items === undefined &&
    value.anyOf === undefined &&
    value.oneOf === undefined &&
    value.allOf === undefined &&
    value.enum === undefined &&
    value.const === undefined &&
    value.$ref === undefined
  );
}

function requiresJsonEnvelope(value: Record<string, unknown>): boolean {
  if (isUnconstrainedSchema(value)) return true;
  const type = value.type;
  const isObjectSchema =
    type === "object" ||
    (Array.isArray(type) && type.includes("object")) ||
    value.properties !== undefined ||
    value.additionalProperties !== undefined ||
    value.patternProperties !== undefined;
  if (!isObjectSchema) return false;
  // Codex strict output forbids open maps. Preserve explicit open-map semantics
  // (and property-less object schemas) through an envelope instead of silently
  // replacing their dynamic values with an empty closed object. Object schemas
  // with declared properties but no additionalProperties follow the adapter's
  // provider-neutral strict normalization and are closed below.
  return (
    value.additionalProperties === true ||
    isRecord(value.additionalProperties) ||
    value.patternProperties !== undefined ||
    (!isRecord(value.properties) && value.additionalProperties !== false)
  );
}

function schemaMatchesValue(schema: Record<string, unknown>, value: unknown): boolean {
  if (Array.isArray(schema.enum)) return schema.enum.includes(value);
  if ("const" in schema) return Object.is(schema.const, value);
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.every((type) => typeof type !== "string")) return true;
  return types.some((type) => {
    if (type === "null") return value === null;
    if (type === "array") return Array.isArray(value);
    if (type === "object") return isRecord(value) && !Array.isArray(value);
    if (type === "integer") return typeof value === "number" && Number.isInteger(value);
    return typeof value === type;
  });
}

function restoreCodexOutputValue(value: unknown, schema: JSONSchema): unknown {
  const source = schema as Record<string, unknown>;
  if (value === null) return null;

  if (requiresJsonEnvelope(source)) {
    if (!isRecord(value) || typeof value[CODEX_JSON_VALUE_KEY] !== "string") {
      throw new Error(
        "[cli-inference:codex-sdk] structured output omitted the JSON envelope for an open or unconstrained value"
      );
    }
    return JSON.parse(value[CODEX_JSON_VALUE_KEY]);
  }

  for (const unionKey of ["anyOf", "oneOf"] as const) {
    const union = source[unionKey];
    if (!Array.isArray(union)) continue;
    const branch = union.find(
      (candidate) => isRecord(candidate) && schemaMatchesValue(candidate, value)
    );
    if (isRecord(branch)) return restoreCodexOutputValue(value, branch as JSONSchema);
  }

  if (Array.isArray(value)) {
    if (isRecord(source.items)) {
      return value.map((item) => restoreCodexOutputValue(item, source.items as JSONSchema));
    }
    if (Array.isArray(source.items)) {
      const itemSchemas = source.items;
      return value.map((item, index) => {
        const itemSchema = itemSchemas[index];
        return isRecord(itemSchema)
          ? restoreCodexOutputValue(item, itemSchema as JSONSchema)
          : item;
      });
    }
    return value;
  }

  if (!isRecord(value) || !isRecord(source.properties)) return value;
  const originallyRequired = new Set(
    Array.isArray(source.required)
      ? source.required.filter((key): key is string => typeof key === "string")
      : []
  );
  const restored: Record<string, unknown> = {};
  for (const [key, childValue] of Object.entries(value)) {
    const childSchema = source.properties[key];
    if (!isRecord(childSchema)) {
      restored[key] = childValue;
      continue;
    }
    if (childValue === null && !originallyRequired.has(key) && !schemaAllowsNull(childSchema)) {
      continue;
    }
    restored[key] = restoreCodexOutputValue(childValue, childSchema as JSONSchema);
  }
  return restored;
}

function restoreCodexStructuredOutput(text: string, schema: JSONSchema): string {
  return JSON.stringify(restoreCodexOutputValue(JSON.parse(text), schema));
}

/**
 * Codex passes output schemas to the Responses API's strict JSON mode. That
 * transport requires every object to be closed and every declared property to
 * appear in `required`, including schemas authored for providers that support
 * optional properties. The response path restores strict-mode placeholders to
 * the caller's original omission and unconstrained-value semantics before
 * downstream validation sees them.
 */
export function normalizeCodexOutputSchema(schema: JSONSchema): JSONSchema {
  const withNull = (value: JSONSchema): JSONSchema => {
    const nullable = { ...value } as Record<string, unknown>;
    if (schemaAllowsNull(nullable)) return nullable as JSONSchema;
    if ("const" in nullable) {
      return {
        anyOf: [nullable as JSONSchema, { type: "null" }],
      } as JSONSchema;
    }
    if (Array.isArray(nullable.enum) && !nullable.enum.includes(null)) {
      nullable.enum = [...nullable.enum, null];
    }
    const type = nullable.type;
    if (typeof type === "string") nullable.type = [type, "null"];
    else if (Array.isArray(type)) nullable.type = [...type, "null"];
    else {
      return {
        anyOf: [nullable as JSONSchema, { type: "null" }],
      } as JSONSchema;
    }
    return nullable as JSONSchema;
  };

  const normalizeNode = (value: JSONSchema, isRoot = false): JSONSchema => {
    const normalized = { ...value } as Record<string, unknown>;
    const hasProperties = isRecord(normalized.properties);
    const needsEnvelope = requiresJsonEnvelope(normalized);
    if (isRoot && !needsEnvelope && normalized.type !== "object" && !hasProperties) {
      throw new Error("[cli-inference:codex-sdk] output schema root must be an object");
    }
    const legacyNullable = normalized.nullable === true;
    const allowsNull = schemaAllowsNull(normalized);
    if (isRoot && allowsNull) {
      throw new Error("[cli-inference:codex-sdk] output schema root cannot be nullable");
    }
    delete normalized.nullable;

    const hints: string[] = [];
    for (const constraint of CODEX_UNSUPPORTED_SCHEMA_CONSTRAINTS) {
      if (constraint in normalized) {
        hints.push(`${constraint}=${String(normalized[constraint])}`);
        delete normalized[constraint];
      }
    }
    if (hints.length > 0) {
      const existing = typeof normalized.description === "string" ? normalized.description : "";
      const suffix = `(${hints.join(", ")})`;
      normalized.description = existing ? `${existing} ${suffix}` : suffix;
    }

    if (needsEnvelope) {
      const existing = typeof normalized.description === "string" ? normalized.description : "";
      const wrapped = {
        type: "object",
        additionalProperties: false,
        required: [CODEX_JSON_VALUE_KEY],
        properties: {
          [CODEX_JSON_VALUE_KEY]: {
            type: "string",
            description: "JSON-encoded value; encode strings as JSON strings too.",
          },
        },
        ...(typeof normalized.title === "string" ? { title: normalized.title } : {}),
        description: existing
          ? `${existing} Supply this value through the JSON envelope.`
          : "Supply this value through the JSON envelope.",
      } as JSONSchema;
      return allowsNull && !isRoot ? withNull(wrapped) : wrapped;
    }

    if (isRecord(normalized.properties)) {
      const originallyRequired = new Set(
        Array.isArray(normalized.required)
          ? normalized.required.filter((key): key is string => typeof key === "string")
          : []
      );
      const properties: Record<string, JSONSchema> = {};
      for (const [key, child] of Object.entries(normalized.properties)) {
        if (!isRecord(child)) {
          throw new Error(
            `[cli-inference:codex-sdk] output schema property "${key}" is not an object`
          );
        }
        const normalizedChild = normalizeNode(child as JSONSchema);
        properties[key] = originallyRequired.has(key) ? normalizedChild : withNull(normalizedChild);
      }
      const objectType = normalized.type;
      normalized.type =
        Array.isArray(objectType) && objectType.includes("null") ? ["object", "null"] : "object";
      normalized.properties = properties;
      normalized.required = Object.keys(properties);
      normalized.additionalProperties = false;
    }
    if (
      normalized.type === "object" ||
      (Array.isArray(normalized.type) && normalized.type.includes("object"))
    ) {
      normalized.additionalProperties = false;
    }

    if (isRecord(normalized.items)) {
      normalized.items = normalizeNode(normalized.items as JSONSchema);
    } else if (Array.isArray(normalized.items)) {
      normalized.items = normalized.items.map((item) =>
        isRecord(item) ? normalizeNode(item as JSONSchema) : item
      );
    }

    for (const unionKey of ["anyOf", "oneOf", "allOf"] as const) {
      const union = normalized[unionKey];
      if (Array.isArray(union)) {
        normalized[unionKey] = union.map((item) =>
          isRecord(item) ? normalizeNode(item as JSONSchema) : item
        );
      }
    }
    for (const mapKey of ["$defs", "definitions"] as const) {
      const definitions = normalized[mapKey];
      if (!isRecord(definitions)) continue;
      normalized[mapKey] = Object.fromEntries(
        Object.entries(definitions).map(([key, child]) => [
          key,
          isRecord(child) ? normalizeNode(child as JSONSchema) : child,
        ])
      );
    }

    return legacyNullable ? withNull(normalized as JSONSchema) : (normalized as JSONSchema);
  };

  return normalizeNode(schema, true);
}

function isCodexModule(value: unknown): value is CodexModule {
  return isRecord(value) && typeof value.Codex === "function";
}

async function loadCodex(): Promise<CodexModule> {
  const codex: unknown = await import(SDK_PACKAGE);
  if (!isCodexModule(codex)) {
    throw new Error("[cli-inference:codex-sdk] Codex SDK module has an unexpected shape");
  }
  return codex;
}

/** Pull the assistant text out of a completed codex turn. */
function turnToText(turn: CodexTurn): string {
  if (typeof turn.finalResponse === "string" && turn.finalResponse.trim()) {
    return turn.finalResponse.trim();
  }
  // Fallback: the last agent_message item's text.
  for (const item of [...(turn.items ?? [])].reverse()) {
    if (item.type === "agent_message" && typeof item.text === "string" && item.text.trim()) {
      return item.text.trim();
    }
  }
  return "";
}

/**
 * Request-owned Codex SDK configuration for one model and mode. Each call owns
 * a fresh thread so no conversation state crosses requests.
 */
export class CodexSdkSession {
  private readonly model: string;
  private readonly router: boolean;
  private readonly reasoningEffort: string | null;
  private readonly codexBinPath: string | null;
  private readonly subprocessEnv: RotationSubprocessEnv | null;
  private readonly codexOverride?: CodexModule;

  private chain: Promise<unknown> = Promise.resolve();

  constructor(config: CodexSdkSessionConfig) {
    this.model = config.model?.trim() || DEFAULT_MODEL;
    this.router = config.router === true;
    this.reasoningEffort = normalizeCodexReasoningEffort(config.reasoningEffort);
    this.codexBinPath = config.codexBinPath?.trim() || null;
    this.subprocessEnv = config.subprocessEnv ?? null;
    this.codexOverride = config.codexModule;
  }

  /**
   * TEXT mode: generate one completion's text. A caller-provided schema is a
   * turn-level constraint and is applied only to this isolated thread.
   */
  generate(body: string, outputSchema?: JSONSchema): Promise<string> {
    return this.enqueue(() => this.sendOnce(body, "text", outputSchema));
  }

  /**
   * ROUTE mode: return `JSON.stringify({action, params})` — the action the model
   * picked via codex's native structured output. Consumed directly by the planner
   * loop's text-mode parser, so no core change is needed.
   */
  route(body: string): Promise<string> {
    return this.enqueue(() => this.sendOnce(body, "route"));
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    // error-policy:J5 the chain tail only serializes turns; the REAL result/error
    // is returned to the caller via `run`. Swallowing here just stops a settled
    // tail from raising an unhandled rejection — the caller still sees the error.
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async sendOnce(
    body: string,
    mode: "text" | "route",
    outputSchema?: JSONSchema
  ): Promise<string> {
    if (!body.trim()) {
      throw new Error("[cli-inference:codex-sdk] empty prompt body");
    }
    const thread = await this.start();
    // Schemas belong to individual turns: ROUTE owns its fixed action schema,
    // while TEXT normalizes the provider-neutral responseSchema for Codex.
    // The SDK/API remains the validation boundary and any rejection propagates
    // so runtime provider failover can observe it.
    const turnOptions =
      mode === "route"
        ? { outputSchema: ROUTE_OUTPUT_SCHEMA }
        : outputSchema !== undefined
          ? { outputSchema: normalizeCodexOutputSchema(outputSchema) }
          : undefined;
    const turn = await thread.run(body, turnOptions);
    const text = turnToText(turn);
    if (mode === "route") {
      return this.normalizeRoute(text);
    }
    if (!text) {
      throw new Error("[cli-inference:codex-sdk] empty completion");
    }
    return outputSchema ? restoreCodexStructuredOutput(text, outputSchema) : text;
  }

  /** Coerce the structured-output JSON into a bare {action, params} string. */
  private normalizeRoute(text: string): string {
    if (!text) {
      throw new Error("[cli-inference:codex-sdk] route: empty structured output");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // error-policy:J3 untrusted model output — structured output SHOULD be valid
      // JSON; if wrapped, salvage the first {...} block, else throw a typed
      // "non-JSON output" (does not fabricate a valid route).
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) {
        throw new Error("[cli-inference:codex-sdk] route: non-JSON output");
      }
      parsed = JSON.parse(match[0]);
    }
    const obj = parsed as { action?: unknown; params?: unknown };
    if (typeof obj.action !== "string" || !obj.action.trim()) {
      throw new Error("[cli-inference:codex-sdk] route: missing action");
    }
    // `params` arrives as a JSON STRING (ROUTE_OUTPUT_SCHEMA encodes it that way
    // for strict-mode), or already as an object on the free-text fallback path.
    let params: Record<string, unknown>;
    if (typeof obj.params === "string") {
      if (!obj.params.trim()) {
        throw new Error("[cli-inference:codex-sdk] route: empty params JSON");
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(obj.params);
      } catch {
        // error-policy:J3 untrusted model output — malformed params are an
        // explicit invalid route so provider failover can observe the failure.
        throw new Error("[cli-inference:codex-sdk] route: non-JSON params output");
      }
      if (!isRecord(decoded) || Array.isArray(decoded)) {
        throw new Error("[cli-inference:codex-sdk] route: params JSON must encode an object");
      }
      params = decoded;
    } else if (isRecord(obj.params) && !Array.isArray(obj.params)) {
      params = obj.params;
    } else {
      throw new Error("[cli-inference:codex-sdk] route: missing params object");
    }
    return JSON.stringify({
      action: obj.action.trim(),
      params,
    });
  }

  private async start(): Promise<CodexThread> {
    const { Codex } = this.codexOverride ?? (await loadCodex());
    // A deployment may intentionally pin a separately-managed system binary;
    // otherwise the SDK's version-matched binary remains authoritative.
    const codexOptions: Record<string, unknown> = {};
    if (this.codexBinPath) codexOptions.codexPathOverride = this.codexBinPath;
    if (this.subprocessEnv) codexOptions.env = this.subprocessEnv;
    const codex = new Codex(codexOptions);
    // Pure inference: read-only, no network, no approvals, no git-repo coupling.
    // A fresh thread is the request boundary because Eliza supplies the complete
    // transcript and different calls may belong to different users or rooms.
    const options: Record<string, unknown> = {
      model: this.model,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchEnabled: false,
      skipGitRepoCheck: true,
    };
    if (this.reasoningEffort) options.modelReasoningEffort = this.reasoningEffort;
    const thread = codex.startThread(options);
    logger.debug(
      { src: "cli-inference:codex-sdk", model: this.model, mode: this.router ? "route" : "text" },
      "isolated Codex SDK thread started"
    );
    return thread;
  }

  /** Retained for the shared plugin lifecycle; calls hold no persistent thread. */
  dispose(): void {
    // Each SDK thread is scoped to one completed call, so there is no retained
    // conversation process to tear down here.
  }
}
