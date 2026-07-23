/**
 * Strongly ordered conversation state for shared-runtime agent turns.
 *
 * One Durable Object is addressed per agent room. Its local storage is the
 * request-path source of truth; Postgres is read only for one-time migration
 * and updated asynchronously as a recoverable reporting/backup mirror.
 */

import type { AgentSandbox } from "@/db/repositories/agent-sandboxes";
import type { BridgeRequest } from "@/lib/services/eliza-sandbox";
import type { SharedTurnMessage } from "@/lib/services/shared-runtime/run-shared-agent-turn";
import type { SharedRuntimeHistoryStore } from "@/lib/services/shared-runtime/shared-runtime-chat";
import type { AppEnv } from "@/types/cloud-worker-env";

type ConversationRequest =
  | { operation: "bridge"; agent: AgentSandbox; rpc: BridgeRequest }
  | { operation: "stream"; agent: AgentSandbox; rpc: BridgeRequest }
  | { operation: "history"; agentId: string; roomId: string };

interface StoredConversation {
  agentId: string;
  channelId: string;
  history: SharedTurnMessage[];
  dirty: boolean;
  version?: number;
}

const CONVERSATION_KEY = "conversation";
const RETRY_DELAY_MS = 30_000;

class ConversationCacheWarmingError extends Error {
  constructor() {
    super("Conversation cache is warming. Retry shortly.");
    this.name = "ConversationCacheWarmingError";
  }
}

interface ConversationRuntime {
  fetch(request: Request): Promise<Response>;
  alarm(): Promise<void>;
}

interface ConversationDependencies {
  runWithBindings<T>(
    env: AppEnv["Bindings"],
    fn: () => Promise<T>,
  ): Promise<T>;
  readHistory(
    agentId: string,
    channelId: string,
  ): Promise<SharedTurnMessage[]>;
  writeHistory(
    agentId: string,
    channelId: string,
    history: SharedTurnMessage[],
  ): Promise<void>;
  getHistory(
    agentId: string,
    channelId: string,
    store: SharedRuntimeHistoryStore,
  ): Promise<SharedTurnMessage[]>;
  bridge: typeof import("@/lib/services/shared-runtime/shared-runtime-chat").sharedRuntimeChatService.bridge;
  stream: typeof import("@/lib/services/shared-runtime/shared-runtime-chat").sharedRuntimeChatService.stream;
  warn(message: string, context: Record<string, unknown>): Promise<void>;
}

interface ConversationRuntimeState {
  state: DurableObjectState;
  env: AppEnv["Bindings"];
  dependencies: ConversationDependencies;
  conversation: StoredConversation | null | undefined;
  hydration: Promise<void> | undefined;
  queue: Promise<void>;
  mirrorQueue: Promise<void>;
}

const defaultDependencies: ConversationDependencies = {
  runWithBindings: async (env, fn) => {
    const [{ runWithDbCacheAsync }, { runWithCloudBindingsAsync }] =
      await Promise.all([
        import("@/db/client"),
        import("@/lib/runtime/cloud-bindings"),
      ]);
    return await runWithCloudBindingsAsync(env, async () =>
      runWithDbCacheAsync(fn),
    );
  },
  readHistory: async (agentId, channelId) => {
    const { sharedRuntimeHistoryRepository } = await import(
      "@/db/repositories/shared-runtime-history"
    );
    return await sharedRuntimeHistoryRepository.get(agentId, channelId);
  },
  writeHistory: async (agentId, channelId, history) => {
    const { sharedRuntimeHistoryRepository } = await import(
      "@/db/repositories/shared-runtime-history"
    );
    await sharedRuntimeHistoryRepository.upsert(agentId, channelId, history);
  },
  getHistory: async (agentId, channelId, store) => {
    const { sharedRuntimeChatService } = await import(
      "@/lib/services/shared-runtime/shared-runtime-chat"
    );
    return await sharedRuntimeChatService.getHistory(
      agentId,
      channelId,
      store,
    );
  },
  bridge: async (agent, rpc, options) => {
    const { sharedRuntimeChatService } = await import(
      "@/lib/services/shared-runtime/shared-runtime-chat"
    );
    return await sharedRuntimeChatService.bridge(agent, rpc, options);
  },
  stream: async (agent, rpc, options) => {
    const { sharedRuntimeChatService } = await import(
      "@/lib/services/shared-runtime/shared-runtime-chat"
    );
    return await sharedRuntimeChatService.stream(agent, rpc, options);
  },
  warn: async (message, context) => {
    const { logger } = await import("@/lib/utils/logger");
    logger.warn(message, context);
  },
};

async function runWithBindings<T>(
  runtime: ConversationRuntimeState,
  fn: () => Promise<T>,
): Promise<T> {
  return await runtime.dependencies.runWithBindings(runtime.env, fn);
}

async function loadConversation(
  runtime: ConversationRuntimeState,
  agentId: string,
  channelId: string,
): Promise<StoredConversation> {
  if (runtime.conversation) return runtime.conversation;
  if (runtime.conversation === undefined) {
    runtime.conversation =
      (await runtime.state.storage.get<StoredConversation>(CONVERSATION_KEY)) ??
      null;
  }
  if (runtime.conversation) return runtime.conversation;

  if (!runtime.hydration) {
    runtime.hydration = runWithBindings(runtime, async () => {
      const history = await runtime.dependencies.readHistory(
        agentId,
        channelId,
      );
      runtime.conversation = {
        agentId,
        channelId,
        history,
        dirty: false,
        version: 0,
      };
      await runtime.state.storage.put(CONVERSATION_KEY, runtime.conversation);
    })
      .catch(async (error) => {
        // error-policy:J7 a failed migration leaves the request fail-closed;
        // a later retry starts a fresh hydration instead of losing history.
        await runtime.dependencies.warn(
          "[SharedRuntimeConversation] history hydration failed",
          {
            agentId,
            channelId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      })
      .finally(() => {
        runtime.hydration = undefined;
      });
    runtime.state.waitUntil(runtime.hydration);
  }
  throw new ConversationCacheWarmingError();
}

async function mirrorConversation(
  runtime: ConversationRuntimeState,
  snapshot: StoredConversation,
): Promise<void> {
  try {
    await runWithBindings(runtime, async () => {
      await runtime.dependencies.writeHistory(
        snapshot.agentId,
        snapshot.channelId,
        snapshot.history,
      );
    });
    const current =
      await runtime.state.storage.get<StoredConversation>(CONVERSATION_KEY);
    if (
      current?.dirty &&
      current.agentId === snapshot.agentId &&
      current.channelId === snapshot.channelId &&
      (current.version ?? 0) === (snapshot.version ?? 0)
    ) {
      runtime.conversation = { ...current, dirty: false };
      await runtime.state.storage.put(CONVERSATION_KEY, runtime.conversation);
    }
  } catch (error) {
    // error-policy:J7 the Durable Object copy is authoritative for active
    // chat; a failed reporting mirror is retried by alarm and must not kill
    // or delay the user-visible turn.
    await runtime.dependencies.warn(
      "[SharedRuntimeConversation] Postgres mirror failed",
      {
        agentId: snapshot.agentId,
        channelId: snapshot.channelId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    await runtime.state.storage.setAlarm(Date.now() + RETRY_DELAY_MS);
  }
}

function scheduleMirror(
  runtime: ConversationRuntimeState,
  snapshot: StoredConversation,
): Promise<void> {
  runtime.mirrorQueue = runtime.mirrorQueue.then(() =>
    mirrorConversation(runtime, snapshot),
  );
  runtime.state.waitUntil(runtime.mirrorQueue);
  return runtime.mirrorQueue;
}

function historyStore(
  runtime: ConversationRuntimeState,
): SharedRuntimeHistoryStore {
  return {
    load: async (agentId, channelId) =>
      (await loadConversation(runtime, agentId, channelId)).history,
    save: async (agentId, channelId, history) => {
      const snapshot: StoredConversation = {
        agentId,
        channelId,
        history,
        dirty: true,
        version: (runtime.conversation?.version ?? 0) + 1,
      };
      runtime.conversation = snapshot;
      await runtime.state.storage.put(CONVERSATION_KEY, snapshot);
      scheduleMirror(runtime, snapshot);
    },
  };
}

async function handle(
  runtime: ConversationRuntimeState,
  request: Request,
): Promise<Response> {
  const payload = (await request.json()) as ConversationRequest;
  const store = historyStore(runtime);
  if (payload.operation === "history") {
    const history = await runWithBindings(runtime, async () =>
      runtime.dependencies.getHistory(
        payload.agentId,
        payload.roomId,
        store,
      ),
    );
    return Response.json({ history });
  }

  return await runWithBindings(runtime, async () => {
    const executionCtx = {
      waitUntil: (promise: Promise<unknown>) =>
        runtime.state.waitUntil(promise),
    };
    if (payload.operation === "stream") {
      return await runtime.dependencies.stream(
        payload.agent,
        payload.rpc,
        {
          executionCtx,
          historyStore: store,
        },
      );
    }
    const result = await runtime.dependencies.bridge(
      payload.agent,
      payload.rpc,
      { executionCtx, historyStore: store },
    );
    return Response.json(result);
  });
}

function releaseWhenConsumed(
  response: Response,
  release: () => void,
): Response {
  if (!response.body) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      try {
        const next = await reader.read();
        if (next.done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        // error-policy:J1 the response-stream boundary must release the
        // conversation lock before surfacing a read failure to the caller.
        release();
        controller.error(error);
      }
    },
    cancel: async (reason) => {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function fetchConversation(
  runtime: ConversationRuntimeState,
  request: Request,
): Promise<Response> {
  const previous = runtime.queue;
  let release = () => {};
  runtime.queue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;

  try {
    const response = await handle(runtime, request);
    return releaseWhenConsumed(response, release);
  } catch (error) {
    // error-policy:J1 the Durable Object transport boundary translates only
    // cache warming; every other failure remains observable to Workers.
    release();
    if (
      error instanceof ConversationCacheWarmingError ||
      (error instanceof Error &&
        error.name === "SharedRuntimeCacheWarmingError")
    ) {
      return Response.json(
        {
          success: false,
          error: error.message,
          code: "conversation_cache_warming",
          retryable: true,
        },
        { status: 503 },
      );
    }
    throw error;
  }
}

async function alarmConversation(
  runtime: ConversationRuntimeState,
): Promise<void> {
  const snapshot =
    runtime.conversation ??
    (await runtime.state.storage.get<StoredConversation>(CONVERSATION_KEY));
  if (snapshot?.dirty) {
    await scheduleMirror(runtime, snapshot);
  }
}

function createConversationRuntime(
  state: DurableObjectState,
  env: AppEnv["Bindings"],
  dependencies: ConversationDependencies,
): ConversationRuntime {
  const runtime: ConversationRuntimeState = {
    state,
    env,
    dependencies,
    conversation: undefined,
    hydration: undefined,
    queue: Promise.resolve(),
    mirrorQueue: Promise.resolve(),
  };
  return {
    fetch: async (request) => await fetchConversation(runtime, request),
    alarm: async () => await alarmConversation(runtime),
  };
}

export class SharedRuntimeConversation {
  private readonly runtime: ConversationRuntime;

  constructor(
    state: DurableObjectState,
    env: AppEnv["Bindings"],
    dependencies: ConversationDependencies = defaultDependencies,
  ) {
    this.runtime = createConversationRuntime(state, env, dependencies);
  }

  async fetch(request: Request): Promise<Response> {
    return await this.runtime.fetch(request);
  }

  async alarm(): Promise<void> {
    await this.runtime.alarm();
  }
}
