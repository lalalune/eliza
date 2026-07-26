/** Signing-capability tests distinguish managed Steward authority from self-hosted Steward. */
import { describe, expect, it } from "vitest";
import { resolveEvmSigningCapability } from "./evm-signing-capability.ts";

describe("resolveEvmSigningCapability", () => {
  it('classifies ELIZA_CLOUD_PROVISIONED="true" as managed Steward', () => {
    expect(
      resolveEvmSigningCapability({
        ELIZA_CLOUD_PROVISIONED: " TrUe ",
        STEWARD_API_URL: "https://steward.internal",
        STEWARD_AGENT_TOKEN: "agent-token",
      }),
    ).toMatchObject({
      kind: "steward-cloud",
      canSign: true,
    });
  });

  it("keeps Steward self-hosted when no provisioning flag is present", () => {
    expect(
      resolveEvmSigningCapability({
        STEWARD_API_URL: "https://steward.local",
        STEWARD_AGENT_TOKEN: "agent-token",
      }),
    ).toMatchObject({
      kind: "steward-self",
      canSign: true,
    });
  });
});
