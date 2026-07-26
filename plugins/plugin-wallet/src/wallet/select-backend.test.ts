/** Wallet backend selection tests pin managed-Cloud topology without touching signing services. */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalEoaBackend } from "./local-eoa-backend.js";
import { resolveWalletBackend } from "./select-backend.js";
import { StewardBackend } from "./steward-backend.js";

const originalProvisioned = process.env.ELIZA_CLOUD_PROVISIONED;
const originalMode = process.env.ELIZA_WALLET_BACKEND;
const originalStewardAuto = process.env.ELIZA_WALLET_STEWARD_AUTO;

const runtime = {
  getSetting: () => undefined,
} as unknown as IAgentRuntime;

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of [
    ["ELIZA_CLOUD_PROVISIONED", originalProvisioned],
    ["ELIZA_WALLET_BACKEND", originalMode],
    ["ELIZA_WALLET_STEWARD_AUTO", originalStewardAuto],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("resolveWalletBackend", () => {
  it('selects Steward in auto mode for ELIZA_CLOUD_PROVISIONED="true"', async () => {
    process.env.ELIZA_CLOUD_PROVISIONED = " TrUe ";
    delete process.env.ELIZA_WALLET_BACKEND;
    delete process.env.ELIZA_WALLET_STEWARD_AUTO;
    const selected = new Error("steward-selected");
    const stewardCreate = vi
      .spyOn(StewardBackend, "create")
      .mockRejectedValue(selected);
    const localCreate = vi.spyOn(LocalEoaBackend, "create");

    await expect(resolveWalletBackend(runtime)).rejects.toBe(selected);
    expect(stewardCreate).toHaveBeenCalledWith(runtime);
    expect(localCreate).not.toHaveBeenCalled();
  });

  it("keeps an explicit local backend authoritative in managed Cloud", async () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "true";
    process.env.ELIZA_WALLET_BACKEND = "local";
    const selected = new Error("local-selected");
    const localCreate = vi
      .spyOn(LocalEoaBackend, "create")
      .mockRejectedValue(selected);
    const stewardCreate = vi.spyOn(StewardBackend, "create");

    await expect(resolveWalletBackend(runtime)).rejects.toBe(selected);
    expect(localCreate).toHaveBeenCalledWith(runtime);
    expect(stewardCreate).not.toHaveBeenCalled();
  });
});
