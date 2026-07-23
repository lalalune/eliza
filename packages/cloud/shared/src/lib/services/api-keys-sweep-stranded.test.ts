/**
 * `sweepStrandedAgentKeys` behavior (#16071).
 *
 * The cron adapter delegates stranded `agent-sandbox:<uuid>` credentials to
 * the API-key lifecycle service, which owns durable authorization revocation,
 * database deletion, and cache cleanup as one ordered operation.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ApiKey } from "../../db/repositories";
import { apiKeysService } from "./api-keys";
import { sweepStrandedAgentKeys } from "./stranded-agent-key-sweeper";

function strandedKey(id: string): ApiKey {
  return {
    id,
    key_hash: `${id}-hash`,
    name: `agent-sandbox:sandbox-${id}`,
    organization_id: "org-1",
    user_id: "user-1",
    is_active: true,
  } as unknown as ApiKey;
}

describe("sweepStrandedAgentKeys (#16071)", () => {
  const spies: Array<{ mockRestore: () => void }> = [];

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  function track<T extends { mockRestore: () => void }>(spy: T): T {
    spies.push(spy);
    return spy;
  }

  test("no stranded keys -> revokes nothing, no deletes, no invalidations", async () => {
    const revoke = track(spyOn(apiKeysService, "revokeStrandedAgentKeys").mockResolvedValue([]));

    const revoked = await sweepStrandedAgentKeys(new Date());

    expect(revoked).toBe(0);
    expect(revoke).toHaveBeenCalledOnce();
  });

  test("returns the number of credentials durably revoked by the lifecycle service", async () => {
    const keys = [strandedKey("k1"), strandedKey("k2"), strandedKey("k3")];
    const revoke = track(spyOn(apiKeysService, "revokeStrandedAgentKeys").mockResolvedValue(keys));

    const revoked = await sweepStrandedAgentKeys(new Date());

    expect(revoked).toBe(3);
    expect(revoke).toHaveBeenCalledOnce();
  });

  test("passes the grace cutoff straight through to the lifecycle service", async () => {
    const revoke = track(spyOn(apiKeysService, "revokeStrandedAgentKeys").mockResolvedValue([]));

    const cutoff = new Date("2026-01-01T00:00:00.000Z");
    await sweepStrandedAgentKeys(cutoff);

    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(cutoff);
  });
});
