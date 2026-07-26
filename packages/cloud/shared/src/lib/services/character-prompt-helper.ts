/**
 * Character Prompt Helper
 *
 * Extracts character personality traits for use in social media post generation.
 * Provides a simplified interface for getting character voice/style without
 * needing the full elizaOS runtime.
 */

import { logger } from "../utils/logger";
import { charactersService } from "./characters/characters";

export class CharacterPromptCacheWarmingError extends Error {
  constructor(readonly state: "warming" | "unavailable") {
    super("Character prompt cache is warming");
    this.name = "CharacterPromptCacheWarmingError";
  }
}

/**
 * Fisher-Yates shuffle algorithm for unbiased random sampling.
 * Returns a new shuffled array without modifying the original.
 */
function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Get random sample from array using Fisher-Yates shuffle.
 */
function getRandomSample<T>(array: T[], count: number): T[] {
  return shuffleArray(array).slice(0, count);
}

export interface CharacterPromptContext {
  name: string;
  bio: string;
  adjectives: string[];
  topics: string[];
  postExamples: string[];
  postStyle: string[];
  allStyle: string[];
}

function promptContextFromCharacter(
  character: Awaited<ReturnType<typeof charactersService.getById>>,
): CharacterPromptContext | null {
  if (!character) return null;

  const bio = Array.isArray(character.bio)
    ? character.bio.join(" ")
    : character.bio || "";
  const style = character.style || {};
  const postStyle = Array.isArray(style.post) ? style.post : [];
  const allStyle = Array.isArray(style.all) ? style.all : [];

  return {
    name: character.name,
    bio,
    adjectives: Array.isArray(character.adjectives)
      ? character.adjectives
      : [],
    topics: Array.isArray(character.topics) ? character.topics : [],
    postExamples: Array.isArray(character.post_examples)
      ? character.post_examples
      : [],
    postStyle,
    allStyle,
  };
}

/**
 * Get character personality context for social media post generation.
 * Returns null if character not found.
 */
export async function getCharacterPromptContext(
  characterId: string,
): Promise<CharacterPromptContext | null> {
  const character = await charactersService.getById(characterId);

  if (!character) {
    logger.warn("[CharacterPromptHelper] Character not found", { characterId });
    return null;
  }

  // Every list field is caller-supplied jsonb stored verbatim, so normalize
  // malformed values before prompt sampling can attempt to spread them.
  const context = promptContextFromCharacter(character);
  if (!context) return null;

  // Log detailed character context for debugging
  logger.info("[CharacterPromptHelper] Loaded character context", {
    characterId,
    name: context.name,
    bioLength: context.bio.length,
    adjectiveCount: context.adjectives.length,
    topicCount: context.topics.length,
    postExampleCount: context.postExamples.length,
    styleCount: context.postStyle.length + context.allStyle.length,
  });

  return context;
}

/**
 * Resolve character prompt material for interactive generation without a
 * database fallback. A miss retains one authoritative fill under `waitUntil`
 * and tells the route to return a retryable warming response.
 */
export async function getCharacterPromptContextCacheOnly(
  characterId: string,
  executionCtx: { waitUntil(promise: Promise<unknown>): void },
): Promise<CharacterPromptContext> {
  const resolution = await charactersService.getByIdCacheOnly(characterId, {
    executionCtx,
  });
  if (resolution.kind !== "ready") {
    throw new CharacterPromptCacheWarmingError(resolution.kind);
  }
  const context = promptContextFromCharacter(resolution.character);
  if (!context) {
    throw new CharacterPromptCacheWarmingError("warming");
  }
  return context;
}

/**
 * Build a system prompt section for character-voiced content generation.
 * Used by Twitter, Discord, Telegram automation services.
 */
export function buildCharacterSystemPrompt(context: CharacterPromptContext): string {
  const parts: string[] = [];

  parts.push(`You are ${context.name}.`);

  if (context.bio) {
    parts.push(`About you: ${context.bio}`);
  }

  if (context.adjectives.length > 0) {
    const selectedAdjectives = getRandomSample(context.adjectives, 5);
    parts.push(`Your personality: ${selectedAdjectives.join(", ")}`);
  }

  if (context.topics.length > 0) {
    const selectedTopics = getRandomSample(context.topics, 5);
    parts.push(`Topics you enjoy: ${selectedTopics.join(", ")}`);
  }

  const styleGuidelines = [...context.postStyle, ...context.allStyle];
  if (styleGuidelines.length > 0) {
    const selectedStyles = getRandomSample(styleGuidelines, 5);
    parts.push(`Your writing style: ${selectedStyles.join("; ")}`);
  }

  if (context.postExamples.length > 0) {
    const examples = getRandomSample(context.postExamples, 3);
    parts.push(`Example posts you've written:\n${examples.map((ex) => `- "${ex}"`).join("\n")}`);
  }

  const prompt = parts.join("\n\n");

  // Log the generated prompt for debugging
  logger.debug("[CharacterPromptHelper] Built character prompt", {
    name: context.name,
    promptLength: prompt.length,
    promptPreview: `${prompt.substring(0, 200)}...`,
  });

  return prompt;
}
