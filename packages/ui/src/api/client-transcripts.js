/**
 * Transcript API client methods (#8789) — list / get / create / delete over
 * `/api/transcripts`. Declaration-merged onto `ElizaClient` (the side-effect
 * import in `client.ts` installs the prototype methods), matching the other
 * `client-*` domain modules.
 */
import { ElizaClient } from "./client-base";
ElizaClient.prototype.listTranscripts = async function (roomId) {
    const q = roomId ? `?roomId=${encodeURIComponent(roomId)}` : "";
    return this.fetch(`/api/transcripts${q}`);
};
ElizaClient.prototype.getTranscript = async function (id) {
    return this.fetch(`/api/transcripts/${encodeURIComponent(id)}`);
};
ElizaClient.prototype.createTranscript = async function (input) {
    return this.fetch("/api/transcripts", {
        method: "POST",
        body: JSON.stringify(input),
    });
};
ElizaClient.prototype.updateTranscript = async function (id, input) {
    return this.fetch(`/api/transcripts/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(input),
    });
};
ElizaClient.prototype.deleteTranscript = async function (id) {
    return this.fetch(`/api/transcripts/${encodeURIComponent(id)}`, {
        method: "DELETE",
    });
};
