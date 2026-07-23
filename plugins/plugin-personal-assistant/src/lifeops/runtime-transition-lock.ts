/**
 * Serializes cache-backed read/modify/write transitions within one agent
 * runtime. The runtime cache API intentionally exposes no compare-and-swap
 * primitive, so lifecycle stores share this process-local boundary to keep
 * concurrent turns from racing between their read and durable write.
 */

import type { IAgentRuntime } from "@elizaos/core";

const transitionQueues = new WeakMap<
  IAgentRuntime,
  Map<string, Promise<void>>
>();

export async function withRuntimeTransitionLock<T>(
  runtime: IAgentRuntime,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  let queues = transitionQueues.get(runtime);
  if (!queues) {
    queues = new Map<string, Promise<void>>();
    transitionQueues.set(runtime, queues);
  }

  const previous = queues.get(key) ?? Promise.resolve();
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  queues.set(key, tail);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (queues.get(key) === tail) {
      queues.delete(key);
    }
  }
}
