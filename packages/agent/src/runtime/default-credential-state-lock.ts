/**
 * Standalone-agent credential mutation barrier used when no embedding host
 * supplies its own coordinator. Reset closes admission synchronously, drains
 * accepted writers, then holds exclusive ownership through the full wipe.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { ElizaError } from "@elizaos/core";

interface LockContext {
  active: boolean;
  mode: "mutation" | "reset";
}

let activeMutations = 0;
let pendingResets = 0;
let resetTail: Promise<void> = Promise.resolve();
const drainWaiters = new Set<() => void>();
const lockContext = new AsyncLocalStorage<LockContext>();

function resetInProgressError(): ElizaError {
  return new ElizaError("credential mutation refused while reset is pending", {
    code: "CREDENTIAL_RESET_IN_PROGRESS",
    severity: "fatal",
  });
}

function finishMutation(): void {
  activeMutations -= 1;
  if (activeMutations !== 0) return;
  for (const resolve of drainWaiters) resolve();
  drainWaiters.clear();
}

function waitForMutations(): Promise<void> {
  if (activeMutations === 0) return Promise.resolve();
  return new Promise((resolve) => drainWaiters.add(resolve));
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

/** Admits concurrent credential work unless a reset has announced priority. */
export async function withDefaultCredentialStateMutation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  if (lockContext.getStore()?.active) return operation();
  return withDefaultIndependentCredentialStateMutation(operation);
}

/** Tracks work that may outlive the async context inherited from its caller. */
export async function withDefaultIndependentCredentialStateMutation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  if (pendingResets > 0) throw resetInProgressError();
  activeMutations += 1;
  const context: LockContext = { active: true, mode: "mutation" };
  try {
    return await lockContext.run(context, operation);
  } finally {
    context.active = false;
    finishMutation();
  }
}

/** Runs reset only after every previously admitted credential writer drains. */
export async function withDefaultCredentialStateReset<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const inherited = lockContext.getStore();
  if (inherited?.active && inherited.mode === "mutation") {
    throw new ElizaError("credential reset cannot start inside a mutation", {
      code: "CREDENTIAL_RESET_NESTED_MUTATION",
      severity: "fatal",
    });
  }
  if (inherited?.active && inherited.mode === "reset") return operation();

  pendingResets += 1;
  const release = await acquireResetTurn();
  try {
    await waitForMutations();
    const context: LockContext = { active: true, mode: "reset" };
    try {
      return await lockContext.run(context, operation);
    } finally {
      context.active = false;
    }
  } finally {
    pendingResets -= 1;
    release();
  }
}
