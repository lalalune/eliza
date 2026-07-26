/**
 * ElizaClient extension for background-image generation: the server runs the
 * agent's image provider, persists to the content-addressed media store, and
 * returns a durable /api/media/<hash> URL.
 */
import { ElizaClient } from "./client-base";
// ---------------------------------------------------------------------------
// Prototype augmentation
// ---------------------------------------------------------------------------
ElizaClient.prototype.generateBackgroundImage = async function (prompt, size) {
    return this.fetch("/api/background/generate-image", {
        method: "POST",
        body: JSON.stringify({ prompt, ...(size ? { size } : {}) }),
    });
};
ElizaClient.prototype.uploadBackgroundImage = async function (dataUrl) {
    return this.fetch("/api/background/upload-image", {
        method: "POST",
        body: JSON.stringify({ dataUrl }),
    });
};
