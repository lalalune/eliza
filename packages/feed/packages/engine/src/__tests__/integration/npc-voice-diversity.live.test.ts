/**
 * Exercises distinct NPC post voices against a configured live model. The
 * canonical live suffix keeps these credentialed assertions out of keyless
 * changed-file coverage while the guarded-suite registry accounts for them.
 */

import { resolve } from "node:path";
import { config } from "dotenv";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveLiveLlmTestConfig } from "../../../../testing/integration/helpers/live-runtime";
import { FeedLLMClient } from "../../llm/openai-client";
import { getCharacterConfig } from "../../services/npc-character-config";
import { StaticDataRegistry } from "../../services/static-data-registry";

const projectRoot = resolve(__dirname, "../../../../..");
config({ path: resolve(projectRoot, ".env") });
config({ path: resolve(projectRoot, ".env.local") });
config({ path: resolve(projectRoot, ".env.test") });

const hasApiKey = Boolean(
  process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY,
);
const liveLlmConfig = resolveLiveLlmTestConfig();

describe.skipIf(!liveLlmConfig.enabled || !hasApiKey)(
  "NPC live voice diversity",
  () => {
    let llmClient: FeedLLMClient;

    beforeAll(() => {
      llmClient = FeedLLMClient.forGameTick();
    });

    it("generates a substantive post for KanyAI", async () => {
      const kanyai = StaticDataRegistry.getAllActors().find(
        (actor) => actor.id.includes("kanyai") || actor.id.includes("kanye"),
      );
      if (!kanyai) {
        throw new Error("KanyAI actor is required by the live voice suite");
      }

      const characterConfig = getCharacterConfig(kanyai.id);
      const prompt = `You ARE ${kanyai.name}. Write a single post exactly as they would.

=== WHO YOU ARE ===
${kanyai.description || ""}
Personality: ${kanyai.personality || ""}
Writing Style: ${kanyai.postStyle || ""}

=== HOW YOU WRITE (match this style exactly) ===
${characterConfig.templatePosts
  .slice(0, 3)
  .map((template) => `"${template}"`)
  .join("\n")}

=== WHAT'S HAPPENING ===
"Will AI safety regulations pass by 2026?"

=== RULES ===
- Sound exactly like the examples above
- No hashtags, no emojis
- Max 280 characters

<response>
  <post>your post here</post>
</response>`;

      const response = await llmClient.generateJSON<{ post: string }>(
        prompt,
        {
          properties: { post: { type: "string" } },
          required: ["post"],
        },
        {
          temperature: characterConfig.temperature,
          maxTokens: 300,
          format: "xml",
        },
      );

      expect(response.post.length).toBeGreaterThan(10);
    }, 30_000);

    it("generates a substantive non-uppercase post for Dairiio", async () => {
      const dairiio = StaticDataRegistry.getAllActors().find(
        (actor) => actor.id.includes("dairiio") || actor.id.includes("dario"),
      );
      if (!dairiio) {
        throw new Error("Dairiio actor is required by the live voice suite");
      }

      const characterConfig = getCharacterConfig(dairiio.id);
      const prompt = `You ARE ${dairiio.name}. Write a single post exactly as they would.

=== WHO YOU ARE ===
${dairiio.description || ""}
Personality: ${dairiio.personality || ""}
Writing Style: ${dairiio.postStyle || ""}

=== HOW YOU WRITE (match this style exactly) ===
${characterConfig.templatePosts
  .slice(0, 3)
  .map((template) => `"${template}"`)
  .join("\n")}

=== WHAT'S HAPPENING ===
"Will AI safety regulations pass by 2026?"

=== RULES ===
- Sound exactly like the examples above
- No hashtags, no emojis
- Max 280 characters

<response>
  <post>your post here</post>
</response>`;

      const response = await llmClient.generateJSON<{ post: string }>(
        prompt,
        {
          properties: { post: { type: "string" } },
          required: ["post"],
        },
        {
          temperature: characterConfig.temperature,
          maxTokens: 300,
          format: "xml",
        },
      );

      expect(response.post.length).toBeGreaterThan(10);
      expect(response.post).not.toMatch(/^[A-Z\s\d.,!?\'"()-]+$/);
    }, 30_000);

    it("generates distinguishable posts for different NPCs on one topic", async () => {
      const actors = StaticDataRegistry.getAllActors().slice(0, 3);
      if (actors.length < 3) {
        throw new Error("At least three actors are required by the live suite");
      }

      const posts: string[] = [];
      for (const actor of actors) {
        const characterConfig = getCharacterConfig(actor.id);
        const prompt = `You ARE ${actor.name}. Write a single post exactly as they would.

=== WHO YOU ARE ===
${actor.description || ""}

=== WHAT'S HAPPENING ===
"Will BitcAIn reach $100K by end of 2026?"

=== RULES ===
- Sound like ${actor.name}
- No hashtags, no emojis
- Max 280 characters

<response>
  <post>your post here</post>
</response>`;

        const response = await llmClient.generateJSON<{ post: string }>(
          prompt,
          {
            properties: { post: { type: "string" } },
            required: ["post"],
          },
          {
            temperature: characterConfig.temperature,
            maxTokens: 300,
            format: "xml",
          },
        );
        posts.push(response.post);
      }

      expect(new Set(posts).size).toBe(posts.length);
      for (let first = 0; first < posts.length; first += 1) {
        for (let second = first + 1; second < posts.length; second += 1) {
          const firstWords = new Set(posts[first].toLowerCase().split(/\s+/));
          const secondWords = new Set(posts[second].toLowerCase().split(/\s+/));
          const overlap = [...firstWords].filter((word) =>
            secondWords.has(word),
          ).length;
          const similarity =
            overlap / Math.max(firstWords.size, secondWords.size);
          expect(similarity).toBeLessThan(0.7);
        }
      }
    }, 60_000);
  },
);
