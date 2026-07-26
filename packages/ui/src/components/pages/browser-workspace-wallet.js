/**
 * Message protocol + wallet-state model shared by the browser-workspace host
 * and the wallet bridge hook. Defines the postMessage request/response/ready
 * message types, the supported EVM chain ids, and the
 * BrowserWorkspaceWalletState shape (EVM + Solana address/connected/signing
 * capability flags) that embedded iframes read to talk to the host wallet.
 */
export const BROWSER_WALLET_REQUEST_TYPE = "ELIZA_BROWSER_WALLET_REQUEST";
export const BROWSER_WALLET_RESPONSE_TYPE = "ELIZA_BROWSER_WALLET_RESPONSE";
export const BROWSER_WALLET_READY_TYPE = "ELIZA_BROWSER_WALLET_READY";
export const DEFAULT_BROWSER_WORKSPACE_EVM_CHAIN_ID = 1;
export const SUPPORTED_BROWSER_WORKSPACE_EVM_CHAIN_IDS = [
    1, 10, 56, 137, 8453, 42161,
];
const SUPPORTED_BROWSER_WORKSPACE_EVM_CHAIN_ID_SET = new Set(SUPPORTED_BROWSER_WORKSPACE_EVM_CHAIN_IDS);
export const EMPTY_BROWSER_WORKSPACE_WALLET_STATE = {
    address: null,
    connected: false,
    evmAddress: null,
    evmConnected: false,
    mode: "none",
    pendingApprovals: 0,
    reason: null,
    messageSigningAvailable: false,
    transactionSigningAvailable: false,
    chainSwitchingAvailable: false,
    signingAvailable: false,
    solanaAddress: null,
    solanaConnected: false,
    solanaMessageSigningAvailable: false,
    solanaTransactionSigningAvailable: false,
};
export function getBrowserWorkspaceWalletAddress(walletAddresses, walletConfig, stewardStatus) {
    return (stewardStatus?.walletAddresses?.evm ??
        stewardStatus?.evmAddress ??
        walletAddresses?.evmAddress ??
        walletConfig?.evmAddress ??
        null);
}
export function getBrowserWorkspaceSolanaAddress(walletAddresses, walletConfig, stewardStatus) {
    return (stewardStatus?.walletAddresses?.solana ??
        walletAddresses?.solanaAddress ??
        walletConfig?.solanaAddress ??
        null);
}
export function resolveBrowserWorkspaceWalletMode(stewardStatus, evmAddress, solanaAddress, walletConfig) {
    const evmMessageSigningAvailable = Boolean(evmAddress && walletConfig?.evmSigningCapability === "local");
    const evmTransactionSigningAvailable = Boolean(evmAddress && walletConfig?.executionReady);
    if (stewardStatus?.connected) {
        return "steward";
    }
    if (evmMessageSigningAvailable ||
        evmTransactionSigningAvailable ||
        (solanaAddress && walletConfig?.solanaSigningAvailable)) {
        return "local";
    }
    if (evmAddress || solanaAddress) {
        return "blocked";
    }
    return "none";
}
export function buildBrowserWorkspaceWalletState(params) {
    const { pendingApprovals, stewardStatus, walletAddresses, walletConfig } = params;
    const evmAddress = getBrowserWorkspaceWalletAddress(walletAddresses, walletConfig, stewardStatus);
    const solanaAddress = getBrowserWorkspaceSolanaAddress(walletAddresses, walletConfig, stewardStatus);
    const address = evmAddress ?? solanaAddress;
    const mode = resolveBrowserWorkspaceWalletMode(stewardStatus, evmAddress, solanaAddress, walletConfig);
    const evmConnected = Boolean(evmAddress);
    const solanaConnected = Boolean(solanaAddress);
    const evmMessageSigningAvailable = Boolean(evmAddress && walletConfig?.evmSigningCapability === "local");
    const evmTransactionSigningAvailable = Boolean(evmAddress && walletConfig?.executionReady);
    const solanaMessageSigningAvailable = Boolean(solanaAddress && walletConfig?.solanaSigningAvailable);
    if (mode === "steward") {
        return {
            address,
            connected: evmConnected || solanaConnected,
            evmAddress,
            evmConnected,
            mode,
            pendingApprovals,
            reason: null,
            messageSigningAvailable: false,
            transactionSigningAvailable: true,
            chainSwitchingAvailable: true,
            signingAvailable: true,
            solanaAddress,
            solanaConnected,
            solanaMessageSigningAvailable: false,
            solanaTransactionSigningAvailable: solanaConnected,
        };
    }
    if (mode === "local") {
        const solanaTransactionSigningAvailable = Boolean(solanaAddress && walletConfig?.solanaSigningAvailable);
        return {
            address,
            connected: evmConnected || solanaConnected,
            evmAddress,
            evmConnected,
            mode,
            pendingApprovals: 0,
            reason: null,
            messageSigningAvailable: evmMessageSigningAvailable,
            transactionSigningAvailable: evmTransactionSigningAvailable,
            chainSwitchingAvailable: evmTransactionSigningAvailable,
            signingAvailable: evmMessageSigningAvailable ||
                evmTransactionSigningAvailable ||
                solanaMessageSigningAvailable ||
                solanaTransactionSigningAvailable,
            solanaAddress,
            solanaConnected,
            solanaMessageSigningAvailable,
            solanaTransactionSigningAvailable,
        };
    }
    if (mode === "blocked") {
        return {
            address,
            connected: evmConnected || solanaConnected,
            evmAddress,
            evmConnected,
            mode,
            pendingApprovals: 0,
            reason: walletConfig?.executionBlockedReason?.trim() ||
                (solanaConnected && !solanaMessageSigningAvailable
                    ? "Local Solana signing is unavailable."
                    : "Local wallet execution is blocked."),
            messageSigningAvailable: false,
            transactionSigningAvailable: false,
            chainSwitchingAvailable: false,
            signingAvailable: false,
            solanaAddress,
            solanaConnected,
            solanaMessageSigningAvailable: false,
            solanaTransactionSigningAvailable: false,
        };
    }
    return {
        ...EMPTY_BROWSER_WORKSPACE_WALLET_STATE,
        mode,
        reason: stewardStatus?.configured && !stewardStatus.connected
            ? stewardStatus.error?.trim() || "Steward is unavailable."
            : "No wallet configured.",
    };
}
export function isBrowserWorkspaceWalletRequest(value) {
    if (!value || typeof value !== "object") {
        return false;
    }
    const entry = value;
    return (entry.type === BROWSER_WALLET_REQUEST_TYPE &&
        typeof entry.requestId === "string" &&
        typeof entry.method === "string");
}
export function parseBrowserWorkspaceEvmChainId(value) {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
        return value;
    }
    if (typeof value !== "string")
        return null;
    const trimmed = value.trim();
    if (!trimmed)
        return null;
    const parsed = trimmed.startsWith("0x")
        ? Number.parseInt(trimmed.slice(2), 16)
        : Number(trimmed);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
export function formatBrowserWorkspaceEvmChainId(chainId) {
    return `0x${chainId.toString(16)}`;
}
export function isBrowserWorkspaceEvmChainSupported(chainId) {
    return SUPPORTED_BROWSER_WORKSPACE_EVM_CHAIN_ID_SET.has(chainId);
}
export function getUnsupportedBrowserWorkspaceEvmChainError(chainId) {
    return `Unsupported EVM chain ${chainId}. Supported chain IDs: ${SUPPORTED_BROWSER_WORKSPACE_EVM_CHAIN_IDS.join(", ")}.`;
}
export function resolveBrowserWorkspaceSignMessage(params, address) {
    if (typeof params === "string")
        return params;
    if (!Array.isArray(params) || params.length === 0)
        return null;
    const [first, second] = params;
    if (typeof first === "string" && typeof second === "string" && address) {
        const normalizedAddress = address.toLowerCase();
        if (first.toLowerCase() === normalizedAddress)
            return second;
        if (second.toLowerCase() === normalizedAddress)
            return first;
    }
    return typeof first === "string" ? first : null;
}
