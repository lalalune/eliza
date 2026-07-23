/**
 * Covers activation delivery retries and stable-id transcript recovery without
 * mocking the retry policy or replacing the client boundary under test.
 */

import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import {
  type PostSignInActivationClient,
  requestPostSignInActivationWithRetry,
} from "./post-sign-in-activation-client";

const EMPTY_COMMITTED_GREETING = {
  text: "",
  agentName: "Eliza",
  generated: false,
  persisted: false,
  messageId: "activation-1",
  source: "agent_greeting",
  timestamp: 42,
  greetingKind: "post_sign_in_activation" as const,
  activationVersion: "1",
  conversationId: "conversation-1",
};

function client(
  overrides: Partial<PostSignInActivationClient> = {},
): PostSignInActivationClient {
  return {
    getStatus: vi.fn(async () => ({ state: "running" })),
    requestGreeting: vi.fn(async () => ({
      ...EMPTY_COMMITTED_GREETING,
      text: "You're signed in. How would you like to get started?",
    })),
    getConversationMessages: vi.fn(async () => ({ messages: [] })),
    ...overrides,
  };
}

describe("post-sign-in activation client", () => {
  it("waits for running state and retries a transient transport failure", async () => {
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce({ state: "starting" })
      .mockResolvedValue({ state: "running" });
    const requestGreeting = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError({
          kind: "network",
          path: "/greeting",
          message: "connection reset",
        }),
      )
      .mockResolvedValue({
        ...EMPTY_COMMITTED_GREETING,
        text: "You're signed in. How would you like to get started?",
      });
    const sleep = vi.fn(async () => undefined);

    const result = await requestPostSignInActivationWithRetry({
      client: client({ getStatus, requestGreeting }),
      conversationId: "conversation-1",
      language: "en",
      retryDelaysMs: [10, 20, 30],
      sleep,
    });

    expect(result.text).toContain("How would you like to get started");
    expect(getStatus).toHaveBeenCalledTimes(3);
    expect(requestGreeting).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls).toEqual([[10], [20]]);
  });

  it("recovers a committed response from transcript after its HTTP acknowledgement is lost", async () => {
    const getConversationMessages = vi.fn(async () => ({
      messages: [
        {
          id: "activation-1",
          role: "assistant" as const,
          text: "You're signed in. Have you got a problem you'd like to solve?",
          timestamp: 42,
          source: "agent_greeting",
          greetingKind: "post_sign_in_activation" as const,
          activationVersion: "1",
        },
      ],
    }));

    const result = await requestPostSignInActivationWithRetry({
      client: client({
        requestGreeting: vi.fn(async () => EMPTY_COMMITTED_GREETING),
        getConversationMessages,
      }),
      conversationId: "conversation-1",
      language: "en",
      sleep: async () => undefined,
    });

    expect(result).toMatchObject({
      text: expect.stringMatching(/problem you'd like to solve/i),
      messageId: "activation-1",
      greetingKind: "post_sign_in_activation",
    });
    expect(getConversationMessages).toHaveBeenCalledWith("conversation-1", {
      around: "activation-1",
    });
  });

  it("does not replay an activation won by another conversation", async () => {
    const getConversationMessages = vi.fn(async () => ({ messages: [] }));
    const result = await requestPostSignInActivationWithRetry({
      client: client({
        requestGreeting: vi.fn(async () => ({
          ...EMPTY_COMMITTED_GREETING,
          conversationId: "earlier-conversation",
        })),
        getConversationMessages,
      }),
      conversationId: "conversation-1",
      language: "en",
    });

    expect(result.text).toBe("");
    expect(getConversationMessages).not.toHaveBeenCalled();
  });

  it("fails fast on deterministic authorization errors", async () => {
    const requestGreeting = vi.fn(async () => {
      throw new ApiError({
        kind: "http",
        path: "/greeting",
        status: 403,
        message: "owner required",
      });
    });
    const sleep = vi.fn(async () => undefined);

    await expect(
      requestPostSignInActivationWithRetry({
        client: client({ requestGreeting }),
        conversationId: "conversation-1",
        language: "en",
        sleep,
      }),
    ).rejects.toThrow("owner required");
    expect(requestGreeting).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("fails observably after a committed row stays unreadable", async () => {
    const requestGreeting = vi.fn(async () => EMPTY_COMMITTED_GREETING);
    const sleep = vi.fn(async () => undefined);

    await expect(
      requestPostSignInActivationWithRetry({
        client: client({ requestGreeting }),
        conversationId: "conversation-1",
        language: "en",
        retryDelaysMs: [10, 20],
        sleep,
      }),
    ).rejects.toThrow("committed but is not readable");
    expect(requestGreeting).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[10], [20]]);
  });
});
