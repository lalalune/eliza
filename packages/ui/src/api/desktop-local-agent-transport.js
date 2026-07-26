/**
 * AgentRequestTransport for the desktop-hosted local agent: dispatches requests
 * over the Electrobun renderer RPC to the in-process agent via its IPC base.
 */
import { getElectrobunRendererRpc } from "../bridge/electrobun-rpc";
import { isElectrobunRuntime } from "../bridge/electrobun-runtime";
import { isMobileLocalAgentIpcUrl, mobileLocalAgentPathFromUrl, } from "../first-run/mobile-runtime-mode";
import { bodyToString, headersToRecord, methodAllowsBody, } from "./transport";
/**
 * True when `url` targets the desktop local-agent IPC base under an Electrobun
 * runtime. Mirrors `isMobileLocalAgentIpcUrl` (same `eliza-local-agent://ipc`
 * scheme), gated to Electrobun so mobile IPC URLs never resolve here.
 */
export function isElectrobunLocalMode(url) {
    return isElectrobunRuntime() && isMobileLocalAgentIpcUrl(url);
}
const desktopLocalAgentTransport = {
    async request(url, init, context) {
        const rpc = getElectrobunRendererRpc();
        const request = rpc?.request?.localAgentRequest;
        if (!request || !rpc?.request) {
            // The IPC base is active but the main-process handler is not wired yet.
            // Fail loudly — falling back to fetch would open a socket the whole
            // feature exists to remove.
            throw new Error("Desktop local-agent IPC transport is not available: window.__ELIZA_ELECTROBUN_RPC__.request.localAgentRequest is not registered (#12180 item 4 not yet landed)");
        }
        const method = init.method ?? "GET";
        const body = bodyToString(init.body);
        const result = (await request.call(rpc.request, {
            // The path relative to the IPC base; the main process joins it to the
            // in-process route kernel. Fall back to the raw url if it is not an IPC
            // URL (should not happen — the resolver gates on isElectrobunLocalMode).
            path: mobileLocalAgentPathFromUrl(url) ?? url,
            method,
            headers: headersToRecord(init.headers),
            body: methodAllowsBody(method) ? (body ?? null) : null,
            timeoutMs: context?.timeoutMs,
        }));
        return new Response(result.body ?? "", {
            status: result.status,
            statusText: result.statusText ?? "",
            headers: result.headers,
        });
    },
};
export function desktopLocalAgentTransportForUrl(url) {
    return Promise.resolve(isElectrobunLocalMode(url) ? desktopLocalAgentTransport : null);
}
