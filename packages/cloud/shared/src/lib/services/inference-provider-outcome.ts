/**
 * Classifies provider failures only when their wire status proves the request
 * was rejected before inference. Ambiguous transport and server failures stay
 * conservative because absence of output is not evidence of zero provider cost.
 */

import { APICallError, RetryError } from "ai";

const KNOWN_UNACCEPTED_STATUSES = new Set([
  400, 401, 402, 403, 404, 405, 406, 409, 410, 413, 415, 422, 429,
]);

/** True only for an explicit provider response that rejects the request. */
export function isKnownUnacceptedProviderStatus(status: number): boolean {
  return KNOWN_UNACCEPTED_STATUSES.has(status);
}

/** True only for an explicit provider response that rejects the request. */
export function isKnownUnacceptedProviderError(error: unknown): boolean {
  const terminal = RetryError.isInstance(error) ? error.lastError : error;
  return (
    APICallError.isInstance(terminal) &&
    terminal.statusCode !== undefined &&
    isKnownUnacceptedProviderStatus(terminal.statusCode)
  );
}
