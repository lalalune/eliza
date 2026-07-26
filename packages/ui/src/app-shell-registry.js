import { getUiRegistryStore } from "./registry-host";
const APP_SHELL_PAGE_REGISTRY_STORE = "app-shell-pages";
function getRegistryStore() {
    return getUiRegistryStore(APP_SHELL_PAGE_REGISTRY_STORE, () => ({
        entries: new Map(),
        listeners: new Set(),
        version: 0,
    }));
}
export function registerAppShellPage(registration) {
    const store = getRegistryStore();
    store.entries.set(registration.id, registration);
    store.version += 1;
    for (const listener of store.listeners)
        listener();
}
export function listAppShellPages() {
    return [...getRegistryStore().entries.values()];
}
export function subscribeAppShellPages(listener) {
    const store = getRegistryStore();
    store.listeners.add(listener);
    return () => {
        store.listeners.delete(listener);
    };
}
export function getAppShellPageRegistrySnapshot() {
    return getRegistryStore().version;
}
function hostExternalImporterRegistryKey() {
    return Symbol.for("elizaos.app-core.host-external-importer-registry");
}
function getHostExternalImporterStore() {
    const globalObject = globalThis;
    const registryKey = hostExternalImporterRegistryKey();
    const existing = globalObject[registryKey];
    if (existing)
        return existing;
    const created = new Map();
    globalObject[registryKey] = created;
    return created;
}
/**
 * Contribute a host-external importer for a view-bundle specifier the framework
 * trunk map in `DynamicViewLoader` does not own. This is the extension point
 * that keeps plugin-specific specifiers (e.g. `@elizaos/plugin-browser`) out of
 * the shared UI trunk: a plugin app-shell bundle or a build-variant entrypoint
 * registers its own specifiers, and `DynamicViewLoader` consults this registry
 * after its framework map. Backed by a global-symbol store so a single registry
 * is shared even if `@elizaos/ui` is instantiated in more than one chunk.
 */
export function registerHostExternalImporter(specifier, importer) {
    getHostExternalImporterStore().set(specifier, importer);
}
/** Resolve a registered host-external importer, or `undefined` if none. */
export function resolveRegisteredHostExternalImporter(specifier) {
    return getHostExternalImporterStore().get(specifier);
}
/** The specifiers contributed through {@link registerHostExternalImporter}. */
export function registeredHostExternalSpecifiers() {
    return [...getHostExternalImporterStore().keys()];
}
