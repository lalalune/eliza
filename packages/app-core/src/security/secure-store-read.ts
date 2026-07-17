/**
 * Translates platform secure-store read results for credential consumers.
 * Only a confirmed missing item is empty; denial, backend unavailability, and
 * operational failure remain typed failures so boot cannot look healthy while
 * credentials are inaccessible.
 */
import { ElizaError } from "@elizaos/core";

import type {
  SecureStoreGetResult,
  SecureStoreSecretKind,
} from "./platform-secure-store";

const FAILURE_CODES = {
  denied: "SECURE_STORE_READ_DENIED",
  unavailable: "SECURE_STORE_READ_UNAVAILABLE",
  error: "SECURE_STORE_READ_FAILED",
} as const;

export function secureStoreValueOrMissing(
  result: SecureStoreGetResult,
  options: { kind: SecureStoreSecretKind; operation: string },
): string | null {
  if (result.ok) return result.value;
  if (result.reason === "not_found") return null;
  throw new ElizaError("secure-store credential read failed", {
    code: FAILURE_CODES[result.reason],
    context: {
      kind: options.kind,
      operation: options.operation,
      reason: result.reason,
    },
    severity: "fatal",
  });
}
