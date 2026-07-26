/**
 * ElizaClient extension and status types for the iMessage connector (native /
 * imsg / bluebubbles bridges), including chat-db availability and send-only mode.
 */
import { ElizaClient } from "./client-base";
function buildQuery(params) {
    const query = params.toString();
    return query.length > 0 ? `?${query}` : "";
}
ElizaClient.prototype.getIMessageStatus = async function () {
    return this.fetch("/api/lifeops/connectors/imessage/status");
};
function normalizeLifeOpsMessage(message) {
    const attachmentPaths = message.attachments
        ?.map((attachment) => attachment.path)
        .filter((path) => typeof path === "string") ?? [];
    return {
        id: message.id,
        text: message.text,
        handle: message.isFromMe
            ? (message.toHandles[0] ?? "")
            : message.fromHandle,
        chatId: message.chatId ?? "",
        timestamp: Date.parse(message.sentAt) || 0,
        isFromMe: message.isFromMe,
        hasAttachments: attachmentPaths.length > 0,
        ...(attachmentPaths.length > 0 ? { attachmentPaths } : {}),
    };
}
function normalizeLifeOpsChat(chat) {
    return {
        chatId: chat.id,
        chatType: chat.participants.length > 1 ? "group" : "direct",
        displayName: chat.name,
        participants: chat.participants.map((handle) => ({
            handle,
            isPhoneNumber: /^\+?[0-9()\s.-]+$/.test(handle),
        })),
    };
}
ElizaClient.prototype.getIMessageMessages = async function (options = {}) {
    const params = new URLSearchParams();
    if (options.chatId?.trim()) {
        params.set("chatId", options.chatId.trim());
    }
    if (typeof options.limit === "number" && Number.isFinite(options.limit)) {
        params.set("limit", String(options.limit));
    }
    const result = await this.fetch(`/api/lifeops/connectors/imessage/messages${buildQuery(params)}`);
    return {
        messages: result.messages.map(normalizeLifeOpsMessage),
        count: result.count,
    };
};
ElizaClient.prototype.listIMessageChats = async function () {
    const result = await this.fetch("/api/lifeops/connectors/imessage/chats");
    return {
        chats: result.chats.map(normalizeLifeOpsChat),
        count: result.count,
    };
};
ElizaClient.prototype.sendIMessage = async function (request) {
    const attachmentPaths = request.attachmentPaths ??
        (request.mediaUrl ? [request.mediaUrl] : undefined);
    const body = {
        to: request.to,
        text: request.text,
        ...(attachmentPaths ? { attachmentPaths } : {}),
    };
    const result = await this.fetch("/api/lifeops/connectors/imessage/send", {
        method: "POST",
        body: JSON.stringify(body),
    });
    return {
        success: result.ok,
        messageId: result.messageId,
    };
};
