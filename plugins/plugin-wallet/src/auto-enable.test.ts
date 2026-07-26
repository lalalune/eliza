/** Wallet auto-enable tests cover local and managed Steward signing paths. */
import type { PluginAutoEnableContext } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { shouldEnable } from "../auto-enable.js";

function context(env: NodeJS.ProcessEnv): PluginAutoEnableContext {
  return { env, config: {} } as PluginAutoEnableContext;
}

describe("plugin-wallet auto-enable", () => {
  it('accepts ELIZA_CLOUD_PROVISIONED="true" for a managed Steward wallet', () => {
    expect(
      shouldEnable(
        context({
          ELIZA_CLOUD_PROVISIONED: " TrUe ",
          STEWARD_API_URL: "https://steward.internal",
          STEWARD_AGENT_TOKEN: "agent-token",
        }),
      ),
    ).toBe(true);
  });

  it("does not enable without any signing authority", () => {
    expect(
      shouldEnable(context({ ELIZA_CLOUD_PROVISIONED: "true" })),
    ).toBe(false);
  });
});
