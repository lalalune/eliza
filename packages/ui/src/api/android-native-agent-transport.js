/**
 * AgentRequestTransport for the Android local agent: routes requests through
 * the Capacitor native bridge to the in-process musl-bun agent (IPC base),
 * including native streaming. Selected when the API base is an Android local URL.
 */
import { Capacitor } from "@capacitor/core";
import { getBootConfig } from "../config/boot-config";
import { isAndroidLocalAgentUrl } from "../first-run/local-agent-token";
import { ANDROID_LOCAL_AGENT_IPC_BASE, isMobileLocalAgentIpcUrl, mobileLocalAgentPathFromUrl, } from "../first-run/mobile-runtime-mode";
import { createNativeStreamingResponse, supportsNativeStreaming, } from "./native-agent-stream";
import { bodyToString, fetchAgentTransport, headersToRecord, isStreamingRequest, methodAllowsBody, } from "./transport";
const agentPluginName = "Agent";
let nativeTransportPromise = null;
let globalFetchBridgeInstalled = false;
let originalFetch = null;
function toNativeAgentPlugin(plugin) {
    if (!plugin)
        return null;
    const start = plugin.start?.bind(plugin);
    const stop = plugin.stop?.bind(plugin);
    const getStatus = plugin.getStatus?.bind(plugin);
    const request = plugin.request?.bind(plugin);
    const requestStream = plugin.requestStream?.bind(plugin);
    const addListener = plugin.addListener?.bind(plugin);
    if (!start && !stop && !getStatus && !request)
        return null;
    return { start, stop, getStatus, request, requestStream, addListener };
}
function isNativeAndroid() {
    try {
        return Capacitor.getPlatform() === "android";
    }
    catch {
        // error-policy:J4 capability probe — no Capacitor runtime means not
        // native Android; the transport stays on the HTTP path.
        return false;
    }
}
function isNativeIos() {
    try {
        return Capacitor.getPlatform() === "ios";
    }
    catch {
        return false;
    }
}
function isLocalAgentIpcUrl(value) {
    return isMobileLocalAgentIpcUrl(value);
}
function localAgentPathFromUrl(value) {
    return mobileLocalAgentPathFromUrl(value);
}
function shouldAttemptNativeAgentTransport(url) {
    if (!isAndroidLocalAgentUrl(url))
        return false;
    if (isNativeAndroid())
        return true;
    return isLocalAgentIpcUrl(url) && !isNativeIos();
}
function readRuntimeMode() {
    try {
        const persisted = globalThis.localStorage?.getItem("eliza:mobile-runtime-mode");
        if (persisted?.trim())
            return persisted.trim();
    }
    catch {
        // localStorage can be unavailable in tests and early native startup.
    }
    const env = import.meta.env;
    const androidRuntimeMode = typeof env?.VITE_ELIZA_ANDROID_RUNTIME_MODE === "string"
        ? env.VITE_ELIZA_ANDROID_RUNTIME_MODE.trim()
        : "";
    const mobileRuntimeMode = typeof env?.VITE_ELIZA_MOBILE_RUNTIME_MODE === "string"
        ? env.VITE_ELIZA_MOBILE_RUNTIME_MODE.trim()
        : "";
    return androidRuntimeMode || mobileRuntimeMode || null;
}
function configuredApiBaseIsAndroidLocal() {
    const bootBase = getBootConfig().apiBase?.trim();
    return !!bootBase && isAndroidLocalAgentUrl(bootBase);
}
async function resolveNativeAgentPlugin() {
    try {
        const capacitorWithPlugins = Capacitor;
        const registeredAgent = capacitorWithPlugins.Plugins?.[agentPluginName] ??
            Capacitor.registerPlugin(agentPluginName);
        const agent = toNativeAgentPlugin(registeredAgent);
        if (agent)
            return agent;
    }
    catch {
        // error-policy:J4 capability probe — a failed plugin registration means
        // no native transport; callers degrade to the explicit unavailable path.
        return null;
    }
    return null;
}
function shouldBridgeFetchUrl(url, rawUrl) {
    if ((isLocalAgentIpcUrl(rawUrl) || isLocalAgentIpcUrl(url.toString())) &&
        !isNativeIos()) {
        return true;
    }
    if (!isNativeAndroid())
        return false;
    if (isAndroidLocalAgentUrl(rawUrl) ||
        isAndroidLocalAgentUrl(url.toString())) {
        return true;
    }
    if (!url.pathname.startsWith("/api/"))
        return false;
    return readRuntimeMode() === "local" || configuredApiBaseIsAndroidLocal();
}
function localAgentUrlForFetch(url, rawUrl) {
    if (isAndroidLocalAgentUrl(rawUrl))
        return rawUrl;
    if (isAndroidLocalAgentUrl(url.toString()))
        return url.toString();
    return `${ANDROID_LOCAL_AGENT_IPC_BASE}${url.pathname}${url.search}`;
}
function localAgentRequestPath(url) {
    const ipcPath = localAgentPathFromUrl(url);
    if (ipcPath !== null)
        return ipcPath;
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
}
async function normalizeFetchBridgeInit(input, init) {
    const request = input instanceof Request ? input.clone() : null;
    const method = (init?.method ?? request?.method ?? "GET")
        .trim()
        .toUpperCase();
    const headers = init?.headers ?? request?.headers;
    if (!methodAllowsBody(method)) {
        return {
            ...init,
            method,
            headers,
            body: undefined,
        };
    }
    if (init && "body" in init) {
        const body = bodyToString(init.body);
        if (body === undefined && init.body != null)
            return null;
        return {
            ...init,
            method,
            headers,
            body: body ?? undefined,
        };
    }
    if (!request) {
        return {
            ...init,
            method,
            headers,
        };
    }
    const body = await request.text();
    return {
        ...init,
        method,
        headers,
        body: body || undefined,
    };
}
export function createAndroidNativeAgentTransport(agent) {
    return {
        async request(url, init, context) {
            if (!isAndroidLocalAgentUrl(url)) {
                return fetchAgentTransport.request(url, init);
            }
            const request = agent.request;
            if (!request) {
                return createNativeAgentUnavailableResponse("Android local-agent IPC is unavailable because Agent.request is not registered");
            }
            const method = init.method ?? "GET";
            const rawBody = init.body;
            const body = bodyToString(init.body);
            if ((body === undefined && rawBody != null) ||
                (!methodAllowsBody(method) && body != null)) {
                return createNativeAgentUnavailableResponse("Android local-agent IPC only supports string request bodies");
            }
            // SSE requests (the chat reply token stream) go through the streaming
            // bridge so tokens reach the WebView incrementally instead of buffering
            // the whole body. Falls through to the buffered `request` below if the
            // native plugin has no streaming bridge or the stream fails to start.
            if (isStreamingRequest(url, init.headers) &&
                supportsNativeStreaming(agent)) {
                try {
                    return await createNativeStreamingResponse(agent, {
                        method,
                        path: localAgentRequestPath(url),
                        headers: headersToRecord(init.headers),
                        body: methodAllowsBody(method) ? (body ?? null) : null,
                        timeoutMs: context?.timeoutMs,
                    });
                }
                catch {
                    // Stream couldn't start — fall back to the buffered request path.
                }
            }
            const result = await request({
                method,
                path: localAgentRequestPath(url),
                headers: headersToRecord(init.headers),
                body: methodAllowsBody(method) ? (body ?? null) : null,
                timeoutMs: context?.timeoutMs,
            });
            return new Response(nativeResponseBody(result), {
                status: result.status,
                statusText: result.statusText ?? "",
                headers: result.headers,
            });
        },
    };
}
/**
 * Reconstruct the response body from the native bridge result. Prefer the
 * lossless `bodyBase64` (raw bytes) so binary payloads survive; fall back to the
 * UTF-8 `body` string when the native side did not supply base64.
 */
function nativeResponseBody(result) {
    const base64 = result.bodyBase64;
    if (typeof base64 === "string" && base64.length > 0) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    }
    return result.body ?? "";
}
function createNativeAgentUnavailableResponse(message) {
    return new Response(JSON.stringify({
        error: "native_agent_unavailable",
        message,
    }), {
        status: 503,
        statusText: "Service Unavailable",
        headers: { "content-type": "application/json" },
    });
}
export async function androidNativeAgentLifecycleForUrl(url) {
    if (!url || !shouldAttemptNativeAgentTransport(url))
        return null;
    return resolveNativeAgentPlugin();
}
export async function androidNativeAgentTransportForUrl(url) {
    if (!shouldAttemptNativeAgentTransport(url))
        return null;
    nativeTransportPromise ??= resolveNativeAgentPlugin()
        // error-policy:J4 a missing/failed native agent plugin degrades to null so
        // the caller falls back to the IPC/HTTP transport below; the memoized
        // promise is reset on a null result so a later boot can retry.
        .then((agent) => agent?.request ? createAndroidNativeAgentTransport(agent) : null)
        // error-policy:J4 plugin-resolution failure degrades to the explicit
        // "native transport unavailable" response below (IPC URLs) or to the
        // normal HTTP transport (everything else) — never a silent success.
        .catch(() => null);
    const transport = await nativeTransportPromise;
    if (transport)
        return transport;
    nativeTransportPromise = null;
    if (!isLocalAgentIpcUrl(url))
        return null;
    return {
        request: async () => createNativeAgentUnavailableResponse("Android local-agent IPC is unavailable because the native Agent plugin is not registered"),
    };
}
export function installAndroidNativeAgentFetchBridge() {
    if (globalFetchBridgeInstalled)
        return;
    if (typeof globalThis.fetch !== "function")
        return;
    const nativeFetch = globalThis.fetch;
    originalFetch = nativeFetch.bind(globalThis);
    const bridgedFetch = (async (input, init) => {
        const original = originalFetch;
        if (!original)
            return fetch(input, init);
        const rawUrl = input instanceof Request ? input.url : String(input);
        let url;
        try {
            url = new URL(rawUrl, typeof window !== "undefined"
                ? (window.location?.href ?? "http://localhost")
                : "http://localhost");
        }
        catch {
            return original(input, init);
        }
        if (!shouldBridgeFetchUrl(url, rawUrl))
            return original(input, init);
        const bridgedUrl = localAgentUrlForFetch(url, rawUrl);
        const bridgedInit = await normalizeFetchBridgeInit(input, init);
        if (!bridgedInit) {
            return isLocalAgentIpcUrl(bridgedUrl)
                ? createNativeAgentUnavailableResponse("Android local-agent IPC only supports string request bodies")
                : original(input, init);
        }
        const transport = await androidNativeAgentTransportForUrl(bridgedUrl);
        if (!transport) {
            return isLocalAgentIpcUrl(bridgedUrl)
                ? createNativeAgentUnavailableResponse("Android local-agent IPC is unavailable because the native Agent transport is not registered")
                : original(input, init);
        }
        return transport.request(bridgedUrl, bridgedInit);
    });
    const nativeFetchWithPreconnect = nativeFetch;
    if (typeof nativeFetchWithPreconnect.preconnect === "function") {
        bridgedFetch.preconnect =
            nativeFetchWithPreconnect.preconnect.bind(nativeFetch);
    }
    globalThis.fetch = bridgedFetch;
    globalFetchBridgeInstalled = true;
}
export function __resetAndroidNativeAgentTransportForTests() {
    nativeTransportPromise = null;
    if (originalFetch) {
        globalThis.fetch = originalFetch;
    }
    originalFetch = null;
    globalFetchBridgeInstalled = false;
}
