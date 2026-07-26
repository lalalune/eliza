/**
 * localStorage-backed cache of the last-fetched apps catalog, used to paint the
 * apps grid instantly on boot before the network fetch resolves. Reads validate
 * each entry against a minimal `RegistryAppInfo` shape guard and drop the whole
 * cache on any malformed or unparseable payload.
 */
const CACHE_KEY = "eliza:apps:catalog:v1";
function isRegistryAppInfo(value) {
    return (value !== null &&
        typeof value === "object" &&
        typeof value.name === "string");
}
export function readAppsCache() {
    if (typeof window === "undefined")
        return null;
    try {
        const raw = window.localStorage.getItem(CACHE_KEY);
        if (!raw)
            return null;
        const parsed = JSON.parse(raw);
        if (parsed === null ||
            typeof parsed !== "object" ||
            !Array.isArray(parsed.apps)) {
            return null;
        }
        const apps = parsed.apps.filter(isRegistryAppInfo);
        return apps.length > 0 ? apps : null;
    }
    catch {
        // error-policy:J3 corrupt cache envelope — null forces a live registry
        // fetch; the cache is a warm-start optimization only.
        return null;
    }
}
export function writeAppsCache(apps) {
    if (typeof window === "undefined")
        return;
    try {
        const envelope = { cachedAt: Date.now(), apps };
        window.localStorage.setItem(CACHE_KEY, JSON.stringify(envelope));
    }
    catch {
        /* sandboxed storage — drop silently */
    }
}
export function clearAppsCache() {
    if (typeof window === "undefined")
        return;
    try {
        window.localStorage.removeItem(CACHE_KEY);
    }
    catch {
        /* ignore */
    }
}
