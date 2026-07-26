/**
 * Workflow domain methods — status, workflow CRUD.
 *
 * All routes hit `/api/workflow/*` on the local agent server.
 * The workflow CRUD routes are served by the workflow plugin itself
 * but exposed through the same base URL via the plugin's route registration.
 */
import { ElizaClient } from "./client-base";
// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------
ElizaClient.prototype.getWorkflowStatus = async function () {
    return this.fetch("/api/workflow/status");
};
ElizaClient.prototype.getWorkflowDefinition = async function (id) {
    return this.fetch(`/api/workflow/workflows/${encodeURIComponent(id)}`);
};
ElizaClient.prototype.listWorkflowDefinitions = async function () {
    const res = await this.fetch("/api/workflow/workflows");
    return res.workflows ?? [];
};
ElizaClient.prototype.createWorkflowDefinition = async function (request) {
    return this.fetch("/api/workflow/workflows", {
        method: "POST",
        body: JSON.stringify(request),
    });
};
ElizaClient.prototype.updateWorkflowDefinition = async function (id, request) {
    return this.fetch(`/api/workflow/workflows/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(request),
    });
};
ElizaClient.prototype.generateWorkflowDefinition = async function (request) {
    // LLM-driven workflow generation runs keyword extraction, node search,
    // generation, multiple correction passes, and feasibility assessment
    // sequentially — easily 30-90s on a cold cache. The 10s default fetch
    // timeout is far too aggressive and surfaces as
    // "Request timed out after 10000ms" in the Automations UI even when
    // the backend would have succeeded a few seconds later.
    return this.fetch("/api/workflow/workflows/generate", {
        method: "POST",
        body: JSON.stringify(request),
    }, { timeoutMs: 120_000 });
};
ElizaClient.prototype.resolveWorkflowClarification = async function (request) {
    // Patch + deploy is server-side and synchronous from the user's view, but
    // it still runs validateAndRepair + a deploy round-trip. Reuse the same
    // generous timeout as the generate call so a slow workflow write does not
    // surface as a misleading "Request timed out" toast.
    return this.fetch("/api/workflow/workflows/resolve-clarification", {
        method: "POST",
        body: JSON.stringify(request),
    }, { timeoutMs: 120_000 });
};
ElizaClient.prototype.activateWorkflowDefinition = async function (id) {
    return this.fetch(`/api/workflow/workflows/${encodeURIComponent(id)}/activate`, {
        method: "POST",
    });
};
ElizaClient.prototype.deactivateWorkflowDefinition = async function (id) {
    return this.fetch(`/api/workflow/workflows/${encodeURIComponent(id)}/deactivate`, { method: "POST" });
};
ElizaClient.prototype.deleteWorkflowDefinition = async function (id) {
    return this.fetch(`/api/workflow/workflows/${encodeURIComponent(id)}`, { method: "DELETE" });
};
ElizaClient.prototype.runWorkflowDefinition = async function (id) {
    const result = await this.fetch(`/api/workflow/workflows/${encodeURIComponent(id)}/run`, {
        method: "POST",
    });
    if (!result.execution) {
        throw new Error("Workflow run response did not include an execution.");
    }
    return result.execution;
};
ElizaClient.prototype.getWorkflowExecutions = async function (id, limit = 10) {
    const result = await this.fetch(`/api/workflow/workflows/${encodeURIComponent(id)}/executions?limit=${limit}`);
    return result.executions ?? [];
};
ElizaClient.prototype.getWorkflowExecution = async function (id) {
    const result = await this.fetch(`/api/workflow/executions/${encodeURIComponent(id)}`);
    if (!result.execution) {
        throw new Error("Workflow execution response did not include an execution.");
    }
    return result.execution;
};
ElizaClient.prototype.getWorkflowEvaluationSamples = async function (id, limit = 10) {
    return this.fetch(`/api/workflow/workflows/${encodeURIComponent(id)}/evaluation-samples?limit=${limit}`);
};
ElizaClient.prototype.getWorkflowRevisions = async function (id, limit = 20) {
    const result = await this.fetch(`/api/workflow/workflows/${encodeURIComponent(id)}/revisions?limit=${limit}`);
    return {
        currentVersionId: result.currentVersionId ?? null,
        revisions: result.revisions ?? [],
    };
};
ElizaClient.prototype.restoreWorkflowRevision = async function (id, versionId) {
    return this.fetch(`/api/workflow/workflows/${encodeURIComponent(id)}/revisions/${encodeURIComponent(versionId)}/restore`, { method: "POST" });
};
