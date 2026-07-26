/**
 * Build variant accessor for the renderer.
 *
 * The variant is baked into the bundle at Vite build time via the
 * `__ELIZA_BUILD_VARIANT__` define (see `packages/app/vite.config.ts`).
 * Mirror of `packages/app-core/src/runtime/build-variant.ts` for the
 * Node/Bun side — kept as a separate module because the source surface
 * differs (Vite define vs `process.env`).
 */
export const BUILD_VARIANTS = ["store", "direct"];
export const DEFAULT_BUILD_VARIANT = "direct";
function readDefine() {
    if (typeof __ELIZA_BUILD_VARIANT__ === "string") {
        return __ELIZA_BUILD_VARIANT__;
    }
    return undefined;
}
export function getBuildVariant() {
    const raw = readDefine();
    if (raw === "store")
        return "store";
    if (raw === "direct")
        return "direct";
    return DEFAULT_BUILD_VARIANT;
}
export function isStoreBuild() {
    return getBuildVariant() === "store";
}
export function isDirectBuild() {
    return getBuildVariant() === "direct";
}
