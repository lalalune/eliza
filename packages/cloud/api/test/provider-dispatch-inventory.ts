/**
 * Classifies every cloud model or generative-provider dispatch implementation.
 *
 * The companion architecture test discovers dispatch primitives independently,
 * so adding a provider call requires an explicit security/billing classification
 * here. `user_request_synchronous` is existing migration debt, not an approved
 * pattern for new endpoints.
 */

export type ProviderDispatchBoundary =
  | "cache_admission"
  | "shared_runtime_cache_admission"
  | "user_request_synchronous"
  | "latent_unwired"
  | "platform_policy"
  | "internal_background"
  | "provider_adapter";

export interface ProviderDispatchInventoryEntry {
  boundary: ProviderDispatchBoundary;
  entrypoints: readonly string[];
  rationale: string;
}

export const PROVIDER_DISPATCH_INVENTORY = {
  "packages/cloud/api/agents/[id]/a2a/route.ts": {
    boundary: "cache_admission",
    entrypoints: ["/api/agents/:id/a2a"],
    rationale:
      "Public A2A chat uses cached identity/agent policy and versioned organization admission.",
  },
  "packages/cloud/api/agents/[id]/mcp/route.ts": {
    boundary: "cache_admission",
    entrypoints: ["/api/agents/:id/mcp"],
    rationale:
      "The MCP chat tool uses cached identity/agent policy and versioned organization admission.",
  },
  "packages/cloud/api/elevenlabs/voices/verify/[id]/route.ts": {
    boundary: "user_request_synchronous",
    entrypoints: ["/api/elevenlabs/voices/verify/:id"],
    rationale:
      "Voice verification synthesizes an ElevenLabs sample after database-backed auth.",
  },
  "packages/cloud/api/fal/proxy/route.ts": {
    boundary: "user_request_synchronous",
    entrypoints: ["/api/fal/proxy"],
    rationale:
      "The generic fal mutation proxy still uses a synchronous credit reservation.",
  },
  "packages/cloud/api/v1/apps/[id]/chat/route.ts": {
    boundary: "cache_admission",
    entrypoints: ["/api/v1/apps/:id/chat"],
    rationale:
      "App chat uses cached identity/app policy and deferred app admission before dispatch.",
  },
  "packages/cloud/api/v1/apps/[id]/generate-image/route.ts": {
    boundary: "user_request_synchronous",
    entrypoints: ["/api/v1/apps/:id/generate-image"],
    rationale:
      "App image generation still performs database auth and app-credit debit inline.",
  },
  "packages/cloud/api/v1/chat/completions/route.ts": {
    boundary: "cache_admission",
    entrypoints: ["/api/v1/chat/completions", "/api/v1/responses"],
    rationale:
      "Canonical OpenAI-compatible text inference uses cached auth and DO dispatch.",
  },
  "packages/cloud/api/v1/chat/route.ts": {
    boundary: "cache_admission",
    entrypoints: ["/api/v1/chat"],
    rationale:
      "Dashboard chat uses cached auth/anonymous policy and serialized admission.",
  },
  "packages/cloud/api/v1/embeddings/route.ts": {
    boundary: "cache_admission",
    entrypoints: ["/api/v1/embeddings"],
    rationale:
      "Embedding inference uses cached auth and the organization admission DO.",
  },
  "packages/cloud/api/v1/generate-image/route.ts": {
    boundary: "user_request_synchronous",
    entrypoints: ["/api/v1/generate-image"],
    rationale:
      "Image generation still reserves organization credits synchronously.",
  },
  "packages/cloud/api/v1/generate-music/route.ts": {
    boundary: "user_request_synchronous",
    entrypoints: ["/api/v1/generate-music"],
    rationale:
      "Music generation still reserves organization credits synchronously.",
  },
  "packages/cloud/api/v1/generate-prompts/route.ts": {
    boundary: "cache_admission",
    entrypoints: ["/api/v1/generate-prompts"],
    rationale:
      "Prompt suggestions use cached auth and the organization admission DO.",
  },
  "packages/cloud/api/v1/generate-sfx/route.ts": {
    boundary: "user_request_synchronous",
    entrypoints: ["/api/v1/generate-sfx"],
    rationale:
      "Sound-effect generation still reserves organization credits synchronously.",
  },
  "packages/cloud/api/v1/generate-video/route.ts": {
    boundary: "user_request_synchronous",
    entrypoints: ["/api/v1/generate-video"],
    rationale:
      "Video generation still reserves organization credits synchronously.",
  },
  "packages/cloud/api/v1/messages/route.ts": {
    boundary: "cache_admission",
    entrypoints: ["/api/v1/messages"],
    rationale:
      "Anthropic-compatible text inference uses cached auth and DO dispatch.",
  },
  "packages/cloud/api/v1/voice/clone/route.ts": {
    boundary: "user_request_synchronous",
    entrypoints: ["/api/v1/voice/clone"],
    rationale:
      "Voice cloning still authenticates, prices, and reserves through database services.",
  },
  "packages/cloud/api/v1/voice/session/ws/route.ts": {
    boundary: "user_request_synchronous",
    entrypoints: ["/api/v1/voice/session/ws"],
    rationale:
      "Realtime voice uses Redis token/revocation checks before opening provider sockets.",
  },
  "packages/cloud/api/v1/voice/session/lib/provider-socket-factory.ts": {
    boundary: "provider_adapter",
    entrypoints: ["/api/v1/voice/session/ws"],
    rationale:
      "The Worker transport opens authenticated Deepgram and Cartesia provider sockets.",
  },
  "packages/cloud/api/v1/voice/stt/providers/deepgram-flux.ts": {
    boundary: "provider_adapter",
    entrypoints: ["/api/v1/voice/session/ws"],
    rationale:
      "Deepgram Flux adapter opens the realtime transcription provider socket.",
  },
  "packages/cloud/api/v1/voice/stt/route.ts": {
    boundary: "user_request_synchronous",
    entrypoints: ["/api/v1/voice/stt", "/api/elevenlabs/stt"],
    rationale:
      "Batch transcription still authenticates and reserves through database services.",
  },
  "packages/cloud/api/v1/voice/tts/cartesia-synthesis.ts": {
    boundary: "provider_adapter",
    entrypoints: ["/api/v1/voice/tts"],
    rationale:
      "The batch Cartesia adapter sends authenticated synthesis requests.",
  },
  "packages/cloud/api/v1/voice/tts/route.ts": {
    boundary: "user_request_synchronous",
    entrypoints: ["/api/v1/voice/tts", "/api/elevenlabs/tts"],
    rationale:
      "Speech synthesis still authenticates and reserves through database services.",
  },
  "packages/cloud/shared/src/lib/api/a2a/skills.ts": {
    boundary: "latent_unwired",
    entrypoints: [
      "Exported cloud-shared A2A skill API; no registered Worker route",
    ],
    rationale:
      "Legacy A2A text and image skills contain synchronous reservations but have no production route consumer.",
  },
  "packages/cloud/shared/src/lib/providers/_http.ts": {
    boundary: "provider_adapter",
    entrypoints: ["OpenAI-compatible provider transports"],
    rationale:
      "The common HTTP transport owns timeout, retry, and upstream error translation.",
  },
  "packages/cloud/shared/src/lib/providers/anthropic-direct.ts": {
    boundary: "provider_adapter",
    entrypoints: ["/api/v1/chat/completions", "/api/v1/messages"],
    rationale:
      "The Anthropic fallback forwards admitted text requests to the direct API.",
  },
  "packages/cloud/shared/src/lib/providers/audio/elevenlabs-audio-generation.ts":
    {
      boundary: "provider_adapter",
      entrypoints: ["/api/v1/generate-music", "/api/v1/generate-sfx"],
      rationale:
        "The ElevenLabs audio adapter sends music and sound-effect generation requests.",
    },
  "packages/cloud/shared/src/lib/providers/audio/fal-audio-generation.ts": {
    boundary: "provider_adapter",
    entrypoints: ["/api/v1/generate-music", "/api/v1/generate-sfx"],
    rationale:
      "The fal audio adapter submits and polls long-running generation requests.",
  },
  "packages/cloud/shared/src/lib/providers/audio/suno-audio-generation.ts": {
    boundary: "provider_adapter",
    entrypoints: ["/api/v1/generate-music"],
    rationale:
      "The Suno adapter sends authenticated music generation requests.",
  },
  "packages/cloud/shared/src/lib/providers/cerebras-direct.ts": {
    boundary: "provider_adapter",
    entrypoints: [
      "/api/v1/chat",
      "/api/v1/chat/completions",
      "/api/v1/messages",
    ],
    rationale:
      "The Cerebras fallback forwards admitted text requests to the direct API.",
  },
  "packages/cloud/shared/src/lib/providers/fal-queue.ts": {
    boundary: "provider_adapter",
    entrypoints: ["/api/v1/generate-music", "/api/v1/generate-sfx"],
    rationale:
      "The shared fal queue client owns authenticated submit, status, and result requests.",
  },
  "packages/cloud/shared/src/lib/providers/groq.ts": {
    boundary: "provider_adapter",
    entrypoints: [
      "/api/v1/chat",
      "/api/v1/chat/completions",
      "/api/v1/messages",
    ],
    rationale:
      "The Groq provider forwards model requests and catalog reads to the direct API.",
  },
  "packages/cloud/shared/src/lib/providers/image/atlascloud-image-generation.ts":
    {
      boundary: "provider_adapter",
      entrypoints: [
        "/api/v1/generate-image",
        "/api/v1/apps/:id/generate-image",
      ],
      rationale:
        "The AtlasCloud image adapter submits and polls authenticated generation jobs.",
    },
  "packages/cloud/shared/src/lib/providers/image/fal-image-generation.ts": {
    boundary: "provider_adapter",
    entrypoints: ["/api/v1/generate-image", "/api/v1/apps/:id/generate-image"],
    rationale:
      "The fal image adapter submits generation and downloads the resulting image.",
  },
  "packages/cloud/shared/src/lib/providers/language-model.ts": {
    boundary: "provider_adapter",
    entrypoints: [
      "/api/v1/chat",
      "/api/v1/chat/completions",
      "/api/v1/messages",
    ],
    rationale:
      "The AI SDK language-model registry constructs configured upstream clients.",
  },
  "packages/cloud/shared/src/lib/providers/openai-direct.ts": {
    boundary: "provider_adapter",
    entrypoints: ["/api/v1/chat/completions", "/api/v1/embeddings"],
    rationale:
      "The OpenAI fallback forwards admitted text and embedding requests directly.",
  },
  "packages/cloud/shared/src/lib/providers/openrouter.ts": {
    boundary: "provider_adapter",
    entrypoints: ["/api/v1/chat/completions", "/api/v1/embeddings"],
    rationale:
      "The OpenRouter fallback forwards admitted requests with bounded provider retry.",
  },
  "packages/cloud/shared/src/lib/providers/vast.ts": {
    boundary: "provider_adapter",
    entrypoints: ["/api/v1/chat/completions"],
    rationale:
      "The Vast adapter forwards admitted requests to the selected serverless model.",
  },
  "packages/cloud/shared/src/lib/providers/vercel-ai-gateway.ts": {
    boundary: "provider_adapter",
    entrypoints: ["/api/v1/chat/completions", "/api/v1/messages"],
    rationale:
      "The Vercel AI Gateway adapter forwards admitted requests through the gateway SDK.",
  },
  "packages/cloud/shared/src/lib/providers/video/atlascloud-video-generation.ts":
    {
      boundary: "provider_adapter",
      entrypoints: ["/api/v1/generate-video"],
      rationale:
        "The AtlasCloud video adapter submits and polls authenticated generation jobs.",
    },
  "packages/cloud/shared/src/lib/providers/video/fal-video-generation.ts": {
    boundary: "provider_adapter",
    entrypoints: ["/api/v1/generate-video"],
    rationale:
      "The fal video adapter submits, polls, and resolves generated video jobs.",
  },
  "packages/cloud/shared/src/lib/services/app-promotion-assets.ts": {
    boundary: "user_request_synchronous",
    entrypoints: ["/api/v1/apps/:id/promote/assets"],
    rationale:
      "Promotion image/copy generation is reached from an owner request after DB checks.",
  },
  "packages/cloud/shared/src/lib/services/app-promotion.ts": {
    boundary: "user_request_synchronous",
    entrypoints: ["/api/v1/apps/:id/promote"],
    rationale:
      "Promotion copy generation is reached from an owner request after DB checks.",
  },
  "packages/cloud/shared/src/lib/services/app-review.ts": {
    boundary: "platform_policy",
    entrypoints: ["/api/v1/apps/:id/review"],
    rationale:
      "The platform-funded compliance classifier is rate-limited but not user-billed.",
  },
  "packages/cloud/shared/src/lib/services/content-moderation.ts": {
    boundary: "platform_policy",
    entrypoints: [
      "/api/v1/chat",
      "/api/v1/chat/completions",
      "/api/v1/messages",
    ],
    rationale:
      "OpenAI moderation is a platform policy control and normally runs off response.",
  },
  "packages/cloud/shared/src/lib/services/content-safety.ts": {
    boundary: "platform_policy",
    entrypoints: [
      "/api/v1/generate-image",
      "/api/v1/generate-video",
      "/api/v1/generate-music",
      "/api/v1/generate-sfx",
      "/api/v1/voice/tts",
    ],
    rationale:
      "Generative-media safety screening is a platform policy control.",
  },
  "packages/cloud/shared/src/lib/services/cartesia-sonic-tts.ts": {
    boundary: "provider_adapter",
    entrypoints: ["/api/v1/voice/session/ws"],
    rationale:
      "The realtime Cartesia adapter owns the Sonic synthesis WebSocket protocol.",
  },
  "packages/cloud/shared/src/lib/services/discord-automation/app-automation.ts":
    {
      boundary: "user_request_synchronous",
      entrypoints: [
        "/api/v1/apps/:id/discord-automation/post",
        "/api/v1/apps/:id/promote/preview",
        "/api/cron/social-automation",
      ],
      rationale:
        "Discord copy generation is reachable from owner requests and scheduled automation.",
    },
  "packages/cloud/shared/src/lib/services/elevenlabs.ts": {
    boundary: "provider_adapter",
    entrypoints: [
      "/api/v1/voice/stt",
      "/api/v1/voice/tts",
      "/api/v1/voice/:id",
    ],
    rationale:
      "The ElevenLabs SDK adapter owns speech, transcription, and voice-management HTTP.",
  },
  "packages/cloud/shared/src/lib/services/eliza-app/connection-enforcement.ts":
    {
      boundary: "internal_background",
      entrypoints: ["eliza-app connection enforcement"],
      rationale:
        "Connection nudges are internal lifecycle work rather than caller-selected inference.",
    },
  "packages/cloud/shared/src/lib/services/eliza-app/onboarding-chat.ts": {
    boundary: "user_request_synchronous",
    entrypoints: ["/api/eliza-app/onboarding/chat"],
    rationale:
      "Public onboarding chat invokes a platform model after database-backed session work.",
  },
  "packages/cloud/shared/src/lib/services/memory.ts": {
    boundary: "internal_background",
    entrypoints: ["shared runtime memory summarization"],
    rationale: "Memory summarization is internal agent-runtime maintenance.",
  },
  "packages/cloud/shared/src/lib/services/provisioning-agent-chat.ts": {
    boundary: "user_request_synchronous",
    entrypoints: ["/api/eliza-app/provisioning-agent/chat"],
    rationale:
      "Provisioning chat invokes a platform model after database-backed session validation.",
  },
  "packages/cloud/shared/src/lib/services/room-title.ts": {
    boundary: "internal_background",
    entrypoints: ["conversation room-title generation"],
    rationale: "Room titles are generated as internal conversation metadata.",
  },
  "packages/cloud/shared/src/lib/services/seo.ts": {
    boundary: "user_request_synchronous",
    entrypoints: ["/api/v1/apps/:id/promote"],
    rationale:
      "SEO metadata generation runs inline when an owner launches app promotion.",
  },
  "packages/cloud/shared/src/lib/services/shared-runtime/run-shared-agent-turn.ts":
    {
      boundary: "shared_runtime_cache_admission",
      entrypoints: ["shared Eliza agent bridge"],
      rationale:
        "Shared-runtime turns receive the caller proof and mark the existing DO at dispatch.",
    },
  "packages/cloud/shared/src/lib/services/team-credential-pool/probe.ts": {
    boundary: "internal_background",
    entrypoints: ["team credential health probe"],
    rationale: "Credential probes are internal control-plane health checks.",
  },
  "packages/cloud/shared/src/lib/services/telegram-automation/app-automation.ts":
    {
      boundary: "user_request_synchronous",
      entrypoints: [
        "/api/v1/apps/:id/telegram-automation/post",
        "/api/v1/apps/:id/promote/preview",
        "/api/v1/telegram/webhook/:orgId",
        "/api/cron/social-automation",
      ],
      rationale:
        "Telegram copy generation is reachable from owner requests, webhooks, and automation.",
    },
  "packages/cloud/shared/src/lib/services/twitter-automation/app-automation.ts":
    {
      boundary: "user_request_synchronous",
      entrypoints: [
        "/api/v1/apps/:id/twitter-automation/post",
        "/api/v1/apps/:id/promote/preview",
        "/api/cron/social-automation",
      ],
      rationale:
        "Twitter copy generation is reachable from owner requests and scheduled automation.",
    },
} as const satisfies Record<string, ProviderDispatchInventoryEntry>;
