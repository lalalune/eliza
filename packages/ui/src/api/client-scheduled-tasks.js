/**
 * ElizaClient extension for owner-facing scheduled-task verbs — exactly the
 * runner's frozen ScheduledTaskVerb set — plus list/filter reads.
 */
import { ElizaClient } from "./client-base";
function buildQuery(filter) {
    if (!filter)
        return "";
    const params = new URLSearchParams();
    if (filter.kind)
        params.set("kind", filter.kind);
    if (filter.status)
        params.set("status", filter.status);
    if (filter.source)
        params.set("source", filter.source);
    if (filter.firedSince)
        params.set("firedSince", filter.firedSince);
    if (filter.ownerVisibleOnly)
        params.set("ownerVisibleOnly", "1");
    const query = params.toString();
    return query ? `?${query}` : "";
}
ElizaClient.prototype.listScheduledTasks = async function (filter) {
    const res = await this.fetch(`/api/lifeops/scheduled-tasks${buildQuery(filter)}`);
    return { tasks: Array.isArray(res?.tasks) ? res.tasks : [] };
};
ElizaClient.prototype.applyScheduledTask = async function (taskId, verb, payload) {
    return this.fetch(`/api/lifeops/scheduled-tasks/${encodeURIComponent(taskId)}/${verb}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload ?? {}),
    });
};
ElizaClient.prototype.fireScheduledTask = async function (taskId) {
    return this.fetch(`/api/lifeops/scheduled-tasks/${encodeURIComponent(taskId)}/fire`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
    });
};
ElizaClient.prototype.runLifeOpsTestProbe = async function (kind) {
    return this.fetch("/api/lifeops/scheduled-tasks/test-probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(kind ? { kind } : {}),
    });
};
