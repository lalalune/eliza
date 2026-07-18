/**
 * Verifies cache-routing options across the real AI SDK/provider serialization boundary.
 * The HTTP response is local; no OpenRouter credential or network call is used.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleTextSmall } from "../models/text";

function createRuntime(): IAgentRuntime {
  const settings: Record<string, string> = {
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
    OPENROUTER_SMALL_MODEL: "anthropic/claude-sonnet-4",
  };
  return {
    character: { system: "Keep responses brief." },
    emitEvent: vi.fn(async () => undefined),
    getSetting: vi.fn((key: string) => settings[key] ?? null),
  } as IAgentRuntime;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenRouter cache routing wire shape", () => {
  it("serializes promptCacheKey as the documented session_id field", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        id: "generation-test",
        model: "anthropic/claude-sonnet-4",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "OK" },
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await handleTextSmall(createRuntime(), {
      prompt: "Reply OK.",
      providerOptions: { openrouter: { promptCacheKey: "cache-session-123" } },
    } as never);

    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.session_id).toBe("cache-session-123");
    expect(body).not.toHaveProperty("promptCacheKey");
    expect(body).not.toHaveProperty("prompt_cache_key");
  });
});
