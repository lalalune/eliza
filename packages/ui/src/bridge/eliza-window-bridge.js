/**
 * eliza-window-bridge — the single namespaced RPC surface native hosts, devtools,
 * and e2e drivers use to invoke in-page capabilities.
 *
 * Executable capabilities are registered into a module-private registry and are
 * reachable only through the frozen `window.__ELIZA_BRIDGE__` object. No bare
 * function-valued `__ELIZA_*` window slot is written, so a same-origin script
 * cannot replace or wrap a capability: the bridge object is installed once and
 * defined non-writable / non-configurable, its capability slots are get-only
 * accessors that delegate to the private registry, and re-installation is a
 * no-op. A capability accessor returns a function only once its owner module has
 * registered it (so `typeof window.__ELIZA_BRIDGE__?.<cap> === "function"`
 * still means "installed and ready", matching the pre-bridge window-slot probe).
 */
/**
 * Module-private capability registry. Shared across every importer of this
 * module (single package instance), so both the iOS transport and the view
 * registry contribute into one bridge. Mutable by design: last registration of
 * a capability wins, matching the previous last-writer-wins window assignment.
 */
const registry = {};
export function registerElizaBridgeCapability(capability, handler) {
    registry[capability] = handler;
}
const bridge = Object.freeze(Object.defineProperties({}, {
    iosLocalAgentRequest: {
        enumerable: true,
        get: () => registry.iosLocalAgentRequest,
    },
    viewInteract: {
        enumerable: true,
        get: () => registry.viewInteract,
    },
}));
/**
 * Install the frozen bridge on `window`. Idempotent and safe under duplicate
 * bundle copies: if `window.__ELIZA_BRIDGE__` already exists (installed by this
 * or another copy) the call is a no-op and returns the live object. The slot is
 * non-writable and non-configurable, so it cannot later be replaced or deleted.
 */
export function installElizaBridge() {
    if (typeof window === "undefined")
        return undefined;
    const existing = window.__ELIZA_BRIDGE__;
    if (existing)
        return existing;
    Object.defineProperty(window, "__ELIZA_BRIDGE__", {
        value: bridge,
        writable: false,
        configurable: false,
        enumerable: true,
    });
    return window.__ELIZA_BRIDGE__;
}
