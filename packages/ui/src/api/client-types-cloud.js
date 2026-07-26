/**
 * Cloud-domain client DTOs: Cloud*, App*, Trajectory*, Registry*, Whitelist*,
 * Verification*, wallet display types, CodingAgent*, Pty*. One slice of the
 * ElizaClient type surface, re-exported through client-types.ts.
 */
/**
 * Maps raw ACP sessions from /api/coding-agents into CodingAgentSession[].
 * Extracted as a pure function so it can be unit-tested without instantiating
 * the full ElizaClient.
 */
export function mapAcpSessionsToCodingAgentSessions(acpSessions) {
    return acpSessions.map((s) => ({
        sessionId: s.id,
        agentType: s.agentType ?? "claude",
        label: s.metadata?.label ?? s.name ?? s.agentType ?? "Agent",
        originalTask: "",
        workdir: s.workdir ?? "",
        status: s.status === "ready" || s.status === "busy"
            ? "active"
            : s.status === "error"
                ? "error"
                : s.status === "stopped" ||
                    s.status === "done" ||
                    s.status === "completed" ||
                    s.status === "exited"
                    ? "stopped"
                    : "active",
        decisionCount: 0,
        autoResolvedCount: 0,
    }));
}
/** Maps persisted task threads into the existing CodingAgentSession UI shape. */
export function mapTaskThreadsToCodingAgentSessions(taskThreads) {
    return taskThreads.map((thread) => ({
        sessionId: thread.latestSessionId ?? thread.id,
        agentType: "task-thread",
        label: thread.title || thread.latestSessionLabel || "Task",
        originalTask: thread.originalRequest,
        workdir: thread.latestWorkdir ?? thread.latestRepo ?? "",
        status: thread.status === "failed"
            ? "error"
            : thread.status === "done"
                ? "completed"
                : thread.status === "interrupted"
                    ? "stopped"
                    : thread.status === "validating"
                        ? "tool_running"
                        : thread.status === "blocked" ||
                            thread.status === "waiting_on_user"
                            ? "blocked"
                            : "active",
        decisionCount: thread.decisionCount,
        autoResolvedCount: 0,
        lastActivity: thread.status === "interrupted"
            ? "Interrupted - reopen or resume this task"
            : thread.summary || thread.latestSessionLabel || thread.status,
    }));
}
