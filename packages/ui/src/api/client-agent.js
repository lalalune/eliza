/**
 * Agent domain methods — lifecycle, auth, config, connectors, triggers,
 * training, plugins, streaming, logs, character, permissions, updates.
 */
import { isElizaSettingsDebugEnabled, sanitizeForSettingsDebug, settingsDebugCloudSummary, } from "@elizaos/shared";
import { invokeDesktopBridgeRequest, invokeDesktopBridgeRequestWithTimeout, } from "../bridge/electrobun-rpc";
import { getAppBlockerPlugin, getWebsiteBlockerPlugin, } from "../bridge/native-plugins";
import { TERMINAL_STATUSES } from "../chat/coding-agent-session-state";
import { openEventSource } from "../utils/event-source";
import { androidNativeAgentLifecycleForUrl } from "./android-native-agent-transport";
import { ElizaClient } from "./client-base";
import { isDirectCloudSharedAgentBase } from "./client-cloud";
import { ApiError, mapAcpSessionsToCodingAgentSessions, mapTaskThreadsToCodingAgentSessions, } from "./client-types";
import { isDesktopExternalApiBaseUrl } from "./desktop-external-api-base";
// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------
function clientSettingsDebug() {
    let viteEnv;
    try {
        viteEnv = import.meta.env;
    }
    catch {
        viteEnv = undefined;
    }
    return isElizaSettingsDebugEnabled({
        importMetaEnv: viteEnv,
        env: typeof process !== "undefined" ? process.env : undefined,
    });
}
function isTradePermissionMode(value) {
    return (value === "user-sign-only" ||
        value === "manual-local-key" ||
        value === "agent-auto" ||
        value === "disabled");
}
const WEBSITE_BLOCKING_PERMISSION_ID = "website-blocking";
function getNativeWebsiteBlockerPluginIfAvailable() {
    const plugin = getWebsiteBlockerPlugin();
    return typeof plugin.getStatus === "function" &&
        typeof plugin.startBlock === "function" &&
        typeof plugin.stopBlock === "function" &&
        typeof plugin.checkPermissions === "function" &&
        typeof plugin.requestPermissions === "function" &&
        typeof plugin.openSettings === "function"
        ? plugin
        : null;
}
function getNativeAppBlockerPluginIfAvailable() {
    const plugin = getAppBlockerPlugin();
    return typeof plugin.getStatus === "function" &&
        typeof plugin.checkPermissions === "function" &&
        typeof plugin.requestPermissions === "function" &&
        typeof plugin.getInstalledApps === "function" &&
        typeof plugin.selectApps === "function" &&
        typeof plugin.blockApps === "function" &&
        typeof plugin.unblockApps === "function"
        ? plugin
        : null;
}
function mapWebsiteBlockerPermissionResult(permission) {
    return {
        id: WEBSITE_BLOCKING_PERMISSION_ID,
        status: permission.status,
        canRequest: permission.canRequest,
        reason: permission.reason,
        lastChecked: Date.now(),
        platform: currentClientPlatform(),
    };
}
function mapWebsiteBlockerStatusToPermission(status) {
    return {
        id: WEBSITE_BLOCKING_PERMISSION_ID,
        status: status.permissionStatus ??
            (status.available ? "granted" : "not-determined"),
        canRequest: status.canRequestPermission ?? status.supportsElevationPrompt,
        reason: status.reason,
        lastChecked: Date.now(),
        platform: currentClientPlatform(),
    };
}
function currentClientPlatform() {
    if (typeof navigator !== "undefined") {
        const ua = navigator.userAgent.toLowerCase();
        if (ua.includes("mac"))
            return "darwin";
        if (ua.includes("win"))
            return "win32";
    }
    return "linux";
}
function logSettingsClient(phase, detail) {
    if (!clientSettingsDebug())
        return;
    console.debug(`[eliza][settings][client] ${phase}`, sanitizeForSettingsDebug(detail));
}
const SETTINGS_MUTATION_TIMEOUT_MS = 30_000;
const DESKTOP_STATUS_RPC_TIMEOUT_MS = 1_500;
async function getDesktopStatusRpc(baseUrl, rpcMethod, params) {
    if (isDesktopExternalApiBaseUrl(baseUrl))
        return null;
    const outcome = await invokeDesktopBridgeRequestWithTimeout({
        rpcMethod,
        ipcChannel: "agent",
        params,
        timeoutMs: DESKTOP_STATUS_RPC_TIMEOUT_MS,
    });
    return outcome.status === "ok" && outcome.value ? outcome.value : null;
}
async function invokeLocalDesktopAgentRpc(baseUrl, options) {
    if (isDesktopExternalApiBaseUrl(baseUrl))
        return null;
    return invokeDesktopBridgeRequest(options);
}
// ---------------------------------------------------------------------------
// Prototype augmentation
// ---------------------------------------------------------------------------
ElizaClient.prototype.getStatus = async function () {
    // A shared-runtime cloud agent is provisioned and running cloud-side with no
    // agent server, so /api/status 404s and the readiness poll would wedge on
    // "Initializing agent…". Report it running (the provision response confirms
    // status:"running") so startup proceeds to chat — its REST adapter already
    // serves /api/conversations + /api/conversations/:id/messages.
    if (isDirectCloudSharedAgentBase(this.getBaseUrl())) {
        return {
            state: "running",
            agentName: "Eliza",
            model: undefined,
            // Cloud-shared agent is provisioned + serving cloud-side — first-turn
            // capability is online, so the composer should be live immediately.
            canRespond: true,
            uptime: undefined,
            startedAt: undefined,
        };
    }
    try {
        const viaRpc = await getDesktopStatusRpc(this.getBaseUrl(), "getAgentStatus");
        if (viaRpc)
            return viaRpc;
    }
    catch {
        /* fall through */
    }
    const nativeAgent = await androidNativeAgentLifecycleForUrl(this.getBaseUrl());
    if (nativeAgent?.getStatus) {
        const native = (await nativeAgent.getStatus());
        // The native lifecycle plugin reports the bun *process* state but not the
        // agent's first-turn readiness (`canRespond`) or loaded `model` — those
        // exist only in the HTTP `/api/status` the running agent serves. Without
        // them `deriveAgentReady` never flips, so the chat's `ready` gate stays
        // false forever ("waking up…") and voice / hands-free is blocked even though
        // the agent can answer. When the process is up but its status doesn't yet
        // confirm `canRespond`, fill the readiness fields from `/api/status`.
        if (native.state === "running" && native.canRespond !== true) {
            try {
                const http = (await this.fetch("/api/status"));
                if (http && typeof http === "object") {
                    return { ...native, ...http };
                }
            }
            catch {
                /* /api/status unreachable — fall back to the native lifecycle status */
            }
        }
        return native;
    }
    return this.fetch("/api/status");
};
ElizaClient.prototype.getBootProgress = async function () {
    try {
        return await getDesktopStatusRpc(this.getBaseUrl(), "bootProgress");
    }
    catch {
        // error-policy:J4 optional desktop RPC channel — null means "no boot
        // progress available here"; the startup UI keeps its HTTP-derived state.
        return null;
    }
};
ElizaClient.prototype.getLaunchProgress = async function () {
    try {
        return await getDesktopStatusRpc(this.getBaseUrl(), "launchProgress");
    }
    catch {
        // error-policy:J4 optional desktop RPC channel — null means "no launch
        // snapshot available here"; callers fall back to HTTP status polling.
        return null;
    }
};
ElizaClient.prototype.getAgentSelfStatus = async function () {
    try {
        const viaRpc = await getDesktopStatusRpc(this.getBaseUrl(), "getAgentSelfStatus");
        if (viaRpc)
            return viaRpc;
    }
    catch {
        /* fall through */
    }
    return this.fetch("/api/agent/self-status");
};
ElizaClient.prototype.getRuntimeSnapshot = async function (opts) {
    try {
        const viaRpc = await getDesktopStatusRpc(this.getBaseUrl(), "getRuntimeSnapshot", opts);
        if (viaRpc)
            return viaRpc;
    }
    catch {
        /* fall through */
    }
    const params = new URLSearchParams();
    if (typeof opts?.depth === "number")
        params.set("depth", String(opts.depth));
    if (typeof opts?.maxArrayLength === "number") {
        params.set("maxArrayLength", String(opts.maxArrayLength));
    }
    if (typeof opts?.maxObjectEntries === "number") {
        params.set("maxObjectEntries", String(opts.maxObjectEntries));
    }
    if (typeof opts?.maxStringLength === "number") {
        params.set("maxStringLength", String(opts.maxStringLength));
    }
    const qs = params.toString();
    return this.fetch(`/api/runtime${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.setAutomationMode = async function (mode) {
    try {
        const viaRpc = await invokeLocalDesktopAgentRpc(this.getBaseUrl(), {
            rpcMethod: "setAgentAutomationMode",
            ipcChannel: "agent:setAgentAutomationMode",
            params: { mode },
        });
        if (viaRpc)
            return { mode: viaRpc.mode };
    }
    catch {
        /* fall through */
    }
    return this.fetch("/api/permissions/automation-mode", {
        method: "PUT",
        body: JSON.stringify({ mode }),
    });
};
ElizaClient.prototype.setTradeMode = async function (mode) {
    if (isTradePermissionMode(mode)) {
        try {
            const viaRpc = await invokeLocalDesktopAgentRpc(this.getBaseUrl(), {
                rpcMethod: "setTradePermissionMode",
                ipcChannel: "agent:setTradePermissionMode",
                params: { mode },
            });
            if (viaRpc) {
                return {
                    ok: viaRpc.ok ?? true,
                    tradePermissionMode: viaRpc.tradePermissionMode,
                };
            }
        }
        catch {
            /* fall through */
        }
    }
    return this.fetch("/api/permissions/trade-mode", {
        method: "PUT",
        body: JSON.stringify({ mode }),
    });
};
ElizaClient.prototype.runTerminalCommand = async function (command) {
    return this.fetch("/api/terminal/run", {
        method: "POST",
        body: JSON.stringify({ command }),
    });
};
ElizaClient.prototype.getFirstRunStatus = async function () {
    // A shared-runtime cloud agent is provisioned on our behalf, so first-run is
    // complete by definition AND its REST adapter has no /api/first-run* surface.
    // Short-circuit here: otherwise the native-bridge RPC path (a local on-device
    // agent that auto-starts on stock phones) answers with ITS first-run state
    // ({complete:false}), and the HTTP path 404s — either way the app wrongly
    // re-enters onboarding instead of going to the cloud chat.
    if (isDirectCloudSharedAgentBase(this.getBaseUrl())) {
        return { complete: true, cloudProvisioned: true };
    }
    // Prefer typed Electrobun RPC. The bun-side composer throws
    // AgentNotReadyError if the agent has no port yet; we catch and
    // fall through to HTTP so the renderer's polling loop sees the
    // same "transport not ready" semantic as before RPC was wired.
    // Server contract: eliza/packages/agent/src/api/first-run-routes.ts.
    try {
        const viaRpc = await invokeLocalDesktopAgentRpc(this.getBaseUrl(), {
            rpcMethod: "getFirstRunStatus",
            ipcChannel: "agent",
        });
        if (viaRpc)
            return viaRpc;
    }
    catch {
        /* AgentNotReadyError or any RPC failure → fall through to HTTP */
    }
    return this.fetch("/api/first-run/status");
};
ElizaClient.prototype.getWalletKeys = async function () {
    return this.fetch("/api/wallet/keys");
};
ElizaClient.prototype.getWalletOsStoreStatus = async function () {
    return this.fetch("/api/wallet/os-store");
};
ElizaClient.prototype.postWalletOsStoreAction = async function (action) {
    return this.fetch("/api/wallet/os-store", {
        method: "POST",
        body: JSON.stringify({ action }),
    });
};
ElizaClient.prototype.getAuthStatus = async function () {
    // Prefer typed Electrobun RPC. Throws AgentNotReadyError when the
    // agent has no port yet — we catch and fall through to HTTP so the
    // existing retry/backoff loop handles the "not ready" semantic
    // exactly as it did before RPC was in the picture. NEVER fabricates
    // a 401-shaped fallback response (see the auth-client.ts authMe wrapper
    // history if you need the bug story).
    try {
        const viaRpc = await invokeLocalDesktopAgentRpc(this.getBaseUrl(), { rpcMethod: "getAuthStatus", ipcChannel: "agent" });
        if (viaRpc)
            return viaRpc;
    }
    catch {
        /* AgentNotReadyError or any RPC failure → fall through to HTTP */
    }
    const maxRetries = 3;
    const baseBackoffMs = 1000;
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await this.fetch("/api/auth/status");
        }
        catch (err) {
            const status = err?.status;
            if (status === 401) {
                return { required: true, pairingEnabled: false, expiresAt: null };
            }
            if (status === 404) {
                return { required: false, pairingEnabled: false, expiresAt: null };
            }
            lastErr = err;
            if (attempt < maxRetries) {
                await new Promise((r) => setTimeout(r, baseBackoffMs * 2 ** attempt));
            }
        }
    }
    throw lastErr;
};
ElizaClient.prototype.postBootstrapExchange = async function (token) {
    // Use allowNonOk so 401/429/503 bodies are parsed rather than thrown.
    const body = await this.fetch("/api/auth/bootstrap/exchange", {
        method: "POST",
        body: JSON.stringify({ token }),
    }, { allowNonOk: true });
    if (typeof body.sessionId === "string" &&
        typeof body.expiresAt === "number" &&
        typeof body.identityId === "string") {
        return {
            ok: true,
            sessionId: body.sessionId,
            expiresAt: body.expiresAt,
            identityId: body.identityId,
        };
    }
    // Map reason to an HTTP status bucket for the UI layer.
    const reason = body.reason;
    const status = reason === "rate_limited"
        ? 429
        : reason === "db_unavailable" ||
            reason === "missing_issuer_env" ||
            reason === "missing_container_env"
            ? 503
            : reason === "missing_token"
                ? 400
                : 401;
    return {
        ok: false,
        status,
        error: body.error ?? "exchange_failed",
        reason,
    };
};
ElizaClient.prototype.pair = async function (code) {
    const res = await this.fetch("/api/auth/pair", {
        method: "POST",
        body: JSON.stringify({ code }),
    });
    return res;
};
ElizaClient.prototype.getFirstRunOptions = async function () {
    try {
        const viaRpc = await invokeLocalDesktopAgentRpc(this.getBaseUrl(), {
            rpcMethod: "getFirstRunOptions",
            ipcChannel: "agent",
        });
        if (viaRpc)
            return viaRpc;
    }
    catch {
        /* AgentNotReadyError or any RPC failure → fall through to HTTP */
    }
    return this.fetch("/api/first-run/options");
};
ElizaClient.prototype.submitFirstRun = async function (data) {
    await this.fetch("/api/first-run", {
        method: "POST",
        body: JSON.stringify(data),
    });
};
ElizaClient.prototype.startAnthropicLogin = async function () {
    return this.fetch("/api/subscription/anthropic/start", { method: "POST" });
};
ElizaClient.prototype.exchangeAnthropicCode = async function (code) {
    return this.fetch("/api/subscription/anthropic/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
    });
};
ElizaClient.prototype.submitAnthropicSetupToken = async function (token) {
    return this.fetch("/api/subscription/anthropic/setup-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
    });
};
ElizaClient.prototype.getSubscriptionStatus = async function () {
    try {
        const viaRpc = await invokeLocalDesktopAgentRpc(this.getBaseUrl(), {
            rpcMethod: "getSubscriptionStatus",
            ipcChannel: "agent",
        });
        if (viaRpc)
            return viaRpc;
    }
    catch {
        /* fall through */
    }
    return this.fetch("/api/subscription/status");
};
ElizaClient.prototype.deleteSubscription = async function (provider) {
    return this.fetch(`/api/subscription/${encodeURIComponent(provider)}`, {
        method: "DELETE",
    });
};
ElizaClient.prototype.switchProvider = async function (provider, apiKey, primaryModel) {
    logSettingsClient("POST /api/provider/switch → start", {
        baseUrl: this.getBaseUrl(),
        provider,
        hasApiKey: Boolean(apiKey?.trim()),
        apiKey,
        hasPrimaryModel: Boolean(primaryModel?.trim()),
        primaryModel,
    });
    const result = (await this.fetch("/api/provider/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            provider,
            ...(apiKey ? { apiKey } : {}),
            ...(primaryModel ? { primaryModel } : {}),
        }),
    }));
    logSettingsClient("POST /api/provider/switch ← ok", {
        baseUrl: this.getBaseUrl(),
        result,
    });
    return result;
};
ElizaClient.prototype.startOpenAILogin = async function () {
    return this.fetch("/api/subscription/openai/start", { method: "POST" });
};
ElizaClient.prototype.exchangeOpenAICode = async function (code) {
    return this.fetch("/api/subscription/openai/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
    });
};
ElizaClient.prototype.startAgent = async function () {
    const nativeAgent = await androidNativeAgentLifecycleForUrl(this.getBaseUrl());
    if (nativeAgent?.start) {
        return (await nativeAgent.start());
    }
    const res = await this.fetch("/api/agent/start", {
        method: "POST",
    });
    return res.status;
};
ElizaClient.prototype.stopAgent = async function () {
    const nativeAgent = await androidNativeAgentLifecycleForUrl(this.getBaseUrl());
    if (nativeAgent?.stop) {
        await nativeAgent.stop();
        return {
            state: "stopped",
            agentName: "Eliza",
            port: undefined,
            startedAt: undefined,
        };
    }
    const res = await this.fetch("/api/agent/stop", {
        method: "POST",
    });
    return res.status;
};
ElizaClient.prototype.pauseAgent = async function () {
    const res = await this.fetch("/api/agent/pause", {
        method: "POST",
    });
    return res.status;
};
ElizaClient.prototype.resumeAgent = async function () {
    const res = await this.fetch("/api/agent/resume", {
        method: "POST",
    });
    return res.status;
};
ElizaClient.prototype.restartAgent = async function () {
    const nativeAgent = await androidNativeAgentLifecycleForUrl(this.getBaseUrl());
    if (nativeAgent?.start) {
        if (nativeAgent.stop) {
            await nativeAgent.stop();
        }
        return (await nativeAgent.start());
    }
    try {
        const res = await this.fetch("/api/agent/restart", {
            method: "POST",
        });
        return res.status;
    }
    catch {
        // Back-compat for older runtimes that still expose only the process-level
        // restart endpoint.
        await this.fetch("/api/restart", { method: "POST" });
        return {
            state: "restarting",
            agentName: "Eliza",
            model: undefined,
            uptime: undefined,
            startedAt: undefined,
        };
    }
};
ElizaClient.prototype.restartAndWait = async function (maxWaitMs = 30000) {
    try {
        await this.restartAgent();
    }
    catch {
        // 409 is expected while already restarting; poll will detect running state
    }
    const start = Date.now();
    const interval = 1000;
    while (Date.now() - start < maxWaitMs) {
        await new Promise((r) => setTimeout(r, interval));
        try {
            const status = await this.getStatus();
            if (status.state === "running") {
                return status;
            }
        }
        catch {
            // getStatus may fail while agent is restarting; keep polling
        }
    }
    return this.getStatus();
};
ElizaClient.prototype.resetAgent = async function () {
    await this.fetch("/api/agent/reset", { method: "POST" });
};
ElizaClient.prototype.restart = async function () {
    return this.fetch("/api/restart", { method: "POST" });
};
ElizaClient.prototype.getConfig = async function () {
    logSettingsClient("GET /api/config → start", {
        baseUrl: this.getBaseUrl(),
    });
    let viaRpc = null;
    try {
        viaRpc = await invokeLocalDesktopAgentRpc(this.getBaseUrl(), {
            rpcMethod: "getConfig",
            ipcChannel: "agent",
        });
    }
    catch {
        /* AgentNotReadyError or any RPC failure → fall through to HTTP */
    }
    const r = viaRpc ?? (await this.fetch("/api/config"));
    const cloud = r.cloud;
    logSettingsClient("GET /api/config ← ok", {
        baseUrl: this.getBaseUrl(),
        topKeys: Object.keys(r).sort(),
        cloud: settingsDebugCloudSummary(cloud),
        transport: viaRpc ? "rpc" : "http",
    });
    return r;
};
ElizaClient.prototype.getConfigSchema = async function () {
    try {
        const viaRpc = await invokeLocalDesktopAgentRpc(this.getBaseUrl(), {
            rpcMethod: "getConfigSchema",
            ipcChannel: "agent",
        });
        if (viaRpc)
            return viaRpc;
    }
    catch {
        /* fall through */
    }
    return this.fetch("/api/config/schema");
};
ElizaClient.prototype.updateConfig = async function (patch) {
    logSettingsClient("PUT /api/config → start", {
        baseUrl: this.getBaseUrl(),
        patch,
    });
    let out = null;
    let transport = "rpc";
    try {
        out = await invokeLocalDesktopAgentRpc(this.getBaseUrl(), {
            rpcMethod: "updateConfig",
            ipcChannel: "agent:updateConfig",
            params: patch,
        });
    }
    catch {
        out = null;
    }
    if (!out) {
        transport = "http";
        out = (await this.fetch("/api/config", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
        }, {
            timeoutMs: SETTINGS_MUTATION_TIMEOUT_MS,
        }));
    }
    const cloud = out.cloud;
    logSettingsClient("PUT /api/config ← ok", {
        baseUrl: this.getBaseUrl(),
        topKeys: Object.keys(out).sort(),
        cloud: settingsDebugCloudSummary(cloud),
        transport,
    });
    return out;
};
ElizaClient.prototype.getConnectors = async function () {
    return this.fetch("/api/connectors");
};
ElizaClient.prototype.saveConnector = async function (name, config) {
    return this.fetch("/api/connectors", {
        method: "POST",
        body: JSON.stringify({ name, config }),
    });
};
ElizaClient.prototype.deleteConnector = async function (name) {
    return this.fetch(`/api/connectors/${encodeURIComponent(name)}`, {
        method: "DELETE",
    });
};
function connectorAccountsPath(provider, _connectorId, accountId, action) {
    const base = `/api/connectors/${encodeURIComponent(provider)}/accounts`;
    if (!accountId)
        return base;
    const withAccount = `${base}/${encodeURIComponent(accountId)}`;
    return action ? `${withAccount}/${action}` : withAccount;
}
function connectorAccountOAuthPath(provider, action) {
    return `/api/connectors/${encodeURIComponent(provider)}/oauth/${action}`;
}
/**
 * Server connector-account role → UI role mapping (#12087 Item 32). Keys are the
 * uppercased server role strings; the value is the UI bucket. A server role NOT
 * in this table is genuinely unknown and maps to `undefined` — it is NOT
 * silently relabelled `OWNER` (the fail-open mislabel this replaced).
 */
export const CONNECTOR_SERVER_ROLE_TO_UI_ROLE = {
    OWNER: "OWNER",
    AGENT: "AGENT",
    SERVICE: "AGENT",
    TEAM: "TEAM",
    ADMIN: "TEAM",
    MEMBER: "TEAM",
    VIEWER: "TEAM",
};
function normalizeConnectorAccountRole(value) {
    if (typeof value !== "string" || !value.trim())
        return undefined;
    return CONNECTOR_SERVER_ROLE_TO_UI_ROLE[value.trim().toUpperCase()];
}
function normalizeConnectorStatus(value) {
    switch (value) {
        case "connected":
        case "pending":
        case "needs-reauth":
        case "disconnected":
        case "error":
            return value;
        case "disabled":
        case "revoked":
            return "disconnected";
        default:
            return "unknown";
    }
}
function isConnectorRoleValue(value) {
    return normalizeConnectorAccountRole(value) !== undefined;
}
function normalizeConnectorPurposeList(value) {
    const values = Array.isArray(value)
        ? value
        : typeof value === "string"
            ? [value]
            : [];
    return values
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter((item) => Boolean(item) && !isConnectorRoleValue(item));
}
function recordFromUnknown(raw) {
    return raw && typeof raw === "object" && !Array.isArray(raw)
        ? raw
        : {};
}
function nonEmptyString(value) {
    return typeof value === "string" && value.trim() ? value : null;
}
function connectorAccountLabel(record) {
    return (nonEmptyString(record.label) ??
        nonEmptyString(record.displayHandle) ??
        nonEmptyString(record.handle) ??
        nonEmptyString(record.externalId) ??
        String(record.id ?? "unknown"));
}
function connectorAccountHandle(record) {
    return typeof record.handle === "string"
        ? record.handle
        : typeof record.displayHandle === "string"
            ? record.displayHandle
            : null;
}
function connectorAccountMetadata(record) {
    return record.metadata && typeof record.metadata === "object"
        ? record.metadata
        : undefined;
}
export function normalizeConnectorAccountRecord(provider, connectorId, raw) {
    const record = recordFromUnknown(raw);
    // #12087 Item 32: an unrecognized/missing server role stays `undefined` — it
    // is NOT defaulted to OWNER. The UI renders such accounts outside the Owner
    // section (ConnectorAccountList "UNKNOWN" bucket) rather than mislabelling
    // them as the owner's own account.
    const role = normalizeConnectorAccountRole(record.role) ??
        normalizeConnectorAccountRole(record.purpose);
    return {
        ...record,
        id: String(record.id ?? ""),
        provider: typeof record.provider === "string" && record.provider
            ? record.provider
            : provider,
        connectorId,
        label: connectorAccountLabel(record),
        handle: connectorAccountHandle(record),
        externalId: typeof record.externalId === "string" ? record.externalId : null,
        status: normalizeConnectorStatus(record.status),
        role,
        purpose: normalizeConnectorPurposeList(record.purpose),
        isDefault: record.isDefault === true,
        enabled: record.enabled !== false,
        metadata: connectorAccountMetadata(record),
    };
}
function normalizeConnectorAccountsListResponse(provider, connectorId, raw) {
    const record = raw && typeof raw === "object" && !Array.isArray(raw)
        ? raw
        : {};
    const accounts = Array.isArray(record.accounts)
        ? record.accounts.map((item) => normalizeConnectorAccountRecord(provider, connectorId, item))
        : [];
    const defaultAccountId = typeof record.defaultAccountId === "string"
        ? record.defaultAccountId
        : (accounts.find((account) => account.isDefault === true &&
            account.enabled !== false &&
            account.status === "connected")?.id ?? null);
    return {
        provider: typeof record.provider === "string" && record.provider
            ? record.provider
            : provider,
        connectorId,
        defaultAccountId,
        accounts,
    };
}
function normalizeConnectorAccountActionResult(provider, connectorId, raw) {
    const record = recordFromUnknown(raw);
    const account = record.account ?? (typeof record.id === "string" ? record : null);
    const flow = recordFromUnknown(record.flow);
    return {
        ...record,
        ok: normalizeConnectorActionOk(record, account),
        account: account
            ? normalizeConnectorAccountRecord(provider, connectorId, account)
            : undefined,
        accounts: Array.isArray(record.accounts)
            ? record.accounts.map((item) => normalizeConnectorAccountRecord(provider, connectorId, item))
            : undefined,
        defaultAccountId: typeof record.defaultAccountId === "string"
            ? record.defaultAccountId
            : null,
        flow: Object.keys(flow).length > 0 ? flow : undefined,
        authUrl: connectorActionAuthUrl(record, flow),
        status: connectorActionStatus(record, flow),
        error: typeof record.error === "string" ? record.error : undefined,
    };
}
function normalizeConnectorActionOk(record, account) {
    return typeof record.ok === "boolean"
        ? record.ok
        : record.deleted === true || (!("error" in record) && account !== null);
}
function connectorActionAuthUrl(record, flow) {
    if (typeof record.authUrl === "string")
        return record.authUrl;
    return typeof flow.authUrl === "string" ? flow.authUrl : undefined;
}
function connectorActionStatus(record, flow) {
    if (typeof record.status === "string") {
        return normalizeConnectorStatus(record.status);
    }
    return typeof flow.status === "string"
        ? normalizeConnectorStatus(flow.status)
        : undefined;
}
function connectorAccountAuditPath(provider, query = {}) {
    const params = new URLSearchParams();
    if (query.accountId)
        params.set("accountId", query.accountId);
    if (query.action)
        params.set("action", query.action);
    if (query.outcome)
        params.set("outcome", query.outcome);
    if (typeof query.limit === "number") {
        params.set("limit", String(query.limit));
    }
    const qs = params.toString();
    return `/api/connectors/${encodeURIComponent(provider)}/audit/events${qs ? `?${qs}` : ""}`;
}
ElizaClient.prototype.listConnectorAccounts = async function (provider, connectorId = provider) {
    const response = await this.fetch(connectorAccountsPath(provider, connectorId));
    return normalizeConnectorAccountsListResponse(provider, connectorId, response);
};
ElizaClient.prototype.addConnectorAccount = async function (provider, connectorId = provider, body = {}) {
    const response = await this.fetch(connectorAccountsPath(provider, connectorId), {
        method: "POST",
        body: JSON.stringify(body),
    });
    return normalizeConnectorAccountActionResult(provider, connectorId, response);
};
ElizaClient.prototype.startConnectorAccountOAuth = async function (provider, connectorId = provider, body = {}) {
    const response = await this.fetch(connectorAccountOAuthPath(provider, "start"), {
        method: "POST",
        body: JSON.stringify(body),
    });
    return normalizeConnectorAccountActionResult(provider, connectorId, response);
};
ElizaClient.prototype.patchConnectorAccount = async function (provider, connectorId = provider, accountId, body) {
    const response = await this.fetch(connectorAccountsPath(provider, connectorId, accountId), {
        method: "PATCH",
        body: JSON.stringify(body),
    });
    return normalizeConnectorAccountRecord(provider, connectorId, response);
};
ElizaClient.prototype.testConnectorAccount = async function (provider, connectorId = provider, accountId) {
    const response = await this.fetch(connectorAccountsPath(provider, connectorId, accountId, "test"), { method: "POST" });
    return normalizeConnectorAccountActionResult(provider, connectorId, response);
};
ElizaClient.prototype.refreshConnectorAccount = async function (provider, connectorId = provider, accountId) {
    const response = await this.fetch(connectorAccountsPath(provider, connectorId, accountId, "refresh"), { method: "POST" });
    return normalizeConnectorAccountActionResult(provider, connectorId, response);
};
ElizaClient.prototype.deleteConnectorAccount = async function (provider, connectorId = provider, accountId) {
    const response = await this.fetch(connectorAccountsPath(provider, connectorId, accountId), { method: "DELETE" });
    return normalizeConnectorAccountActionResult(provider, connectorId, response);
};
ElizaClient.prototype.makeDefaultConnectorAccount = async function (provider, connectorId = provider, accountId) {
    const response = await this.fetch(connectorAccountsPath(provider, connectorId, accountId, "default"), { method: "POST" });
    return normalizeConnectorAccountActionResult(provider, connectorId, response);
};
ElizaClient.prototype.listConnectorAccountAuditEvents = async function (provider, query = {}) {
    return this.fetch(connectorAccountAuditPath(provider, query));
};
ElizaClient.prototype.getTriggers = async function () {
    return this.fetch("/api/triggers");
};
ElizaClient.prototype.getTrigger = async function (id) {
    return this.fetch(`/api/triggers/${encodeURIComponent(id)}`);
};
ElizaClient.prototype.createTrigger = async function (request) {
    return this.fetch("/api/triggers", {
        method: "POST",
        body: JSON.stringify(request),
    });
};
ElizaClient.prototype.updateTrigger = async function (id, request) {
    return this.fetch(`/api/triggers/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(request),
    });
};
ElizaClient.prototype.deleteTrigger = async function (id) {
    return this.fetch(`/api/triggers/${encodeURIComponent(id)}`, {
        method: "DELETE",
    });
};
ElizaClient.prototype.runTriggerNow = async function (id) {
    return this.fetch(`/api/triggers/${encodeURIComponent(id)}/execute`, {
        method: "POST",
    });
};
ElizaClient.prototype.getTriggerRuns = async function (id) {
    return this.fetch(`/api/triggers/${encodeURIComponent(id)}/runs`);
};
ElizaClient.prototype.emitTriggerEvent = async function (eventKind, payload = {}) {
    return this.fetch(`/api/triggers/events/${encodeURIComponent(eventKind)}`, {
        method: "POST",
        body: JSON.stringify({ payload }),
    });
};
ElizaClient.prototype.getTriggerHealth = async function () {
    try {
        const viaRpc = await invokeLocalDesktopAgentRpc(this.getBaseUrl(), {
            rpcMethod: "getTriggerHealth",
            ipcChannel: "agent",
        });
        if (viaRpc)
            return viaRpc;
    }
    catch {
        /* fall through */
    }
    return this.fetch("/api/triggers/health");
};
ElizaClient.prototype.getTrainingStatus = async function () {
    return this.fetch("/api/training/status");
};
ElizaClient.prototype.listTrainingTrajectories = async function (opts) {
    const params = new URLSearchParams();
    if (typeof opts?.limit === "number")
        params.set("limit", String(opts.limit));
    if (typeof opts?.offset === "number")
        params.set("offset", String(opts.offset));
    const qs = params.toString();
    return this.fetch(`/api/training/trajectories${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.getTrainingTrajectory = async function (trajectoryId) {
    return this.fetch(`/api/training/trajectories/${encodeURIComponent(trajectoryId)}`);
};
ElizaClient.prototype.listTrainingDatasets = async function () {
    return this.fetch("/api/training/datasets");
};
ElizaClient.prototype.buildTrainingDataset = async function (options) {
    return this.fetch("/api/training/datasets/build", {
        method: "POST",
        body: JSON.stringify(options ?? {}),
    });
};
ElizaClient.prototype.writeTrainingBenchmarkMatrix = async function (options) {
    return this.fetch("/api/training/benchmarks/matrix", {
        method: "POST",
        body: JSON.stringify(options),
    });
};
ElizaClient.prototype.listTrainingJobs = async function () {
    return this.fetch("/api/training/jobs");
};
ElizaClient.prototype.startTrainingJob = async function (options) {
    return this.fetch("/api/training/jobs", {
        method: "POST",
        body: JSON.stringify(options ?? {}),
    });
};
ElizaClient.prototype.getTrainingJob = async function (jobId) {
    return this.fetch(`/api/training/jobs/${encodeURIComponent(jobId)}`);
};
ElizaClient.prototype.cancelTrainingJob = async function (jobId) {
    return this.fetch(`/api/training/jobs/${encodeURIComponent(jobId)}/cancel`, {
        method: "POST",
    });
};
function trainingModelRecordFromVastRegistry(item, loadedAt) {
    const entry = item.entry;
    const id = item.short_name ?? entry?.eliza_short_name;
    if (!id || !entry)
        return null;
    return {
        id,
        createdAt: loadedAt ?? "",
        jobId: `vast-registry:${id}`,
        outputDir: entry.gguf_repo_id ?? entry.eliza_repo_id ?? "",
        modelPath: entry.gguf_repo_id ?? entry.eliza_repo_id ?? id,
        adapterPath: null,
        sourceModel: entry.base_hf_id ?? null,
        backend: "cuda",
        ollamaModel: null,
        active: false,
        benchmark: {
            status: "not_run",
            lastRunAt: null,
            output: entry.tier
                ? `Eliza-1 ${entry.tier} registry entry`
                : "Eliza-1 registry entry",
        },
    };
}
ElizaClient.prototype.listTrainingModels = async function () {
    const listed = await this.fetch("/api/training/models");
    if (Array.isArray(listed.models) && listed.models.length > 0) {
        return { models: listed.models };
    }
    try {
        const registry = await this.fetch("/api/training/vast/models");
        const registryModels = (registry.entries ?? [])
            .map((item) => trainingModelRecordFromVastRegistry(item, registry.loaded_at))
            .filter((model) => model !== null);
        if (registryModels.length > 0)
            return { models: registryModels };
    }
    catch {
        // The legacy training service and Vast registry are optional independent
        // surfaces; keep the legacy response when the registry is unavailable.
    }
    return { models: listed.models ?? [] };
};
ElizaClient.prototype.importTrainingModelToOllama = async function (modelId, options) {
    return this.fetch(`/api/training/models/${encodeURIComponent(modelId)}/import-ollama`, {
        method: "POST",
        body: JSON.stringify(options ?? {}),
    });
};
ElizaClient.prototype.activateTrainingModel = async function (modelId, providerModel) {
    return this.fetch(`/api/training/models/${encodeURIComponent(modelId)}/activate`, {
        method: "POST",
        body: JSON.stringify({ providerModel }),
    });
};
ElizaClient.prototype.benchmarkTrainingModel = async function (modelId) {
    return this.fetch(`/api/training/models/${encodeURIComponent(modelId)}/benchmark`, { method: "POST" });
};
ElizaClient.prototype.buildTrainingAnalysisIndex = async function (options) {
    return this.fetch("/api/training/analysis/index", {
        method: "POST",
        body: JSON.stringify(options ?? {}),
    });
};
ElizaClient.prototype.buildTrainingReadinessReport = async function (options) {
    return this.fetch("/api/training/analysis/readiness", {
        method: "POST",
        body: JSON.stringify(options ?? {}),
    });
};
ElizaClient.prototype.ingestHuggingFaceTrainingDataset = async function (options) {
    return this.fetch("/api/training/datasets/ingest-hf", {
        method: "POST",
        body: JSON.stringify(options ?? {}),
    });
};
ElizaClient.prototype.stageEliza1Bundle = async function (options) {
    return this.fetch("/api/training/models/stage-eliza1-bundle", {
        method: "POST",
        body: JSON.stringify(options ?? {}),
    });
};
ElizaClient.prototype.runFeedTrainingGeneration = async function (options) {
    return this.fetch("/api/training/feed/generate", {
        method: "POST",
        body: JSON.stringify(options ?? {}),
    });
};
ElizaClient.prototype.runTrainingScenarios = async function (options) {
    return this.fetch("/api/training/scenarios/run", {
        method: "POST",
        body: JSON.stringify(options ?? {}),
    });
};
ElizaClient.prototype.runTrainingActionBenchmark = async function (options) {
    return this.fetch("/api/training/benchmarks/action-selection/run", {
        method: "POST",
        body: JSON.stringify(options ?? {}),
    });
};
ElizaClient.prototype.runTrainingBenchmarkVsCerebras = async function (options) {
    return this.fetch("/api/training/benchmarks/run-vs-cerebras", {
        method: "POST",
        body: JSON.stringify(options ?? {}),
    });
};
ElizaClient.prototype.runTrainingLocalEvalComparison = async function (options) {
    return this.fetch("/api/training/evals/run-local-comparison", {
        method: "POST",
        body: JSON.stringify(options ?? {}),
    });
};
ElizaClient.prototype.runTrainingCollection = async function (options) {
    return this.fetch("/api/training/collect", {
        method: "POST",
        body: JSON.stringify(options ?? {}),
    });
};
ElizaClient.prototype.listTrainingCollections = async function (options) {
    const params = new URLSearchParams();
    if (options?.limit !== undefined) {
        params.set("limit", String(options.limit));
    }
    if (options?.root) {
        params.set("root", options.root);
    }
    const query = params.toString();
    return this.fetch(`/api/training/collections${query ? `?${query}` : ""}`);
};
ElizaClient.prototype.getPlugins = async function () {
    return this.fetch("/api/plugins");
};
ElizaClient.prototype.fetchModels = async function (provider, refresh = true) {
    const params = new URLSearchParams({ provider });
    if (refresh)
        params.set("refresh", "true");
    return this.fetch(`/api/models?${params.toString()}`);
};
ElizaClient.prototype.getCorePlugins = async function () {
    try {
        const viaRpc = await invokeLocalDesktopAgentRpc(this.getBaseUrl(), {
            rpcMethod: "getCorePlugins",
            ipcChannel: "agent",
        });
        if (viaRpc)
            return viaRpc;
    }
    catch {
        /* fall through */
    }
    return this.fetch("/api/plugins/core");
};
ElizaClient.prototype.toggleCorePlugin = async function (npmName, enabled) {
    return this.fetch("/api/plugins/core/toggle", {
        method: "POST",
        body: JSON.stringify({ npmName, enabled }),
    });
};
ElizaClient.prototype.updatePlugin = async function (id, config) {
    logSettingsClient(`PUT /api/plugins/${id} → start`, {
        baseUrl: this.getBaseUrl(),
        body: config,
    });
    const result = (await this.fetch(`/api/plugins/${id}`, {
        method: "PUT",
        body: JSON.stringify(config),
    }, {
        timeoutMs: SETTINGS_MUTATION_TIMEOUT_MS,
    }));
    logSettingsClient(`PUT /api/plugins/${id} ← ok`, {
        baseUrl: this.getBaseUrl(),
        result,
    });
    return result;
};
ElizaClient.prototype.getSecrets = async function () {
    return this.fetch("/api/secrets");
};
ElizaClient.prototype.updateSecrets = async function (secrets) {
    logSettingsClient("PUT /api/secrets → start", {
        baseUrl: this.getBaseUrl(),
        secretMeta: Object.keys(secrets)
            .sort()
            .map((key) => ({
            key,
            hasValue: Boolean(secrets[key]),
        })),
    });
    const out = (await this.fetch("/api/secrets", {
        method: "PUT",
        body: JSON.stringify({ secrets }),
    }));
    logSettingsClient("PUT /api/secrets ← ok", {
        baseUrl: this.getBaseUrl(),
        out,
    });
    return out;
};
ElizaClient.prototype.tunnelCredential = async function (input) {
    // SECURITY: never log the value. Only the scope/session/key are safe to
    // surface for debugging.
    logSettingsClient("POST /api/credential-tunnel → start", {
        baseUrl: this.getBaseUrl(),
        credentialScopeId: input.credentialScopeId,
        childSessionId: input.childSessionId,
        key: input.key,
        hasValue: Boolean(input.value),
    });
    const out = (await this.fetch("/api/credential-tunnel", {
        method: "POST",
        body: JSON.stringify(input),
    }));
    logSettingsClient("POST /api/credential-tunnel ← ok", {
        baseUrl: this.getBaseUrl(),
        credentialScopeId: out.credentialScopeId,
        childSessionId: out.childSessionId,
        key: out.key,
        ok: out.ok,
    });
    return out;
};
ElizaClient.prototype.testPluginConnection = async function (id) {
    return this.fetch(`/api/plugins/${encodeURIComponent(id)}/test`, {
        method: "POST",
    });
};
ElizaClient.prototype.getLogs = async function (filter) {
    const params = new URLSearchParams();
    if (filter?.source)
        params.set("source", filter.source);
    if (filter?.level)
        params.set("level", filter.level);
    if (filter?.tag)
        params.set("tag", filter.tag);
    if (filter?.since)
        params.set("since", String(filter.since));
    const qs = params.toString();
    return this.fetch(`/api/logs${qs ? `?${qs}` : ""}`);
};
// buildSecurityAuditParams is a private helper used only by agent audit methods
function buildSecurityAuditParams(filter, includeStream = false) {
    const params = new URLSearchParams();
    if (filter?.type)
        params.set("type", filter.type);
    if (filter?.severity)
        params.set("severity", filter.severity);
    if (filter?.since !== undefined) {
        const sinceValue = filter.since instanceof Date
            ? filter.since.toISOString()
            : String(filter.since);
        params.set("since", sinceValue);
    }
    if (filter?.limit !== undefined)
        params.set("limit", String(filter.limit));
    if (includeStream)
        params.set("stream", "1");
    return params;
}
async function throwSecurityAuditResponseError(res) {
    const body = (await res
        .json()
        .catch(() => ({ error: res.statusText })));
    const err = new Error(body?.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
}
function findSseEventBreak(chunkBuffer) {
    const lfBreak = chunkBuffer.indexOf("\n\n");
    const crlfBreak = chunkBuffer.indexOf("\r\n\r\n");
    if (lfBreak === -1 && crlfBreak === -1)
        return null;
    if (lfBreak === -1)
        return { index: crlfBreak, length: 4 };
    if (crlfBreak === -1)
        return { index: lfBreak, length: 2 };
    return lfBreak < crlfBreak
        ? { index: lfBreak, length: 2 }
        : { index: crlfBreak, length: 4 };
}
function parseSecurityAuditPayload(payload, onEvent) {
    if (!payload)
        return;
    try {
        const parsed = JSON.parse(payload);
        if (parsed.type === "snapshot" || parsed.type === "entry") {
            onEvent(parsed);
        }
    }
    catch (error) {
        console.warn("[client-agent] dropped malformed security audit stream frame", { payload, error });
    }
}
function consumeSecurityAuditEvent(rawEvent, onEvent) {
    for (const line of rawEvent.split(/\r?\n/)) {
        if (!line.startsWith("data:"))
            continue;
        parseSecurityAuditPayload(line.slice(5).trim(), onEvent);
    }
}
async function readSecurityAuditStream(body, onEvent) {
    const decoder = new TextDecoder();
    const reader = body.getReader();
    let buffer = "";
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        buffer += decoder.decode(value, { stream: true });
        let eventBreak = findSseEventBreak(buffer);
        while (eventBreak) {
            const rawEvent = buffer.slice(0, eventBreak.index);
            buffer = buffer.slice(eventBreak.index + eventBreak.length);
            consumeSecurityAuditEvent(rawEvent, onEvent);
            eventBreak = findSseEventBreak(buffer);
        }
    }
    if (buffer.trim())
        consumeSecurityAuditEvent(buffer, onEvent);
}
ElizaClient.prototype.getSecurityAudit = async function (filter) {
    const qs = buildSecurityAuditParams(filter).toString();
    return this.fetch(`/api/security/audit${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.streamSecurityAudit = async function (onEvent, filter, signal) {
    if (!this.apiAvailable) {
        throw new Error("API not available (no HTTP origin)");
    }
    const token = this.apiToken;
    const qs = buildSecurityAuditParams(filter, true).toString();
    const res = await this.rawRequest(`/api/security/audit${qs ? `?${qs}` : ""}`, {
        method: "GET",
        headers: {
            Accept: "text/event-stream",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal,
    }, { allowNonOk: true });
    if (!res.ok) {
        await throwSecurityAuditResponseError(res);
    }
    if (!res.body) {
        throw new Error("Streaming not supported by this browser");
    }
    await readSecurityAuditStream(res.body, onEvent);
};
ElizaClient.prototype.getAgentEvents = async function (opts) {
    const params = new URLSearchParams();
    if (opts?.afterEventId)
        params.set("after", opts.afterEventId);
    if (typeof opts?.limit === "number")
        params.set("limit", String(opts.limit));
    if (opts?.runId)
        params.set("runId", opts.runId);
    if (typeof opts?.fromSeq === "number")
        params.set("fromSeq", String(Math.trunc(opts.fromSeq)));
    const qs = params.toString();
    return this.fetch(`/api/agent/events${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.getExtensionStatus = async function () {
    try {
        const viaRpc = await invokeLocalDesktopAgentRpc(this.getBaseUrl(), {
            rpcMethod: "getExtensionStatus",
            ipcChannel: "agent",
        });
        if (viaRpc)
            return viaRpc;
    }
    catch {
        /* fall through */
    }
    return this.fetch("/api/extension/status");
};
ElizaClient.prototype.getRelationshipsGraph = async function (query) {
    const params = new URLSearchParams();
    if (query?.search)
        params.set("search", query.search);
    if (query?.platform)
        params.set("platform", query.platform);
    if (query?.scope)
        params.set("scope", query.scope);
    if (typeof query?.limit === "number")
        params.set("limit", String(query.limit));
    if (typeof query?.offset === "number")
        params.set("offset", String(query.offset));
    const qs = params.toString();
    const response = await this.fetch(`/api/relationships/graph${qs ? `?${qs}` : ""}`);
    return response.data;
};
ElizaClient.prototype.getRelationshipsPeople = async function (query) {
    const params = new URLSearchParams();
    if (query?.search)
        params.set("search", query.search);
    if (query?.platform)
        params.set("platform", query.platform);
    if (query?.scope)
        params.set("scope", query.scope);
    if (typeof query?.limit === "number")
        params.set("limit", String(query.limit));
    if (typeof query?.offset === "number")
        params.set("offset", String(query.offset));
    const qs = params.toString();
    const response = await this.fetch(`/api/relationships/people${qs ? `?${qs}` : ""}`);
    return {
        people: response.data,
        stats: response.stats,
    };
};
ElizaClient.prototype.getRelationshipsPerson = async function (id) {
    const response = await this.fetch(`/api/relationships/people/${encodeURIComponent(id)}`);
    return response.data;
};
ElizaClient.prototype.getRelationshipsActivity = async function (limit, offset) {
    const params = new URLSearchParams();
    if (typeof limit === "number")
        params.set("limit", String(limit));
    if (typeof offset === "number")
        params.set("offset", String(offset));
    const qs = params.toString();
    return this.fetch(`/api/relationships/activity${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.getRelationshipsCandidates = async function () {
    const response = await this.fetch("/api/relationships/candidates");
    return response.data;
};
ElizaClient.prototype.acceptRelationshipsCandidate = async function (candidateId) {
    const response = await this.fetch(`/api/relationships/candidates/${encodeURIComponent(candidateId)}/accept`, { method: "POST" });
    return response.data;
};
ElizaClient.prototype.rejectRelationshipsCandidate = async function (candidateId) {
    const response = await this.fetch(`/api/relationships/candidates/${encodeURIComponent(candidateId)}/reject`, { method: "POST" });
    return response.data;
};
ElizaClient.prototype.proposeRelationshipsLink = async function (sourceEntityId, targetEntityId, evidence) {
    const response = await this.fetch(`/api/relationships/people/${encodeURIComponent(sourceEntityId)}/link`, {
        method: "POST",
        body: JSON.stringify({
            targetEntityId,
            evidence: evidence ?? {},
        }),
        headers: { "Content-Type": "application/json" },
    });
    return response.data;
};
ElizaClient.prototype.getCharacter = async function () {
    // RPC composer forwards the `/api/character` body verbatim, so the
    // wire shape is `{ character, agentName }` — bun-side just types it
    // loosely as Record. Catch swallows AgentNotReadyError + transport
    // failure → fall through to HTTP.
    try {
        const viaRpc = await invokeLocalDesktopAgentRpc(this.getBaseUrl(), { rpcMethod: "getCharacter", ipcChannel: "agent" });
        if (viaRpc)
            return viaRpc;
    }
    catch {
        /* fall through */
    }
    return this.fetch("/api/character");
};
ElizaClient.prototype.getRandomName = async function () {
    return this.fetch("/api/character/random-name");
};
ElizaClient.prototype.generateCharacterField = async function (field, context, mode) {
    return this.fetch("/api/character/generate", {
        method: "POST",
        body: JSON.stringify({ field, context, mode }),
    });
};
ElizaClient.prototype.updateCharacter = async function (character) {
    return this.fetch("/api/character", {
        method: "PUT",
        body: JSON.stringify(character),
    });
};
ElizaClient.prototype.listCharacterHistory = async function (options) {
    const params = new URLSearchParams();
    if (typeof options?.limit === "number") {
        params.set("limit", String(options.limit));
    }
    if (typeof options?.offset === "number") {
        params.set("offset", String(options.offset));
    }
    const qs = params.toString();
    return this.fetch(`/api/character/history${qs ? `?${qs}` : ""}`);
};
function appendMultiQueryParam(params, key, value) {
    if (Array.isArray(value)) {
        value
            .map((item) => item.trim())
            .filter(Boolean)
            .forEach((item) => {
            params.append(key, item);
        });
        return;
    }
    if (typeof value === "string" && value.trim()) {
        params.append(key, value.trim());
    }
}
function appendTrimmedQueryParam(params, key, value) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed)
        params.set(key, trimmed);
}
function appendNumberQueryParam(params, key, value) {
    if (typeof value === "number")
        params.set(key, String(value));
}
function appendBooleanQueryParam(params, key, value) {
    if (typeof value === "boolean")
        params.set(key, String(value));
}
function appendExperienceScalarParams(params, options, includeOffset) {
    appendNumberQueryParam(params, "limit", options?.limit);
    if (includeOffset)
        appendNumberQueryParam(params, "offset", options?.offset);
    appendTrimmedQueryParam(params, "q", options?.q);
    appendTrimmedQueryParam(params, "query", options?.query);
    appendNumberQueryParam(params, "minConfidence", options?.minConfidence);
    appendNumberQueryParam(params, "minImportance", options?.minImportance);
    appendBooleanQueryParam(params, "includeRelated", options?.includeRelated);
}
function appendExperienceCollectionParams(params, options) {
    appendMultiQueryParam(params, "type", options?.type);
    appendMultiQueryParam(params, "outcome", options?.outcome);
    appendMultiQueryParam(params, "domain", options?.domain);
    options?.tags
        ?.map((tag) => tag.trim())
        .filter(Boolean)
        .forEach((tag) => {
        params.append("tag", tag);
    });
}
function buildExperienceQueryParams(options, includeOffset) {
    const params = new URLSearchParams();
    appendExperienceScalarParams(params, options, includeOffset);
    appendExperienceCollectionParams(params, options);
    return params;
}
ElizaClient.prototype.listExperiences = async function (options) {
    const params = buildExperienceQueryParams(options, true);
    const qs = params.toString();
    const response = await this.fetch(`/api/character/experiences${qs ? `?${qs}` : ""}`);
    return {
        experiences: response.data,
        total: response.total,
    };
};
ElizaClient.prototype.getExperienceGraph = async function (options) {
    const params = buildExperienceQueryParams(options, false);
    const qs = params.toString();
    const response = await this.fetch(`/api/character/experiences/graph${qs ? `?${qs}` : ""}`);
    return { graph: response.data };
};
ElizaClient.prototype.runExperienceMaintenance = async function (options) {
    const response = await this.fetch("/api/character/experiences/maintenance", {
        method: "POST",
        body: JSON.stringify(options ?? {}),
    });
    return { result: response.data };
};
ElizaClient.prototype.getExperience = async function (id) {
    const response = await this.fetch(`/api/character/experiences/${encodeURIComponent(id)}`);
    return { experience: response.data };
};
ElizaClient.prototype.updateExperience = async function (id, data) {
    const response = await this.fetch(`/api/character/experiences/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(data),
    });
    return { experience: response.data };
};
ElizaClient.prototype.deleteExperience = async function (id) {
    return this.fetch(`/api/character/experiences/${encodeURIComponent(id)}`, {
        method: "DELETE",
    });
};
ElizaClient.prototype.getUpdateStatus = async function (force = false) {
    try {
        const viaRpc = await invokeLocalDesktopAgentRpc(this.getBaseUrl(), {
            rpcMethod: "getUpdateStatus",
            ipcChannel: "agent",
            params: { force },
        });
        if (viaRpc)
            return viaRpc;
    }
    catch {
        /* fall through */
    }
    return this.fetch(`/api/update/status${force ? "?force=true" : ""}`);
};
ElizaClient.prototype.setUpdateChannel = async function (channel) {
    return this.fetch("/api/update/channel", {
        method: "PUT",
        body: JSON.stringify({ channel }),
    });
};
ElizaClient.prototype.getAgentAutomationMode = async function () {
    try {
        const viaRpc = await invokeLocalDesktopAgentRpc(this.getBaseUrl(), {
            rpcMethod: "getAgentAutomationMode",
            ipcChannel: "agent:getAgentAutomationMode",
        });
        if (viaRpc)
            return viaRpc;
    }
    catch {
        /* fall through */
    }
    return this.fetch("/api/permissions/automation-mode");
};
ElizaClient.prototype.setAgentAutomationMode = async function (mode) {
    try {
        const viaRpc = await invokeLocalDesktopAgentRpc(this.getBaseUrl(), {
            rpcMethod: "setAgentAutomationMode",
            ipcChannel: "agent:setAgentAutomationMode",
            params: { mode },
        });
        if (viaRpc)
            return viaRpc;
    }
    catch {
        /* fall through */
    }
    return this.fetch("/api/permissions/automation-mode", {
        method: "PUT",
        body: JSON.stringify({ mode }),
    });
};
ElizaClient.prototype.getTradePermissionMode = async function () {
    try {
        const viaRpc = await invokeLocalDesktopAgentRpc(this.getBaseUrl(), {
            rpcMethod: "getTradePermissionMode",
            ipcChannel: "agent:getTradePermissionMode",
        });
        if (viaRpc)
            return viaRpc;
    }
    catch {
        /* fall through */
    }
    return this.fetch("/api/permissions/trade-mode");
};
ElizaClient.prototype.setTradePermissionMode = async function (mode) {
    try {
        const viaRpc = await invokeLocalDesktopAgentRpc(this.getBaseUrl(), {
            rpcMethod: "setTradePermissionMode",
            ipcChannel: "agent:setTradePermissionMode",
            params: { mode },
        });
        if (viaRpc)
            return viaRpc;
    }
    catch {
        /* fall through */
    }
    return this.fetch("/api/permissions/trade-mode", {
        method: "PUT",
        body: JSON.stringify({ mode }),
    });
};
ElizaClient.prototype.getPermissions = async function () {
    const permissions = await this.fetch("/api/permissions");
    const plugin = getNativeWebsiteBlockerPluginIfAvailable();
    if (!plugin) {
        return permissions;
    }
    const permission = mapWebsiteBlockerStatusToPermission(await plugin.getStatus());
    return {
        ...permissions,
        [WEBSITE_BLOCKING_PERMISSION_ID]: permission,
    };
};
ElizaClient.prototype.getPermission = async function (id) {
    if (id === WEBSITE_BLOCKING_PERMISSION_ID) {
        const plugin = getNativeWebsiteBlockerPluginIfAvailable();
        if (plugin) {
            return mapWebsiteBlockerStatusToPermission(await plugin.getStatus());
        }
    }
    return this.fetch(`/api/permissions/${id}`);
};
ElizaClient.prototype.requestPermission = async function (id) {
    if (id === WEBSITE_BLOCKING_PERMISSION_ID) {
        const plugin = getNativeWebsiteBlockerPluginIfAvailable();
        if (plugin) {
            return mapWebsiteBlockerPermissionResult(await plugin.requestPermissions());
        }
    }
    return this.fetch(`/api/permissions/${id}/request`, { method: "POST" });
};
ElizaClient.prototype.openPermissionSettings = async function (id) {
    if (id === WEBSITE_BLOCKING_PERMISSION_ID) {
        const plugin = getNativeWebsiteBlockerPluginIfAvailable();
        if (plugin) {
            await plugin.openSettings();
            return;
        }
    }
    await this.fetch(`/api/permissions/${id}/open-settings`, {
        method: "POST",
    });
};
ElizaClient.prototype.refreshPermissions = async function () {
    const permissions = await this.fetch("/api/permissions/refresh", {
        method: "POST",
    });
    const plugin = getNativeWebsiteBlockerPluginIfAvailable();
    if (!plugin) {
        return permissions;
    }
    const permission = mapWebsiteBlockerStatusToPermission(await plugin.getStatus());
    return {
        ...permissions,
        [WEBSITE_BLOCKING_PERMISSION_ID]: permission,
    };
};
ElizaClient.prototype.setShellEnabled = async function (enabled) {
    return this.fetch("/api/permissions/shell", {
        method: "PUT",
        body: JSON.stringify({ enabled }),
    });
};
ElizaClient.prototype.isShellEnabled = async function () {
    const result = await this.fetch("/api/permissions/shell");
    return result.enabled;
};
ElizaClient.prototype.getWebsiteBlockerStatus = async function () {
    const plugin = getNativeWebsiteBlockerPluginIfAvailable();
    if (plugin) {
        return plugin.getStatus();
    }
    return this.fetch("/api/website-blocker");
};
ElizaClient.prototype.startWebsiteBlock = async function (options) {
    const plugin = getNativeWebsiteBlockerPluginIfAvailable();
    if (plugin) {
        return plugin.startBlock(options);
    }
    return this.fetch("/api/website-blocker", {
        method: "PUT",
        body: JSON.stringify(options),
    });
};
ElizaClient.prototype.stopWebsiteBlock = async function () {
    const plugin = getNativeWebsiteBlockerPluginIfAvailable();
    if (plugin) {
        return plugin.stopBlock();
    }
    return this.fetch("/api/website-blocker", {
        method: "DELETE",
    });
};
ElizaClient.prototype.getAppBlockerStatus = async function () {
    const plugin = getNativeAppBlockerPluginIfAvailable();
    if (plugin) {
        return plugin.getStatus();
    }
    return {
        available: false,
        active: false,
        platform: "web",
        engine: "none",
        blockedCount: 0,
        blockedPackageNames: [],
        endsAt: null,
        permissionStatus: "not-applicable",
        reason: "App blocking is only available on iPhone and Android builds.",
    };
};
ElizaClient.prototype.checkAppBlockerPermissions = async function () {
    const plugin = getNativeAppBlockerPluginIfAvailable();
    if (plugin) {
        return plugin.checkPermissions();
    }
    return {
        status: "not-applicable",
        canRequest: false,
        reason: "App blocking is only available on iPhone and Android builds.",
    };
};
ElizaClient.prototype.requestAppBlockerPermissions = async function () {
    const plugin = getNativeAppBlockerPluginIfAvailable();
    if (plugin) {
        return plugin.requestPermissions();
    }
    return {
        status: "not-applicable",
        canRequest: false,
        reason: "App blocking is only available on iPhone and Android builds.",
    };
};
ElizaClient.prototype.getInstalledAppsToBlock = async function () {
    const plugin = getNativeAppBlockerPluginIfAvailable();
    if (plugin) {
        return plugin.getInstalledApps();
    }
    return { apps: [] };
};
ElizaClient.prototype.selectAppBlockerApps = async function () {
    const plugin = getNativeAppBlockerPluginIfAvailable();
    if (plugin) {
        return plugin.selectApps();
    }
    return {
        apps: [],
        cancelled: true,
    };
};
ElizaClient.prototype.startAppBlock = async function (options) {
    const plugin = getNativeAppBlockerPluginIfAvailable();
    if (plugin) {
        return plugin.blockApps(options);
    }
    return {
        success: false,
        endsAt: null,
        blockedCount: 0,
        error: "App blocking is only available on iPhone and Android builds.",
    };
};
ElizaClient.prototype.stopAppBlock = async function () {
    const plugin = getNativeAppBlockerPluginIfAvailable();
    if (plugin) {
        return plugin.unblockApps();
    }
    return {
        success: false,
        error: "App blocking is only available on iPhone and Android builds.",
    };
};
ElizaClient.prototype.getCodingAgentStatus = async function () {
    const [acpResult, orchestratorStatusResult, taskThreadsResult] = await Promise.allSettled([
        this.fetch("/api/coding-agents"),
        this.getOrchestratorStatus(),
        this.listCodingAgentTaskThreads({ limit: 20 }),
    ]);
    const acpSessions = acpResult.status === "fulfilled" && Array.isArray(acpResult.value)
        ? acpResult.value
        : null;
    const taskThreads = taskThreadsResult.status === "fulfilled" &&
        Array.isArray(taskThreadsResult.value)
        ? taskThreadsResult.value
        : null;
    const orchestratorStatus = orchestratorStatusResult.status === "fulfilled"
        ? orchestratorStatusResult.value
        : null;
    if (!acpSessions && !taskThreads && !orchestratorStatus) {
        return null;
    }
    const acpTasks = acpSessions
        ? mapAcpSessionsToCodingAgentSessions(acpSessions).filter((task) => !TERMINAL_STATUSES.has(task.status))
        : [];
    const taskThreadSessions = taskThreads
        ? mapTaskThreadsToCodingAgentSessions(taskThreads).filter((task) => !TERMINAL_STATUSES.has(task.status))
        : [];
    const tasks = [...acpTasks, ...taskThreadSessions];
    const taskThreadCount = typeof orchestratorStatus?.taskCount === "number"
        ? orchestratorStatus.taskCount
        : (taskThreads?.length ?? 0);
    return {
        supervisionLevel: acpSessions ? "acp" : "orchestrator",
        taskCount: tasks.length,
        tasks,
        pendingConfirmations: 0,
        taskThreadCount,
        taskThreads: taskThreads ?? [],
    };
};
ElizaClient.prototype.listCodingAgentTaskThreads = async function (options) {
    const params = new URLSearchParams();
    if (options?.includeArchived)
        params.set("includeArchived", "true");
    if (options?.status)
        params.set("status", options.status);
    if (options?.search)
        params.set("search", options.search);
    if (typeof options?.limit === "number") {
        params.set("limit", String(options.limit));
    }
    const qs = params.toString();
    const res = await this.fetch(`/api/orchestrator/tasks${qs ? `?${qs}` : ""}`);
    return res.tasks;
};
ElizaClient.prototype.getCodingAgentTaskThread = async function (threadId) {
    try {
        return await this.fetch(`/api/orchestrator/tasks/${encodeURIComponent(threadId)}`);
    }
    catch (error) {
        // A task that no longer exists (deleted between list and detail fetch) is a
        // normal "no detail" outcome, not a load failure. Every other error
        // propagates so the caller can surface it.
        if (error instanceof ApiError && error.status === 404) {
            return null;
        }
        throw error;
    }
};
ElizaClient.prototype.archiveCodingAgentTaskThread = async function (threadId) {
    await this.fetch(`/api/orchestrator/tasks/${encodeURIComponent(threadId)}/archive`, { method: "POST" });
    return true;
};
ElizaClient.prototype.reopenCodingAgentTaskThread = async function (threadId) {
    await this.fetch(`/api/orchestrator/tasks/${encodeURIComponent(threadId)}/reopen`, { method: "POST" });
    return true;
};
// --- Orchestrator-native task operations (/api/orchestrator/*) -------------
// The four methods above are the compatibility surface the legacy coding-agent
// panel binds to. The methods below are the orchestrator workbench vocabulary.
// A task that vanished resolves to null on detail reads so the rail can refresh.
ElizaClient.prototype.getOrchestratorStatus = async function () {
    return this.fetch("/api/orchestrator/status");
};
ElizaClient.prototype.getOrchestratorAccounts = async function () {
    return this.fetch("/api/orchestrator/accounts");
};
ElizaClient.prototype.getOrchestratorAccountReadiness = async function (opts) {
    const qs = opts?.rotation ? "?rotation=1" : "";
    // The route returns 503 when the pool is degraded — but that 503 body IS the
    // verdict the panel renders, not an error. allowNonOk skips the throw so we
    // read the body on both 200 (ready) and 503 (degraded).
    return this.fetch(`/api/orchestrator/accounts/readiness${qs}`, undefined, { allowNonOk: true });
};
ElizaClient.prototype.getOrchestratorRooms = async function () {
    return this.fetch("/api/orchestrator/rooms");
};
ElizaClient.prototype.createOrchestratorTask = function (input) {
    return this.fetch("/api/orchestrator/tasks", {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "Content-Type": "application/json" },
    });
};
ElizaClient.prototype.pauseOrchestratorTask = async function (taskId) {
    try {
        return await this.fetch(`/api/orchestrator/tasks/${encodeURIComponent(taskId)}/pause`, { method: "POST" });
    }
    catch (error) {
        if (error instanceof ApiError && error.status === 404)
            return null;
        throw error;
    }
};
ElizaClient.prototype.resumeOrchestratorTask = async function (taskId) {
    try {
        return await this.fetch(`/api/orchestrator/tasks/${encodeURIComponent(taskId)}/resume`, { method: "POST" });
    }
    catch (error) {
        if (error instanceof ApiError && error.status === 404)
            return null;
        throw error;
    }
};
ElizaClient.prototype.deleteOrchestratorTask = async function (taskId) {
    await this.fetch(`/api/orchestrator/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
    return true;
};
ElizaClient.prototype.forkOrchestratorTask = async function (taskId, input) {
    try {
        return await this.fetch(`/api/orchestrator/tasks/${encodeURIComponent(taskId)}/fork`, {
            method: "POST",
            body: JSON.stringify(input ?? {}),
            headers: { "Content-Type": "application/json" },
        });
    }
    catch (error) {
        if (error instanceof ApiError && error.status === 404)
            return null;
        throw error;
    }
};
ElizaClient.prototype.updateOrchestratorTask = async function (taskId, input) {
    try {
        return await this.fetch(`/api/orchestrator/tasks/${encodeURIComponent(taskId)}`, {
            method: "PATCH",
            body: JSON.stringify(input),
            headers: { "Content-Type": "application/json" },
        });
    }
    catch (error) {
        if (error instanceof ApiError && error.status === 404)
            return null;
        throw error;
    }
};
ElizaClient.prototype.validateOrchestratorTask = async function (taskId, input) {
    try {
        return await this.fetch(`/api/orchestrator/tasks/${encodeURIComponent(taskId)}/validate`, {
            method: "POST",
            body: JSON.stringify(input),
            headers: { "Content-Type": "application/json" },
        });
    }
    catch (error) {
        if (error instanceof ApiError && error.status === 404)
            return null;
        throw error;
    }
};
ElizaClient.prototype.addOrchestratorAgent = async function (taskId, input) {
    try {
        return await this.fetch(`/api/orchestrator/tasks/${encodeURIComponent(taskId)}/agents`, {
            method: "POST",
            body: JSON.stringify(input),
            headers: { "Content-Type": "application/json" },
        });
    }
    catch (error) {
        if (error instanceof ApiError && error.status === 404)
            return null;
        throw error;
    }
};
ElizaClient.prototype.stopOrchestratorAgent = async function (taskId, sessionId) {
    await this.fetch(`/api/orchestrator/tasks/${encodeURIComponent(taskId)}/agents/${encodeURIComponent(sessionId)}/stop`, { method: "POST" });
    return true;
};
ElizaClient.prototype.retryOrchestratorTaskTurn = async function (taskId, input) {
    try {
        return await this.fetch(`/api/orchestrator/tasks/${encodeURIComponent(taskId)}/retry-turn`, {
            method: "POST",
            body: JSON.stringify(input),
            headers: { "Content-Type": "application/json" },
        });
    }
    catch (error) {
        if (error instanceof ApiError && error.status === 404)
            return null;
        throw error;
    }
};
ElizaClient.prototype.rerunOrchestratorTaskFromEvent = async function (taskId, input) {
    try {
        return await this.fetch(`/api/orchestrator/tasks/${encodeURIComponent(taskId)}/rerun-from-event`, {
            method: "POST",
            body: JSON.stringify(input),
            headers: { "Content-Type": "application/json" },
        });
    }
    catch (error) {
        if (error instanceof ApiError && error.status === 404)
            return null;
        throw error;
    }
};
ElizaClient.prototype.restartOrchestratorTask = async function (taskId, input) {
    try {
        return await this.fetch(`/api/orchestrator/tasks/${encodeURIComponent(taskId)}/restart`, {
            method: "POST",
            body: JSON.stringify(input ?? {}),
            headers: { "Content-Type": "application/json" },
        });
    }
    catch (error) {
        if (error instanceof ApiError && error.status === 404)
            return null;
        throw error;
    }
};
ElizaClient.prototype.restartOrchestratorTaskWithEditedPlan = async function (taskId, input) {
    try {
        return await this.fetch(`/api/orchestrator/tasks/${encodeURIComponent(taskId)}/restart-with-edited-plan`, {
            method: "POST",
            body: JSON.stringify(input),
            headers: { "Content-Type": "application/json" },
        });
    }
    catch (error) {
        if (error instanceof ApiError && error.status === 404)
            return null;
        throw error;
    }
};
ElizaClient.prototype.listOrchestratorTaskPlanRevisions = function (taskId, options) {
    const params = new URLSearchParams();
    if (options?.cursor)
        params.set("cursor", options.cursor);
    if (typeof options?.limit === "number") {
        params.set("limit", String(options.limit));
    }
    const qs = params.toString();
    return this.fetch(`/api/orchestrator/tasks/${encodeURIComponent(taskId)}/plan-revisions${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.createOrchestratorTaskPlanRevision = async function (taskId, input) {
    try {
        return await this.fetch(`/api/orchestrator/tasks/${encodeURIComponent(taskId)}/plan-revisions`, {
            method: "POST",
            body: JSON.stringify(input),
            headers: { "Content-Type": "application/json" },
        });
    }
    catch (error) {
        if (error instanceof ApiError && error.status === 404)
            return null;
        throw error;
    }
};
ElizaClient.prototype.listOrchestratorTaskMessages = function (taskId, options) {
    const params = new URLSearchParams();
    if (options?.cursor)
        params.set("cursor", options.cursor);
    if (typeof options?.limit === "number") {
        params.set("limit", String(options.limit));
    }
    const qs = params.toString();
    return this.fetch(`/api/orchestrator/tasks/${encodeURIComponent(taskId)}/messages${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.postOrchestratorTaskMessage = async function (taskId, content) {
    const result = await this.fetch(`/api/orchestrator/tasks/${encodeURIComponent(taskId)}/messages`, {
        method: "POST",
        body: JSON.stringify({ content }),
        headers: { "Content-Type": "application/json" },
    });
    return result.recorded && (result.failedTo?.length ?? 0) === 0;
};
ElizaClient.prototype.listOrchestratorTaskEvents = function (taskId, options) {
    const params = new URLSearchParams();
    if (options?.cursor)
        params.set("cursor", options.cursor);
    if (typeof options?.limit === "number") {
        params.set("limit", String(options.limit));
    }
    const qs = params.toString();
    return this.fetch(`/api/orchestrator/tasks/${encodeURIComponent(taskId)}/events${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.listOrchestratorTaskTimeline = function (taskId, options) {
    const params = new URLSearchParams();
    if (options?.cursor)
        params.set("cursor", options.cursor);
    if (typeof options?.limit === "number") {
        params.set("limit", String(options.limit));
    }
    const qs = params.toString();
    return this.fetch(`/api/orchestrator/tasks/${encodeURIComponent(taskId)}/timeline${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.streamOrchestratorTask = function (taskId, onChange) {
    const url = `${this.baseUrl || ""}/api/orchestrator/tasks/${encodeURIComponent(taskId)}/stream`;
    // On-device runtimes are addressed via the native IPC base, which
    // EventSource cannot open; skip the live stream (the caller still has its
    // initial fetch) rather than throwing a synchronous SecurityError.
    const source = openEventSource(url);
    if (!source)
        return () => { };
    source.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            // The stream pings `{type:"change"}` on every room mutation; the caller
            // refetches the tail. `ready` and heartbeat comments are ignored.
            if (data && data.type === "change")
                onChange();
        }
        catch {
            // ignore non-JSON frames
        }
    };
    return () => source.close();
};
ElizaClient.prototype.pauseAllOrchestratorTasks = async function () {
    const res = await this.fetch("/api/orchestrator/pause-all", { method: "POST" });
    return res.paused;
};
ElizaClient.prototype.resumeAllOrchestratorTasks = async function () {
    const res = await this.fetch("/api/orchestrator/resume-all", { method: "POST" });
    return res.resumed;
};
ElizaClient.prototype.stopCodingAgent = async function (sessionId) {
    try {
        await this.fetch(`/api/coding-agents/${encodeURIComponent(sessionId)}/stop`, { method: "POST" });
        return true;
    }
    catch {
        // error-policy:J1 boundary translation — the typed contract is an
        // explicit boolean failure the plugin callers render; never fake success.
        return false;
    }
};
ElizaClient.prototype.listCodingAgentScratchWorkspaces = async function () {
    return this.fetch("/api/coding-agents/scratch");
};
ElizaClient.prototype.keepCodingAgentScratchWorkspace = async function (sessionId) {
    try {
        await this.fetch(`/api/coding-agents/${encodeURIComponent(sessionId)}/scratch/keep`, { method: "POST" });
        return true;
    }
    catch {
        // error-policy:J1 boundary translation — the typed contract is an
        // explicit boolean failure the plugin callers render; never fake success.
        return false;
    }
};
ElizaClient.prototype.deleteCodingAgentScratchWorkspace = async function (sessionId) {
    try {
        await this.fetch(`/api/coding-agents/${encodeURIComponent(sessionId)}/scratch/delete`, { method: "POST" });
        return true;
    }
    catch {
        // error-policy:J1 boundary translation — the typed contract is an
        // explicit boolean failure the plugin callers render; never fake success.
        return false;
    }
};
ElizaClient.prototype.promoteCodingAgentScratchWorkspace = async function (sessionId, name) {
    try {
        const response = await this.fetch(`/api/coding-agents/${encodeURIComponent(sessionId)}/scratch/promote`, {
            method: "POST",
            body: JSON.stringify(name ? { name } : {}),
        });
        return response.scratch ?? null;
    }
    catch {
        // error-policy:J1 boundary translation — null is the typed "promotion
        // failed" signal in this contract; never fake a workspace record.
        return null;
    }
};
ElizaClient.prototype.spawnShellSession = async function (workdir) {
    const res = await this.fetch("/api/coding-agents/spawn", {
        method: "POST",
        body: JSON.stringify({
            agentType: "shell",
            ...(workdir ? { workdir } : {}),
        }),
    });
    return { sessionId: res.sessionId };
};
ElizaClient.prototype.spawnPtySession = async function (options) {
    const res = await this.fetch("/api/pty/sessions", {
        method: "POST",
        body: JSON.stringify(options ?? {}),
    });
    return { sessionId: res.session.sessionId };
};
ElizaClient.prototype.stopPtySession = async function (sessionId) {
    try {
        await this.fetch(`/api/pty/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
        return true;
    }
    catch {
        // error-policy:J1 boundary translation — the typed contract is an
        // explicit boolean failure the plugin callers render; never fake success.
        return false;
    }
};
ElizaClient.prototype.subscribePtyOutput = function (sessionId) {
    this.sendWsMessage({ type: "pty-subscribe", sessionId });
};
ElizaClient.prototype.unsubscribePtyOutput = function (sessionId) {
    this.sendWsMessage({ type: "pty-unsubscribe", sessionId });
};
/**
 * Max UTF-16 length of a single `pty-input` WS message the agent server
 * accepts (its per-message DoS cap — see `MAX_PTY_INPUT_MESSAGE_LENGTH` in
 * `packages/agent/src/api/pty-ws-bridge.ts`). Anything larger must be split
 * client-side: xterm delivers an entire paste as ONE `onData` call, so a
 * pasted stack trace/diff easily exceeds this.
 */
export const MAX_PTY_INPUT_CHUNK_LENGTH = 4096;
/**
 * Split PTY input into ordered chunks of at most `maxLength` UTF-16 units so
 * each fits under the server's per-message cap. Never splits a surrogate
 * pair across chunks (a lone surrogate would be mangled to U+FFFD when the
 * server writes the chunk to the PTY as UTF-8). Input at or under the cap is
 * returned as a single chunk, preserving the previous one-message behavior.
 */
export function chunkPtyInput(data, maxLength = MAX_PTY_INPUT_CHUNK_LENGTH) {
    if (data.length <= maxLength)
        return [data];
    const chunks = [];
    let start = 0;
    while (start < data.length) {
        let end = Math.min(start + maxLength, data.length);
        if (end < data.length && end - start > 1) {
            const boundary = data.charCodeAt(end - 1);
            // High surrogate at the cut point → keep the pair together by ending
            // the chunk one unit earlier.
            if (boundary >= 0xd800 && boundary <= 0xdbff)
                end -= 1;
        }
        chunks.push(data.slice(start, end));
        start = end;
    }
    return chunks;
}
ElizaClient.prototype.sendPtyInput = function (sessionId, data) {
    // One WS message per chunk, sent in order. Each message gets its own msgId
    // (sendWsMessage stamps it), and both the open-socket path and the offline
    // send-queue preserve call order, so the PTY receives the paste intact.
    for (const chunk of chunkPtyInput(data)) {
        this.sendWsMessage({ type: "pty-input", sessionId, data: chunk });
    }
};
ElizaClient.prototype.resizePty = function (sessionId, cols, rows) {
    this.sendWsMessage({ type: "pty-resize", sessionId, cols, rows });
};
ElizaClient.prototype.getPtyBufferedOutput = async function (sessionId) {
    try {
        const res = await this.fetch(`/api/pty/sessions/${encodeURIComponent(sessionId)}/buffered-output`);
        return res.output ?? "";
    }
    catch {
        // error-policy:J4 older coding-agent PTY sessions keep their buffer
        // behind the legacy route tried below.
    }
    try {
        const res = await this.fetch(`/api/coding-agents/${encodeURIComponent(sessionId)}/buffered-output`);
        return res.output ?? "";
    }
    catch {
        // error-policy:J4 scrollback hydration only — an empty replay degrades
        // the terminal history; live output still arrives via the PTY stream.
        return "";
    }
};
ElizaClient.prototype.streamGoLive = async function () {
    return this.fetch("/api/stream/live", { method: "POST" });
};
ElizaClient.prototype.streamGoOffline = async function () {
    return this.fetch("/api/stream/offline", { method: "POST" });
};
ElizaClient.prototype.streamStatus = async function () {
    return this.fetch("/api/stream/status");
};
ElizaClient.prototype.getStreamingDestinations = async function () {
    return this.fetch("/api/streaming/destinations");
};
ElizaClient.prototype.setActiveDestination = async function (destinationId) {
    return this.fetch("/api/streaming/destination", {
        method: "POST",
        body: JSON.stringify({ destinationId }),
    });
};
ElizaClient.prototype.setStreamVolume = async function (volume) {
    return this.fetch("/api/stream/volume", {
        method: "POST",
        body: JSON.stringify({ volume }),
    });
};
ElizaClient.prototype.muteStream = async function () {
    return this.fetch("/api/stream/mute", { method: "POST" });
};
ElizaClient.prototype.unmuteStream = async function () {
    return this.fetch("/api/stream/unmute", { method: "POST" });
};
ElizaClient.prototype.getStreamVoice = async function () {
    return this.fetch("/api/stream/voice");
};
ElizaClient.prototype.saveStreamVoice = async function (settings) {
    return this.fetch("/api/stream/voice", {
        method: "POST",
        body: JSON.stringify(settings),
    });
};
ElizaClient.prototype.streamVoiceSpeak = async function (text) {
    return this.fetch("/api/stream/voice/speak", {
        method: "POST",
        body: JSON.stringify({ text }),
    });
};
ElizaClient.prototype.getOverlayLayout = async function (destinationId) {
    const qs = destinationId
        ? `?destination=${encodeURIComponent(destinationId)}`
        : "";
    return this.fetch(`/api/stream/overlay-layout${qs}`);
};
ElizaClient.prototype.saveOverlayLayout = async function (layout, destinationId) {
    const qs = destinationId
        ? `?destination=${encodeURIComponent(destinationId)}`
        : "";
    return this.fetch(`/api/stream/overlay-layout${qs}`, {
        method: "POST",
        body: JSON.stringify({ layout }),
    });
};
ElizaClient.prototype.getStreamSource = async function () {
    return this.fetch("/api/stream/source");
};
ElizaClient.prototype.setStreamSource = async function (sourceType, customUrl) {
    return this.fetch("/api/stream/source", {
        method: "POST",
        body: JSON.stringify({ sourceType, customUrl }),
    });
};
ElizaClient.prototype.getStreamSettings = async function () {
    return this.fetch("/api/stream/settings");
};
ElizaClient.prototype.saveStreamSettings = async function (settings) {
    return this.fetch("/api/stream/settings", {
        method: "POST",
        body: JSON.stringify({ settings }),
    });
};
// ---------------------------------------------------------------------------
// Multi-account routes (WS3)
// ---------------------------------------------------------------------------
ElizaClient.prototype.listAccounts = async function () {
    return this.fetch("/api/accounts");
};
ElizaClient.prototype.createApiKeyAccount = async function (providerId, body) {
    return this.fetch(`/api/accounts/${encodeURIComponent(providerId)}`, {
        method: "POST",
        body: JSON.stringify({ source: "api-key", ...body }),
    });
};
ElizaClient.prototype.patchAccount = async function (providerId, accountId, body) {
    return this.fetch(`/api/accounts/${encodeURIComponent(providerId)}/${encodeURIComponent(accountId)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
    });
};
ElizaClient.prototype.deleteAccount = async function (providerId, accountId) {
    return this.fetch(`/api/accounts/${encodeURIComponent(providerId)}/${encodeURIComponent(accountId)}`, { method: "DELETE" });
};
ElizaClient.prototype.testAccount = async function (providerId, accountId) {
    return this.fetch(`/api/accounts/${encodeURIComponent(providerId)}/${encodeURIComponent(accountId)}/test`, { method: "POST" });
};
ElizaClient.prototype.refreshAccountUsage = async function (providerId, accountId) {
    return this.fetch(`/api/accounts/${encodeURIComponent(providerId)}/${encodeURIComponent(accountId)}/refresh-usage`, { method: "POST" });
};
ElizaClient.prototype.startAccountOAuth = async function (providerId, body) {
    return this.fetch(`/api/accounts/${encodeURIComponent(providerId)}/oauth/start`, {
        method: "POST",
        body: JSON.stringify(body),
    });
};
ElizaClient.prototype.submitAccountOAuthCode = async function (providerId, body) {
    return this.fetch(`/api/accounts/${encodeURIComponent(providerId)}/oauth/submit-code`, {
        method: "POST",
        body: JSON.stringify(body),
    });
};
ElizaClient.prototype.cancelAccountOAuth = async function (providerId, body) {
    return this.fetch(`/api/accounts/${encodeURIComponent(providerId)}/oauth/cancel`, {
        method: "POST",
        body: JSON.stringify(body),
    });
};
ElizaClient.prototype.patchProviderStrategy = async function (providerId, body) {
    return this.fetch(`/api/providers/${encodeURIComponent(providerId)}/strategy`, {
        method: "PATCH",
        body: JSON.stringify(body),
    });
};
