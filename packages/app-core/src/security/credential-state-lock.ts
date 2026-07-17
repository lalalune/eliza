/**
 * Coordinates credential persistence with destructive agent reset.
 *
 * Credential mutations run concurrently. Reset closes admission before
 * draining accepted mutations, which prevents boot hydration or credential
 * rotation from recreating a secret immediately after cleanup finishes.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { ElizaError } from "@elizaos/core";

let activeMutationCount = 0;
let resetTail: Promise<void> = Promise.resolve();
let pendingResetCount = 0;
const drainWaiters = new Set<() => void>();
interface CredentialStateContext {
  active: boolean;
  mode: "mutation" | "reset";
}
const credentialStateContext = new AsyncLocalStorage<CredentialStateContext>();
const MUTATION_CONTINUATION_HEADER = "x-eliza-credential-mutation-continuation";
const mutationContinuationToken = randomBytes(32).toString("base64url");

/** Header for a loopback request that is synchronously awaited by the lock owner. */
export function credentialMutationContinuationHeaders(): Record<
  string,
  string
> {
  if (!credentialStateContext.getStore()?.active) {
    throw new ElizaError(
      "credential continuation token requested outside an active transaction",
      {
        code: "CREDENTIAL_CONTINUATION_OUTSIDE_TRANSACTION",
        severity: "fatal",
      },
    );
  }
  return { [MUTATION_CONTINUATION_HEADER]: mutationContinuationToken };
}

/** Accepts only this process's high-entropy continuation token. */
export function isCredentialMutationContinuation(
  value: string | string[] | undefined,
): boolean {
  if (typeof value !== "string") return false;
  const supplied = Buffer.from(value);
  const expected = Buffer.from(mutationContinuationToken);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

async function acquireResetTurn(): Promise<() => void> {
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = resetTail;
  resetTail = previous.then(() => current);
  await previous;
  return release;
}

function waitForAcceptedMutations(): Promise<void> {
  if (activeMutationCount === 0) return Promise.resolve();
  return new Promise((resolve) => drainWaiters.add(resolve));
}

function finishMutation(): void {
  activeMutationCount -= 1;
  if (activeMutationCount !== 0) return;
  for (const resolve of drainWaiters) resolve();
  drainWaiters.clear();
}

function resetInProgressError(): ElizaError {
  return new ElizaError("credential mutation refused while reset is pending", {
    code: "CREDENTIAL_RESET_IN_PROGRESS",
    severity: "fatal",
  });
}

/** Admits one concurrent credential transaction unless reset has priority. */
export async function withCredentialStateMutation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  if (credentialStateContext.getStore()?.active) return operation();
  return withIndependentCredentialStateMutation(operation);
}

/**
 * Tracks work that outlives its parent request as a separate transaction.
 * Deferred boot uses this so reset still drains it after the HTTP response.
 */
export async function withIndependentCredentialStateMutation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  if (pendingResetCount > 0) throw resetInProgressError();
  // No await may occur between admission and accounting. Reset announces
  // itself synchronously, so it either sees this mutation or refuses it.
  activeMutationCount += 1;
  const context: CredentialStateContext = { active: true, mode: "mutation" };
  try {
    return await credentialStateContext.run(context, operation);
  } finally {
    context.active = false;
    finishMutation();
  }
}

/**
 * Drains earlier credential mutations, rejects later ones, and holds exclusive
 * ownership until every persistent and in-memory reset step has completed.
 */
export async function withCredentialStateReset<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const inherited = credentialStateContext.getStore();
  if (inherited?.active && inherited.mode === "mutation") {
    throw new ElizaError("credential reset cannot start inside a mutation", {
      code: "CREDENTIAL_RESET_NESTED_MUTATION",
      severity: "fatal",
    });
  }
  if (inherited?.active && inherited.mode === "reset") return operation();
  // Close admission before waiting for an earlier reset or active mutation.
  pendingResetCount += 1;
  const release = await acquireResetTurn();
  try {
    await waitForAcceptedMutations();
    const context: CredentialStateContext = { active: true, mode: "reset" };
    try {
      return await credentialStateContext.run(context, operation);
    } finally {
      context.active = false;
    }
  } finally {
    pendingResetCount -= 1;
    release();
  }
}
