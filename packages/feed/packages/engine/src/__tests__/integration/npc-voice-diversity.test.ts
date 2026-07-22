/**
 * Validates NPC character configuration and registry coverage without a model,
 * network access, or credentials. Live voice-generation behavior is isolated
 * in the canonical sibling live suite.
 */

import { describe, expect, it } from "vitest";
import { resolveLiveLlmTestConfig } from "../../../../testing/integration/helpers/live-runtime";
import {
  getCharacterConfig,
  getConfiguredCharacters,
} from "../../services/npc-character-config";
import { StaticDataRegistry } from "../../services/static-data-registry";

describe("NPC voice configuration", () => {
  it("requires explicit opt-in and a provider credential for live checks", () => {
    const originalEnvironment = {
      anthropic: process.env.ANTHROPIC_API_KEY,
      groq: process.env.GROQ_API_KEY,
      openai: process.env.OPENAI_API_KEY,
      optIn: process.env.RUN_LIVE_LLM_TESTS,
    };

    try {
      process.env.RUN_LIVE_LLM_TESTS = "1";
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.GROQ_API_KEY;
      delete process.env.OPENAI_API_KEY;
      expect(resolveLiveLlmTestConfig()).toMatchObject({
        enabled: false,
        requested: true,
      });

      process.env.GROQ_API_KEY = "test-groq-key";
      expect(resolveLiveLlmTestConfig()).toEqual({
        enabled: true,
        requested: true,
        skipReason: null,
      });
    } finally {
      for (const [name, value] of [
        ["ANTHROPIC_API_KEY", originalEnvironment.anthropic],
        ["GROQ_API_KEY", originalEnvironment.groq],
        ["OPENAI_API_KEY", originalEnvironment.openai],
        ["RUN_LIVE_LLM_TESTS", originalEnvironment.optIn],
      ] as const) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });

  it("should have character configs for key NPCs", () => {
    const chars = getConfiguredCharacters();

    // Verify key characters are configured
    expect(chars).toContain("kanyai-west");
    expect(chars).toContain("trump-terminal");
    expect(chars).toContain("dairiio-amodei");
    expect(chars).toContain("sam-ailtman");
    expect(chars).toContain("ailon-musk");
  });

  it("should have different temperatures for different personality types", () => {
    const kanyaiConfig = getCharacterConfig("kanyai-west");
    const dairiioConfig = getCharacterConfig("dairiio-amodei");
    const trumpConfig = getCharacterConfig("trump-terminal");

    // KanyAI "chaotic visionary" -> chaotic (0.95)
    expect(kanyaiConfig.temperature).toBe(0.95);
    // Trump "narcissistic showman" -> provocative (0.9)
    expect(trumpConfig.temperature).toBe(0.9);
    // Dairiio "safety theater director" -> corporate (0.6)
    expect(dairiioConfig.temperature).toBe(0.6);
    // Chaotic > Provocative > Corporate
    expect(kanyaiConfig.temperature).toBeGreaterThan(trumpConfig.temperature);
    expect(trumpConfig.temperature).toBeGreaterThan(dairiioConfig.temperature);
  });

  it("should have defined rivalries", () => {
    const samConfig = getCharacterConfig("sam-ailtman");
    const dairiioConfig = getCharacterConfig("dairiio-amodei");

    // Sam AIltman and Dairiio AmodAI are rivals
    expect(samConfig.rivals).toContain("dairiio-amodei");
    expect(dairiioConfig.rivals).toContain("sam-ailtman");
  });

  it("should load actors from static registry", () => {
    const actors = StaticDataRegistry.getAllActors();

    expect(actors.length).toBeGreaterThan(0);

    // Check that some key actors exist
    const actorIds = actors.map((a) => a.id);
    expect(
      actorIds.some((id) => id.includes("kanye") || id.includes("kanyai")),
    ).toBe(true);
  });
});
