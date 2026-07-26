/**
 * Locks the live chat telemetry workflow to an exact deployed revision and
 * ensures transport or proof failures cannot be converted into green evidence.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../../../.github/workflows/chat-latency-live.yml", import.meta.url),
  "utf8",
);

describe("chat latency telemetry workflow", () => {
  test("runs only by explicit dispatch on the canonical environment branch", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("pull_request:");
    expect(workflow).toContain(
      "inputs.environment == 'staging' && github.ref == 'refs/heads/develop'",
    );
    expect(workflow).toContain(
      "inputs.environment == 'production' && github.ref == 'refs/heads/main'",
    );
    expect(workflow).toContain("environment: ${{ inputs.environment }}");
  });

  test("binds checkout and both health probes to the requested deployment", () => {
    expect(workflow).toContain("expected_gateway_sha:");
    expect(workflow).toContain("checkout !== expected");
    expect(workflow).toContain("health?.commit !== process.env.EXPECTED_GATEWAY_SHA");
    expect(workflow).toContain("Verify deployed gateway before measurement");
    expect(workflow).toContain("Verify deployed gateway after measurement");
    expect(workflow).toContain(
      "chat-latency-${{ inputs.environment }}-${{ github.sha }}",
    );
  });

  test("propagates probe failures through the tee pipeline", () => {
    expect(workflow).not.toContain("continue-on-error:");
    expect(workflow).toContain("set -o pipefail");
    expect(workflow).toContain("--target paired");
    expect(workflow).toContain(
      "--direct-api-key-env CEREBRAS_CHAT_LATENCY_API_KEY",
    );
    expect(workflow).toContain(
      "--gateway-api-key-env ELIZA_CLOUD_CHAT_LATENCY_API_KEY",
    );
  });
});
