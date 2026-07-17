/** Verifies Steward address caching uses hydrated env and reset removes every in-process mirror. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getWalletAddresses,
  initStewardWalletCache,
  resetStewardWalletCache,
} from "./wallet";

const EVM_ADDRESS = `0x${"1".repeat(40)}`;
const SOLANA_ADDRESS = "So11111111111111111111111111111111111111112";
const ORIGINAL_FETCH = globalThis.fetch;
const ENV_KEYS = [
  "STEWARD_API_URL",
  "STEWARD_AGENT_ID",
  "ELIZA_STEWARD_AGENT_ID",
  "STEWARD_AGENT_TOKEN",
  "STEWARD_API_KEY",
  "STEWARD_TENANT_ID",
  "STEWARD_EVM_ADDRESS",
  "STEWARD_SOLANA_ADDRESS",
  "SOLANA_PUBLIC_KEY",
  "WALLET_PUBLIC_KEY",
  "EVM_PRIVATE_KEY",
  "SOLANA_PRIVATE_KEY",
  "ELIZA_MANAGED_EVM_ADDRESS",
  "ELIZA_MANAGED_SOLANA_ADDRESS",
  "WALLET_SOURCE_EVM",
  "WALLET_SOURCE_SOLANA",
] as const;

describe("Steward wallet address cache", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    resetStewardWalletCache();
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    resetStewardWalletCache();
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  it("does not issue an unauthenticated request before env hydration", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    process.env.STEWARD_API_URL = "https://steward.local";
    process.env.STEWARD_AGENT_ID = "agent-1";

    await initStewardWalletCache();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears cached addresses and derived public-key mirrors", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              walletAddresses: {
                evm: EVM_ADDRESS,
                solana: SOLANA_ADDRESS,
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    process.env.STEWARD_API_URL = "https://steward.local";
    process.env.STEWARD_AGENT_ID = "agent-1";
    process.env.STEWARD_AGENT_TOKEN = "agent-token";

    await initStewardWalletCache();
    expect(getWalletAddresses()).toEqual({
      evmAddress: EVM_ADDRESS,
      solanaAddress: SOLANA_ADDRESS,
    });
    expect(process.env.SOLANA_PUBLIC_KEY).toBe(SOLANA_ADDRESS);
    expect(process.env.WALLET_PUBLIC_KEY).toBe(SOLANA_ADDRESS);

    resetStewardWalletCache();

    expect(getWalletAddresses()).toEqual({
      evmAddress: null,
      solanaAddress: null,
    });
    expect(process.env.STEWARD_EVM_ADDRESS).toBeUndefined();
    expect(process.env.STEWARD_SOLANA_ADDRESS).toBeUndefined();
    expect(process.env.SOLANA_PUBLIC_KEY).toBeUndefined();
    expect(process.env.WALLET_PUBLIC_KEY).toBeUndefined();
  });

  it("discards an address response that arrives after reset", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    process.env.STEWARD_API_URL = "https://steward.local";
    process.env.STEWARD_AGENT_ID = "agent-1";
    process.env.STEWARD_AGENT_TOKEN = "agent-token";

    const pending = initStewardWalletCache();
    expect(fetchMock).toHaveBeenCalledOnce();
    resetStewardWalletCache();
    resolveFetch(
      new Response(
        JSON.stringify({
          data: {
            walletAddresses: {
              evm: EVM_ADDRESS,
              solana: SOLANA_ADDRESS,
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await pending;

    expect(getWalletAddresses()).toEqual({
      evmAddress: null,
      solanaAddress: null,
    });
    expect(process.env.STEWARD_EVM_ADDRESS).toBeUndefined();
    expect(process.env.STEWARD_SOLANA_ADDRESS).toBeUndefined();
    expect(process.env.SOLANA_PUBLIC_KEY).toBeUndefined();
    expect(process.env.WALLET_PUBLIC_KEY).toBeUndefined();
  });
});
