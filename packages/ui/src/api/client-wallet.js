/**
 * Wallet domain methods — wallet addresses/balances, BSC trading, steward,
 * trading profile, registry (ERC-8004), drop/mint, whitelist, twitter verify.
 */
import { ElizaClient } from "./client-base";
// ---------------------------------------------------------------------------
// Prototype augmentation
// ---------------------------------------------------------------------------
ElizaClient.prototype.getWalletAddresses = async function () {
    return this.fetch("/api/wallet/addresses");
};
ElizaClient.prototype.getWalletBalances = async function () {
    return this.fetch("/api/wallet/balances");
};
ElizaClient.prototype.getWalletNfts = async function () {
    return this.fetch("/api/wallet/nfts");
};
ElizaClient.prototype.getWalletConfig = async function () {
    return this.fetch("/api/wallet/config");
};
ElizaClient.prototype.updateWalletConfig = async function (config) {
    return this.fetch("/api/wallet/config", {
        method: "PUT",
        body: JSON.stringify(config),
    });
};
ElizaClient.prototype.refreshCloudWallets = async function () {
    return this.fetch("/api/wallet/refresh-cloud", {
        method: "POST",
    });
};
ElizaClient.prototype.setWalletPrimary = async function (params) {
    return this.fetch("/api/wallet/primary", {
        method: "POST",
        body: JSON.stringify(params),
    });
};
ElizaClient.prototype.generateWallet = async function (params = {}) {
    return this.fetch("/api/wallet/generate", {
        method: "POST",
        body: JSON.stringify(params),
    });
};
ElizaClient.prototype.exportWalletKeys = async function (exportToken) {
    return this.fetch("/api/wallet/export", {
        method: "POST",
        body: JSON.stringify({ confirm: true, exportToken }),
    });
};
ElizaClient.prototype.getBscTradePreflight = async function (tokenAddress) {
    return this.fetch("/api/wallet/trade/preflight", {
        method: "POST",
        body: JSON.stringify(tokenAddress?.trim() ? { tokenAddress: tokenAddress.trim() } : {}),
    });
};
ElizaClient.prototype.getBscTradeQuote = async function (request) {
    return this.fetch("/api/wallet/trade/quote", {
        method: "POST",
        body: JSON.stringify(request),
    });
};
ElizaClient.prototype.executeBscTrade = async function (request) {
    return this.fetch("/api/wallet/trade/execute", {
        method: "POST",
        body: JSON.stringify(request),
    });
};
ElizaClient.prototype.executeBscTransfer = async function (request) {
    return this.fetch("/api/wallet/transfer/execute", {
        method: "POST",
        body: JSON.stringify(request),
    });
};
ElizaClient.prototype.getBscTradeTxStatus = async function (hash) {
    return this.fetch(`/api/wallet/trade/tx-status?hash=${encodeURIComponent(hash)}`);
};
ElizaClient.prototype.getStewardStatus = async function () {
    return this.fetch("/api/wallet/steward-status");
};
ElizaClient.prototype.getStewardAddresses = async function () {
    return this.fetch("/api/wallet/steward-addresses");
};
ElizaClient.prototype.getStewardBalance = async function (chainId) {
    const qs = chainId == null ? "" : `?chainId=${encodeURIComponent(String(chainId))}`;
    return this.fetch(`/api/wallet/steward-balances${qs}`);
};
ElizaClient.prototype.getStewardTokens = async function (chainId) {
    const qs = chainId == null ? "" : `?chainId=${encodeURIComponent(String(chainId))}`;
    return this.fetch(`/api/wallet/steward-tokens${qs}`);
};
ElizaClient.prototype.getStewardWebhookEvents = async function (opts) {
    const params = new URLSearchParams();
    if (opts?.event)
        params.set("event", opts.event);
    if (opts?.since != null)
        params.set("since", String(opts.since));
    const qs = params.toString();
    return this.fetch(`/api/wallet/steward-webhook-events${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.getStewardPolicies = async function () {
    return this.fetch("/api/wallet/steward-policies");
};
ElizaClient.prototype.setStewardPolicies = async function (policies) {
    await this.fetch("/api/wallet/steward-policies", {
        method: "PUT",
        body: JSON.stringify({ policies }),
    });
};
ElizaClient.prototype.getStewardHistory = async function (opts) {
    const params = new URLSearchParams();
    if (opts?.status)
        params.set("status", opts.status);
    if (opts?.limit != null)
        params.set("limit", String(opts.limit));
    if (opts?.offset != null)
        params.set("offset", String(opts.offset));
    const qs = params.toString();
    return this.fetch(`/api/wallet/steward-tx-records${qs ? `?${qs}` : ""}`);
};
ElizaClient.prototype.getStewardPending = async function () {
    return this.fetch("/api/wallet/steward-pending-approvals");
};
ElizaClient.prototype.approveStewardTx = async function (txId) {
    return this.fetch("/api/wallet/steward-approve-tx", {
        method: "POST",
        body: JSON.stringify({ txId }),
    });
};
ElizaClient.prototype.rejectStewardTx = async function (txId, reason) {
    return this.fetch("/api/wallet/steward-deny-tx", {
        method: "POST",
        body: JSON.stringify({ txId, reason }),
    });
};
ElizaClient.prototype.signViaSteward = async function (request) {
    return this.fetch("/api/wallet/steward-sign", {
        method: "POST",
        body: JSON.stringify(request),
    });
};
ElizaClient.prototype.sendBrowserWalletTransaction = async function (request) {
    return this.fetch("/api/wallet/browser-transaction", {
        method: "POST",
        body: JSON.stringify(request),
    });
};
ElizaClient.prototype.signBrowserWalletMessage = async function (message) {
    return this.fetch("/api/wallet/browser-sign-message", {
        method: "POST",
        body: JSON.stringify({ message }),
    });
};
ElizaClient.prototype.signBrowserSolanaMessage = async function (request) {
    return this.fetch("/api/wallet/browser-solana-sign-message", {
        method: "POST",
        body: JSON.stringify(request),
    });
};
ElizaClient.prototype.sendBrowserSolanaTransaction = async function (request) {
    return this.fetch("/api/wallet/browser-solana-transaction", {
        method: "POST",
        body: JSON.stringify(request),
    });
};
ElizaClient.prototype.getWalletMarketOverview = async function () {
    return this.fetch("/api/wallet/market-overview");
};
ElizaClient.prototype.getWalletTradingProfile = async function (window = "30d", source = "all") {
    const params = new URLSearchParams({ window, source });
    return this.fetch(`/api/wallet/trading/profile?${params.toString()}`);
};
ElizaClient.prototype.applyProductionWalletDefaults = async function () {
    return this.fetch("/api/wallet/production-defaults", {
        method: "POST",
        body: JSON.stringify({ confirm: true }),
    });
};
ElizaClient.prototype.getRegistryStatus = async function () {
    return this.fetch("/api/registry/status");
};
ElizaClient.prototype.registerAgent = async function (params) {
    return this.fetch("/api/registry/register", {
        method: "POST",
        body: JSON.stringify(params ?? {}),
    });
};
ElizaClient.prototype.updateRegistryTokenURI = async function (tokenURI) {
    return this.fetch("/api/registry/update-uri", {
        method: "POST",
        body: JSON.stringify({ tokenURI }),
    });
};
ElizaClient.prototype.syncRegistryProfile = async function (params) {
    return this.fetch("/api/registry/sync", {
        method: "POST",
        body: JSON.stringify(params ?? {}),
    });
};
ElizaClient.prototype.getRegistryConfig = async function () {
    return this.fetch("/api/registry/config");
};
ElizaClient.prototype.getDropStatus = async function () {
    return this.fetch("/api/drop/status");
};
ElizaClient.prototype.mintAgent = async function (params) {
    return this.fetch("/api/drop/mint", {
        method: "POST",
        body: JSON.stringify(params ?? {}),
    });
};
ElizaClient.prototype.mintAgentWhitelist = async function (params) {
    return this.fetch("/api/drop/mint-whitelist", {
        method: "POST",
        body: JSON.stringify(params),
    });
};
ElizaClient.prototype.getWhitelistStatus = async function () {
    return this.fetch("/api/whitelist/status");
};
ElizaClient.prototype.generateTwitterVerificationMessage = async function () {
    return this.fetch("/api/whitelist/twitter/message", { method: "POST" });
};
ElizaClient.prototype.verifyTwitter = async function (tweetUrl) {
    return this.fetch("/api/whitelist/twitter/verify", {
        method: "POST",
        body: JSON.stringify({ tweetUrl }),
    });
};
