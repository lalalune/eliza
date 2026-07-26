/**
 * view-interact-registry — bridges WS `view:interact` messages to loaded view modules.
 *
 * DynamicViewLoader registers an interact handler when a view module is loaded
 * and unregisters it on unmount.  The startup-phase WS listener calls
 * `dispatchViewInteract` when it receives a `view:interact` message from the
 * server, which routes it to the correct handler and sends the result back.
 */
import { client } from "../../api";
import { installElizaBridge, registerElizaBridgeCapability, } from "../../bridge/eliza-window-bridge";
function handlerKey(viewId, viewType) {
    return `${viewType}:${viewId}`;
}
/** viewType:viewId → handler registered by the mounted DynamicViewLoader. */
const handlers = new Map();
const handledRequestIds = new Map();
const HANDLED_REQUEST_TTL_MS = 60_000;
export function registerViewInteractHandler(viewId, viewType, handler) {
    const key = handlerKey(viewId, viewType);
    handlers.set(key, handler);
    return () => {
        if (handlers.get(key) === handler) {
            handlers.delete(key);
        }
    };
}
/**
 * Called by the startup-phase WS listener when a `view:interact` message
 * arrives.  Routes to the correct handler and sends the result back via WS.
 */
export async function dispatchViewInteract(viewId, viewType, capability, params, requestId) {
    const resolvedViewType = viewType ?? "gui";
    const handler = handlers.get(handlerKey(viewId, resolvedViewType));
    if (!handler) {
        // The API broadcasts view-interact requests to every connected shell.
        // Clients that do not currently mount the target view must stay silent so
        // they do not race the mounted client and resolve the request as failed.
        return;
    }
    if (handledRequestIds.has(requestId)) {
        return;
    }
    const timeout = setTimeout(() => {
        handledRequestIds.delete(requestId);
    }, HANDLED_REQUEST_TTL_MS);
    timeout.unref?.();
    handledRequestIds.set(requestId, timeout);
    try {
        const result = await handler(capability, params);
        client.sendWsMessage({
            type: "view:interact:result",
            requestId,
            success: true,
            result,
        });
    }
    catch (err) {
        client.sendWsMessage({
            type: "view:interact:result",
            requestId,
            success: false,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
/**
 * Invoke a mounted view's interact handler and RETURN its result — the same path
 * `dispatchViewInteract` runs, minus the WS round-trip. This is what lets the
 * agent (and devtools / e2e) read and drive any view's agent surface directly
 * through the frozen bridge:
 * `window.__ELIZA_BRIDGE__.viewInteract("settings","gui","list-elements",{})`,
 * `…("agent-fill",{ id, value })`, `…("agent-click",{ id })`.
 */
export async function invokeViewInteract(viewId, viewType, capability, params) {
    const handler = handlers.get(handlerKey(viewId, viewType ?? "gui"));
    if (!handler) {
        throw new Error(`No interact handler mounted for ${viewType ?? "gui"}:${viewId}`);
    }
    return handler(capability, params);
}
registerElizaBridgeCapability("viewInteract", invokeViewInteract);
installElizaBridge();
