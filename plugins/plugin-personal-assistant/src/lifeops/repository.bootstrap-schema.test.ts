/** Verifies route-time schema reconciliation preserves every table owned by the runtime's aggregate plugin. */

import { knowledgeGraphSchema, pendantSessionSchema } from "@elizaos/agent";
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { LifeOpsRepository } from "./repository";

describe("LifeOpsRepository.bootstrapSchema", () => {
  it("reconciles the complete runtime-owned eliza schema", async () => {
    const runPluginMigrations = vi.fn(async () => undefined);
    const runtime = {
      adapter: {
        isReady: async () => true,
        runPluginMigrations,
        db: {
          execute: vi.fn(async () => ({ rows: [] })),
        },
      },
    } as unknown as IAgentRuntime;

    await LifeOpsRepository.bootstrapSchema(runtime);

    const migrations = runPluginMigrations.mock.calls[0]?.[0] as Plugin[];
    const runtimePlugin = migrations.find((plugin) => plugin.name === "eliza");
    expect(Object.keys(runtimePlugin?.schema ?? {})).toEqual(
      expect.arrayContaining([
        ...Object.keys(knowledgeGraphSchema),
        ...Object.keys(pendantSessionSchema),
      ]),
    );
  });
});
