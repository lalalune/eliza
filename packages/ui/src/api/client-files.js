/**
 * Files API client methods (PR5, attachments v1) — list / delete over
 * `/api/files`. Declaration-merged onto `ElizaClient` (the side-effect import
 * in `client.ts` installs the prototype methods), matching the other
 * `client-*` domain modules.
 *
 * Backend contract (already implemented on the agent server):
 *  - `GET /api/files` → `{ files: StoredFile[] }` (newest first; authenticated).
 *  - `DELETE /api/files/:filename` → `{ deleted: boolean }` (authenticated).
 */
import { ElizaClient } from "./client-base";
ElizaClient.prototype.listFiles = async function () {
    return this.fetch("/api/files");
};
ElizaClient.prototype.deleteFile = async function (fileName) {
    return this.fetch(`/api/files/${encodeURIComponent(fileName)}`, {
        method: "DELETE",
    });
};
