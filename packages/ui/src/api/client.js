/**
 * API client for the backend.
 *
 * Thin fetch wrapper + WebSocket for real-time chat/events.
 * Replaces the gateway WebSocket protocol entirely.
 *
 * The ElizaClient class is defined in client-base.ts and re-exported here.
 * Domain methods are defined via declaration merging + prototype augmentation
 * in the companion files: client-agent, client-chat, client-wallet,
 * client-cloud, client-skills, client-computeruse, client-imessage.
 */
import { DEFAULT_WALLET_RPC_SELECTIONS, normalizeWalletRpcProviderId, normalizeWalletRpcSelections, WALLET_RPC_PROVIDER_OPTIONS, } from "@elizaos/shared";
// Re-export the class from client-base (no circular dependency issues)
export { ElizaClient } from "./client-base";
export { parseMeetingStatusEvent, parseMeetingTranscriptEvent, } from "./client-meetings";
export * from "./client-types";
export { DEFAULT_WALLET_RPC_SELECTIONS, normalizeWalletRpcProviderId, normalizeWalletRpcSelections, WALLET_RPC_PROVIDER_OPTIONS, };
// ---------------------------------------------------------------------------
// Domain method augmentations (declaration merging + prototype assignment)
// These import ElizaClient from client-base directly, avoiding circular deps.
// ---------------------------------------------------------------------------
import "./client-agent";
import "./client-approvals";
import "./client-automations";
import "./client-background";
import "./client-browser-workspace";
import "./client-chat";
import "./client-cloud";
import "./client-computeruse";
import "./client-files";
import "./client-imessage";
import "./client-local-inference";
import "./client-meetings";
import "./client-notifications";
import "./client-scheduled-tasks";
import "./client-voice-models";
import "./client-workflow";
import "./client-skills";
import "./client-transcripts";
import "./client-vault";
import "./client-wallet";
import "./client-xr";
import { ElizaClient as _ElizaClient } from "./client-base";
// External plugins augment ElizaClient via `declare module "@elizaos/ui"`.
// Annotating with ElizaClient (which TypeScript normalizes to the canonical
// @elizaos/ui export) makes augmented methods visible to callers. The
// prototype has all methods at runtime via the augmenting side-effect imports.
export const client = new _ElizaClient();
