/**
 * Local-inference engine surface for the shared UI library.
 *
 * Text inference runs in the bun AGENT — reached from the renderer through
 * the device-bridge / API client, or in-process through a runtime-registered
 * `localInferenceLoader` service (the AOSP bun:ffi loader or the device-bridge
 * loader). The shared `@elizaos/ui` library ships in the WebView/browser where
 * no Node-native llama binding can load, so this module owns NO inference
 * binding. It is a typed no-op surface kept so `active-model.ts` and its
 * consumers (the Settings UI, the active-model SSE) keep a stable fallback to
 * resolve against when no runtime loader is registered.
 *
 * The fallback always reports unavailable; `load()` / `generate()` fail with a
 * clear message instead of pretending to run a model in the renderer.
 */
const UNAVAILABLE_MESSAGE = "Local inference runs in the Eliza agent, not the UI renderer. " +
    "Register a `localInferenceLoader` service (AOSP bun:ffi or device-bridge) " +
    "to drive local models.";
export function gpuLayersForKvOffload(mode) {
    if (mode === "cpu")
        return 0;
    if (mode === "gpu")
        return "max";
    if (mode === "split")
        return "auto";
    return mode.gpuLayers;
}
export function resolveGpuLayersForLoad(resolved) {
    if (resolved?.gpuLayers !== undefined)
        return resolved.gpuLayers;
    if (resolved?.kvOffload !== undefined) {
        return gpuLayersForKvOffload(resolved.kvOffload);
    }
    if (resolved?.useGpu === false)
        return 0;
    return "auto";
}
export class LocalInferenceEngine {
    available() {
        return Promise.resolve(false);
    }
    currentModelPath() {
        return null;
    }
    hasLoadedModel() {
        return false;
    }
    unload() {
        return Promise.resolve();
    }
    load(_modelPath, _resolved) {
        return Promise.reject(new Error(UNAVAILABLE_MESSAGE));
    }
    generate(_args) {
        return Promise.reject(new Error(UNAVAILABLE_MESSAGE));
    }
}
export const localInferenceEngine = new LocalInferenceEngine();
