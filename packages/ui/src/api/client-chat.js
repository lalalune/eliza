/**
 * Chat domain methods — chat, conversations, documents, memory, MCP,
 * share ingest, workbench, trajectories, database.
 */
import { invokeDesktopBridgeRequest } from "../bridge/electrobun-rpc";
import { ElizaClient } from "./client-base";
import { isDesktopExternalApiBaseUrl } from "./desktop-external-api-base";
function setPositiveNumberParam(params, key, value) {
    if (typeof value === "number" && value > 0)
        params.set(key, String(value));
}
function setTruthyNumberParam(params, key, value) {
    if (value)
        params.set(key, String(value));
}
function setDefinedNumberParam(params, key, value) {
    if (value !== undefined)
        params.set(key, String(value));
}
function setNonEmptyStringParam(params, key, value) {
    if (typeof value === "string" && value.length > 0)
        params.set(key, value);
}
function setTruthyStringParam(params, key, value) {
    if (value)
        params.set(key, value);
}
function appendTagsParam(params, tags) {
    for (const tag of tags ?? [])
        params.append("tag", tag);
}
function buildSourcesParams(sources) {
    const params = new URLSearchParams();
    if (sources && sources.length > 0)
        params.set("sources", sources.join(","));
    return params;
}
function buildInboxMessagesParams(options) {
    const params = buildSourcesParams(options?.sources);
    setPositiveNumberParam(params, "limit", options?.limit);
    setNonEmptyStringParam(params, "roomId", options?.roomId);
    setNonEmptyStringParam(params, "roomSource", options?.roomSource);
    return params;
}
function buildInboxMessagesRpcParams(options) {
    const params = {};
    if (typeof options?.limit === "number" && options.limit > 0) {
        params.limit = options.limit;
    }
    if (options?.sources && options.sources.length > 0) {
        params.sources = options.sources;
    }
    if (typeof options?.roomId === "string" && options.roomId.length > 0) {
        params.roomId = options.roomId;
    }
    if (typeof options?.roomSource === "string" &&
        options.roomSource.length > 0) {
        params.roomSource = options.roomSource;
    }
    return params;
}
function buildInboxChatsRpcParams(options) {
    return options?.sources && options.sources.length > 0
        ? { sources: options.sources }
        : {};
}
function appendDocumentFilterParams(params, options) {
    setTruthyStringParam(params, "scope", options?.scope);
    setTruthyStringParam(params, "scopedToEntityId", options?.scopedToEntityId);
    setTruthyStringParam(params, "addedBy", options?.addedBy);
    setTruthyStringParam(params, "timeRangeStart", options?.timeRangeStart);
    setTruthyStringParam(params, "timeRangeEnd", options?.timeRangeEnd);
    appendTagsParam(params, options?.tags);
}
function buildDocumentListParams(options) {
    const params = new URLSearchParams();
    setTruthyNumberParam(params, "limit", options?.limit);
    setTruthyNumberParam(params, "offset", options?.offset);
    if (options?.query)
        params.set("q", options.query);
    appendDocumentFilterParams(params, options);
    return params;
}
function buildDocumentSearchParams(query, options) {
    const params = new URLSearchParams({ q: query });
    setDefinedNumberParam(params, "threshold", options?.threshold);
    setDefinedNumberParam(params, "limit", options?.limit);
    setTruthyStringParam(params, "query", options?.query);
    appendDocumentFilterParams(params, options);
    return params;
}
function buildTrajectoryParams(options) {
    const params = new URLSearchParams();
    setTruthyNumberParam(params, "limit", options?.limit);
    setTruthyNumberParam(params, "offset", options?.offset);
    setTruthyStringParam(params, "source", options?.source);
    setTruthyStringParam(params, "scenarioId", options?.scenarioId);
    setTruthyStringParam(params, "batchId", options?.batchId);
    setTruthyStringParam(params, "status", options?.status);
    setTruthyStringParam(params, "startDate", options?.startDate);
    setTruthyStringParam(params, "endDate", options?.endDate);
    setTruthyStringParam(params, "search", options?.search);
    return params;
}
// ---------------------------------------------------------------------------
// Prototype augmentation
// ---------------------------------------------------------------------------
const LEGACY_CHAT_COMPAT_TITLE = "Quick Chat";
const LEGACY_CHAT_CONVERSATION_STORAGE_PREFIX = "legacy_chat_conversation";
function getLegacyChatConversationStorageKey(client) {
    const base = client.getBaseUrl() ||
        (typeof window !== "undefined" ? window.location.origin : "same-origin");
    return `${LEGACY_CHAT_CONVERSATION_STORAGE_PREFIX}:${encodeURIComponent(base)}`;
}
function readLegacyChatConversationId(client) {
    if (typeof window === "undefined") {
        return null;
    }
    const stored = window.sessionStorage.getItem(getLegacyChatConversationStorageKey(client));
    return stored?.trim() ? stored.trim() : null;
}
function writeLegacyChatConversationId(client, conversationId) {
    if (typeof window === "undefined") {
        return;
    }
    const key = getLegacyChatConversationStorageKey(client);
    if (conversationId?.trim()) {
        window.sessionStorage.setItem(key, conversationId.trim());
        return;
    }
    window.sessionStorage.removeItem(key);
}
async function ensureLegacyChatConversationId(client) {
    const cached = readLegacyChatConversationId(client);
    if (cached) {
        return cached;
    }
    const { conversation } = await client.createConversation(LEGACY_CHAT_COMPAT_TITLE);
    writeLegacyChatConversationId(client, conversation.id);
    return conversation.id;
}
ElizaClient.prototype.sendChatRest = async function (text, channelType = "DM") {
    const sendToConversation = async (conversationId) => this.sendConversationMessage(conversationId, text, channelType, undefined);
    const conversationId = await ensureLegacyChatConversationId(this);
    try {
        return await sendToConversation(conversationId);
    }
    catch (error) {
        if (error instanceof Error &&
            error.name === "ApiError" &&
            error.status === 404) {
            writeLegacyChatConversationId(this, null);
            return sendToConversation(await ensureLegacyChatConversationId(this));
        }
        throw error;
    }
};
ElizaClient.prototype.sendChatMessage = function (text, channelType = "DM") {
    void this.sendChatRest(text, channelType).catch(() => {
        // View affordances use this as a fire-and-forget "ask Eliza" bridge; the
        // chat surface owns visible delivery/error state for full composer sends.
    });
};
ElizaClient.prototype.sendChatStream = async function (text, onToken, channelType = "DM", signal) {
    const streamConversation = async (conversationId) => this.sendConversationMessageStream(conversationId, text, onToken, channelType, signal, undefined);
    const conversationId = await ensureLegacyChatConversationId(this);
    try {
        return await streamConversation(conversationId);
    }
    catch (error) {
        if (error instanceof Error &&
            error.name === "ApiError" &&
            error.status === 404) {
            writeLegacyChatConversationId(this, null);
            return streamConversation(await ensureLegacyChatConversationId(this));
        }
        throw error;
    }
};
// A serverless / shared-runtime agent may omit `updatedAt` from conversation
// objects (a never-updated conversation legitimately has updatedAt == createdAt).
// The shared `isConversationRecord` guard requires the standard shape, so without
// this the conversation list filters to empty and chat sends are dropped for want
// of an active conversation (createConversation's result is rejected too). Default
// the field at the API boundary — clean DTO completion, not a server-specific
// special case.
function withConversationDefaults(conversation) {
    if (conversation &&
        typeof conversation === "object" &&
        typeof conversation.updatedAt !== "string") {
        const createdAt = conversation.createdAt;
        if (typeof createdAt === "string") {
            return {
                ...conversation,
                updatedAt: createdAt,
            };
        }
    }
    return conversation;
}
function withConversationListDefaults(response) {
    if (response && Array.isArray(response.conversations)) {
        return {
            ...response,
            conversations: response.conversations.map(withConversationDefaults),
        };
    }
    return response;
}
async function invokeLocalDesktopChatRpc(baseUrl, options) {
    if (isDesktopExternalApiBaseUrl(baseUrl))
        return null;
    return invokeDesktopBridgeRequest(options);
}
ElizaClient.prototype.listConversations = async function () {
    // Prefer typed Electrobun RPC. The bun-side composer throws
    // AgentNotReadyError if the agent has no port yet; we catch and
    // fall through to HTTP so the sidebar's polling loop sees the same
    // "transport not ready" semantic as before RPC was wired.
    try {
        const viaRpc = await invokeLocalDesktopChatRpc(this.getBaseUrl(), {
            rpcMethod: "listConversations",
            ipcChannel: "agent",
        });
        if (viaRpc)
            return withConversationListDefaults(viaRpc);
    }
    catch {
        /* AgentNotReadyError or any RPC failure → fall through to HTTP */
    }
    return withConversationListDefaults(await this.fetch("/api/conversations"));
};
ElizaClient.prototype.createConversation = async function (title, options) {
    const response = await this.fetch("/api/conversations", {
        method: "POST",
        body: JSON.stringify({
            title,
            ...(options?.includeGreeting === true ||
                options?.bootstrapGreeting === true
                ? { includeGreeting: true }
                : {}),
            ...(typeof options?.lang === "string" && options.lang.trim()
                ? { lang: options.lang.trim() }
                : {}),
            ...(options?.metadata ? { metadata: options.metadata } : {}),
        }),
    });
    const conversation = withConversationDefaults(response.conversation);
    if (!response.greeting) {
        return { ...response, conversation };
    }
    return {
        ...response,
        conversation,
        greeting: {
            ...response.greeting,
            text: this.normalizeGreetingText(response.greeting.text),
        },
    };
};
ElizaClient.prototype.getConversationMessages = async function (id, options) {
    let response = null;
    // The desktop-bridge RPC only serves the recent window; an `around` jump must
    // go straight to HTTP so the server can center the window on the target.
    if (!options?.around) {
        try {
            response = await invokeLocalDesktopChatRpc(this.getBaseUrl(), {
                rpcMethod: "getConversationMessages",
                ipcChannel: "agent",
                params: { id },
            });
        }
        catch {
            response = null;
        }
    }
    // The HTTP path is abortable (a rapid conversation swipe cancels the prior
    // in-flight load so stacked requests don't race to set the thread); the
    // desktop bridge path is local + fast and ignores the signal.
    const query = options?.around
        ? `?around=${encodeURIComponent(options.around)}`
        : "";
    response ??= await this.fetch(`/api/conversations/${encodeURIComponent(id)}/messages${query}`, options?.signal ? { signal: options.signal } : undefined);
    return {
        messages: response.messages.map((message) => {
            if (message.role !== "assistant")
                return message;
            const text = this.normalizeAssistantText(message.text);
            return text === message.text ? message : { ...message, text };
        }),
    };
};
ElizaClient.prototype.searchConversationMessages = async function (query, options) {
    const params = new URLSearchParams({ q: query });
    if (options?.limit !== undefined)
        params.set("limit", String(options.limit));
    if (options?.offset !== undefined)
        params.set("offset", String(options.offset));
    return this.fetch(`/api/conversations/messages/search?${params}`, options?.signal ? { signal: options.signal } : undefined);
};
ElizaClient.prototype.getInboxMessages = async function (options) {
    const params = buildInboxMessagesParams(options);
    const query = params.toString();
    const path = query ? `/api/inbox/messages?${query}` : "/api/inbox/messages";
    try {
        const viaRpc = await invokeLocalDesktopChatRpc(this.getBaseUrl(), {
            rpcMethod: "getInboxMessages",
            ipcChannel: "agent",
            params: buildInboxMessagesRpcParams(options),
        });
        if (viaRpc)
            return viaRpc;
    }
    catch {
        /* fall through */
    }
    return this.fetch(path);
};
ElizaClient.prototype.getInboxSources = async function () {
    try {
        const viaRpc = await invokeLocalDesktopChatRpc(this.getBaseUrl(), {
            rpcMethod: "getInboxSources",
            ipcChannel: "agent",
        });
        if (viaRpc)
            return viaRpc;
    }
    catch {
        /* fall through */
    }
    return this.fetch("/api/inbox/sources");
};
ElizaClient.prototype.getInboxChats = async function (options) {
    const params = buildSourcesParams(options?.sources);
    const query = params.toString();
    const path = query ? `/api/inbox/chats?${query}` : "/api/inbox/chats";
    try {
        const viaRpc = await invokeLocalDesktopChatRpc(this.getBaseUrl(), {
            rpcMethod: "getInboxChats",
            ipcChannel: "agent",
            params: buildInboxChatsRpcParams(options),
        });
        if (viaRpc)
            return viaRpc;
    }
    catch {
        /* fall through */
    }
    return this.fetch(path);
};
ElizaClient.prototype.setInboxChatMute = async function (data) {
    return this.fetch("/api/inbox/chats/mute", {
        method: "POST",
        body: JSON.stringify(data),
    });
};
ElizaClient.prototype.sendInboxMessage = async function (data) {
    return this.fetch("/api/inbox/messages", {
        method: "POST",
        body: JSON.stringify(data),
    });
};
ElizaClient.prototype.truncateConversationMessages = async function (id, messageId, options) {
    return this.fetch(`/api/conversations/${encodeURIComponent(id)}/messages/truncate`, {
        method: "POST",
        body: JSON.stringify({
            messageId,
            inclusive: options?.inclusive === true,
        }),
    });
};
ElizaClient.prototype.deleteConversationMessage = async function (id, messageId) {
    return this.fetch(`/api/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}`, { method: "DELETE" });
};
ElizaClient.prototype.sendConversationMessage = async function (id, text, channelType = "DM", images, metadata) {
    const response = await this.fetch(`/api/conversations/${encodeURIComponent(id)}/messages`, {
        method: "POST",
        body: JSON.stringify({
            text,
            channelType,
            ...(images?.length ? { images } : {}),
            ...(metadata ? { metadata } : {}),
        }),
    });
    return {
        ...response,
        text: response.noResponseReason === "ignored"
            ? ""
            : this.normalizeAssistantText(response.text),
    };
};
ElizaClient.prototype.sendConversationMessageStream = async function (id, text, onToken, channelType = "DM", signal, images, metadata, onStatus) {
    return this.streamChatEndpoint(`/api/conversations/${encodeURIComponent(id)}/messages/stream`, text, onToken, channelType, signal, images, metadata, onStatus);
};
ElizaClient.prototype.abortConversationTurn = async function (roomId, reason = "ui-abort") {
    return this.fetch(`/api/turns/${encodeURIComponent(roomId)}/abort`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
    });
};
ElizaClient.prototype.requestGreeting = async function (id, lang) {
    const qs = lang ? `?lang=${encodeURIComponent(lang)}` : "";
    const response = await this.fetch(`/api/conversations/${encodeURIComponent(id)}/greeting${qs}`, {
        method: "POST",
    });
    return {
        ...response,
        text: this.normalizeGreetingText(response.text),
    };
};
ElizaClient.prototype.renameConversation = async function (id, title, options) {
    return this.updateConversation(id, {
        title,
        generate: options?.generate,
    });
};
ElizaClient.prototype.updateConversation = async function (id, data) {
    return this.fetch(`/api/conversations/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({
            ...(typeof data?.title === "string" ? { title: data.title } : {}),
            ...(typeof data?.generate === "boolean"
                ? { generate: data.generate }
                : {}),
            ...(data && "metadata" in data ? { metadata: data.metadata } : {}),
        }),
    });
};
ElizaClient.prototype.deleteConversation = async function (id) {
    return this.fetch(`/api/conversations/${encodeURIComponent(id)}`, {
        method: "DELETE",
    });
};
ElizaClient.prototype.cleanupEmptyConversations = async function (options) {
    return this.fetch("/api/conversations/cleanup-empty", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            ...(options?.keepId ? { keepId: options.keepId } : {}),
        }),
    });
};
ElizaClient.prototype.getDocumentStats = async function () {
    return this.fetch("/api/documents/stats");
};
ElizaClient.prototype.listDocuments = async function (options) {
    const params = buildDocumentListParams(options);
    const query = params.toString();
    return this.fetch(`/api/documents${query ? `?${query}` : ""}`);
};
ElizaClient.prototype.getDocument = async function (documentId) {
    return this.fetch(`/api/documents/${encodeURIComponent(documentId)}`);
};
ElizaClient.prototype.updateDocument = async function (documentId, data) {
    return this.fetch(`/api/documents/${encodeURIComponent(documentId)}`, {
        method: "PATCH",
        body: JSON.stringify(data),
    });
};
ElizaClient.prototype.deleteDocument = async function (documentId) {
    return this.fetch(`/api/documents/${encodeURIComponent(documentId)}`, {
        method: "DELETE",
    });
};
ElizaClient.prototype.uploadDocument = async function (data) {
    return this.fetch("/api/documents", {
        method: "POST",
        body: JSON.stringify(data),
    });
};
ElizaClient.prototype.uploadDocumentsBulk = async function (data) {
    return this.fetch("/api/documents/bulk", {
        method: "POST",
        body: JSON.stringify(data),
    });
};
ElizaClient.prototype.uploadDocumentFromUrl = async function (url, options) {
    const metadata = {
        ...(options?.metadata ?? {}),
        ...(typeof options?.includeImageDescriptions === "boolean"
            ? { includeImageDescriptions: options.includeImageDescriptions }
            : {}),
    };
    return this.fetch("/api/documents/url", {
        method: "POST",
        body: JSON.stringify({
            url,
            ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
            ...(options?.entityId ? { entityId: options.entityId } : {}),
            ...(options?.scope ? { scope: options.scope } : {}),
            ...(options?.scopedToEntityId
                ? { scopedToEntityId: options.scopedToEntityId }
                : {}),
        }),
    });
};
ElizaClient.prototype.searchDocuments = async function (query, options) {
    const params = buildDocumentSearchParams(query, options);
    return this.fetch(`/api/documents/search?${params}`);
};
ElizaClient.prototype.getDocumentFragments = async function (documentId) {
    return this.fetch(`/api/documents/${encodeURIComponent(documentId)}/fragments`);
};
ElizaClient.prototype.rememberMemory = async function (text) {
    return this.fetch("/api/memory/remember", {
        method: "POST",
        body: JSON.stringify({ text }),
    });
};
ElizaClient.prototype.searchMemory = async function (query, options) {
    const params = new URLSearchParams({ q: query });
    if (options?.limit !== undefined)
        params.set("limit", String(options.limit));
    return this.fetch(`/api/memory/search?${params}`);
};
ElizaClient.prototype.quickContext = async function (query, options) {
    const params = new URLSearchParams({ q: query });
    if (options?.limit !== undefined)
        params.set("limit", String(options.limit));
    return this.fetch(`/api/context/quick?${params}`);
};
ElizaClient.prototype.getMemoryFeed = async function (query) {
    const params = new URLSearchParams();
    if (query?.type)
        params.set("type", query.type);
    if (typeof query?.limit === "number")
        params.set("limit", String(query.limit));
    if (typeof query?.before === "number")
        params.set("before", String(query.before));
    const qs = params.toString();
    return this.fetch(`/api/memories/feed${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.browseMemories = async function (query) {
    const params = new URLSearchParams();
    if (query?.type)
        params.set("type", query.type);
    if (query?.entityId)
        params.set("entityId", query.entityId);
    if (query?.roomId)
        params.set("roomId", query.roomId);
    if (query?.q)
        params.set("q", query.q);
    if (typeof query?.limit === "number")
        params.set("limit", String(query.limit));
    if (typeof query?.offset === "number")
        params.set("offset", String(query.offset));
    const qs = params.toString();
    return this.fetch(`/api/memories/browse${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.getMemoriesByEntity = async function (entityId, query) {
    const params = new URLSearchParams();
    if (query?.type)
        params.set("type", query.type);
    if (typeof query?.limit === "number")
        params.set("limit", String(query.limit));
    if (typeof query?.offset === "number")
        params.set("offset", String(query.offset));
    if (query?.entityIds && query.entityIds.length > 0)
        params.set("entityIds", query.entityIds.join(","));
    const qs = params.toString();
    return this.fetch(`/api/memories/by-entity/${encodeURIComponent(entityId)}${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.getMemoryStats = async function () {
    return this.fetch("/api/memories/stats");
};
ElizaClient.prototype.getMcpConfig = async function () {
    return this.fetch("/api/mcp/config");
};
ElizaClient.prototype.getMcpStatus = async function () {
    return this.fetch("/api/mcp/status");
};
ElizaClient.prototype.searchMcpMarketplace = async function (query, limit) {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    return this.fetch(`/api/mcp/marketplace/search?${params}`);
};
ElizaClient.prototype.getMcpServerDetails = async function (name) {
    return this.fetch(`/api/mcp/marketplace/${encodeURIComponent(name)}`);
};
ElizaClient.prototype.addMcpServer = async function (name, config) {
    await this.fetch("/api/mcp/servers", {
        method: "POST",
        body: JSON.stringify({ name, config }),
    });
};
ElizaClient.prototype.removeMcpServer = async function (name) {
    await this.fetch(`/api/mcp/servers/${encodeURIComponent(name)}`, {
        method: "DELETE",
    });
};
ElizaClient.prototype.ingestShare = async function (payload) {
    return this.fetch("/api/ingest/share", {
        method: "POST",
        body: JSON.stringify(payload),
    });
};
ElizaClient.prototype.consumeShareIngest = async function () {
    return this.fetch("/api/share/consume", { method: "POST" });
};
ElizaClient.prototype.getWorkbenchOverview = async function () {
    return this.fetch("/api/workbench/overview");
};
ElizaClient.prototype.listWorkbenchTasks = async function () {
    return this.fetch("/api/workbench/tasks");
};
ElizaClient.prototype.getWorkbenchTask = async function (taskId) {
    return this.fetch(`/api/workbench/tasks/${encodeURIComponent(taskId)}`);
};
ElizaClient.prototype.createWorkbenchTask = async function (data) {
    return this.fetch("/api/workbench/tasks", {
        method: "POST",
        body: JSON.stringify(data),
    });
};
ElizaClient.prototype.updateWorkbenchTask = async function (taskId, data) {
    return this.fetch(`/api/workbench/tasks/${encodeURIComponent(taskId)}`, {
        method: "PUT",
        body: JSON.stringify(data),
    });
};
ElizaClient.prototype.deleteWorkbenchTask = async function (taskId) {
    return this.fetch(`/api/workbench/tasks/${encodeURIComponent(taskId)}`, {
        method: "DELETE",
    });
};
ElizaClient.prototype.listWorkbenchTodos = async function () {
    return this.fetch("/api/workbench/todos");
};
ElizaClient.prototype.getWorkbenchTodo = async function (todoId) {
    return this.fetch(`/api/workbench/todos/${encodeURIComponent(todoId)}`);
};
ElizaClient.prototype.createWorkbenchTodo = async function (data) {
    return this.fetch("/api/workbench/todos", {
        method: "POST",
        body: JSON.stringify(data),
    });
};
ElizaClient.prototype.updateWorkbenchTodo = async function (todoId, data) {
    return this.fetch(`/api/workbench/todos/${encodeURIComponent(todoId)}`, {
        method: "PUT",
        body: JSON.stringify(data),
    });
};
ElizaClient.prototype.setWorkbenchTodoCompleted = async function (todoId, isCompleted) {
    await this.fetch(`/api/workbench/todos/${encodeURIComponent(todoId)}/complete`, {
        method: "POST",
        body: JSON.stringify({ isCompleted }),
    });
};
ElizaClient.prototype.deleteWorkbenchTodo = async function (todoId) {
    return this.fetch(`/api/workbench/todos/${encodeURIComponent(todoId)}`, {
        method: "DELETE",
    });
};
ElizaClient.prototype.createWorkbenchVfsProject = async function (projectId) {
    return this.fetch("/api/workbench/vfs/projects", {
        method: "POST",
        body: JSON.stringify({ projectId }),
    });
};
ElizaClient.prototype.getWorkbenchVfsQuota = async function (projectId) {
    return this.fetch(`/api/workbench/vfs/projects/${encodeURIComponent(projectId)}/quota`);
};
ElizaClient.prototype.listWorkbenchVfsFiles = async function (projectId, options = {}) {
    const params = new URLSearchParams();
    if (options.path)
        params.set("path", options.path);
    if (options.recursive)
        params.set("recursive", "true");
    const query = params.toString();
    return this.fetch(`/api/workbench/vfs/projects/${encodeURIComponent(projectId)}/files${query ? `?${query}` : ""}`);
};
ElizaClient.prototype.readWorkbenchVfsFile = async function (projectId, path, options = {}) {
    const params = new URLSearchParams({ path });
    if (options.encoding)
        params.set("encoding", options.encoding);
    return this.fetch(`/api/workbench/vfs/projects/${encodeURIComponent(projectId)}/file?${params.toString()}`);
};
ElizaClient.prototype.writeWorkbenchVfsFile = async function (projectId, data) {
    return this.fetch(`/api/workbench/vfs/projects/${encodeURIComponent(projectId)}/file`, {
        method: "PUT",
        body: JSON.stringify(data),
    });
};
ElizaClient.prototype.deleteWorkbenchVfsFile = async function (projectId, path) {
    const params = new URLSearchParams({ path });
    return this.fetch(`/api/workbench/vfs/projects/${encodeURIComponent(projectId)}/file?${params.toString()}`, { method: "DELETE" });
};
ElizaClient.prototype.listWorkbenchVfsSnapshots = async function (projectId) {
    return this.fetch(`/api/workbench/vfs/projects/${encodeURIComponent(projectId)}/snapshots`);
};
ElizaClient.prototype.createWorkbenchVfsSnapshot = async function (projectId, data = {}) {
    return this.fetch(`/api/workbench/vfs/projects/${encodeURIComponent(projectId)}/snapshots`, {
        method: "POST",
        body: JSON.stringify(data),
    });
};
ElizaClient.prototype.getWorkbenchVfsDiff = async function (projectId, snapshotId) {
    const params = new URLSearchParams({ snapshotId });
    return this.fetch(`/api/workbench/vfs/projects/${encodeURIComponent(projectId)}/diff?${params.toString()}`);
};
ElizaClient.prototype.rollbackWorkbenchVfs = async function (projectId, snapshotId) {
    return this.fetch(`/api/workbench/vfs/projects/${encodeURIComponent(projectId)}/rollback`, {
        method: "POST",
        body: JSON.stringify({ snapshotId }),
    });
};
ElizaClient.prototype.compileWorkbenchVfsPlugin = async function (projectId, data) {
    return this.fetch(`/api/workbench/vfs/projects/${encodeURIComponent(projectId)}/compile-plugin`, {
        method: "POST",
        body: JSON.stringify(data),
    });
};
ElizaClient.prototype.loadWorkbenchVfsPlugin = async function (projectId, data) {
    return this.fetch(`/api/workbench/vfs/projects/${encodeURIComponent(projectId)}/load-plugin`, {
        method: "POST",
        body: JSON.stringify(data),
    });
};
ElizaClient.prototype.listWorkbenchVfsPlugins = async function () {
    return this.fetch("/api/workbench/vfs/plugins");
};
ElizaClient.prototype.unloadWorkbenchVfsPlugin = async function (projectId, pluginName) {
    return this.fetch(`/api/workbench/vfs/projects/${encodeURIComponent(projectId)}/plugins/${encodeURIComponent(pluginName)}`, { method: "DELETE" });
};
ElizaClient.prototype.promoteWorkbenchVfsToCloud = async function (projectId, data = {}) {
    return this.fetch(`/api/workbench/vfs/projects/${encodeURIComponent(projectId)}/promote-to-cloud`, {
        method: "POST",
        body: JSON.stringify(data),
    });
};
ElizaClient.prototype.promoteVfsToCloudContainer = async function (data) {
    return this.fetch("/api/cloud/coding-containers/promotions", {
        method: "POST",
        body: JSON.stringify(data),
    });
};
ElizaClient.prototype.requestCloudCodingContainer = async function (data) {
    return this.fetch("/api/cloud/coding-containers", {
        method: "POST",
        body: JSON.stringify(data),
    });
};
ElizaClient.prototype.syncCloudCodingContainerChanges = async function (containerId, data) {
    return this.fetch(`/api/cloud/coding-containers/${encodeURIComponent(containerId)}/sync`, {
        method: "POST",
        body: JSON.stringify(data),
    });
};
ElizaClient.prototype.refreshRegistry = async function () {
    await this.fetch("/api/apps/refresh", { method: "POST" });
};
ElizaClient.prototype.getTrajectories = async function (options) {
    const params = buildTrajectoryParams(options);
    const query = params.toString();
    return this.fetch(`/api/trajectories${query ? `?${query}` : ""}`);
};
ElizaClient.prototype.getTrajectoryDetail = async function (trajectoryId) {
    return this.fetch(`/api/trajectories/${encodeURIComponent(trajectoryId)}`);
};
ElizaClient.prototype.getTrajectoryStats = async function () {
    return this.fetch("/api/trajectories/stats");
};
ElizaClient.prototype.getTrajectoryConfig = async function () {
    return this.fetch("/api/trajectories/config");
};
ElizaClient.prototype.updateTrajectoryConfig = async function (config) {
    return this.fetch("/api/trajectories/config", {
        method: "PUT",
        body: JSON.stringify(config),
    });
};
ElizaClient.prototype.exportTrajectories = async function (options) {
    const res = await this.rawRequest("/api/trajectories/export", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(options),
    });
    return res.blob();
};
ElizaClient.prototype.deleteTrajectories = async function (trajectoryIds) {
    return this.fetch("/api/trajectories", {
        method: "DELETE",
        body: JSON.stringify({ trajectoryIds }),
    });
};
ElizaClient.prototype.clearAllTrajectories = async function () {
    return this.fetch("/api/trajectories", {
        method: "DELETE",
        body: JSON.stringify({ clearAll: true }),
    });
};
ElizaClient.prototype.getDatabaseStatus = async function () {
    return this.fetch("/api/database/status");
};
ElizaClient.prototype.getDatabaseConfig = async function () {
    return this.fetch("/api/database/config");
};
ElizaClient.prototype.saveDatabaseConfig = async function (config) {
    return this.fetch("/api/database/config", {
        method: "PUT",
        body: JSON.stringify(config),
    });
};
ElizaClient.prototype.testDatabaseConnection = async function (creds) {
    return this.fetch("/api/database/test", {
        method: "POST",
        body: JSON.stringify(creds),
    });
};
ElizaClient.prototype.getDatabaseTables = async function () {
    return this.fetch("/api/database/tables");
};
ElizaClient.prototype.getDatabaseRows = async function (table, opts) {
    const params = new URLSearchParams();
    if (opts?.offset != null)
        params.set("offset", String(opts.offset));
    if (opts?.limit != null)
        params.set("limit", String(opts.limit));
    if (opts?.sort)
        params.set("sort", opts.sort);
    if (opts?.order)
        params.set("order", opts.order);
    if (opts?.search)
        params.set("search", opts.search);
    const qs = params.toString();
    return this.fetch(`/api/database/tables/${encodeURIComponent(table)}/rows${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.insertDatabaseRow = async function (table, data) {
    return this.fetch(`/api/database/tables/${encodeURIComponent(table)}/rows`, {
        method: "POST",
        body: JSON.stringify({ data }),
    });
};
ElizaClient.prototype.updateDatabaseRow = async function (table, where, data) {
    return this.fetch(`/api/database/tables/${encodeURIComponent(table)}/rows`, {
        method: "PUT",
        body: JSON.stringify({ where, data }),
    });
};
ElizaClient.prototype.deleteDatabaseRow = async function (table, where) {
    return this.fetch(`/api/database/tables/${encodeURIComponent(table)}/rows`, {
        method: "DELETE",
        body: JSON.stringify({ where }),
    });
};
ElizaClient.prototype.executeDatabaseQuery = async function (sql, readOnly = true) {
    return this.fetch("/api/database/query", {
        method: "POST",
        body: JSON.stringify({ sql, readOnly }),
    });
};
