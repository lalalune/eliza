/**
 * Skills domain methods — skills, catalog, marketplace, apps, Feed,
 * custom actions, WhatsApp, agent events.
 */
import { packageNameToAppRouteSlug } from "@elizaos/shared";
import { ElizaClient } from "./client-base";
// ---------------------------------------------------------------------------
// Prototype augmentation
// ---------------------------------------------------------------------------
ElizaClient.prototype.getSkills = async function () {
    return this.fetch("/api/skills");
};
ElizaClient.prototype.refreshSkills = async function () {
    return this.fetch("/api/skills/refresh", { method: "POST" });
};
ElizaClient.prototype.getSkillCatalog = async function (opts) {
    const params = new URLSearchParams();
    if (opts?.page)
        params.set("page", String(opts.page));
    if (opts?.perPage)
        params.set("perPage", String(opts.perPage));
    if (opts?.sort)
        params.set("sort", opts.sort);
    const qs = params.toString();
    return this.fetch(`/api/skills/catalog${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.searchSkillCatalog = async function (query, limit = 30) {
    return this.fetch(`/api/skills/catalog/search?q=${encodeURIComponent(query)}&limit=${limit}`);
};
ElizaClient.prototype.getSkillCatalogDetail = async function (slug) {
    return this.fetch(`/api/skills/catalog/${encodeURIComponent(slug)}`);
};
ElizaClient.prototype.refreshSkillCatalog = async function () {
    return this.fetch("/api/skills/catalog/refresh", { method: "POST" });
};
ElizaClient.prototype.installCatalogSkill = async function (slug, version) {
    return this.fetch("/api/skills/catalog/install", {
        method: "POST",
        body: JSON.stringify({ slug, version }),
    });
};
ElizaClient.prototype.uninstallCatalogSkill = async function (slug) {
    return this.fetch("/api/skills/catalog/uninstall", {
        method: "POST",
        body: JSON.stringify({ slug }),
    });
};
ElizaClient.prototype.getRegistryPlugins = async function () {
    return this.fetch("/api/registry/plugins");
};
ElizaClient.prototype.getRegistryPluginInfo = async function (name) {
    return this.fetch(`/api/registry/plugins/${encodeURIComponent(name)}`);
};
ElizaClient.prototype.getInstalledPlugins = async function () {
    return this.fetch("/api/plugins/installed");
};
ElizaClient.prototype.installRegistryPlugin = async function (name, autoRestart = true, options = {}) {
    return this.fetch("/api/plugins/install", {
        method: "POST",
        body: JSON.stringify({ name, autoRestart, ...options }),
    }, { timeoutMs: 120_000 });
};
ElizaClient.prototype.updateRegistryPlugin = async function (name, autoRestart = true, options = {}) {
    return this.fetch("/api/plugins/update", {
        method: "POST",
        body: JSON.stringify({ name, autoRestart, ...options }),
    }, { timeoutMs: 120_000 });
};
ElizaClient.prototype.uninstallRegistryPlugin = async function (name, autoRestart = true) {
    return this.fetch("/api/plugins/uninstall", {
        method: "POST",
        body: JSON.stringify({ name, autoRestart }),
    });
};
ElizaClient.prototype.searchSkillsMarketplace = async function (query, installed, limit) {
    const params = new URLSearchParams({
        q: query,
        installed: String(installed),
        limit: String(limit),
    });
    return this.fetch(`/api/skills/marketplace/search?${params}`);
};
ElizaClient.prototype.getSkillsMarketplaceConfig = async function () {
    return this.fetch("/api/skills/marketplace/config");
};
ElizaClient.prototype.updateSkillsMarketplaceConfig = async function (apiKey) {
    return this.fetch("/api/skills/marketplace/config", {
        method: "PUT",
        body: JSON.stringify({ apiKey }),
    });
};
ElizaClient.prototype.installMarketplaceSkill = async function (data) {
    await this.fetch("/api/skills/marketplace/install", {
        method: "POST",
        body: JSON.stringify(data),
    });
};
ElizaClient.prototype.uninstallMarketplaceSkill = async function (skillId, autoRefresh) {
    await this.fetch("/api/skills/marketplace/uninstall", {
        method: "POST",
        body: JSON.stringify({ id: skillId, autoRefresh }),
    });
};
ElizaClient.prototype.enableSkill = async function (skillId) {
    return this.fetch(`/api/skills/${encodeURIComponent(skillId)}/enable`, {
        method: "POST",
    });
};
ElizaClient.prototype.disableSkill = async function (skillId) {
    return this.fetch(`/api/skills/${encodeURIComponent(skillId)}/disable`, {
        method: "POST",
    });
};
ElizaClient.prototype.createSkill = async function (name, description) {
    return this.fetch("/api/skills/create", {
        method: "POST",
        body: JSON.stringify({ name, description }),
    });
};
ElizaClient.prototype.openSkill = async function (id) {
    return this.fetch(`/api/skills/${encodeURIComponent(id)}/open`, {
        method: "POST",
    });
};
ElizaClient.prototype.getSkillSource = async function (id) {
    return this.fetch(`/api/skills/${encodeURIComponent(id)}/source`);
};
ElizaClient.prototype.saveSkillSource = async function (id, content) {
    return this.fetch(`/api/skills/${encodeURIComponent(id)}/source`, {
        method: "PUT",
        body: JSON.stringify({ content }),
    });
};
ElizaClient.prototype.deleteSkill = async function (id) {
    return this.fetch(`/api/skills/${encodeURIComponent(id)}`, {
        method: "DELETE",
    });
};
ElizaClient.prototype.getSkillScanReport = async function (id) {
    return this.fetch(`/api/skills/${encodeURIComponent(id)}/scan`);
};
ElizaClient.prototype.acknowledgeSkill = async function (id, enable) {
    return this.fetch(`/api/skills/${encodeURIComponent(id)}/acknowledge`, {
        method: "POST",
        body: JSON.stringify({ enable }),
    });
};
ElizaClient.prototype.listApps = async function () {
    return this.fetch("/api/apps");
};
ElizaClient.prototype.listCatalogApps = async function () {
    return this.fetch("/api/catalog/apps");
};
ElizaClient.prototype.searchApps = async function (query) {
    return this.fetch(`/api/apps/search?q=${encodeURIComponent(query)}`);
};
ElizaClient.prototype.listInstalledApps = async function () {
    return this.fetch("/api/apps/installed");
};
ElizaClient.prototype.listAppRuns = async function () {
    return this.fetch("/api/apps/runs");
};
ElizaClient.prototype.getAppRun = async function (runId) {
    return this.fetch(`/api/apps/runs/${encodeURIComponent(runId)}`);
};
ElizaClient.prototype.attachAppRun = async function (runId) {
    return this.fetch(`/api/apps/runs/${encodeURIComponent(runId)}/attach`, {
        method: "POST",
    });
};
ElizaClient.prototype.detachAppRun = async function (runId) {
    return this.fetch(`/api/apps/runs/${encodeURIComponent(runId)}/detach`, {
        method: "POST",
    });
};
ElizaClient.prototype.stopApp = async function (name) {
    return this.fetch("/api/apps/stop", {
        method: "POST",
        body: JSON.stringify({ name }),
    });
};
ElizaClient.prototype.stopAppRun = async function (runId) {
    return this.fetch(`/api/apps/runs/${encodeURIComponent(runId)}/stop`, {
        method: "POST",
    });
};
ElizaClient.prototype.heartbeatAppRun = async function (runId) {
    return this.fetch(`/api/apps/runs/${encodeURIComponent(runId)}/heartbeat`, {
        method: "POST",
    });
};
ElizaClient.prototype.getAppInfo = async function (name) {
    return this.fetch(`/api/apps/info/${encodeURIComponent(name)}`);
};
ElizaClient.prototype.launchApp = async function (name) {
    return this.fetch("/api/apps/launch", {
        method: "POST",
        body: JSON.stringify({ name }),
    });
};
ElizaClient.prototype.listAppPermissions = async function () {
    return this.fetch("/api/apps/permissions");
};
ElizaClient.prototype.getAppPermissions = async function (slug) {
    return this.fetch(`/api/apps/permissions/${encodeURIComponent(slug)}`);
};
ElizaClient.prototype.setAppPermissions = async function (slug, namespaces) {
    // Body shape derived from the zod schema so a server-side rename
    // surfaces as a TS error here at compile time. See
    // packages/shared/src/contracts/app-permissions-routes.ts for the
    // schema this type comes from.
    const body = {
        namespaces: Array.from(namespaces),
    };
    return this.fetch(`/api/apps/permissions/${encodeURIComponent(slug)}`, {
        method: "PUT",
        body: JSON.stringify(body),
    });
};
ElizaClient.prototype.sendAppRunMessage = async function (runId, content) {
    const response = await this.rawRequest(`/api/apps/runs/${encodeURIComponent(runId)}/message`, {
        method: "POST",
        body: JSON.stringify({ content }),
    }, { allowNonOk: true });
    const data = (await response.json().catch(() => ({})));
    return {
        success: Boolean(data.success),
        message: typeof data.message === "string" && data.message.trim().length > 0
            ? data.message.trim()
            : response.status === 202
                ? "Command queued."
                : response.status >= 500
                    ? "Command unavailable."
                    : "Command rejected.",
        disposition: data.disposition === "accepted" ||
            data.disposition === "queued" ||
            data.disposition === "rejected" ||
            data.disposition === "unsupported"
            ? data.disposition
            : response.status === 202
                ? "queued"
                : response.status >= 500
                    ? "unsupported"
                    : response.status >= 400
                        ? "rejected"
                        : "accepted",
        status: response.status,
        run: data.run && typeof data.run === "object"
            ? data.run
            : null,
        session: data.session && typeof data.session === "object"
            ? data.session
            : null,
    };
};
ElizaClient.prototype.controlAppRun = async function (runId, action) {
    const response = await this.rawRequest(`/api/apps/runs/${encodeURIComponent(runId)}/control`, {
        method: "POST",
        body: JSON.stringify({ action }),
    }, { allowNonOk: true });
    const data = (await response.json().catch(() => ({})));
    return {
        success: Boolean(data.success),
        message: typeof data.message === "string" && data.message.trim().length > 0
            ? data.message.trim()
            : response.status === 202
                ? "Command queued."
                : response.status >= 500
                    ? "Command unavailable."
                    : "Command rejected.",
        disposition: data.disposition === "accepted" ||
            data.disposition === "queued" ||
            data.disposition === "rejected" ||
            data.disposition === "unsupported"
            ? data.disposition
            : response.status === 202
                ? "queued"
                : response.status >= 500
                    ? "unsupported"
                    : response.status >= 400
                        ? "rejected"
                        : "accepted",
        status: response.status,
        run: data.run && typeof data.run === "object"
            ? data.run
            : null,
        session: data.session && typeof data.session === "object"
            ? data.session
            : null,
    };
};
ElizaClient.prototype.getAppSessionState = async function (appName, sessionId) {
    const routeSlug = packageNameToAppRouteSlug(appName) ?? appName;
    return this.fetch(`/api/apps/${encodeURIComponent(routeSlug)}/session/${encodeURIComponent(sessionId)}`);
};
ElizaClient.prototype.sendAppSessionMessage = async function (appName, sessionId, content) {
    const routeSlug = packageNameToAppRouteSlug(appName) ?? appName;
    return this.fetch(`/api/apps/${encodeURIComponent(routeSlug)}/session/${encodeURIComponent(sessionId)}/message`, {
        method: "POST",
        body: JSON.stringify({ content }),
    });
};
ElizaClient.prototype.controlAppSession = async function (appName, sessionId, action) {
    const routeSlug = packageNameToAppRouteSlug(appName) ?? appName;
    return this.fetch(`/api/apps/${encodeURIComponent(routeSlug)}/session/${encodeURIComponent(sessionId)}/control`, {
        method: "POST",
        body: JSON.stringify({ action }),
    });
};
ElizaClient.prototype.listRegistryPlugins = async function () {
    return this.fetch("/api/apps/plugins");
};
ElizaClient.prototype.searchRegistryPlugins = async function (query) {
    return this.fetch(`/api/apps/plugins/search?q=${encodeURIComponent(query)}`);
};
ElizaClient.prototype.listCommands = async function (surface) {
    const query = surface ? `?surface=${encodeURIComponent(surface)}` : "";
    const data = await this.fetch(`/api/commands${query}`);
    return data.commands;
};
ElizaClient.prototype.listCustomActions = async function () {
    const data = await this.fetch("/api/custom-actions");
    return data.actions;
};
ElizaClient.prototype.createCustomAction = async function (action) {
    const data = await this.fetch("/api/custom-actions", { method: "POST", body: JSON.stringify(action) });
    return data.action;
};
ElizaClient.prototype.updateCustomAction = async function (id, action) {
    const data = await this.fetch(`/api/custom-actions/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(action) });
    return data.action;
};
ElizaClient.prototype.deleteCustomAction = async function (id) {
    await this.fetch(`/api/custom-actions/${encodeURIComponent(id)}`, {
        method: "DELETE",
    });
};
ElizaClient.prototype.testCustomAction = async function (id, params) {
    return this.fetch(`/api/custom-actions/${encodeURIComponent(id)}/test`, {
        method: "POST",
        body: JSON.stringify({ params }),
    });
};
ElizaClient.prototype.generateCustomAction = async function (prompt) {
    return this.fetch("/api/custom-actions/generate", {
        method: "POST",
        body: JSON.stringify({ prompt }),
    });
};
ElizaClient.prototype.getWhatsAppStatus = async function (accountId = "default", options = {}) {
    const params = new URLSearchParams({ accountId });
    if (options.authScope) {
        params.set("authScope", options.authScope);
    }
    return this.fetch(`/api/whatsapp/status?${params.toString()}`);
};
ElizaClient.prototype.startWhatsAppPairing = async function (accountId = "default", options = {}) {
    return this.fetch("/api/whatsapp/pair", {
        method: "POST",
        body: JSON.stringify({ ...options, accountId }),
    });
};
ElizaClient.prototype.stopWhatsAppPairing = async function (accountId = "default", options = {}) {
    return this.fetch("/api/whatsapp/pair/stop", {
        method: "POST",
        body: JSON.stringify({ ...options, accountId }),
    });
};
ElizaClient.prototype.disconnectWhatsApp = async function (accountId = "default", options = {}) {
    return this.fetch("/api/whatsapp/disconnect", {
        method: "POST",
        body: JSON.stringify({ ...options, accountId }),
    });
};
ElizaClient.prototype.getSignalStatus = async function (accountId = "default") {
    return this.fetch(`/api/signal/status?accountId=${encodeURIComponent(accountId)}`);
};
ElizaClient.prototype.startSignalPairing = async function (accountId = "default") {
    return this.fetch("/api/signal/pair", {
        method: "POST",
        body: JSON.stringify({ accountId }),
    });
};
ElizaClient.prototype.stopSignalPairing = async function (accountId = "default") {
    return this.fetch("/api/signal/pair/stop", {
        method: "POST",
        body: JSON.stringify({ accountId }),
    });
};
ElizaClient.prototype.disconnectSignal = async function (accountId = "default") {
    return this.fetch("/api/signal/disconnect", {
        method: "POST",
        body: JSON.stringify({ accountId }),
    });
};
ElizaClient.prototype.getTelegramAccountStatus = async function () {
    return this.fetch("/api/setup/telegram-account/status");
};
ElizaClient.prototype.startTelegramAccountAuth = async function (phone) {
    return this.fetch("/api/setup/telegram-account/start", {
        method: "POST",
        body: JSON.stringify(typeof phone === "string" && phone.trim().length > 0
            ? { phone: phone.trim() }
            : {}),
    });
};
ElizaClient.prototype.submitTelegramAccountAuth = async function (input) {
    return this.fetch("/api/setup/telegram-account/submit-code", {
        method: "POST",
        body: JSON.stringify(input),
    });
};
ElizaClient.prototype.disconnectTelegramAccount = async function () {
    return this.fetch("/api/setup/telegram-account/cancel", {
        method: "POST",
    });
};
ElizaClient.prototype.getDiscordLocalStatus = async function () {
    return this.fetch("/api/discord-local/status");
};
ElizaClient.prototype.authorizeDiscordLocal = async function () {
    return this.fetch("/api/discord-local/authorize", {
        method: "POST",
    });
};
ElizaClient.prototype.disconnectDiscordLocal = async function () {
    return this.fetch("/api/discord-local/disconnect", {
        method: "POST",
    });
};
ElizaClient.prototype.listDiscordLocalGuilds = async function () {
    return this.fetch("/api/discord-local/guilds");
};
ElizaClient.prototype.listDiscordLocalChannels = async function (guildId) {
    return this.fetch(`/api/discord-local/channels?guildId=${encodeURIComponent(guildId)}`);
};
ElizaClient.prototype.saveDiscordLocalSubscriptions = async function (channelIds) {
    return this.fetch("/api/discord-local/subscriptions", {
        method: "POST",
        body: JSON.stringify({ channelIds }),
    });
};
ElizaClient.prototype.getBlueBubblesStatus = async function () {
    return this.fetch("/api/bluebubbles/status");
};
// ---------------------------------------------------------------------------
// Feed terminal methods
// ---------------------------------------------------------------------------
ElizaClient.prototype.getFeedAgentStatus = async function () {
    return this.fetch("/api/apps/feed/agent/status");
};
ElizaClient.prototype.getFeedAgentActivity = async function (opts) {
    const params = new URLSearchParams();
    if (opts?.limit)
        params.set("limit", String(opts.limit));
    if (opts?.type)
        params.set("type", opts.type);
    const qs = params.toString();
    return this.fetch(`/api/apps/feed/agent/activity${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.getFeedAgentLogs = async function (opts) {
    const params = new URLSearchParams();
    if (opts?.type)
        params.set("type", opts.type);
    if (opts?.level)
        params.set("level", opts.level);
    const qs = params.toString();
    return this.fetch(`/api/apps/feed/agent/logs${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.getFeedAgentWallet = async function () {
    return this.fetch("/api/apps/feed/agent/wallet");
};
ElizaClient.prototype.getFeedTeam = async function () {
    return this.fetch("/api/apps/feed/team");
};
ElizaClient.prototype.getFeedTeamChat = async function () {
    return this.fetch("/api/apps/feed/team/info");
};
ElizaClient.prototype.sendFeedTeamChat = async function (content, mentions) {
    return this.fetch("/api/apps/feed/team/chat", {
        method: "POST",
        body: JSON.stringify({ content, mentions }),
    });
};
ElizaClient.prototype.toggleFeedAgent = async function (action) {
    return this.fetch("/api/apps/feed/agent/toggle", {
        method: "POST",
        body: JSON.stringify({ action }),
    });
};
ElizaClient.prototype.toggleFeedAgentAutonomy = async function (opts) {
    return this.fetch("/api/apps/feed", {
        method: "POST",
        body: JSON.stringify(opts),
    });
};
// ---------------------------------------------------------------------------
// Feed markets
// ---------------------------------------------------------------------------
ElizaClient.prototype.getFeedPredictionMarkets = async function (opts) {
    const params = new URLSearchParams();
    if (opts?.page)
        params.set("page", String(opts.page));
    if (opts?.pageSize)
        params.set("pageSize", String(opts.pageSize));
    if (opts?.status)
        params.set("status", opts.status);
    if (opts?.category)
        params.set("category", opts.category);
    const qs = params.toString();
    return this.fetch(`/api/apps/feed/markets/predictions${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.getFeedPredictionMarket = async function (marketId) {
    return this.fetch(`/api/apps/feed/markets/predictions/${encodeURIComponent(marketId)}`);
};
ElizaClient.prototype.buyFeedPredictionShares = async function (marketId, side, amount) {
    return this.fetch(`/api/apps/feed/markets/predictions/${encodeURIComponent(marketId)}/buy`, { method: "POST", body: JSON.stringify({ side, amount }) });
};
ElizaClient.prototype.sellFeedPredictionShares = async function (marketId, side, amount) {
    return this.fetch(`/api/apps/feed/markets/predictions/${encodeURIComponent(marketId)}/sell`, { method: "POST", body: JSON.stringify({ side, amount }) });
};
ElizaClient.prototype.getFeedPerpMarkets = async function () {
    return this.fetch("/api/apps/feed/markets/perps");
};
ElizaClient.prototype.getFeedOpenPerpPositions = async function () {
    return this.fetch("/api/apps/feed/markets/perps/open");
};
ElizaClient.prototype.closeFeedPerpPosition = async function (positionId) {
    return this.fetch(`/api/apps/feed/markets/perps/position/${encodeURIComponent(positionId)}/close`, { method: "POST", body: JSON.stringify({}) });
};
// ---------------------------------------------------------------------------
// Feed social
// ---------------------------------------------------------------------------
ElizaClient.prototype.getFeedPosts = async function (opts) {
    const params = new URLSearchParams();
    if (opts?.page)
        params.set("page", String(opts.page));
    if (opts?.limit)
        params.set("limit", String(opts.limit));
    if (opts?.feed)
        params.set("feed", opts.feed);
    const qs = params.toString();
    return this.fetch(`/api/apps/feed/posts${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.createFeedPost = async function (content, marketId) {
    return this.fetch("/api/apps/feed/posts", {
        method: "POST",
        body: JSON.stringify({ content, marketId }),
    });
};
ElizaClient.prototype.commentOnFeedPost = async function (postId, content) {
    return this.fetch(`/api/apps/feed/posts/${encodeURIComponent(postId)}/comments`, { method: "POST", body: JSON.stringify({ content }) });
};
ElizaClient.prototype.likeFeedPost = async function (postId) {
    return this.fetch(`/api/apps/feed/posts/${encodeURIComponent(postId)}/like`, {
        method: "POST",
    });
};
// ---------------------------------------------------------------------------
// Feed messaging
// ---------------------------------------------------------------------------
ElizaClient.prototype.getFeedChats = async function () {
    return this.fetch("/api/apps/feed/chats");
};
ElizaClient.prototype.getFeedChatMessages = async function (chatId) {
    return this.fetch(`/api/apps/feed/chats/${encodeURIComponent(chatId)}/messages`);
};
ElizaClient.prototype.sendFeedChatMessage = async function (chatId, content) {
    return this.fetch(`/api/apps/feed/chats/${encodeURIComponent(chatId)}/message`, { method: "POST", body: JSON.stringify({ content }) });
};
ElizaClient.prototype.getFeedDM = async function (userId) {
    return this.fetch(`/api/apps/feed/chats/dm?userId=${encodeURIComponent(userId)}`);
};
// ---------------------------------------------------------------------------
// Feed agent management
// ---------------------------------------------------------------------------
ElizaClient.prototype.getFeedAgentGoals = async function () {
    return this.fetch("/api/apps/feed/agent/goals");
};
ElizaClient.prototype.getFeedAgentStats = async function () {
    return this.fetch("/api/apps/feed/agent/stats");
};
ElizaClient.prototype.getFeedAgentSummary = async function () {
    return this.fetch("/api/apps/feed/agent/summary");
};
ElizaClient.prototype.getFeedAgentRecentTrades = async function () {
    return this.fetch("/api/apps/feed/agent/recent-trades");
};
ElizaClient.prototype.getFeedAgentTradingBalance = async function () {
    return this.fetch("/api/apps/feed/agent/trading-balance");
};
ElizaClient.prototype.sendFeedAgentChat = async function (content) {
    return this.fetch("/api/apps/feed/agent/chat", {
        method: "POST",
        body: JSON.stringify({ content }),
    });
};
ElizaClient.prototype.getFeedAgentChat = async function () {
    return this.fetch("/api/apps/feed/agent/chat");
};
// ---------------------------------------------------------------------------
// Feed feed
// ---------------------------------------------------------------------------
ElizaClient.prototype.getFeedFeedForYou = async function () {
    return this.fetch("/api/apps/feed/feed/for-you");
};
ElizaClient.prototype.getFeedFeedHot = async function () {
    return this.fetch("/api/apps/feed/feed/hot");
};
ElizaClient.prototype.getFeedTrades = async function () {
    return this.fetch("/api/apps/feed/trades");
};
// ---------------------------------------------------------------------------
// Feed discover & team management
// ---------------------------------------------------------------------------
ElizaClient.prototype.discoverFeedAgents = async function () {
    return this.fetch("/api/apps/feed/agents/discover");
};
ElizaClient.prototype.getFeedTeamDashboard = async function () {
    return this.fetch("/api/apps/feed/team/dashboard");
};
ElizaClient.prototype.getFeedTeamConversations = async function () {
    return this.fetch("/api/apps/feed/team/conversations");
};
ElizaClient.prototype.pauseAllFeedAgents = async function () {
    return this.fetch("/api/apps/feed/admin/agents/pause-all", {
        method: "POST",
    });
};
ElizaClient.prototype.resumeAllFeedAgents = async function () {
    return this.fetch("/api/apps/feed/admin/agents/resume-all", {
        method: "POST",
    });
};
