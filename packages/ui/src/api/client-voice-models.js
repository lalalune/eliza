/**
 * Client-side helpers for `/api/local-inference/voice-models/*`.
 *
 * Backs the `ModelUpdatesPanel` UI (R5-versioning §5) — the panel lives in
 * `packages/ui/src/components/local-inference/ModelUpdatesPanel.tsx` and
 * was originally wired with inert handlers until the local-runtime compat
 * routes landed.
 *
 * Augments `ElizaClient` via declaration merging, same pattern as
 * `client-local-inference.ts`.
 */
import { ElizaClient } from "./client-base";
ElizaClient.prototype.listVoiceModels = async function () {
    return this.fetch("/api/local-inference/voice-models");
};
ElizaClient.prototype.checkVoiceModelUpdates = async function (options) {
    const query = options?.force ? "?force=1" : "";
    return this.fetch(`/api/local-inference/voice-models/check${query}`);
};
ElizaClient.prototype.triggerVoiceModelUpdate = async function (id) {
    return this.fetch(`/api/local-inference/voice-models/${encodeURIComponent(id)}/update`, { method: "POST", body: JSON.stringify({}) });
};
ElizaClient.prototype.pinVoiceModel = async function (id, pinned) {
    return this.fetch(`/api/local-inference/voice-models/${encodeURIComponent(id)}/pin`, { method: "POST", body: JSON.stringify({ pinned }) });
};
ElizaClient.prototype.getVoiceModelPreferences = async function () {
    return this.fetch("/api/local-inference/voice-models/preferences");
};
ElizaClient.prototype.setVoiceModelPreferences = async function (patch) {
    return this.fetch("/api/local-inference/voice-models/preferences", {
        method: "POST",
        body: JSON.stringify(patch),
    });
};
