/**
 * Keeps the upstream model catalog available through provider outages without
 * turning cold or stale reads into a retry storm. Refresh work is coalesced per
 * cache key, failures enter a bounded cooldown, and only successful loads can
 * replace the last-good shared-cache entry.
 */
import { ElizaError } from "@elizaos/core";
import type { CatalogModel } from "../models";

export const MODEL_CATALOG_FAILURE_BACKOFF_BASE_MS = 30_000;
export const MODEL_CATALOG_FAILURE_BACKOFF_MAX_MS = 5 * 60_000;

export interface ModelCatalogCacheStore {
  getWithSWR<T>(
    key: string,
    staleTTL: number,
    revalidate: () => Promise<T>,
    ttl?: number,
  ): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

interface ModelCatalogCacheEntry {
  data: CatalogModel[];
  cachedAt: number;
  staleAt: number;
}

export type ModelCatalogRefreshResult<T> =
  | { kind: "loaded"; value: T }
  | {
      kind: "failed" | "cooldown";
      error: unknown;
      retryAt: number;
      consecutiveFailures: number;
    };

export interface ModelCatalogRefreshFailure {
  key: string;
  error: unknown;
  retryAt: number;
  consecutiveFailures: number;
}

interface RefreshState<T> {
  inFlight: Promise<ModelCatalogRefreshResult<T>> | null;
  retryAt: number;
  consecutiveFailures: number;
  lastError: unknown;
}

interface ModelCatalogRefreshCoordinatorOptions {
  now?: () => number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  onFailure?: (failure: ModelCatalogRefreshFailure) => void | Promise<void>;
}

/** Coalesces refreshes and suppresses retries until the key's cooldown expires. */
export class ModelCatalogRefreshCoordinator<T> {
  private readonly states = new Map<string, RefreshState<T>>();
  private readonly now: () => number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly onFailure:
    | ((failure: ModelCatalogRefreshFailure) => void | Promise<void>)
    | undefined;

  constructor(options: ModelCatalogRefreshCoordinatorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.baseBackoffMs = options.baseBackoffMs ?? MODEL_CATALOG_FAILURE_BACKOFF_BASE_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? MODEL_CATALOG_FAILURE_BACKOFF_MAX_MS;
    this.onFailure = options.onFailure;
  }

  run(key: string, load: () => Promise<T>): Promise<ModelCatalogRefreshResult<T>> {
    let state = this.states.get(key);
    if (!state) {
      state = {
        inFlight: null,
        retryAt: 0,
        consecutiveFailures: 0,
        lastError: undefined,
      };
      this.states.set(key, state);
    }

    if (state.inFlight) return state.inFlight;

    if (this.now() < state.retryAt) {
      return Promise.resolve({
        kind: "cooldown",
        error: state.lastError,
        retryAt: state.retryAt,
        consecutiveFailures: state.consecutiveFailures,
      });
    }

    let attempt: Promise<ModelCatalogRefreshResult<T>>;
    attempt = Promise.resolve()
      .then(load)
      .then(
        (value): ModelCatalogRefreshResult<T> => {
          state.consecutiveFailures = 0;
          state.retryAt = 0;
          state.lastError = undefined;
          return { kind: "loaded", value };
        },
        async (error: unknown): Promise<ModelCatalogRefreshResult<T>> => {
          state.consecutiveFailures += 1;
          const exponent = Math.min(state.consecutiveFailures - 1, 30);
          const backoffMs = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** exponent);
          state.retryAt = this.now() + backoffMs;
          state.lastError = error;
          // error-policy:J5 this is the sole observer for the shared in-flight
          // rejection; every waiter receives the same explicit failure result.
          try {
            await this.onFailure?.({
              key,
              error,
              retryAt: state.retryAt,
              consecutiveFailures: state.consecutiveFailures,
            });
          } catch (observerError) {
            // error-policy:J5 the observer exception is captured in the same
            // explicit result returned to every waiter, so diagnostics cannot
            // turn a handled refresh failure into an unhandled rejection.
            state.lastError = new AggregateError(
              [error, observerError],
              "Model catalog refresh and failure observer both failed",
            );
          }
          return {
            kind: "failed",
            error: state.lastError,
            retryAt: state.retryAt,
            consecutiveFailures: state.consecutiveFailures,
          };
        },
      )
      .finally(() => {
        if (state.inFlight === attempt) state.inFlight = null;
        if (state.consecutiveFailures === 0) this.states.delete(key);
      });

    state.inFlight = attempt;
    return attempt;
  }

  clear(): void {
    this.states.clear();
  }
}

export interface ModelCatalogCacheOptions {
  key: string;
  store: ModelCatalogCacheStore;
  isProviderConfigured: () => boolean;
  fetchModels: () => Promise<unknown>;
  freshnessSeconds: number;
  retentionSeconds: number;
  now?: () => number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  onRefreshFailure?: (failure: ModelCatalogRefreshFailure) => void | Promise<void>;
}

function valueKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && !Number.isFinite(value)) return "non-finite-number";
  return typeof value;
}

interface CatalogContractViolation {
  field: string;
  expected: string;
  received: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index) || typeof value[index] !== "string") return false;
  }
  return true;
}

function validateOptionalFields(model: Record<string, unknown>): CatalogContractViolation | null {
  const stringFields = ["name", "description", "type"] as const;
  for (const field of stringFields) {
    if (field in model && typeof model[field] !== "string") {
      return { field, expected: "string", received: model[field] };
    }
  }

  const numberFields = ["released", "context_length", "context_window", "max_tokens"] as const;
  for (const field of numberFields) {
    const value = model[field];
    if (field in model && (typeof value !== "number" || !Number.isFinite(value))) {
      return { field, expected: "finite number", received: value };
    }
  }

  const booleanFields = ["recommended", "free"] as const;
  for (const field of booleanFields) {
    if (field in model && typeof model[field] !== "boolean") {
      return { field, expected: "boolean", received: model[field] };
    }
  }

  const stringArrayFields = ["tags", "supported_parameters"] as const;
  for (const field of stringArrayFields) {
    if (field in model && !isStringArray(model[field])) {
      return { field, expected: "string array", received: model[field] };
    }
  }

  if ("pricing" in model && !isRecord(model.pricing)) {
    return { field: "pricing", expected: "object", received: model.pricing };
  }

  if ("architecture" in model) {
    if (!isRecord(model.architecture)) {
      return { field: "architecture", expected: "object", received: model.architecture };
    }

    const architecture = model.architecture;
    if ("modality" in architecture && typeof architecture.modality !== "string") {
      return {
        field: "architecture.modality",
        expected: "string",
        received: architecture.modality,
      };
    }
    for (const field of ["input_modalities", "output_modalities"] as const) {
      if (field in architecture && !isStringArray(architecture[field])) {
        return {
          field: `architecture.${field}`,
          expected: "string array",
          received: architecture[field],
        };
      }
    }
  }

  return null;
}

type CatalogModelValidation =
  | { valid: true; model: CatalogModel }
  | { valid: false; violation: CatalogContractViolation };

function validateCatalogModel(value: unknown): CatalogModelValidation {
  if (!isRecord(value)) {
    return {
      valid: false,
      violation: { field: "entry", expected: "object", received: value },
    };
  }
  if (typeof value.id !== "string" || value.id.trim().length === 0) {
    return {
      valid: false,
      violation: { field: "id", expected: "non-empty string", received: value.id },
    };
  }
  if ("object" in value && value.object !== "model") {
    return {
      valid: false,
      violation: { field: "object", expected: 'literal "model"', received: value.object },
    };
  }
  if (typeof value.created !== "number" || !Number.isFinite(value.created)) {
    return {
      valid: false,
      violation: { field: "created", expected: "finite number", received: value.created },
    };
  }
  if (
    "owned_by" in value &&
    (typeof value.owned_by !== "string" || value.owned_by.trim().length === 0)
  ) {
    return {
      valid: false,
      violation: { field: "owned_by", expected: "non-empty string", received: value.owned_by },
    };
  }

  const optionalViolation = validateOptionalFields(value);
  if (optionalViolation) return { valid: false, violation: optionalViolation };

  // OpenRouter omits the OpenAI list metadata fields. Normalize them at this
  // boundary so old provider-shaped cache entries and new refreshes both leave
  // the service as the stricter internal CatalogModel contract.
  const model: CatalogModel = {
    id: value.id,
    object: "model",
    created: value.created,
    owned_by: typeof value.owned_by === "string" ? value.owned_by : value.id.split("/", 1)[0],
  };

  if (typeof value.released === "number") model.released = value.released;
  if (typeof value.name === "string") model.name = value.name;
  if (typeof value.description === "string") model.description = value.description;
  if (typeof value.context_length === "number") model.context_length = value.context_length;
  if (typeof value.context_window === "number") model.context_window = value.context_window;
  if (typeof value.max_tokens === "number") model.max_tokens = value.max_tokens;
  if (typeof value.type === "string") model.type = value.type;
  if (isStringArray(value.tags)) model.tags = value.tags;
  if (isRecord(value.pricing)) model.pricing = value.pricing;
  if (typeof value.recommended === "boolean") model.recommended = value.recommended;
  if (typeof value.free === "boolean") model.free = value.free;
  if (isStringArray(value.supported_parameters)) {
    model.supported_parameters = value.supported_parameters;
  }
  if (isRecord(value.architecture)) {
    const architecture: NonNullable<CatalogModel["architecture"]> = {};
    if (typeof value.architecture.modality === "string") {
      architecture.modality = value.architecture.modality;
    }
    if (isStringArray(value.architecture.input_modalities)) {
      architecture.input_modalities = value.architecture.input_modalities;
    }
    if (isStringArray(value.architecture.output_modalities)) {
      architecture.output_modalities = value.architecture.output_modalities;
    }
    model.architecture = architecture;
  }

  return { valid: true, model };
}

function catalogContractError(
  key: string,
  boundary: "cache" | "refresh",
  received: unknown,
  modelIndex?: number,
  field?: string,
  expected?: string,
): ElizaError {
  const receivedKind = valueKind(received);
  const location = modelIndex === undefined ? "catalog" : `catalog[${modelIndex}].${field}`;
  const expectation = expected ?? "array";
  const cause = new TypeError(
    `Expected ${location} to be ${expectation}, received ${receivedKind}`,
  );
  return new ElizaError("Model catalog cache contract returned an invalid value", {
    code: "MODEL_CATALOG_CACHE_CONTRACT_VIOLATION",
    context: {
      key,
      boundary,
      receivedKind,
      ...(modelIndex === undefined
        ? expected === undefined
          ? {}
          : { expected: expectation }
        : { modelIndex, field, expected: expectation }),
    },
    cause,
    severity: "fatal",
  });
}

function requireCatalogModels(
  value: unknown,
  key: string,
  boundary: "cache" | "refresh",
  allowEmpty = true,
): CatalogModel[] {
  if (!Array.isArray(value)) throw catalogContractError(key, boundary, value);
  if (!allowEmpty && value.length === 0) {
    throw catalogContractError(key, boundary, value, undefined, undefined, "non-empty array");
  }

  const models: CatalogModel[] = [];
  for (const [modelIndex, model] of value.entries()) {
    const validation = validateCatalogModel(model);
    if (!validation.valid) {
      const { violation } = validation;
      throw catalogContractError(
        key,
        boundary,
        violation.received,
        modelIndex,
        violation.field,
        violation.expected,
      );
    }
    models.push(validation.model);
  }

  return models;
}

/** Owns the BitRouter catalog's shared-cache and refresh policy. */
export class ModelCatalogCache {
  private readonly key: string;
  private readonly store: ModelCatalogCacheStore;
  private readonly isProviderConfigured: () => boolean;
  private readonly fetchModels: () => Promise<unknown>;
  private readonly freshnessSeconds: number;
  private readonly retentionSeconds: number;
  private readonly now: () => number;
  private readonly refreshes: ModelCatalogRefreshCoordinator<CatalogModel[]>;

  constructor(options: ModelCatalogCacheOptions) {
    this.key = options.key;
    this.store = options.store;
    this.isProviderConfigured = options.isProviderConfigured;
    this.fetchModels = options.fetchModels;
    this.freshnessSeconds = options.freshnessSeconds;
    this.retentionSeconds = options.retentionSeconds;
    this.now = options.now ?? Date.now;
    this.refreshes = new ModelCatalogRefreshCoordinator<CatalogModel[]>({
      now: this.now,
      baseBackoffMs: options.baseBackoffMs,
      maxBackoffMs: options.maxBackoffMs,
      onFailure: options.onRefreshFailure,
    });
  }

  private runRefresh(): Promise<ModelCatalogRefreshResult<CatalogModel[]>> {
    return this.refreshes.run(this.key, async () => {
      if (!this.isProviderConfigured()) return [];
      return requireCatalogModels(await this.fetchModels(), this.key, "refresh", false);
    });
  }

  private async loadModels(): Promise<CatalogModel[]> {
    const refreshed = await this.runRefresh();
    if (refreshed.kind === "loaded") return refreshed.value;
    throw refreshed.error;
  }

  async getCached(): Promise<CatalogModel[]> {
    const cached = await this.store.getWithSWR<unknown>(
      this.key,
      this.freshnessSeconds,
      () => this.loadModels(),
      this.retentionSeconds,
    );

    try {
      // A configured cold miss rejects in loadModels. Null, an empty configured
      // catalog, or another invalid value therefore means the cache boundary
      // violated its declared contract; it must not masquerade as a healthy hit.
      return requireCatalogModels(cached, this.key, "cache", !this.isProviderConfigured());
    } catch (error) {
      if (
        !(error instanceof ElizaError) ||
        error.code !== "MODEL_CATALOG_CACHE_CONTRACT_VIOLATION" ||
        error.context?.boundary !== "cache"
      ) {
        throw error;
      }

      // error-policy:J3 shared-cache bytes are untrusted input. Evict the typed
      // invalid value and return only a newly validated authoritative result.
      await this.store.del(this.key);
      return await this.refresh();
    }
  }

  async refresh(): Promise<CatalogModel[]> {
    const models = await this.loadModels();
    const cachedAt = this.now();
    await this.store.set<ModelCatalogCacheEntry>(
      this.key,
      {
        data: models,
        cachedAt,
        staleAt: cachedAt + this.freshnessSeconds * 1000,
      },
      this.retentionSeconds,
    );
    return models;
  }

  /** Test hook for module-level consumers that share the production instance. */
  clearRefreshStateForTests(): void {
    this.refreshes.clear();
  }
}
