/**
 * AppBootConfig — typed runtime configuration that replaces window.__* globals.
 *
 * The hosting app (e.g. apps/app) creates an AppBootConfig and passes it via
 * <AppBootProvider>. All app-core code reads from this config instead of
 * reaching for window globals.
 *
 * React context lives in `boot-config-react.hooks.ts` so Bun/Node can import
 * this module without loading `react` runtime (avoids Bun parsing @types/react).
 */
export { syncBrandEnvToEliza, syncElizaEnvToBrand } from "@elizaos/core";
// ---------------------------------------------------------------------------
// Defaults (brand-agnostic — no product-specific references)
// ---------------------------------------------------------------------------
export const DEFAULT_BOOT_CONFIG = {
    branding: {},
    cloudApiBase: "https://elizacloud.ai",
    preferSharedCloudTier: true,
};
// ---------------------------------------------------------------------------
// Process-global config ref (for non-React code like client.ts, asset-url.ts)
// Use a Symbol-backed slot on globalThis so duplicated module instances
// still read/write the same live boot config.
// ---------------------------------------------------------------------------
const BOOT_CONFIG_STORE_KEY = Symbol.for("elizaos.app.boot-config");
const BOOT_CONFIG_WINDOW_KEY = "__ELIZAOS_APP_BOOT_CONFIG__";
/** Resolve the global object (browser or Node) with symbol-key access. */
function getGlobalSlot() {
    return globalThis;
}
function getBootConfigStore() {
    const globalObject = getGlobalSlot();
    // An established store always wins. The window-key mirror is only a pre-boot
    // seed and must never replace a store that already exists — see the matching
    // note in `@elizaos/core`'s boot-env.ts. All three copies (core, shared, ui)
    // share the same global slot, so they must agree on write-once semantics.
    const existing = globalObject[BOOT_CONFIG_STORE_KEY];
    if (existing &&
        typeof existing === "object" &&
        "current" in existing) {
        return existing;
    }
    // No store yet: seed it once from a cross-bundle window mirror if a bootstrap
    // set it, otherwise from defaults.
    const mirroredWindowConfig = globalObject[BOOT_CONFIG_WINDOW_KEY];
    const store = {
        current: mirroredWindowConfig ?? DEFAULT_BOOT_CONFIG,
    };
    globalObject[BOOT_CONFIG_STORE_KEY] = store;
    globalObject[BOOT_CONFIG_WINDOW_KEY] = store.current;
    return store;
}
/** Set the boot config. Called by AppBootProvider on mount. */
export function setBootConfig(config) {
    const store = getBootConfigStore();
    store.current = config;
    getGlobalSlot()[BOOT_CONFIG_WINDOW_KEY] = config;
}
/** Read the boot config from non-React code. */
export function getBootConfig() {
    return getBootConfigStore().current;
}
// ---------------------------------------------------------------------------
// Character catalog helpers
// ---------------------------------------------------------------------------
function resolveAssets(catalog) {
    return catalog.assets.map((asset) => ({
        ...asset,
        compressedVrmPath: `vrms/${asset.slug}.vrm.gz`,
        rawVrmPath: `vrms/${asset.slug}.vrm`,
        previewPath: `vrms/previews/${asset.slug}.png`,
        backgroundPath: `vrms/backgrounds/${asset.slug}.png`,
        sourceVrmFilename: `${asset.sourceName}.vrm`,
    }));
}
/** Resolve a character catalog into ready-to-use assets and characters. */
export function resolveCharacterCatalog(catalog) {
    const assets = resolveAssets(catalog);
    const assetById = new Map(assets.map((a) => [a.id, a]));
    const defaultAsset = assets[0] ?? null;
    const injectedCharacters = catalog.injectedCharacters.map((character) => {
        const avatarAsset = assetById.get(character.avatarAssetId) ?? defaultAsset;
        if (!avatarAsset) {
            throw new Error(`Missing avatar asset ${character.avatarAssetId} for ${character.name}.`);
        }
        return { ...character, avatarAsset };
    });
    const byCatchphrase = new Map(injectedCharacters.map((c) => [c.catchphrase, c]));
    return {
        assets,
        assetCount: assets.length,
        defaultAsset,
        injectedCharacters,
        injectedCharacterCount: injectedCharacters.length,
        getAsset: (id) => assetById.get(id) ?? defaultAsset,
        getInjectedCharacter: (catchphrase) => byCatchphrase.get(catchphrase) ?? null,
    };
}
