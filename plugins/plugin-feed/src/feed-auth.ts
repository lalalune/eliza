import type { IAgentRuntime } from "@elizaos/core";

const FETCH_TIMEOUT_MS = 8_000;
const DEFAULT_API_BASE_PROD = "https://staging.feed.market";
const DEFAULT_API_BASE_DEV = "http://localhost:3000";
const FEED_AGENT_SESSION_TOKEN_KEY = "FEED_AGENT_SESSION_TOKEN";
const FEED_AGENT_SESSION_EXPIRES_AT_KEY = "FEED_AGENT_SESSION_EXPIRES_AT";

interface FeedAuthToken {
  token: string;
  expiresAt: number;
}

interface FeedRuntimeAuthState {
  cachedToken: FeedAuthToken | null;
  generation: number;
  controllers: Set<AbortController>;
}

interface FeedEnvironmentCredentialOwner {
  owner: object | null;
  value: string;
  baseline: string | undefined;
}

const runtimeAuthStates = new WeakMap<object, FeedRuntimeAuthState>();
const runtimeCredentialOwnership = new WeakMap<object, Map<string, string>>();
const environmentCredentialOwners = new Map<
  string,
  FeedEnvironmentCredentialOwner
>();
const hostlessAuthState: FeedRuntimeAuthState = {
  cachedToken: null,
  generation: 0,
  controllers: new Set(),
};
let hostlessCredentialOwnership = new Map<string, string>();

interface RuntimeLike {
  agentId?: string;
  character?: {
    name?: string;
    settings?: { secrets?: Record<string, string> };
    secrets?: Record<string, string>;
  };
  getSetting?: (key: string) => string | null | undefined;
  setSetting?: (key: string, value: string, secret?: boolean) => void;
}

export function asRuntimeLike(value: unknown): RuntimeLike | null {
  return value && typeof value === "object" ? (value as RuntimeLike) : null;
}

function runtimeIdentity(
  runtime: IAgentRuntime | RuntimeLike | null,
): object | null {
  return runtime && typeof runtime === "object" ? runtime : null;
}

function authStateFor(
  runtime: IAgentRuntime | RuntimeLike | null,
): FeedRuntimeAuthState {
  const identity = runtimeIdentity(runtime);
  if (!identity) return hostlessAuthState;
  let state = runtimeAuthStates.get(identity);
  if (!state) {
    state = { cachedToken: null, generation: 0, controllers: new Set() };
    runtimeAuthStates.set(identity, state);
  }
  return state;
}

function credentialOwnershipFor(
  runtime: IAgentRuntime | RuntimeLike | null,
): Map<string, string> {
  const identity = runtimeIdentity(runtime);
  if (!identity) return hostlessCredentialOwnership;
  let ownership = runtimeCredentialOwnership.get(identity);
  if (!ownership) {
    ownership = new Map();
    runtimeCredentialOwnership.set(identity, ownership);
  }
  return ownership;
}

export function resolveSettingLike(
  runtime: IAgentRuntime | RuntimeLike | null | undefined,
  key: string,
): string | undefined {
  const fromRuntime = runtime?.getSetting?.(key);
  if (typeof fromRuntime === "string" && fromRuntime.trim().length > 0) {
    return fromRuntime.trim();
  }
  const fromEnv = process.env[key];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return undefined;
}

export interface FeedConfig {
  apiBaseUrl: string;
  agentId: string | undefined;
  agentSecret: string | undefined;
  /**
   * The agent's existing Steward/Eliza-Cloud session JWT. When present, the
   * agent auto-logs in to Feed with this token (Feed verifies the shared-secret
   * HS256 `iss:"steward"` JWT inline) — no `FEED_AGENT_ID`/`FEED_AGENT_SECRET`
   * exchange is required. Resolved from the agent's Steward sidecar credential.
   */
  stewardToken: string | undefined;
  runtime: IAgentRuntime | null;
}

/**
 * Resolve the agent's Steward session JWT from the runtime/env. The app-core
 * Steward sidecar persists the agent token to `STEWARD_AGENT_TOKEN`;
 * `FEED_STEWARD_TOKEN` is an explicit per-app override.
 */
export function resolveStewardToken(
  runtime: IAgentRuntime | RuntimeLike | null | undefined,
): string | undefined {
  return (
    resolveSettingLike(runtime, "FEED_STEWARD_TOKEN") ??
    resolveSettingLike(runtime, "STEWARD_AGENT_TOKEN")
  );
}

export function resolveFeedConfig(runtime: IAgentRuntime | null): FeedConfig {
  return {
    apiBaseUrl: (
      resolveSettingLike(runtime, "FEED_API_URL") ??
      resolveSettingLike(runtime, "FEED_APP_URL") ??
      resolveSettingLike(runtime, "FEED_CLIENT_URL") ??
      (process.env.NODE_ENV === "production"
        ? DEFAULT_API_BASE_PROD
        : DEFAULT_API_BASE_DEV)
    ).replace(/\/+$/, ""),
    agentId: resolveSettingLike(runtime, "FEED_AGENT_ID"),
    agentSecret: resolveSettingLike(runtime, "FEED_AGENT_SECRET"),
    stewardToken: resolveStewardToken(runtime),
    runtime,
  };
}

export function resolveFeedClientUrl(
  runtime: IAgentRuntime | RuntimeLike | null | undefined,
): string {
  return (
    resolveSettingLike(runtime, "FEED_CLIENT_URL") ??
    resolveSettingLike(runtime, "FEED_APP_URL") ??
    resolveSettingLike(runtime, "FEED_API_URL") ??
    (process.env.NODE_ENV === "production"
      ? DEFAULT_API_BASE_PROD
      : DEFAULT_API_BASE_DEV)
  ).replace(/\/+$/, "");
}

export function persistFeedCredential(
  runtime: IAgentRuntime | RuntimeLike | null,
  key: string,
  value: string,
  secret = false,
): void {
  const identity = runtimeIdentity(runtime);
  const previousOwner = environmentCredentialOwners.get(key);
  const baseline = previousOwner?.baseline ?? process.env[key];
  environmentCredentialOwners.set(key, { owner: identity, value, baseline });
  credentialOwnershipFor(runtime).set(key, value);
  process.env[key] = value;
  runtime?.setSetting?.(key, value, secret);

  const runtimeLike = asRuntimeLike(runtime);
  const character = runtimeLike?.character;
  if (!character) return;
  if (!character.settings) {
    character.settings = {};
  }
  if (!character.settings.secrets) {
    character.settings.secrets = {};
  }
  character.settings.secrets[key] = value;
  if (!character.secrets) {
    character.secrets = {};
  }
  character.secrets[key] = value;
}

/** Drops transient and plugin-created credentials when the runtime unloads. */
export function clearFeedAuthState(
  runtime: IAgentRuntime | RuntimeLike | null,
): void {
  const state = authStateFor(runtime);
  state.generation += 1;
  state.cachedToken = null;
  for (const controller of state.controllers) controller.abort();
  state.controllers.clear();
  const ownership = credentialOwnershipFor(runtime);
  const identity = runtimeIdentity(runtime);
  const character = asRuntimeLike(runtime)?.character;
  for (const [key, ownedValue] of ownership) {
    const envOwner = environmentCredentialOwners.get(key);
    if (envOwner?.owner === identity && process.env[key] === envOwner.value) {
      if (envOwner.baseline === undefined) delete process.env[key];
      else process.env[key] = envOwner.baseline;
      environmentCredentialOwners.delete(key);
    }
    if (character?.settings?.secrets?.[key] === ownedValue) {
      delete character.settings.secrets[key];
    }
    if (character?.secrets?.[key] === ownedValue) delete character.secrets[key];
    runtime?.setSetting?.(key, "", true);
    if (character?.settings?.secrets?.[key] === "") {
      delete character.settings.secrets[key];
    }
    if (character?.secrets?.[key] === "") delete character.secrets[key];
  }
  ownership.clear();
  if (identity) runtimeCredentialOwnership.delete(identity);
  else hostlessCredentialOwnership = new Map();
}

async function authenticate(config: FeedConfig): Promise<string> {
  if (!config.agentId || !config.agentSecret) {
    throw new Error(
      "Feed agent credentials not configured. Set FEED_AGENT_ID and FEED_AGENT_SECRET.",
    );
  }

  const state = authStateFor(config.runtime);
  const generation = state.generation;
  const controller = new AbortController();
  state.controllers.add(controller);
  try {
    const url = new URL("/api/agents/auth", config.apiBaseUrl);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: config.agentId,
        agentSecret: config.agentSecret,
      }),
      signal: AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(FETCH_TIMEOUT_MS),
      ]),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Feed auth failed (${response.status}): ${text || response.statusText}`,
      );
    }

    const data = (await response.json()) as {
      token?: string;
      sessionToken?: string;
      expiresIn?: number;
    };
    const token = data.token ?? data.sessionToken;
    if (!token) {
      throw new Error("Feed auth response did not include a session token.");
    }
    if (state.generation !== generation) {
      throw new Error("Feed authentication was cancelled by agent reset.");
    }

    const expiresIn = data.expiresIn ?? 14 * 60;
    state.cachedToken = {
      token,
      expiresAt: Date.now() + expiresIn * 1000,
    };
    persistFeedCredential(
      config.runtime,
      FEED_AGENT_SESSION_TOKEN_KEY,
      token,
      true,
    );
    persistFeedCredential(
      config.runtime,
      FEED_AGENT_SESSION_EXPIRES_AT_KEY,
      String(state.cachedToken.expiresAt),
      true,
    );

    return token;
  } finally {
    state.controllers.delete(controller);
  }
}

async function getSessionToken(config: FeedConfig): Promise<string | null> {
  const state = authStateFor(config.runtime);
  if (state.cachedToken && state.cachedToken.expiresAt > Date.now() + 30_000) {
    return state.cachedToken.token;
  }

  if (!config.agentId || !config.agentSecret) {
    return null;
  }

  return authenticate(config);
}

function clearCachedToken(runtime: IAgentRuntime | null): void {
  authStateFor(runtime).cachedToken = null;
}

export async function proxyFeedRequest(
  config: FeedConfig,
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<Response> {
  const url = new URL(apiPath, config.apiBaseUrl);
  const apiKey = resolveSettingLike(config.runtime, "FEED_A2A_API_KEY");

  const send = (token: string | null): Promise<Response> => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    if (apiKey) {
      headers["X-Feed-Api-Key"] = apiKey;
    }
    return fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  };

  // Prefer the agent's existing Steward/Eliza-Cloud session JWT. Feed verifies
  // it inline (shared-secret HS256, iss:"steward"), so the agent auto-logs in
  // without the FEED_AGENT_ID/SECRET → /api/agents/auth exchange. On rejection
  // (expired token / unshared secret) we fall through to the agent-session path.
  if (config.stewardToken) {
    const stewardResponse = await send(config.stewardToken);
    if (stewardResponse.status !== 401) {
      return stewardResponse;
    }
  }

  const token = await getSessionToken(config);
  const response = await send(token);

  if (response.status === 401 && token) {
    clearCachedToken(config.runtime);
    const newToken = await getSessionToken(config);
    if (newToken && newToken !== token) {
      return send(newToken);
    }
  }

  return response;
}
