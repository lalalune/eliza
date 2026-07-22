/**
 * Canonical type definitions shared between the agent API server and the UI
 * client. These types describe the HTTP contract and must not contain
 * Node.js-only imports or React-specific code so they remain importable in
 * both environments.
 *
 * Previously each package held its own copy. The authoritative definitions
 * live here; agent and UI now import from @elizaos/shared.
 */

import type {
  TriggerConfig,
  TriggerKind,
  TriggerLastStatus,
  TriggerRunRecord,
  TriggerType,
  TriggerWakeMode,
  UUID,
} from "@elizaos/core";

// ── Agent automation mode ────────────────────────────────────────────────────

export type AgentAutomationMode = "connectors-only" | "full";

// ── Stream event types ────────────────────────────────────────────────────────

export type StreamEventType =
  | "agent_event"
  | "heartbeat_event"
  | "training_event";

export interface StreamEventEnvelope {
  type: StreamEventType;
  version: 1;
  eventId: string;
  ts: number;
  runId?: string;
  /** Per-event ordinal within an agent run (NOT the buffer sequence). */
  seq?: number;
  /**
   * Monotonic per-agent buffer sequence, mirroring the integer portion of
   * `eventId`. Used as the cursor for WS reconnect replay so a client can ask
   * the server to replay only events with `bufferSeq > lastApplied`. Optional
   * for backward compatibility with envelopes that predate the cursor.
   */
  bufferSeq?: number;
  stream?: string;
  sessionKey?: string;
  agentId?: string;
  roomId?: string | UUID;
  payload: unknown;
}

// ── Trigger API types ────────────────────────────────────────────────────────

export interface TriggerTaskMetadata {
  updatedAt?: number;
  updateInterval?: number;
  blocking?: boolean;
  trigger?: TriggerConfig;
  triggerRuns?: TriggerRunRecord[];
  [key: string]:
    | string
    | number
    | boolean
    | string[]
    | number[]
    | Record<string, string | number | boolean>
    | undefined
    | TriggerConfig
    | TriggerRunRecord[];
}

export interface TriggerSummary {
  id: UUID;
  taskId: UUID;
  displayName: string;
  instructions: string;
  triggerType: TriggerType;
  enabled: boolean;
  wakeMode: TriggerWakeMode;
  createdBy: string;
  timezone?: string;
  intervalMs?: number;
  scheduledAtIso?: string;
  cronExpression?: string;
  eventKind?: string;
  maxRuns?: number;
  runCount: number;
  nextRunAtMs?: number;
  lastRunAtIso?: string;
  lastStatus?: TriggerLastStatus;
  lastError?: string;
  updatedAt?: number;
  updateInterval?: number;
  kind?: TriggerKind;
  workflowId?: string;
  workflowName?: string;
}

export interface TriggerHealthSnapshot {
  triggersEnabled: boolean;
  activeTriggers: number;
  disabledTriggers: number;
  totalExecutions: number;
  totalFailures: number;
  totalSkipped: number;
  lastExecutionAt?: number;
}

export interface CreateTriggerRequest {
  displayName?: string;
  instructions?: string;
  triggerType?: TriggerType;
  wakeMode?: TriggerWakeMode;
  enabled?: boolean;
  createdBy?: string;
  timezone?: string;
  intervalMs?: number;
  scheduledAtIso?: string;
  cronExpression?: string;
  eventKind?: string;
  maxRuns?: number;
  kind?: TriggerKind;
  workflowId?: string;
  workflowName?: string;
}

export interface UpdateTriggerRequest {
  displayName?: string;
  instructions?: string;
  triggerType?: TriggerType;
  wakeMode?: TriggerWakeMode;
  enabled?: boolean;
  timezone?: string;
  intervalMs?: number;
  scheduledAtIso?: string;
  cronExpression?: string;
  eventKind?: string;
  maxRuns?: number;
  kind?: TriggerKind;
  workflowId?: string;
  workflowName?: string;
}

// ── Plugin param types ────────────────────────────────────────────────────────

export interface PluginParamDef {
  key: string;
  type: string;
  description: string;
  required: boolean;
  sensitive: boolean;
  default?: string;
  /** Predefined options for dropdown selection (e.g. model names). */
  options?: string[];
  /** Current value from process.env (masked if sensitive). */
  currentValue: string | null;
  /** Whether a value is currently set in the environment. */
  isSet: boolean;
}

// ── Database status types ─────────────────────────────────────────────────────

export interface DatabaseStatus {
  provider: string;
  connected: boolean;
  serverVersion: string | null;
  tableCount: number;
  pgliteDataDir: string | null;
  postgresHost: string | null;
}

export interface ConnectionTestResult {
  success: boolean;
  serverVersion: string | null;
  error: string | null;
  durationMs: number;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
}

export interface TableInfo {
  name: string;
  schema: string;
  rowCount: number;
  columns: ColumnInfo[];
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  durationMs: number;
}

// ── Runtime order types ───────────────────────────────────────────────────────

export interface RuntimeOrderItem {
  index: number;
  name: string;
  className: string;
  id: string | null;
}

export interface RuntimeServiceOrderItem {
  index: number;
  serviceType: string;
  count: number;
  instances: RuntimeOrderItem[];
}

// ── Log entry ────────────────────────────────────────────────────────────────

/** A single log line captured by the API server log buffer. */
export interface LogEntry {
  timestamp: number;
  level: string;
  message: string;
  source: string;
  tags: string[];
}

// ── Skill entry ───────────────────────────────────────────────────────────────

/** A skill surfaced by the skills API. */
export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  /** Set automatically when a scan report exists for this skill. */
  scanStatus?: "clean" | "warning" | "critical" | "blocked" | null;
}

// ── Agent startup diagnostics ─────────────────────────────────────────────────

/** Tracks agent restart / startup state surfaced by the status endpoint. */
export interface AgentStartupDiagnostics {
  phase: string;
  attempt: number;
  lastError?: string;
  lastErrorAt?: number;
  nextRetryAt?: number;
}

// ── Chat image attachment ─────────────────────────────────────────────────────

/** An image attachment sent with a chat message. */
export interface ChatImageAttachment {
  /** Base64-encoded image data (no data URL prefix). */
  data: string;
  mimeType: string;
  name: string;
  /**
   * Optional client-generated downscaled preview (base64, no prefix). Persisted
   * separately and surfaced as the attachment's `thumbnailUrl` so the chat tile
   * loads a small image while the full resolution opens in the lightbox.
   */
  thumbnail?: { data: string; mimeType: string };
}

/**
 * A chat attachment handed to the authenticated send boundary by a native
 * composer. The server materializes every variant into {@link ChatImageAttachment}
 * before message construction: remote URLs pass through the SSRF guard and all
 * bytes land in the existing content-addressed media store. A separate file id
 * or native-only store is deliberately unrepresentable.
 */
export type ChatAttachmentSource =
  | {
      source: "inline";
      mimeType: string;
      bytesBase64: string;
      name?: string;
    }
  | { source: "data-url"; dataUrl: string; name?: string }
  | { source: "remote"; url: string; mimeType?: string; name?: string }
  | { source: "stored"; url: string; mimeType?: string; name?: string };

/** Additive input accepted by chat sends from web and native composers. */
export type ChatAttachmentInput = ChatImageAttachment | ChatAttachmentSource;

/**
 * Durable proof that the chat boundary accepted one logical user turn. The
 * server only emits this after the user memory has been persisted; retries
 * carrying the same `clientMessageId` return the same `userMessageId`.
 */
export interface ChatSendReceipt {
  conversationId: string;
  clientMessageId: string;
  userMessageId: string;
}

/** Machine-readable reasons a renderer-side chat send can fail. */
export type ChatSendFailureReason =
  | "empty"
  | "command"
  | "conversation-unavailable"
  | "validation"
  | "transport"
  | "generation"
  | "missing-receipt"
  | "unknown";

/**
 * Truthful terminal result for one logical chat send. `accepted` always carries
 * a server-issued persistence receipt; interruption and failure are distinct so
 * native shells never infer success from an idempotency key or optimistic row.
 */
export type ChatSendResult =
  | {
      status: "accepted";
      receipt: ChatSendReceipt;
      /** Whether the assistant stream reached its terminal `done` frame. */
      completed: boolean;
    }
  | {
      status: "cancelled";
      conversationId: string | null;
      clientMessageId: string;
      message: string;
    }
  | {
      status: "failed";
      conversationId: string | null;
      clientMessageId: string;
      reason: ChatSendFailureReason;
      message: string;
      retryable: boolean;
    };
