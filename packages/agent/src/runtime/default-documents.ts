/**
 * Seeds a fixed set of bundled knowledge documents (Eliza overview, ELIZA
 * history, Eliza Cloud basics/monetization, and the per-topic help FAQ from
 * default-help-documents.ts) into the agent's `documents` and
 * `document_fragments` memory tables so retrieval works before a user adds any
 * knowledge. Ids are derived deterministically from agentId + document key and
 * seeding is idempotent: documents and fragments are created, updated in place
 * when their definition or version changes, and stale fragments are pruned.
 * Fragment embeddings are reused when unchanged or computed on demand.
 */
import path from "node:path";
import {
  type AgentRuntime,
  logger,
  type Memory,
  MemoryType,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { HELP_DOCUMENTS } from "./default-help-documents";

const DOCUMENT_BATCH_SIZE = 100;
const DEFAULT_DOCUMENTS_SOURCE = "eliza-default-documents";
const DOCUMENTS_TABLE = "documents";
const DOCUMENT_FRAGMENTS_TABLE = "document_fragments";

type SeededMemory = Memory & { id: UUID };

export interface DefaultDocumentFragmentDefinition {
  text: string;
  embedding?: number[];
}

export interface DefaultDocumentDefinition {
  key: string;
  version: number;
  filename: string;
  contentType: string;
  text: string;
  fragments: readonly DefaultDocumentFragmentDefinition[];
  metadata?: Record<string, unknown>;
}

export const ELIZA_OVERVIEW_TEXT =
  "Eliza is an autonomous agent powered by elizaOS, the agent framework. Users can ask Eliza to write code, add new skills, and run recurring workflows on scheduled triggers. Eliza Cloud is an open source cloud backend that simplifies deploying and delivering Eliza.";

export const ELIZA_HISTORY_TEXT =
  "ELIZA was created by Joseph Weizenbaum at MIT in the mid-1960s and is widely regarded as one of the earliest chatbots. Its best-known script, DOCTOR, used pattern matching to imitate a Rogerian psychotherapist and showed how simple language rules could feel surprisingly conversational. ELIZA helped define the history of chatbots and influenced later work on conversational agents.";

export const ELIZA_CLOUD_BASICS_TEXT =
  "Eliza Cloud is the managed backend and app platform for Eliza and Eliza when cloud mode is enabled. Builders can create and manage apps, keep an appId, use Cloud login and redirect flows so app users can authenticate against Cloud, route chat and media through Cloud, monetize app usage with inference markup and purchase-share settings, promote apps, connect payment requests, and deploy Docker containers when an app needs server-side execution.";

export const ELIZA_CLOUD_MONETIZATION_TEXT =
  "Eliza and Eliza can help builders make money with Cloud apps: create monetized apps, set inference markup and app-credit purchase share, send payment requests through Stripe/OxaPay app credits or x402 crypto payments, track whether requests were paid, route payment results back into the initiating conversation, earn from affiliate and creator revenue-share flows, and request admin-reviewed elizaOS token payouts on Base, BSC, Ethereum, or Solana. Paid actions require explicit user confirmation.";

/**
 * Help fold-in (#13377 / #13595 slice 3): the former standalone Help view's Q&A
 * is seeded as `help`-tagged default knowledge so asking for help in chat
 * retrieves it through normal knowledge search (SEARCH_KNOWLEDGE / the hub's
 * `help` tag filter) instead of a bespoke Help screen. Each entry stays short
 * (2-4 sentences), jargon-light, and mirrors the plain-language answers a new
 * user actually asks. The `help` tag is what the retired `/help` deep-link
 * redirect filters on.
 */
export const HELP_KNOWLEDGE_TAG = "help";

export const HELP_GETTING_STARTED_TEXT =
  "Eliza is your personal AI agent. It chats with you by text or voice, can run on your own device or in the cloud, and can do real work: answer questions, manage tasks, use connected apps, and control its own screens. You drive all of it through one chat that floats over every view. To get started, just say hi in the chat and tell it what you want, or take the built-in tour from Help. The glowing pill at the bottom is that always-available chat: click it to open, and it stays with you as you move between screens.";

export const HELP_CHAT_NAVIGATION_TEXT =
  "The chat floats over every screen. Open or close it with the pill at the bottom, and it keeps your conversation as you switch views. You can move around the app just by talking to it: ask to open Settings, Skills, Documents, or any view and Eliza navigates there for you. You can also click the navigation to switch screens manually. To reach Settings, ask for it in chat or open it from the menu.";

export const HELP_AI_MODELS_TEXT =
  "You choose which AI model powers Eliza in Settings under the AI model section. Eliza can use a hosted cloud model or run a model on your own device for fully offline, local inference. If you are unsure which to pick, a hosted model is the easiest to start with and a local model is best when you want everything to stay on your machine. You can switch at any time.";

export const HELP_PRIVACY_TEXT =
  "Your data can stay local. Eliza can run on your own device with your conversations and knowledge stored locally, use a cloud backend when you opt in, or connect to a remote server you point it at. Local keeps everything on your machine; cloud adds managed hosting and app features; remote connects to a server you control. You decide which mode to use, and paid or third-party actions always ask for your confirmation first.";

export const HELP_VOICE_TEXT =
  "You can talk to Eliza by voice as well as text. Turn voice on and pick a voice in Settings, then use the microphone in the chat to speak. If voice is not working, check that your browser or device has microphone permission, that a voice is selected, and that your audio output is not muted.";

export const HELP_CONNECTORS_TEXT =
  "Connectors link Eliza to outside apps like Discord, Telegram, and Slack so it can send and receive messages there. You add and manage them from the connectors area: pick the app, follow the connect flow to authorize it, and Eliza can then operate in that app. Each connector is opt-in and can be disconnected at any time.";

export const HELP_ELIZA_CLOUD_TEXT =
  "Eliza Cloud is the managed backend and app platform for Eliza. It lets builders create and manage apps, route chat and media through the cloud, monetize app usage, and deploy server-side containers. You do not have to use Cloud to use Eliza, but logging in to Cloud unlocks the app platform and cloud-hosted features. To log in, use the Cloud login flow from Settings or when an app prompts you.";

export const HELP_WHAT_ELIZA_CAN_DO_TEXT =
  "Eliza can answer questions, manage tasks and reminders, search and use your knowledge and documents, control the app's own screens, run recurring workflows on a schedule, and act inside connected apps. Skills are add-on capabilities you can enable to give it new abilities. The Launcher is where you start apps and tools. Just ask in chat and Eliza will use whatever it needs to help.";

export const HELP_TROUBLESHOOTING_TEXT =
  "If Eliza is not responding, check that a model is selected and reachable in Settings and that your connection is up, then try sending your message again. Slow startup usually means a model or backend is still loading; give it a moment on first launch. To start fresh you can reset from Settings. You can replay the interactive tutorial any time from Help.";

export const DEFAULT_DOCUMENTS: readonly DefaultDocumentDefinition[] = [
  {
    key: "eliza-overview",
    version: 1,
    filename: "eliza-overview.txt",
    contentType: "text/plain",
    text: ELIZA_OVERVIEW_TEXT,
    fragments: [
      {
        text: ELIZA_OVERVIEW_TEXT,
      },
    ],
  },
  {
    key: "eliza-history",
    version: 1,
    filename: "eliza-history.txt",
    contentType: "text/plain",
    text: ELIZA_HISTORY_TEXT,
    fragments: [
      {
        text: ELIZA_HISTORY_TEXT,
      },
    ],
  },
  {
    key: "eliza-cloud-basics",
    version: 2,
    filename: "eliza-cloud-basics.txt",
    contentType: "text/plain",
    text: ELIZA_CLOUD_BASICS_TEXT,
    fragments: [
      {
        text: ELIZA_CLOUD_BASICS_TEXT,
      },
    ],
  },
  {
    key: "eliza-cloud-monetization",
    version: 1,
    filename: "eliza-cloud-monetization.txt",
    contentType: "text/plain",
    text: ELIZA_CLOUD_MONETIZATION_TEXT,
    fragments: [
      {
        text: ELIZA_CLOUD_MONETIZATION_TEXT,
      },
    ],
  },
<<<<<<< HEAD
  // Help fold-in (#13377): former Help view content as help-tagged knowledge.
  {
    key: "help-getting-started",
    version: 1,
    filename: "help-getting-started.txt",
    contentType: "text/plain",
    text: HELP_GETTING_STARTED_TEXT,
    fragments: [{ text: HELP_GETTING_STARTED_TEXT }],
    metadata: { tags: [HELP_KNOWLEDGE_TAG], helpCategory: "Getting started" },
  },
  {
    key: "help-chat-navigation",
    version: 1,
    filename: "help-chat-navigation.txt",
    contentType: "text/plain",
    text: HELP_CHAT_NAVIGATION_TEXT,
    fragments: [{ text: HELP_CHAT_NAVIGATION_TEXT }],
    metadata: { tags: [HELP_KNOWLEDGE_TAG], helpCategory: "Chat & navigation" },
  },
  {
    key: "help-ai-models",
    version: 1,
    filename: "help-ai-models.txt",
    contentType: "text/plain",
    text: HELP_AI_MODELS_TEXT,
    fragments: [{ text: HELP_AI_MODELS_TEXT }],
    metadata: { tags: [HELP_KNOWLEDGE_TAG], helpCategory: "AI models" },
  },
  {
    key: "help-privacy-data",
    version: 1,
    filename: "help-privacy-data.txt",
    contentType: "text/plain",
    text: HELP_PRIVACY_TEXT,
    fragments: [{ text: HELP_PRIVACY_TEXT }],
    metadata: { tags: [HELP_KNOWLEDGE_TAG], helpCategory: "Privacy & data" },
  },
  {
    key: "help-voice",
    version: 1,
    filename: "help-voice.txt",
    contentType: "text/plain",
    text: HELP_VOICE_TEXT,
    fragments: [{ text: HELP_VOICE_TEXT }],
    metadata: { tags: [HELP_KNOWLEDGE_TAG], helpCategory: "Voice" },
  },
  {
    key: "help-connectors",
    version: 1,
    filename: "help-connectors.txt",
    contentType: "text/plain",
    text: HELP_CONNECTORS_TEXT,
    fragments: [{ text: HELP_CONNECTORS_TEXT }],
    metadata: { tags: [HELP_KNOWLEDGE_TAG], helpCategory: "Connecting apps" },
  },
  {
    key: "help-eliza-cloud",
    version: 1,
    filename: "help-eliza-cloud.txt",
    contentType: "text/plain",
    text: HELP_ELIZA_CLOUD_TEXT,
    fragments: [{ text: HELP_ELIZA_CLOUD_TEXT }],
    metadata: { tags: [HELP_KNOWLEDGE_TAG], helpCategory: "Eliza Cloud" },
  },
  {
    key: "help-what-eliza-can-do",
    version: 1,
    filename: "help-what-eliza-can-do.txt",
    contentType: "text/plain",
    text: HELP_WHAT_ELIZA_CAN_DO_TEXT,
    fragments: [{ text: HELP_WHAT_ELIZA_CAN_DO_TEXT }],
    metadata: { tags: [HELP_KNOWLEDGE_TAG], helpCategory: "What Eliza can do" },
  },
  {
    key: "help-troubleshooting",
    version: 1,
    filename: "help-troubleshooting.txt",
    contentType: "text/plain",
    text: HELP_TROUBLESHOOTING_TEXT,
    fragments: [{ text: HELP_TROUBLESHOOTING_TEXT }],
    metadata: { tags: [HELP_KNOWLEDGE_TAG], helpCategory: "Troubleshooting" },
  },
=======
  // The app help FAQ — the chat is the help surface, so "how do I…" answers
  // ship as retrievable knowledge instead of a dedicated Help view.
  ...HELP_DOCUMENTS,
>>>>>>> origin/develop
];

function getDocumentId(agentId: UUID, key: string): UUID {
  return stringToUuid(`eliza-default-knowledge:${agentId}:${key}:document`);
}

function getFragmentId(agentId: UUID, key: string, index: number): UUID {
  return stringToUuid(
    `eliza-default-knowledge:${agentId}:${key}:fragment:${index}`,
  );
}

function getExpectedEmbeddingDimensions(
  runtime: AgentRuntime,
): number | undefined {
  const raw = runtime.getSetting("EMBEDDING_DIMENSION");
  const parsed =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number.parseInt(raw, 10)
        : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeProvidedEmbedding(
  runtime: AgentRuntime,
  document: DefaultDocumentDefinition,
  index: number,
  embedding: readonly number[] | undefined,
): number[] | undefined {
  if (!embedding || embedding.length === 0) {
    return undefined;
  }

  if (!embedding.every((value) => Number.isFinite(value))) {
    logger.warn(
      `[eliza] Ignoring bundled document embedding for ${document.filename} fragment ${index}: vector contains non-finite values.`,
    );
    return undefined;
  }

  const expectedDimensions = getExpectedEmbeddingDimensions(runtime);
  if (
    expectedDimensions !== undefined &&
    embedding.length !== expectedDimensions
  ) {
    logger.warn(
      `[eliza] Ignoring bundled document embedding for ${document.filename} fragment ${index}: expected ${expectedDimensions} dimensions, received ${embedding.length}.`,
    );
    return undefined;
  }

  return [...embedding];
}

function extractTimestamp(memory: Memory | null): number {
  const metadata = memory?.metadata as Record<string, unknown> | undefined;
  const timestamp = metadata?.timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp)
    ? timestamp
    : Date.now();
}

function buildDocumentMetadata(
  document: DefaultDocumentDefinition,
  documentId: UUID,
  agentId: UUID,
  timestamp: number,
): Record<string, unknown> {
  const parsed = path.parse(document.filename);

  return {
    type: MemoryType.DOCUMENT,
    documentId,
    filename: document.filename,
    originalFilename: document.filename,
    title: parsed.name || document.filename,
    fileExt: parsed.ext.replace(/^\./, ""),
    fileType: document.contentType,
    contentType: document.contentType,
    fileSize: Buffer.byteLength(document.text, "utf8"),
    source: DEFAULT_DOCUMENTS_SOURCE,
    timestamp,
    scope: "global",
    scopedToEntityId: undefined,
    addedBy: agentId,
    addedByRole: "RUNTIME",
    addedFrom: "default-seed",
    addedAt: timestamp,
    bundledDocument: true,
    bundledDocumentKey: document.key,
    bundledDocumentVersion: document.version,
    ...(document.metadata ?? {}),
  };
}

function buildFragmentMetadata(
  document: DefaultDocumentDefinition,
  documentId: UUID,
  _documentAgentId: UUID,
  index: number,
  agentId: UUID,
  timestamp: number,
): Record<string, unknown> {
  return {
    type: MemoryType.FRAGMENT,
    documentId,
    position: index,
    source: DEFAULT_DOCUMENTS_SOURCE,
    timestamp,
    scope: "global",
    scopedToEntityId: undefined,
    addedBy: agentId,
    addedByRole: "RUNTIME",
    addedFrom: "default-seed",
    addedAt: timestamp,
    bundledDocument: true,
    bundledDocumentKey: document.key,
    bundledDocumentVersion: document.version,
  };
}

function embeddingsEqual(
  left: readonly number[] | undefined,
  right: readonly number[] | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function documentMatchesDefinition(
  existing: Memory | null,
  document: DefaultDocumentDefinition,
  documentId: UUID,
): boolean {
  if (!existing) return false;

  const metadata = existing.metadata as Record<string, unknown> | undefined;
  return (
    existing.content.text === document.text &&
    metadata?.type === MemoryType.DOCUMENT &&
    metadata.documentId === documentId &&
    metadata.filename === document.filename &&
    metadata.contentType === document.contentType &&
    metadata.bundledDocumentKey === document.key &&
    metadata.bundledDocumentVersion === document.version
  );
}

function fragmentMatchesDefinition(
  existing: Memory | null,
  document: DefaultDocumentDefinition,
  documentId: UUID,
  index: number,
  text: string,
  embedding: readonly number[] | undefined,
): boolean {
  if (!existing) return false;

  const metadata = existing.metadata as Record<string, unknown> | undefined;
  const existingEmbedding = Array.isArray(existing.embedding)
    ? existing.embedding
    : undefined;

  return (
    existing.content.text === text &&
    metadata?.type === MemoryType.FRAGMENT &&
    metadata.documentId === documentId &&
    metadata.position === index &&
    metadata.bundledDocumentKey === document.key &&
    metadata.bundledDocumentVersion === document.version &&
    embeddingsEqual(existingEmbedding, embedding)
  );
}

/**
 * List the ids of all document_fragments rows attached to a bundled document.
 *
 * Only ids and metadata are inspected, so embeddings are explicitly excluded
 * (`includeEmbedding: false`). Selecting them here forced the SQL adapter to
 * deserialize every pgvector embedding in the table on each boot, which on
 * self-hosted PGlite nodes pegged the main thread at 100% CPU and starved the
 * API before the agent finished starting.
 *
 * Pagination must use `offset` (skip N rows), not `start` (a createdAt
 * timestamp filter): passing the row offset as `start` re-scanned nearly the
 * whole table on every iteration and never advanced for documents with more
 * than one batch of fragments.
 *
 * Exported for tests.
 */
export async function listFragmentIdsForDocument(
  runtime: AgentRuntime,
  documentId: UUID,
): Promise<UUID[]> {
  const fragmentIds: UUID[] = [];
  let offset = 0;

  while (true) {
    const batch = await runtime.getMemories({
      tableName: DOCUMENT_FRAGMENTS_TABLE,
      roomId: runtime.agentId,
      limit: DOCUMENT_BATCH_SIZE,
      offset,
      includeEmbedding: false,
    });

    if (batch.length === 0) break;

    for (const memory of batch) {
      const metadata = memory.metadata as Record<string, unknown> | undefined;
      if (
        typeof memory.id === "string" &&
        metadata?.documentId === documentId
      ) {
        fragmentIds.push(memory.id as UUID);
      }
    }

    if (batch.length < DOCUMENT_BATCH_SIZE) break;
    offset += DOCUMENT_BATCH_SIZE;
  }

  return fragmentIds;
}

async function seedBundledDocument(
  runtime: AgentRuntime,
  document: DefaultDocumentDefinition,
): Promise<void> {
  const documentId = getDocumentId(runtime.agentId, document.key);
  const existingDocument = await runtime.getMemoryById(documentId);
  const documentTimestamp = extractTimestamp(existingDocument);
  const documentCreatedAt =
    typeof existingDocument?.createdAt === "number"
      ? existingDocument.createdAt
      : Date.now();

  const documentMemory: SeededMemory = {
    id: documentId,
    agentId: runtime.agentId,
    roomId: runtime.agentId,
    worldId: runtime.agentId,
    entityId: runtime.agentId,
    content: { text: document.text },
    metadata: buildDocumentMetadata(
      document,
      documentId,
      runtime.agentId,
      documentTimestamp,
    ),
    createdAt: documentCreatedAt,
  };

  let changed = false;

  if (!documentMatchesDefinition(existingDocument, document, documentId)) {
    if (existingDocument) {
      await runtime.updateMemory(documentMemory);
    } else {
      await runtime.createMemory(documentMemory, DOCUMENTS_TABLE);
    }
    changed = true;
  }

  const staleFragmentIds = new Set(
    await listFragmentIdsForDocument(runtime, documentId),
  );

  for (const [index, fragment] of document.fragments.entries()) {
    const fragmentId = getFragmentId(runtime.agentId, document.key, index);
    const existingFragment = await runtime.getMemoryById(fragmentId);
    const normalizedEmbedding = normalizeProvidedEmbedding(
      runtime,
      document,
      index,
      fragment.embedding,
    );
    const existingEmbedding =
      existingFragment?.content.text === fragment.text &&
      Array.isArray(existingFragment.embedding) &&
      existingFragment.embedding.length > 0
        ? [...existingFragment.embedding]
        : undefined;
    const fragmentEmbedding = normalizedEmbedding ?? existingEmbedding;
    const fragmentTimestamp = extractTimestamp(existingFragment);
    const fragmentCreatedAt =
      typeof existingFragment?.createdAt === "number"
        ? existingFragment.createdAt
        : Date.now();

    const fragmentMemory: SeededMemory = {
      id: fragmentId,
      agentId: runtime.agentId,
      roomId: runtime.agentId,
      worldId: runtime.agentId,
      entityId: runtime.agentId,
      content: { text: fragment.text },
      metadata: buildFragmentMetadata(
        document,
        documentId,
        runtime.agentId as UUID,
        index,
        runtime.agentId,
        fragmentTimestamp,
      ),
      ...(fragmentEmbedding ? { embedding: fragmentEmbedding } : {}),
      createdAt: fragmentCreatedAt,
    };

    if (!fragmentEmbedding) {
      await runtime.addEmbeddingToMemory(fragmentMemory);
    }

    if (
      !fragmentMatchesDefinition(
        existingFragment,
        document,
        documentId,
        index,
        fragment.text,
        fragmentMemory.embedding,
      )
    ) {
      if (existingFragment) {
        await runtime.updateMemory(fragmentMemory);
      } else {
        await runtime.createMemory(fragmentMemory, DOCUMENT_FRAGMENTS_TABLE);
      }
      changed = true;
    }

    staleFragmentIds.delete(fragmentId);
  }

  for (const fragmentId of staleFragmentIds) {
    await runtime.deleteMemory(fragmentId);
    changed = true;
  }

  if (changed) {
    logger.info(
      `[eliza] Seeded bundled document "${document.filename}" (${document.fragments.length} fragment${document.fragments.length === 1 ? "" : "s"}).`,
    );
  }
}

export async function seedBundledDocuments(
  runtime: AgentRuntime,
  documents: readonly DefaultDocumentDefinition[] = DEFAULT_DOCUMENTS,
): Promise<void> {
  for (const document of documents) {
    await seedBundledDocument(runtime, document);
  }
}
