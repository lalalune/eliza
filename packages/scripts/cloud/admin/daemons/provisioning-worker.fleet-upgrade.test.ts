/**
 * Proves registry digest drift reaches the agent-upgrade job that performs the
 * blue/green runtime swap, including per-agent credential rotation.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  __setDepsForTests,
  processFleetUpgradeCycle,
} from "./provisioning-worker";

afterEach(() => {
  __setDepsForTests(null);
});

describe("processFleetUpgradeCycle", () => {
  test("enqueues the blue/green upgrade path for an agent behind the registry digest", async () => {
    const targetDigest = `sha256:${"1".repeat(64)}`;
    const currentDigest = `sha256:${"0".repeat(64)}`;
    const image = "ghcr.io/elizaos/eliza:stable";
    const listCandidates = mock(async () => [
      {
        id: "agent-1",
        organization_id: "org-1",
        user_id: "user-1",
        image_digest: currentDigest,
      },
    ]);
    const enqueueAgentUpgradeOnce = mock(async () => ({
      created: true,
      job: { id: "upgrade-job-1" },
    }));

    __setDepsForTests({
      containersEnv: { defaultAgentImage: () => image },
      resolveImageDigest: async () => targetDigest,
      agentSandboxesRepository: {
        listRunningWithDigestOtherThan: listCandidates,
      },
      jobsRepository: { countInFlightByType: async () => 0 },
      provisioningJobService: { enqueueAgentUpgradeOnce },
      logger: { warn: mock(() => {}) },
    } as unknown as Parameters<typeof __setDepsForTests>[0]);

    const result = await processFleetUpgradeCycle();

    expect(listCandidates).toHaveBeenCalledWith(targetDigest, image, 3);
    expect(enqueueAgentUpgradeOnce).toHaveBeenCalledWith({
      agentId: "agent-1",
      organizationId: "org-1",
      userId: "user-1",
      fromDigest: currentDigest,
      toDigest: targetDigest,
      dockerImage: image,
    });
    expect(result).toMatchObject({
      action: "enqueued",
      targetDigest,
      candidates: 1,
      enqueued: 1,
      inFlight: 0,
    });
  });
});
