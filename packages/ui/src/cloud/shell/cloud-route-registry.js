export const CLOUD_PUBLIC_ROUTE_ACCESS = "cloud-public-route-reviewed";
function registryKey() {
    return Symbol.for("elizaos.ui.cloud-route-registry");
}
function getStore() {
    const globalObject = globalThis;
    const key = registryKey();
    const existing = globalObject[key];
    if (existing)
        return existing;
    const created = {
        entries: new Map(),
        seq: 0,
    };
    globalObject[key] = created;
    return created;
}
/**
 * Register (or replace) a cloud route. Later registration with the same `path`
 * wins, so a host app can override a built-in route by re-registering its path.
 */
export function registerCloudRoute(def) {
    const store = getStore();
    const existing = store.entries.get(def.path);
    if (def.public === true && def.publicAccess !== CLOUD_PUBLIC_ROUTE_ACCESS) {
        throw new Error(`Cloud route "${def.path}" is public but did not opt in with CLOUD_PUBLIC_ROUTE_ACCESS`);
    }
    if (isDevMode() &&
        existing &&
        existing.public !== true &&
        def.public === true) {
        console.warn(`[cloud-route-registry] Route "${def.path}" was re-registered from private to public. Use CLOUD_PUBLIC_ROUTE_ACCESS only for intentionally public routes.`);
    }
    const entry = { ...def, order: store.seq };
    store.seq += 1;
    store.entries.set(def.path, entry);
}
function isDevMode() {
    return (import.meta.env.DEV ||
        import.meta.env.MODE === "test" ||
        process.env.NODE_ENV !== "production");
}
/** All registered cloud routes, in registration order. */
export function listCloudRoutes() {
    return [...getStore().entries.values()]
        .sort((a, b) => a.order - b.order)
        .map(({ path, element, public: isPublic, publicAccess, group, gate }) => ({
        path,
        element,
        public: isPublic,
        publicAccess,
        group,
        gate,
    }));
}
/** Look up a single registered route by path. */
export function getCloudRoute(path) {
    return getStore().entries.get(path);
}
// ── Route-gate registry ──────────────────────────────────────────────────────
//
// The shell enforces `CloudRouteDef.gate` centrally but stays domain-agnostic:
// each gate implementation is registered by name (mirroring the route registry
// symbol-store pattern), so the shell never imports a domain's gate directly and
// no cycle forms. `admin/index.ts` registers `"admin" → AdminGate` at import
// time, alongside its route registration.
function gateRegistryKey() {
    return Symbol.for("elizaos.ui.cloud-route-gate-registry");
}
function getGateStore() {
    const globalObject = globalThis;
    const key = gateRegistryKey();
    const existing = globalObject[key];
    if (existing)
        return existing;
    const created = new Map();
    globalObject[key] = created;
    return created;
}
/** Register (or replace) a named route gate. */
export function registerCloudRouteGate(name, gate) {
    getGateStore().set(name, gate);
}
/** Resolve a registered route gate by name, or `undefined` if none. */
export function getCloudRouteGate(name) {
    return getGateStore().get(name);
}
