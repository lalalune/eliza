/**
 * ElizaClient extension and types for XR device pairing: connection records,
 * pair state, and the pairing-code handshake.
 */
import { ElizaClient } from "./client-base";
ElizaClient.prototype.getXRPairState = async function () {
    return this.fetch("/api/xr/pair");
};
