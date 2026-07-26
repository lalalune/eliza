/**
 * Chat-domain client DTOs: Conversation*, Chat*, Message*, Stream*, Action*,
 * Emote*, Document*, Memory*, MCP*, Share*. One slice of the ElizaClient type
 * surface, re-exported through client-types.ts.
 */
/**
 * Runtime guard for a {@link ConversationMessage} — validates the four required
 * fields (`id`, `role`, `text`, `timestamp`) of an untrusted value before it is
 * trusted as a message. Server/connector responses (e.g. `sendInboxMessage`)
 * are appended straight into the rendered message list; a malformed payload
 * (missing id/role/timestamp, an unexpected role) must NOT be `as`-cast into
 * state where it breaks keying/rendering. Use this at the API boundary instead
 * of `value as ConversationMessage`.
 */
export function isConversationMessage(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const m = value;
    return (typeof m.id === "string" &&
        m.id.length > 0 &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.text === "string" &&
        typeof m.timestamp === "number" &&
        Number.isFinite(m.timestamp));
}
export function isMissingCredentialsResponse(res) {
    const candidate = res;
    return (candidate.warning === "missing credentials" &&
        Array.isArray(candidate.missingCredentials));
}
export function isNeedsClarificationResponse(res) {
    const candidate = res;
    return (candidate.status === "needs_clarification" &&
        Array.isArray(candidate.clarifications) &&
        Array.isArray(candidate.catalog) &&
        typeof candidate.draft === "object" &&
        candidate.draft !== null);
}
