/**
 * In-process workflow execution engine and persistence layer. A single
 * `Service` (type `embedded_workflow_service`) is simultaneously the CRUD store
 * for workflow definitions, credentials, tags, and revisions, and the runtime
 * that executes node graphs — there is no external sidecar or HTTP boundary.
 *
 * Node execution delegates to the Smithers orchestrator (see smithers-runtime);
 * sandboxed JS steps run through QuickJS via `evalQuickJsCode`. The service owns
 * the scheduler for cron/interval triggers (scheduling idempotency keys guard
 * against duplicate concurrent runs) and the webhook matcher that route handlers
 * dispatch inbound requests to. Persistence is Drizzle-over-Postgres against the
 * tables in ../db/schema; the trigger task-name/tag contract is mirrored from
 * `packages/agent` to avoid a dependency cycle.
 */
import { createHash, randomUUID } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import { arch, cpus, freemem, loadavg, platform, release, totalmem, uptime } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import {
  ChannelType,
  ElizaError,
  fetchWithSsrfGuard,
  type GuardedFetchOptions,
  type IAgentRuntime,
  logger,
  Service,
  stringToUuid,
  type Task,
  TRIGGER_SCHEMA_VERSION,
  type TriggerConfig,
  type UUID,
} from '@elizaos/core';
import { detectHostCapabilities, readAliasedEnv } from '@elizaos/shared';
import { and, desc, eq, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  embeddedCredentials,
  embeddedExecutions,
  embeddedTags,
  embeddedWorkflows,
  LEGACY_UNSCOPED_WORKFLOW_AGENT_ID,
  workflowRevisions,
} from '../db/schema';
import type {
  WorkflowCredential,
  WorkflowDefinition,
  WorkflowDefinitionResponse,
  WorkflowExecution,
  WorkflowExecutionContext,
  WorkflowNode,
  WorkflowRevision,
  WorkflowRevisionOperation,
  WorkflowTag,
} from '../types/index';
import { WorkflowApiError } from '../types/index';
import {
  readWorkflowExecutionContext,
  resolveCanonicalWorkflowOwnerTag,
  withWorkflowExecutionContext,
} from '../utils/context';
import {
  resolveSmithersTimeoutMs,
  runWorkflowWithSmithers,
  type SmithersExecutionPlan,
} from './smithers-runtime';
import {
  sanitizeWorkflowExecution,
  serializeWorkflowExecutionError,
  toSafeWorkflowExecutionError,
} from './workflow-execution-error';

export const EMBEDDED_WORKFLOW_SERVICE_TYPE = 'embedded_workflow_service';

/**
 * Task name + tag contract for scheduled workflow runs. Mirrored from
 * `packages/agent/src/triggers/runtime.ts` because plugin-workflow can't
 * import @elizaos/agent (would create a dep cycle). The agent's
 * `registerTriggerTaskWorker` consumes tasks with this name.
 */
export const TRIGGER_TASK_NAME = 'TRIGGER_DISPATCH';
export const TRIGGER_TASK_TAGS: readonly string[] = ['queue', 'repeat', 'trigger'];

/** Discriminator on TaskMetadata so the UI can route workflow tasks. */
export const WORKFLOW_TASK_KIND = 'workflow';

/** Stable tag used on every workflow-backed Task so we can list+delete them. */
const WORKFLOW_TASK_TAG = 'workflow';

/**
 * Legacy task names retained only for rehydration cleanup. `workflow.run`
 * was the prior scheduled-dispatch path; it bypassed `executeTriggerTask`
 * and accumulated no run history. `workflow.webhook` had no producer and
 * was dead from the start. Both are migrated/removed on service start.
 */
const LEGACY_WORKFLOW_RUN_TASK_NAME = 'workflow.run';
const LEGACY_WORKFLOW_WEBHOOK_TASK_NAME = 'workflow.webhook';

const CLOUD_EXECUTION_TIER_SETTING = 'ELIZA_CLOUD_EXECUTION_TIER';
const CLOUD_PROVISIONED_SETTING = 'ELIZA_CLOUD_PROVISIONED';
const DEDICATED_LAZY_EXECUTION_TIER = 'dedicated-lazy';
const SCHEDULE_TRIGGER_NODE_TYPE = 'workflows-nodes-base.scheduleTrigger';
const WORKFLOW_OWNER_TAG_MIGRATION_REQUIRED_CODE = 'WORKFLOW_OWNER_TAG_MIGRATION_REQUIRED';

// Workflow node output is persisted and can also enter later model context, so
// one public endpoint must not be able to consume the agent process's memory.
const WORKFLOW_HTTP_MAX_RESPONSE_BYTES = 1_048_576;

type WorkflowExecuteMode = WorkflowExecution['mode'];

interface INodeExecutionData {
  json: Record<string, unknown>;
  binary?: Record<string, unknown>;
  pairedItem?: { item: number } | Array<{ item: number }>;
}

interface IExecuteFunctions {
  getInputData(inputIndex?: number): INodeExecutionData[];
  getNode(): WorkflowNode;
  /** Agent runtime, present when the workflow runs inside an EmbeddedWorkflowService.
   *  Nodes that need to interact with the agent (e.g. respondToEvent injecting a
   *  memory into the autonomy room) read it from here. Optional because some
   *  nodes are pure data transforms and never touch the runtime. */
  getRuntime?(): IAgentRuntime | null;
  /** Identifier of the in-progress workflow execution, used by nodes that emit
   *  audit metadata (e.g. respondToEvent records it on the injected memory). */
  getExecutionId?(): string | null;
  /** Trusted owner/chat routing captured when the execution was admitted. */
  getExecutionContext?(): WorkflowExecutionContext | undefined;
  /** Cancellation from the Smithers run boundary. Network and wait nodes use
   * this to stop before a timed-out execution can produce late side effects. */
  getAbortSignal?(): AbortSignal;
}

interface NodeCapabilities {
  requiresFs?: boolean;
  requiresInbound?: boolean;
  requiresLongRunning?: boolean;
  requiresChildProcess?: boolean;
  requiresNet?: boolean;
}

interface INodeTypeDescription {
  displayName: string;
  name: string;
  group: string[];
  version: number | number[];
  description: string;
  defaults: { name: string };
  inputs: unknown[];
  outputs: unknown[];
  properties: unknown[];
  capabilities?: NodeCapabilities;
}

interface INodeType {
  description: INodeTypeDescription;
  execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]>;
  trigger?(): Promise<unknown>;
}

interface INodeTypes {
  getByName(nodeType: string): INodeType;
  getByNameAndVersion(nodeType: string): INodeType;
  getKnownTypes(): Record<string, { sourcePath: string; className: string }>;
}

interface StoredCredential extends WorkflowCredential {
  data?: Record<string, unknown>;
}

interface StoredWorkflowRow {
  workflow: WorkflowDefinition;
  createdAt: string;
  updatedAt: string;
  versionId: string;
}

interface StoredWorkflowRevisionRow extends StoredWorkflowRow {
  id: string;
  workflowId: string;
  capturedAt: string;
  operation: WorkflowRevisionOperation;
}

interface ExecuteOptions {
  mode?: WorkflowExecuteMode;
  /**
   * Optional payload to seed the start node's first item. Used by the
   * dispatch service to forward event-bridge data (e.g. `{eventKind,
   * eventPayload}`) into trigger-mode workflows so `respondToEvent` and
   * other nodes can read upstream context. Ignored when empty.
   */
  triggerData?: Record<string, unknown>;
  /**
   * Optional idempotency key. The service atomically claims the key with a
   * durable pending row before execution, then returns that row to duplicate
   * callers (e.g. repeated delivery of one scheduled occurrence).
   */
  idempotencyKey?: string;
  /** Stable identity of the schedule node whose task fired. Omitted only for
   * explicit debug runs that intentionally exercise every schedule branch. */
  scheduleNodeId?: string;
  /** Server-resolved execution owner. Never read from trigger payload data. */
  ownerEntityId?: string;
  /** Conversation that originated the workflow or manual run. */
  sourceRoomId?: string;
  /**
   * When false, failed manual/debug runs are returned as persisted error
   * executions instead of being thrown away as route-level exceptions.
   */
  throwOnError?: boolean;
}

function resolveWorkflowExecutionContext(
  workflow: WorkflowDefinition,
  explicit?: WorkflowExecutionContext
): WorkflowExecutionContext | undefined {
  const stored = readWorkflowExecutionContext(workflow);
  const ownerEntityId = explicit?.ownerEntityId?.trim() || stored?.ownerEntityId;
  const sourceRoomId = explicit?.sourceRoomId?.trim() || stored?.sourceRoomId;
  return ownerEntityId || sourceRoomId ? { ownerEntityId, sourceRoomId } : undefined;
}

function readPendingExecutionContext(
  execution: WorkflowExecution
): WorkflowExecutionContext | undefined {
  const ownerEntityId =
    typeof execution.customData?.ownerEntityId === 'string' &&
    execution.customData.ownerEntityId.trim()
      ? execution.customData.ownerEntityId.trim()
      : undefined;
  const sourceRoomId =
    typeof execution.customData?.sourceRoomId === 'string' &&
    execution.customData.sourceRoomId.trim()
      ? execution.customData.sourceRoomId.trim()
      : undefined;
  return ownerEntityId || sourceRoomId ? { ownerEntityId, sourceRoomId } : undefined;
}

export interface WorkflowExecutionClaimResult {
  execution: WorkflowExecution;
  dedup: boolean;
}

const SMITHERS_RESUME_STATE_KEY = 'smithersResumeState';

interface SmithersResumeState {
  version: 1;
  workflow: WorkflowDefinition;
}

interface ExecutionCursor {
  version: 1;
  startedAt: string;
  id: string;
}

interface IncomingConnection {
  source: string;
  sourceOutputIndex: number;
  destinationInputIndex: number;
}

const EMBEDDED_HOST = 'embedded://local';
const DEFAULT_SCHEDULE_INTERVAL_MS = 60_000;
const EXECUTION_LEASE_HEARTBEAT_MS = 10_000;
const EXECUTION_RECOVERY_POLL_MS = 1_000;
const EXECUTION_RECOVERY_RETRY_MS = 30_000;
const EXECUTION_LEASE_DEADLINE_GRACE_MS = 30_000;
export const DEVICE_HEALTH_CHECK_WORKFLOW_ID = 'system-device-health-check';
const DEVICE_HEALTH_CHECK_RUN_KEY = `${DEVICE_HEALTH_CHECK_WORKFLOW_ID}:initial`;

type WorkflowHttpTransport = Pick<
  GuardedFetchOptions,
  'fetchImpl' | 'lookupFn' | 'pinnedFetchImpl' | 'policy'
>;

const workflowHttpTransportsForTests = new WeakMap<IAgentRuntime, WorkflowHttpTransport>();

/** Test seam for exercising the real SSRF guard with deterministic DNS and transport. */
export function __setWorkflowHttpTransportForTests(
  runtime: IAgentRuntime,
  transport: WorkflowHttpTransport | undefined
): void {
  if (transport) workflowHttpTransportsForTests.set(runtime, transport);
  else workflowHttpTransportsForTests.delete(runtime);
}

/**
 * Persistent, once-per-install marker recording that the default workflow was
 * already seeded on this device. Stored in the runtime cache so it survives
 * restarts. Its presence — independent of whether the workflow row still
 * exists — is what makes seeding respect a user deletion: once seeded, a
 * default the user later deletes is NEVER resurrected on a subsequent boot.
 * (Matching the LifeOps seed-registry's `eliza:scheduling:seeded-defaults:v1`
 * pattern so both consumers of the one clock seed the same way.)
 */
const DEFAULT_WORKFLOW_SEED_MARKER_CACHE_KEY = 'eliza:workflow:seeded-defaults:v1';

const WORKFLOW_AGENT_SCOPE_PRIMARY_KEYS = [
  'credential_mappings_tenant_pkey',
  'embedded_workflows_tenant_pkey',
  'workflow_revisions_tenant_pkey',
  'embedded_executions_tenant_pkey',
  'embedded_credentials_tenant_pkey',
  'embedded_tags_tenant_pkey',
] as const;

const WORKFLOW_AGENT_SCOPE_INDEXES = [
  'idx_credential_mappings_agent_user_cred',
  'idx_embedded_workflows_agent_active',
  'idx_embedded_workflows_agent_updated_at',
  'idx_workflow_revisions_agent_workflow_id',
  'idx_workflow_revisions_agent_workflow_version',
  'idx_workflow_revisions_agent_captured_at',
  'idx_embedded_executions_agent_workflow_id',
  'idx_embedded_executions_agent_status',
  'idx_embedded_executions_agent_started_at',
  'idx_embedded_executions_agent_idempotency_key',
  'idx_embedded_executions_agent_recovery_lease',
  'idx_embedded_credentials_agent_type',
  'idx_embedded_tags_agent_name',
] as const;

let loadedQuickJs: Promise<typeof import('quickjs-emscripten')> | null = null;

async function loadQuickJs(): Promise<typeof import('quickjs-emscripten')> {
  loadedQuickJs ??= import('quickjs-emscripten');
  return loadedQuickJs;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function nowIso(): string {
  return new Date().toISOString();
}

function waitForDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function encodeExecutionCursor(cursor: ExecutionCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeExecutionCursor(value: string): ExecutionCursor {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      !isRecord(decoded) ||
      decoded.version !== 1 ||
      typeof decoded.startedAt !== 'string' ||
      !Number.isFinite(Date.parse(decoded.startedAt)) ||
      typeof decoded.id !== 'string' ||
      decoded.id.length === 0
    ) {
      throw new Error('cursor payload is invalid');
    }
    return { version: 1, startedAt: decoded.startedAt, id: decoded.id };
  } catch (error) {
    // error-policy:J3 the cursor is untrusted input; malformed tokens produce
    // one explicit invalid request rather than silently restarting page one.
    throw new WorkflowApiError('Invalid workflow execution cursor', 400, error);
  }
}

function normalizeTagName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!normalized) throw new WorkflowApiError('Workflow tag name is required', 400);
  return normalized;
}

function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    Array.isArray(value.nodes) &&
    isRecord(value.connections)
  );
}

function readSmithersResumeWorkflow(execution: WorkflowExecution): WorkflowDefinition | undefined {
  const state = execution.customData?.[SMITHERS_RESUME_STATE_KEY];
  if (!isRecord(state) || state.version !== 1) return undefined;
  const workflow = state.workflow;
  return isWorkflowDefinition(workflow) ? cloneJson(workflow) : undefined;
}

function normalizeWorkflowPayload(
  workflow: WorkflowDefinition,
  id: string,
  active: boolean
): WorkflowDefinition {
  return {
    ...cloneJson(workflow),
    id,
    active,
    settings: {
      executionOrder: 'v1',
      ...(workflow.settings ?? {}),
    },
  };
}

function responseFromWorkflow(
  workflow: WorkflowDefinition,
  createdAt: string,
  updatedAt: string,
  versionId: string
): WorkflowDefinitionResponse {
  return {
    ...cloneJson(workflow),
    id: workflow.id ?? randomUUID(),
    createdAt,
    updatedAt,
    versionId,
  };
}

function revisionFromRow(row: StoredWorkflowRevisionRow): WorkflowRevision {
  return {
    id: row.id,
    workflowId: row.workflowId,
    versionId: row.versionId,
    name: row.workflow.name,
    active: row.workflow.active === true,
    workflow: cloneJson(row.workflow),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    capturedAt: row.capturedAt,
    operation: row.operation,
  };
}

function tagFromRow(row: {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}): WorkflowTag {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function bytesFromBlocks(blocks: number, blockSize: number): number {
  return Math.max(0, Math.floor(blocks * blockSize));
}

async function collectDeviceStatus(): Promise<Record<string, unknown>> {
  const disk = await statfs('/');
  const blockSize = Number(disk.bsize);
  const totalDiskBytes = bytesFromBlocks(Number(disk.blocks), blockSize);
  const freeDiskBytes = bytesFromBlocks(Number(disk.bfree), blockSize);
  const availableDiskBytes = bytesFromBlocks(Number(disk.bavail), blockSize);
  const totalMemoryBytes = totalmem();
  const freeMemoryBytes = freemem();

  return {
    checkedAt: nowIso(),
    runtime: {
      node: process.version,
      platform: platform(),
      arch: arch(),
      osRelease: release(),
      pid: process.pid,
      uptimeSeconds: Math.round(uptime()),
    },
    cpu: {
      cores: cpus().length,
      loadAverage: loadavg(),
    },
    memory: {
      totalBytes: totalMemoryBytes,
      freeBytes: freeMemoryBytes,
      usedBytes: Math.max(0, totalMemoryBytes - freeMemoryBytes),
      freeRatio: totalMemoryBytes > 0 ? freeMemoryBytes / totalMemoryBytes : null,
    },
    disk: {
      mount: '/',
      totalBytes: totalDiskBytes,
      freeBytes: freeDiskBytes,
      availableBytes: availableDiskBytes,
      usedBytes: Math.max(0, totalDiskBytes - freeDiskBytes),
      availableRatio: totalDiskBytes > 0 ? availableDiskBytes / totalDiskBytes : null,
    },
  };
}

function buildDeviceHealthCheckWorkflow(): WorkflowDefinition {
  return {
    id: DEVICE_HEALTH_CHECK_WORKFLOW_ID,
    name: 'Device health check',
    active: true,
    nodes: [
      {
        id: 'schedule',
        name: 'Hourly check',
        type: 'workflows-nodes-base.scheduleTrigger',
        typeVersion: 1.2,
        position: [0, 0],
        parameters: {
          intervalMs: 3_600_000,
        },
      },
      {
        id: 'device-status',
        name: 'Device Status',
        type: 'workflows-nodes-base.deviceStatus',
        typeVersion: 1,
        position: [240, 0],
        parameters: {},
      },
    ],
    connections: {
      'Hourly check': {
        main: [[{ node: 'Device Status', type: 'main', index: 0 }]],
      },
    },
    settings: {
      executionOrder: 'v1',
    },
    meta: {
      assumptions: [
        'Runs locally without model calls and records RAM, disk, CPU, and runtime facts.',
      ],
    },
  };
}

function shouldSeedDefaultWorkflows(runtime: IAgentRuntime): boolean {
  const raw = runtime.getSetting?.('WORKFLOW_SEED_DEFAULTS');
  // Managed Cloud has no authenticated owner at service startup. Seeding an
  // active schedule here would either invent one or create an ownerless task,
  // so Cloud starts empty and lets an authenticated user create the first row.
  return raw !== false && raw !== 'false' && !isManagedCloudRuntime(runtime);
}

function runtimeSetting(runtime: IAgentRuntime, key: string): unknown {
  const value = runtime.getSetting?.(key);
  return value === null || value === undefined || value === '' ? readAliasedEnv(key) : value;
}

function isEnabledSetting(value: unknown): boolean {
  return (
    value === true ||
    (typeof value === 'string' && ['1', 'true'].includes(value.trim().toLowerCase()))
  );
}

function isScaleToZeroCloudRuntime(runtime: IAgentRuntime): boolean {
  const executionTier = runtimeSetting(runtime, CLOUD_EXECUTION_TIER_SETTING);
  return (
    isManagedCloudRuntime(runtime) &&
    typeof executionTier === 'string' &&
    executionTier.trim().toLowerCase() === DEDICATED_LAZY_EXECUTION_TIER
  );
}

function hasEnabledScheduleTrigger(workflow: WorkflowDefinition): boolean {
  return workflow.nodes.some((node) => !node.disabled && node.type === SCHEDULE_TRIGGER_NODE_TYPE);
}

function workflowOwnerTagMigrationError(
  workflowId: string,
  reason: 'missing' | 'ambiguous'
): WorkflowApiError {
  const error =
    reason === 'ambiguous'
      ? 'Scheduled workflow has multiple canonical owner tags and cannot be migrated safely.'
      : 'Scheduled workflow has no canonical owner tag and cannot be migrated safely.';
  return new WorkflowApiError(error, 409, {
    success: false,
    code: WORKFLOW_OWNER_TAG_MIGRATION_REQUIRED_CODE,
    error,
    workflowId,
    reason,
  });
}

function isWorkflowOwnerTagMigrationError(error: unknown): error is WorkflowApiError {
  return (
    error instanceof WorkflowApiError &&
    isRecord(error.response) &&
    error.response.code === WORKFLOW_OWNER_TAG_MIGRATION_REQUIRED_CODE
  );
}

/**
 * Build the per-dispatch idempotency key for one exact scheduled occurrence.
 * The node identity keeps sibling schedules independent, while the timestamp
 * lets sub-minute schedules fire repeatedly without being mistaken for retries.
 */
export function buildScheduleIdempotencyKey(
  workflowId: string,
  scheduleNodeId: string,
  nextRunAtMs: number
): string {
  return `${workflowId}:${encodeURIComponent(scheduleNodeId)}:${nextRunAtMs}`;
}

function resolveScheduleNodeId(workflowId: string, node: WorkflowNode): string {
  const explicit = typeof node.id === 'string' ? node.id.trim() : '';
  return explicit || stringToUuid(`${workflowId}:schedule:${node.name}`);
}

function resolveScheduleIntervalMs(parameters: Record<string, unknown>): number {
  const explicitMs = readNumber(parameters.intervalMs, NaN);
  if (Number.isFinite(explicitMs) && explicitMs > 0) return explicitMs;

  const explicitSeconds = readNumber(parameters.intervalSeconds, NaN);
  if (Number.isFinite(explicitSeconds) && explicitSeconds > 0) return explicitSeconds * 1000;

  const rule = isRecord(parameters.rule) ? parameters.rule : null;
  const intervals = Array.isArray(rule?.interval) ? rule.interval : [];
  const first = intervals.find(isRecord);
  if (!first) return DEFAULT_SCHEDULE_INTERVAL_MS;

  const unit = readString(first.field, 'minutes');
  if (unit === 'seconds') return readNumber(first.secondsInterval, 60) * 1000;
  if (unit === 'minutes') return readNumber(first.minutesInterval, 1) * 60_000;
  if (unit === 'hours') return readNumber(first.hoursInterval, 1) * 3_600_000;
  if (unit === 'days') return readNumber(first.daysInterval, 1) * 86_400_000;

  return DEFAULT_SCHEDULE_INTERVAL_MS;
}

function normalizeWebhookPath(path: unknown): string {
  return readString(path, '')
    .trim()
    .replace(/^\/+|\/+$/g, '');
}

function normalizeHeaderEntries(value: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (isRecord(value)) {
    for (const [key, headerValue] of Object.entries(value)) {
      if (typeof headerValue !== 'undefined') headers[key] = String(headerValue);
    }
    return headers;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isRecord(entry)) continue;
      const name = readString(entry.name, '');
      if (name) headers[name] = String(entry.value ?? '');
    }
  }
  return headers;
}

function collectParametersList(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isRecord(entry)) continue;
      const name = readString(entry.name, '');
      if (name) out[name] = entry.value ?? '';
    }
  }
  return out;
}

function normalizeExecutionItem(
  item: unknown,
  pairedItem?: INodeExecutionData['pairedItem']
): INodeExecutionData {
  if (isRecord(item) && 'json' in item) {
    return {
      json: item.json as INodeExecutionData['json'],
      ...(item.pairedItem
        ? { pairedItem: item.pairedItem as INodeExecutionData['pairedItem'] }
        : {}),
    };
  }
  return {
    json: (isRecord(item) ? item : { value: item }) as INodeExecutionData['json'],
    ...(pairedItem ? { pairedItem } : {}),
  };
}

function normalizeExecutionItems(
  value: unknown,
  fallback: INodeExecutionData[]
): INodeExecutionData[] {
  if (typeof value === 'undefined') return fallback.map((item) => normalizeExecutionItem(item));
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeExecutionItem(item, { item: index }));
  }
  if (isRecord(value) && Array.isArray(value.items)) {
    return value.items.map((item, index) => normalizeExecutionItem(item, { item: index }));
  }
  return [normalizeExecutionItem(value)];
}

function readPath(source: unknown, path: string): unknown {
  const parts = path
    .replace(/\[(?:'([^']+)'|"([^"]+)"|(\d+))\]/g, '.$1$2$3')
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean);
  let current = source;
  for (const part of parts) {
    if (!isRecord(current) && !Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

interface ResolvedWorkflowExpression {
  matched: boolean;
  value?: unknown;
}

function resolveWorkflowExpression(
  expression: string,
  item: INodeExecutionData
): ResolvedWorkflowExpression {
  const normalized = expression.trim();
  for (const prefix of ['$json', '$input.item.json']) {
    if (normalized === prefix) return { matched: true, value: item.json };
    if (normalized.startsWith(`${prefix}.`)) {
      return { matched: true, value: readPath(item.json, normalized.slice(prefix.length + 1)) };
    }
    if (normalized.startsWith(`${prefix}[`)) {
      return { matched: true, value: readPath(item.json, normalized.slice(prefix.length)) };
    }
  }
  return { matched: false };
}

function stringifyWorkflowInterpolation(value: unknown): string {
  if (value === null || typeof value === 'undefined') return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value);
}

function resolveParameterValue(value: unknown, item: INodeExecutionData): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  const expressionSource = trimmed.startsWith('=') ? trimmed.slice(1).trim() : trimmed;
  const exactTemplate = expressionSource.match(/^\{\{\s*([^{}]+?)\s*\}\}$/s);
  if (exactTemplate?.[1]) {
    const resolved = resolveWorkflowExpression(exactTemplate[1], item);
    if (resolved.matched) return resolved.value;
  }
  if (trimmed.startsWith('=')) {
    const resolved = resolveWorkflowExpression(expressionSource, item);
    if (resolved.matched) return resolved.value;
  }

  let matched = false;
  const interpolated = expressionSource.replace(
    /\{\{\s*([^{}]+?)\s*\}\}/g,
    (template, expression: string) => {
      const resolved = resolveWorkflowExpression(expression, item);
      if (!resolved.matched) return template;
      matched = true;
      return stringifyWorkflowInterpolation(resolved.value);
    }
  );
  return matched ? interpolated : value;
}

function resolveParameterTree(value: unknown, item: INodeExecutionData): unknown {
  if (typeof value === 'string') return resolveParameterValue(value, item);
  if (Array.isArray(value)) return value.map((entry) => resolveParameterTree(entry, item));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, resolveParameterTree(entry, item)])
  );
}

function isEmptyValue(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'undefined' ||
    value === '' ||
    (Array.isArray(value) && value.length === 0) ||
    (isRecord(value) && Object.keys(value).length === 0)
  );
}

function compareCondition(
  left: unknown,
  operation: string,
  right: unknown,
  item: INodeExecutionData
): boolean {
  const resolvedLeft = resolveParameterValue(left, item);
  const resolvedRight = resolveParameterValue(right, item);
  const op = operation.toLowerCase();

  if (op === 'exists') return typeof resolvedLeft !== 'undefined' && resolvedLeft !== null;
  if (op === 'notexists') return typeof resolvedLeft === 'undefined' || resolvedLeft === null;
  if (op === 'empty') return isEmptyValue(resolvedLeft);
  if (op === 'notempty') return !isEmptyValue(resolvedLeft);
  if (op === 'true') return resolvedLeft === true || resolvedLeft === 'true';
  if (op === 'false') return resolvedLeft === false || resolvedLeft === 'false';
  if (op === 'contains') return String(resolvedLeft ?? '').includes(String(resolvedRight ?? ''));
  if (op === 'notcontains')
    return !String(resolvedLeft ?? '').includes(String(resolvedRight ?? ''));
  if (op === 'startswith')
    return String(resolvedLeft ?? '').startsWith(String(resolvedRight ?? ''));
  if (op === 'endswith') return String(resolvedLeft ?? '').endsWith(String(resolvedRight ?? ''));
  if (op === 'larger' || op === 'largerorequal' || op === 'gt' || op === 'gte') {
    return op.includes('equal') || op === 'gte'
      ? Number(resolvedLeft) >= Number(resolvedRight)
      : Number(resolvedLeft) > Number(resolvedRight);
  }
  if (op === 'smaller' || op === 'smallerorequal' || op === 'lt' || op === 'lte') {
    return op.includes('equal') || op === 'lte'
      ? Number(resolvedLeft) <= Number(resolvedRight)
      : Number(resolvedLeft) < Number(resolvedRight);
  }
  if (op === 'notequal' || op === 'notequals') return resolvedLeft !== resolvedRight;
  return (
    resolvedLeft === resolvedRight || String(resolvedLeft ?? '') === String(resolvedRight ?? '')
  );
}

function collectConditionEntries(parameters: Record<string, unknown>): Array<{
  left: unknown;
  operation: string;
  right: unknown;
}> {
  const conditions = isRecord(parameters.conditions) ? parameters.conditions : {};
  const modern = Array.isArray(conditions.conditions) ? conditions.conditions : [];
  const out: Array<{ left: unknown; operation: string; right: unknown }> = [];

  for (const condition of modern) {
    if (!isRecord(condition)) continue;
    const operator = isRecord(condition.operator) ? condition.operator : {};
    out.push({
      left: condition.leftValue ?? condition.value1,
      operation: readString(operator.operation ?? condition.operation, 'equals'),
      right: condition.rightValue ?? condition.value2,
    });
  }

  for (const group of Object.values(conditions)) {
    if (!Array.isArray(group)) continue;
    for (const condition of group) {
      if (!isRecord(condition)) continue;
      out.push({
        left: condition.value1 ?? condition.leftValue,
        operation: readString(condition.operation, 'equals'),
        right: condition.value2 ?? condition.rightValue,
      });
    }
  }

  return out;
}

function evaluateConditions(
  parameters: Record<string, unknown>,
  item: INodeExecutionData
): boolean {
  const conditions = collectConditionEntries(parameters);
  if (conditions.length === 0) return true;
  const combinator = readString(
    isRecord(parameters.conditions) ? parameters.conditions.combinator : undefined,
    'and'
  ).toLowerCase();
  const results = conditions.map((condition) =>
    compareCondition(condition.left, condition.operation, condition.right, item)
  );
  return combinator === 'or' ? results.some(Boolean) : results.every(Boolean);
}

function workflowHttpResponseTooLarge(actualBytes?: number): ElizaError {
  return new ElizaError(
    `Workflow HTTP response exceeds maximum size of ${WORKFLOW_HTTP_MAX_RESPONSE_BYTES} bytes`,
    {
      code: 'WORKFLOW_HTTP_RESPONSE_TOO_LARGE',
      context: {
        maxBytes: WORKFLOW_HTTP_MAX_RESPONSE_BYTES,
        ...(actualBytes === undefined ? {} : { actualBytes }),
      },
    }
  );
}

async function readResponseTextWithLimit(response: Response): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength) {
    const parsedLength = Number.parseInt(declaredLength, 10);
    if (Number.isFinite(parsedLength) && parsedLength > WORKFLOW_HTTP_MAX_RESPONSE_BYTES) {
      const error = workflowHttpResponseTooLarge(parsedLength);
      try {
        await response.body?.cancel(error);
      } catch (cancelError) {
        // error-policy:J6 the size violation is authoritative; body cancellation
        // is best-effort transport teardown and must not replace that failure.
        logger.warn(
          {
            src: 'plugin:workflow:http',
            error: serializeWorkflowExecutionError(cancelError),
          },
          'failed to cancel oversized workflow HTTP response'
        );
      }
      throw error;
    }
  }

  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > WORKFLOW_HTTP_MAX_RESPONSE_BYTES) {
        throw workflowHttpResponseTooLarge(totalBytes);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch (cancelError) {
      // error-policy:J6 the read/size error remains authoritative; cancelling
      // the upstream response is best-effort transport teardown.
      logger.warn(
        {
          src: 'plugin:workflow:http',
          error: serializeWorkflowExecutionError(cancelError),
        },
        'failed to cancel workflow HTTP response after a body read failure'
      );
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
  return text;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await readResponseTextWithLimit(response);
  if (!text) return null;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function createTriggerNodeOutput(
  inputItems: INodeExecutionData[],
  trigger: 'schedule' | 'manual'
): INodeExecutionData[][] {
  const firedAt = new Date().toISOString();
  const sourceItems = inputItems.length > 0 ? inputItems : [{ json: {} }];
  return [
    sourceItems.map((item) => ({
      ...item,
      json: {
        ...item.json,
        firedAt,
        trigger,
      },
    })),
  ];
}

function createScheduleTriggerNode(): INodeType {
  return {
    description: {
      displayName: 'Schedule Trigger',
      name: 'workflows-nodes-base.scheduleTrigger',
      group: ['trigger'],
      version: [1, 1.1, 1.2],
      description: 'Starts the workflow on a schedule.',
      defaults: { name: 'Schedule Trigger' },
      inputs: [],
      outputs: ['main'] as never,
      properties: [],
      capabilities: { requiresLongRunning: true },
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      return createTriggerNodeOutput(this.getInputData(), 'schedule');
    },
    async trigger() {
      return {};
    },
  };
}

function createSetNode(): INodeType {
  return {
    description: {
      displayName: 'Edit Fields (Set)',
      name: 'workflows-nodes-base.set',
      group: ['transform'],
      version: [1, 2, 3, 3.1, 3.2, 3.3, 3.4],
      description: 'Sets values on the current item.',
      defaults: { name: 'Edit Fields' },
      inputs: ['main'] as never,
      outputs: ['main'] as never,
      properties: [
        {
          displayName: 'Include Other Fields',
          name: 'includeOtherFields',
          type: 'boolean',
          default: true,
        },
        {
          displayName: 'Assignments',
          name: 'assignments',
          type: 'fixedCollection',
          typeOptions: { multipleValues: true },
          default: {},
          options: [
            {
              displayName: 'Assignment',
              name: 'assignments',
              values: [
                { displayName: 'Name', name: 'name', type: 'string', default: '' },
                { displayName: 'Value', name: 'value', type: 'string', default: '' },
              ],
            },
          ],
        },
        {
          displayName: 'Values',
          name: 'values',
          type: 'json',
          default: {},
        },
        {
          displayName: 'Fields',
          name: 'fields',
          type: 'json',
          default: {},
        },
      ] as never,
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      const inputItems = this.getInputData();
      const sourceItems = inputItems.length > 0 ? inputItems : [{ json: {} }];
      const output: INodeExecutionData[] = [];
      const nodeParameters = this.getNode().parameters as Record<string, unknown>;

      for (let itemIndex = 0; itemIndex < sourceItems.length; itemIndex++) {
        const includeOtherFields = nodeParameters.includeOtherFields !== false;
        const base: Record<string, unknown> = includeOtherFields
          ? { ...(sourceItems[itemIndex]?.json ?? {}) }
          : {};

        const assignmentContainer = isRecord(nodeParameters.assignments)
          ? nodeParameters.assignments
          : {};
        const assignments = Array.isArray(assignmentContainer.assignments)
          ? (assignmentContainer.assignments as Array<{ name?: unknown; value?: unknown }>)
          : [];
        for (const assignment of assignments) {
          const name = readString(
            resolveParameterValue(assignment.name, sourceItems[itemIndex]),
            ''
          );
          if (name) base[name] = resolveParameterTree(assignment.value, sourceItems[itemIndex]);
        }

        const values = isRecord(nodeParameters.values) ? nodeParameters.values : {};
        for (const group of Object.values(values)) {
          if (!Array.isArray(group)) continue;
          for (const entry of group) {
            if (!isRecord(entry)) continue;
            const name = readString(resolveParameterValue(entry.name, sourceItems[itemIndex]), '');
            if (name) base[name] = resolveParameterTree(entry.value, sourceItems[itemIndex]);
          }
        }

        const fields = isRecord(nodeParameters.fields) ? nodeParameters.fields : {};
        const resolvedFields = resolveParameterTree(fields, sourceItems[itemIndex]);
        if (isRecord(resolvedFields)) {
          Object.assign(base, resolvedFields);
        }

        output.push({
          json: base as INodeExecutionData['json'],
          pairedItem: { item: itemIndex },
        });
      }

      return [output];
    },
  };
}

function createHttpRequestNode(): INodeType {
  return {
    description: {
      displayName: 'HTTP Request',
      name: 'workflows-nodes-base.httpRequest',
      group: ['output'],
      version: [1, 2, 3, 4, 4.1, 4.2],
      description: 'Makes an HTTP request.',
      defaults: { name: 'HTTP Request' },
      inputs: ['main'] as never,
      outputs: ['main'] as never,
      properties: [
        {
          displayName: 'Method',
          name: 'method',
          type: 'options',
          default: 'GET',
          options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((method) => ({
            name: method,
            value: method,
          })),
        },
        {
          displayName: 'URL',
          name: 'url',
          type: 'string',
          default: '',
        },
        {
          displayName: 'Headers',
          name: 'headers',
          type: 'json',
          default: {},
        },
        {
          displayName: 'Header Parameters',
          name: 'headerParameters',
          type: 'fixedCollection',
          typeOptions: { multipleValues: true },
          default: {},
          options: [
            {
              displayName: 'Parameter',
              name: 'parameters',
              values: [
                { displayName: 'Name', name: 'name', type: 'string', default: '' },
                { displayName: 'Value', name: 'value', type: 'string', default: '' },
              ],
            },
          ],
        },
        {
          displayName: 'Body',
          name: 'body',
          type: 'string',
          default: '',
        },
        {
          displayName: 'JSON Body',
          name: 'jsonBody',
          type: 'json',
          default: {},
        },
        {
          displayName: 'Body Parameters',
          name: 'bodyParameters',
          type: 'fixedCollection',
          typeOptions: { multipleValues: true },
          default: {},
          options: [
            {
              displayName: 'Parameter',
              name: 'parameters',
              values: [
                { displayName: 'Name', name: 'name', type: 'string', default: '' },
                { displayName: 'Value', name: 'value', type: 'string', default: '' },
              ],
            },
          ],
        },
      ] as never,
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      const inputItems = this.getInputData();
      const sourceItems = inputItems.length > 0 ? inputItems : [{ json: {} }];
      const output: INodeExecutionData[] = [];
      const nodeParameters = this.getNode().parameters as Record<string, unknown>;

      for (let itemIndex = 0; itemIndex < sourceItems.length; itemIndex++) {
        const item = sourceItems[itemIndex];
        const url = readString(resolveParameterValue(nodeParameters.url, item), '');
        if (!url) {
          throw new ElizaError('HTTP Request node requires a URL', {
            code: 'WORKFLOW_HTTP_URL_REQUIRED',
          });
        }

        const method = readString(resolveParameterValue(nodeParameters.method, item), 'GET')
          .toUpperCase()
          .trim();

        const resolvedHeaderParameters = resolveParameterTree(
          nodeParameters.headerParameters,
          item
        );
        const headerContainer = isRecord(resolvedHeaderParameters) ? resolvedHeaderParameters : {};
        const headerParameters = headerContainer.parameters ?? [];
        const headers = {
          ...normalizeHeaderEntries(resolveParameterTree(nodeParameters.headers, item)),
          ...normalizeHeaderEntries(headerParameters),
        };

        const requestOptions: RequestInit = {
          method,
          headers,
          signal: this.getAbortSignal?.(),
        };
        const resolvedBodyParameters = resolveParameterTree(nodeParameters.bodyParameters, item);
        const bodyContainer = isRecord(resolvedBodyParameters) ? resolvedBodyParameters : {};
        const bodyParameters = bodyContainer.parameters ?? [];
        const bodyObject = collectParametersList(bodyParameters);
        const jsonBody = resolveParameterTree(nodeParameters.jsonBody, item);
        const rawBody = resolveParameterValue(nodeParameters.body, item);

        if (!['GET', 'HEAD'].includes(method)) {
          if (typeof rawBody === 'string' && rawBody.length > 0) {
            requestOptions.body = rawBody;
          } else if (rawBody !== null && typeof rawBody !== 'undefined' && rawBody !== '') {
            requestOptions.body = JSON.stringify(rawBody);
            headers['content-type'] = headers['content-type'] ?? 'application/json';
          } else if (isRecord(jsonBody) || Object.keys(bodyObject).length > 0) {
            requestOptions.body = JSON.stringify(isRecord(jsonBody) ? jsonBody : bodyObject);
            headers['content-type'] = headers['content-type'] ?? 'application/json';
          }
        }

        const runtime = this.getRuntime?.();
        const guarded = await fetchWithSsrfGuard({
          url,
          init: requestOptions,
          signal: this.getAbortSignal?.(),
          ...(runtime ? workflowHttpTransportsForTests.get(runtime) : undefined),
        });
        try {
          const body = await parseResponseBody(guarded.response);
          if (!guarded.response.ok) {
            throw new ElizaError('HTTP request failed', {
              code: 'WORKFLOW_HTTP_STATUS_ERROR',
              context: { method, statusCode: guarded.response.status },
            });
          }
          output.push({
            json: {
              statusCode: guarded.response.status,
              headers: Object.fromEntries(guarded.response.headers.entries()),
              body,
            } as INodeExecutionData['json'],
            pairedItem: { item: itemIndex },
          });
        } finally {
          await guarded.release();
        }
      }

      return [output];
    },
  };
}

function createManualTriggerNode(): INodeType {
  return {
    description: {
      displayName: 'Manual Trigger',
      name: 'workflows-nodes-base.manualTrigger',
      group: ['trigger'],
      version: [1],
      description: 'Starts the workflow manually.',
      defaults: { name: 'Manual Trigger' },
      inputs: [],
      outputs: ['main'] as never,
      properties: [],
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      return createTriggerNodeOutput(this.getInputData(), 'manual');
    },
    async trigger() {
      return {};
    },
  };
}

function createWebhookNode(): INodeType {
  return {
    description: {
      displayName: 'Webhook',
      name: 'workflows-nodes-base.webhook',
      group: ['trigger'],
      version: [1, 2],
      description: 'Starts the workflow from an HTTP webhook.',
      defaults: { name: 'Webhook' },
      inputs: [],
      outputs: ['main'] as never,
      properties: [
        { displayName: 'Path', name: 'path', type: 'string', default: '' },
        { displayName: 'HTTP Method', name: 'httpMethod', type: 'string', default: 'POST' },
        { displayName: 'Embedded Payload', name: '__embeddedPayload', type: 'json', default: {} },
      ] as never,
      capabilities: { requiresInbound: true },
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      const parameters = this.getNode().parameters as Record<string, unknown>;
      const payload = isRecord(parameters.__embeddedPayload)
        ? parameters.__embeddedPayload
        : { firedAt: new Date().toISOString(), trigger: 'webhook' };
      return [[{ json: cloneJson(payload) as INodeExecutionData['json'] }]];
    },
    async trigger() {
      return {};
    },
  };
}

function createRespondToWebhookNode(): INodeType {
  return {
    description: {
      displayName: 'Respond to Webhook',
      name: 'workflows-nodes-base.respondToWebhook',
      group: ['output'],
      version: [1],
      description: 'Returns the current item as a webhook response.',
      defaults: { name: 'Respond to Webhook' },
      inputs: ['main'] as never,
      outputs: ['main'] as never,
      properties: [
        { displayName: 'Response Body', name: 'responseBody', type: 'json', default: {} },
      ] as never,
      capabilities: { requiresInbound: true },
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      const inputItems = this.getInputData();
      const parameters = this.getNode().parameters as Record<string, unknown>;
      if (isRecord(parameters.responseBody) && Object.keys(parameters.responseBody).length > 0) {
        return [[{ json: cloneJson(parameters.responseBody) as INodeExecutionData['json'] }]];
      }
      return [inputItems.length > 0 ? inputItems : [{ json: {} }]];
    },
  };
}

function createNoOpNode(): INodeType {
  return {
    description: {
      displayName: 'No Operation, do nothing',
      name: 'workflows-nodes-base.noOp',
      group: ['transform'],
      version: [1],
      description: 'Passes input data through unchanged.',
      defaults: { name: 'NoOp' },
      inputs: ['main'] as never,
      outputs: ['main'] as never,
      properties: [],
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      const inputItems = this.getInputData();
      return [inputItems.length > 0 ? inputItems : [{ json: {} }]];
    },
  };
}

function createIfNode(): INodeType {
  return {
    description: {
      displayName: 'If',
      name: 'workflows-nodes-base.if',
      group: ['transform'],
      version: [1, 2],
      description: 'Routes items based on conditions.',
      defaults: { name: 'If' },
      inputs: ['main'] as never,
      outputs: ['main', 'main'] as never,
      properties: [
        { displayName: 'Conditions', name: 'conditions', type: 'fixedCollection', default: {} },
      ] as never,
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      const parameters = this.getNode().parameters as Record<string, unknown>;
      const inputItems = this.getInputData();
      const trueItems: INodeExecutionData[] = [];
      const falseItems: INodeExecutionData[] = [];
      inputItems.forEach((item, index) => {
        const out = evaluateConditions(parameters, item) ? trueItems : falseItems;
        out.push({ ...item, pairedItem: item.pairedItem ?? { item: index } });
      });
      return [trueItems, falseItems];
    },
  };
}

function createFilterNode(): INodeType {
  return {
    description: {
      displayName: 'Filter',
      name: 'workflows-nodes-base.filter',
      group: ['transform'],
      version: [1, 2],
      description: 'Keeps items that match conditions.',
      defaults: { name: 'Filter' },
      inputs: ['main'] as never,
      outputs: ['main'] as never,
      properties: [
        { displayName: 'Conditions', name: 'conditions', type: 'fixedCollection', default: {} },
      ] as never,
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      const parameters = this.getNode().parameters as Record<string, unknown>;
      return [this.getInputData().filter((item) => evaluateConditions(parameters, item))];
    },
  };
}

function createSwitchNode(): INodeType {
  return {
    description: {
      displayName: 'Switch',
      name: 'workflows-nodes-base.switch',
      group: ['transform'],
      version: [1, 2, 3],
      description: 'Routes items to multiple outputs.',
      defaults: { name: 'Switch' },
      inputs: ['main'] as never,
      outputs: ['main', 'main', 'main', 'main', 'main'] as never,
      properties: [
        { displayName: 'Rules', name: 'rules', type: 'fixedCollection', default: {} },
      ] as never,
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      const parameters = this.getNode().parameters as Record<string, unknown>;
      const rulesContainer = isRecord(parameters.rules) ? parameters.rules : {};
      const rules = Array.isArray(rulesContainer.rules) ? rulesContainer.rules : [];
      const outputs: INodeExecutionData[][] = [[], [], [], [], []];
      this.getInputData().forEach((item, itemIndex) => {
        const matchedIndex = rules.findIndex((rule) =>
          isRecord(rule) ? evaluateConditions({ conditions: rule.conditions ?? rule }, item) : false
        );
        const outputIndex = matchedIndex >= 0 ? Math.min(matchedIndex, 3) : 4;
        outputs[outputIndex].push({ ...item, pairedItem: item.pairedItem ?? { item: itemIndex } });
      });
      return outputs;
    },
  };
}

function createMergeNode(): INodeType {
  return {
    description: {
      displayName: 'Merge',
      name: 'workflows-nodes-base.merge',
      group: ['transform'],
      version: [1, 2, 3],
      description: 'Combines items from multiple inputs.',
      defaults: { name: 'Merge' },
      inputs: ['main', 'main'] as never,
      outputs: ['main'] as never,
      properties: [
        { displayName: 'Mode', name: 'mode', type: 'string', default: 'append' },
      ] as never,
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      const first = this.getInputData(0);
      const second = this.getInputData(1);
      return [[...first, ...second]];
    },
  };
}

function createSplitInBatchesNode(): INodeType {
  return {
    description: {
      displayName: 'Split In Batches',
      name: 'workflows-nodes-base.splitInBatches',
      group: ['transform'],
      version: [1, 2, 3],
      description: 'Emits the next batch of items.',
      defaults: { name: 'Split In Batches' },
      inputs: ['main'] as never,
      outputs: ['main', 'main'] as never,
      properties: [
        { displayName: 'Batch Size', name: 'batchSize', type: 'number', default: 1 },
      ] as never,
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      const inputItems = this.getInputData();
      const batchSize = Math.max(
        1,
        readNumber(this.getNode().parameters.batchSize, inputItems.length)
      );
      return [inputItems.slice(0, batchSize), inputItems.slice(batchSize)];
    },
  };
}

function createWaitNode(): INodeType {
  return {
    description: {
      displayName: 'Wait',
      name: 'workflows-nodes-base.wait',
      group: ['transform'],
      version: [1, 1.1],
      description: 'Pauses execution for a duration.',
      defaults: { name: 'Wait' },
      inputs: ['main'] as never,
      outputs: ['main'] as never,
      properties: [
        { displayName: 'Amount', name: 'amount', type: 'number', default: 1 },
        { displayName: 'Unit', name: 'unit', type: 'string', default: 'seconds' },
      ] as never,
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      const parameters = this.getNode().parameters as Record<string, unknown>;
      const amount = Math.max(0, readNumber(parameters.amount, 1));
      const unit = readString(parameters.unit, 'seconds');
      const multiplier =
        unit === 'milliseconds'
          ? 1
          : unit === 'minutes'
            ? 60_000
            : unit === 'hours'
              ? 3_600_000
              : 1000;
      const signal = this.getAbortSignal?.();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, amount * multiplier);
        if (!signal) return;
        const onAbort = (): void => {
          clearTimeout(timer);
          reject(signal.reason ?? new DOMException('Workflow execution aborted', 'AbortError'));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
      return [this.getInputData()];
    },
  };
}

function createDateTimeNode(): INodeType {
  return {
    description: {
      displayName: 'Date & Time',
      name: 'workflows-nodes-base.dateTime',
      group: ['transform'],
      version: [1, 2],
      description: 'Adds date/time values to items.',
      defaults: { name: 'Date & Time' },
      inputs: ['main'] as never,
      outputs: ['main'] as never,
      properties: [
        { displayName: 'Field Name', name: 'fieldName', type: 'string', default: 'dateTime' },
      ] as never,
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      const inputItems = this.getInputData();
      const fieldName = readString(this.getNode().parameters.fieldName, 'dateTime');
      const now = new Date().toISOString();
      return [
        inputItems.map((item, index) => ({
          json: { ...item.json, [fieldName]: now } as INodeExecutionData['json'],
          pairedItem: item.pairedItem ?? { item: index },
        })),
      ];
    },
  };
}

function createCryptoNode(): INodeType {
  return {
    description: {
      displayName: 'Crypto',
      name: 'workflows-nodes-base.crypto',
      group: ['transform'],
      version: [1],
      description: 'Hashes data.',
      defaults: { name: 'Crypto' },
      inputs: ['main'] as never,
      outputs: ['main'] as never,
      properties: [
        { displayName: 'Value', name: 'value', type: 'string', default: '' },
        { displayName: 'Algorithm', name: 'algorithm', type: 'string', default: 'sha256' },
        { displayName: 'Field Name', name: 'fieldName', type: 'string', default: 'hash' },
      ] as never,
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      const parameters = this.getNode().parameters as Record<string, unknown>;
      const algorithm = readString(parameters.algorithm, 'sha256');
      const fieldName = readString(parameters.fieldName, 'hash');
      return [
        this.getInputData().map((item, index) => {
          const raw = resolveParameterValue(parameters.value, item);
          const source =
            raw === '' || typeof raw === 'undefined' ? JSON.stringify(item.json) : String(raw);
          return {
            json: {
              ...item.json,
              [fieldName]: createHash(algorithm).update(source).digest('hex'),
            } as INodeExecutionData['json'],
            pairedItem: item.pairedItem ?? { item: index },
          };
        }),
      ];
    },
  };
}

function createItemListsNode(): INodeType {
  return {
    description: {
      displayName: 'Item Lists',
      name: 'workflows-nodes-base.itemLists',
      group: ['transform'],
      version: [1, 2, 3],
      description: 'Transforms item lists.',
      defaults: { name: 'Item Lists' },
      inputs: ['main'] as never,
      outputs: ['main'] as never,
      properties: [
        { displayName: 'Operation', name: 'operation', type: 'string', default: 'passthrough' },
        { displayName: 'Limit', name: 'limit', type: 'number', default: 0 },
      ] as never,
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      const parameters = this.getNode().parameters as Record<string, unknown>;
      const inputItems = this.getInputData();
      const operation = readString(parameters.operation, 'passthrough');
      if (operation === 'limit') {
        const limit = Math.max(0, readNumber(parameters.limit, inputItems.length));
        return [inputItems.slice(0, limit)];
      }
      return [inputItems];
    },
  };
}

function createDeviceStatusNode(): INodeType {
  return {
    description: {
      displayName: 'Device Status',
      name: 'workflows-nodes-base.deviceStatus',
      group: ['input'],
      version: [1],
      description: 'Reports local RAM, disk, CPU, and runtime status without model calls.',
      defaults: { name: 'Device Status' },
      inputs: ['main'] as never,
      outputs: ['main'] as never,
      properties: [] as never,
      capabilities: { requiresFs: true },
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      const sourceItems = this.getInputData();
      const status = await collectDeviceStatus();
      const json = {
        ...(sourceItems[0]?.json ?? {}),
        ...status,
      } as INodeExecutionData['json'];
      return [[{ json }]];
    },
  };
}

async function runQuickJsCode(jsCode: string, inputItems: INodeExecutionData[]): Promise<unknown> {
  const { getQuickJS, shouldInterruptAfterDeadline } = await loadQuickJs();
  const QuickJS = await getQuickJS();
  const embeddedInput = JSON.stringify(inputItems.map((item) => normalizeExecutionItem(item)));
  const source = `
    "use strict";
    const $input = ${embeddedInput};
    const items = $input;
    const item = $input[0] ?? { json: {} };
    const $json = item.json ?? {};
    const $now = new Date("${new Date().toISOString()}");
    const $workflow = {};
    const $env = {};
    const console = { log() {}, warn() {}, error() {}, info() {} };
    (function embeddedWorkflowCodeNode() {
      ${jsCode}
    })()
  `;
  return QuickJS.evalCode(source, {
    shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + 5_000),
    memoryLimitBytes: 32 * 1024 * 1024,
  });
}

/**
 * Evaluate a snippet of JavaScript in the same isolated QuickJS sandbox the
 * Code node uses (5s deadline, 32 MiB cap, no host/network/fs access). Optional
 * `inputJson` is exposed to the snippet as `$json` / `item.json` / `$input[0]`.
 * The snippet body runs inside an IIFE, so `return <value>` yields the result.
 * Public entry point for the EVAL_CODE action (#8914).
 */
export async function evalQuickJsCode(jsCode: string, inputJson?: unknown): Promise<unknown> {
  const items: INodeExecutionData[] =
    inputJson === undefined ? [] : [{ json: (inputJson ?? {}) as Record<string, unknown> }];
  return runQuickJsCode(jsCode, items);
}

type AutonomyServiceLike = Service & {
  getAutonomousRoomId?(): UUID | undefined;
  getTargetRoomId?(): UUID | undefined;
};

function resolveAutonomyService(runtime: IAgentRuntime): AutonomyServiceLike | null {
  const svc =
    runtime.getService<AutonomyServiceLike>('AUTONOMY') ??
    runtime.getService<AutonomyServiceLike>('autonomy');
  return svc ?? null;
}

function resolveAutonomyRoomId(svc: AutonomyServiceLike): UUID | null {
  const fromAutonomous =
    typeof svc.getAutonomousRoomId === 'function' ? svc.getAutonomousRoomId() : undefined;
  if (fromAutonomous) return fromAutonomous;
  const fromTarget = typeof svc.getTargetRoomId === 'function' ? svc.getTargetRoomId() : undefined;
  return fromTarget ?? null;
}

function isManagedCloudRuntime(runtime: IAgentRuntime): boolean {
  return (
    isEnabledSetting(runtime.getSetting(CLOUD_PROVISIONED_SETTING)) ||
    isEnabledSetting(readAliasedEnv(CLOUD_PROVISIONED_SETTING))
  );
}

async function ensureWorkflowOwnerRoom(
  runtime: IAgentRuntime,
  ownerEntityId: string
): Promise<UUID> {
  const ownerId = stringToUuid(ownerEntityId);
  const worldId = stringToUuid(`workflow-automation-world:${runtime.agentId}:${ownerId}`);
  const roomId = stringToUuid(`workflow-automation-room:${runtime.agentId}:${ownerId}`);
  await runtime.ensureConnection({
    entityId: ownerId,
    roomId,
    worldId,
    source: 'workflow-automation',
    type: ChannelType.DM,
    roomName: 'Workflow automations',
    worldName: 'Workflow automations',
    metadata: { ownership: { ownerId } },
  });
  return roomId;
}

function extractEventFromInputItems(inputItems: INodeExecutionData[]): {
  kind?: string;
  payload?: Record<string, unknown>;
} | null {
  for (const item of inputItems) {
    const json = item.json;
    if (!isRecord(json)) continue;
    const kind = typeof json.eventKind === 'string' ? json.eventKind : undefined;
    const payload = isRecord(json.eventPayload) ? json.eventPayload : undefined;
    if (kind || payload) return { kind, payload };
  }
  return null;
}

function createRespondToEventNode(): INodeType {
  return {
    description: {
      displayName: 'Respond to Event',
      name: 'workflows-nodes-base.respondToEvent',
      group: ['transform'],
      version: [1],
      description: "Inject an instruction into the agent's autonomy room.",
      defaults: { name: 'Respond to Event' },
      inputs: ['main'] as never,
      outputs: ['main'] as never,
      properties: [
        { displayName: 'Instructions', name: 'instructions', type: 'string', default: '' },
        { displayName: 'Display Name', name: 'displayName', type: 'string', default: '' },
        { displayName: 'Wake Mode', name: 'wakeMode', type: 'string', default: 'inject_now' },
      ] as never,
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      const node = this.getNode();
      const inputItems = this.getInputData();
      const parameters = node.parameters as Record<string, unknown>;
      const instructions = readString(parameters.instructions, '');
      const displayName = readString(parameters.displayName, node.name);
      const wakeMode = readString(parameters.wakeMode, 'inject_now');
      const runtime = this.getRuntime?.() ?? null;
      const executionId = this.getExecutionId?.() ?? null;
      const executionContext = this.getExecutionContext?.();

      if (!runtime) {
        logger.warn(
          { src: 'plugin:workflow:respondToEvent', nodeName: node.name },
          '[respondToEvent] Agent runtime is unavailable'
        );
        throw new ElizaError('Workflow response could not access the agent runtime', {
          code: 'WORKFLOW_RESPOND_RUNTIME_UNAVAILABLE',
        });
      }

      let roomId: UUID;
      if (executionContext?.sourceRoomId) {
        roomId = stringToUuid(executionContext.sourceRoomId);
      } else if (executionContext?.ownerEntityId) {
        roomId = await ensureWorkflowOwnerRoom(runtime, executionContext.ownerEntityId);
      } else {
        if (isManagedCloudRuntime(runtime)) {
          runtime.logger.warn(
            { src: 'plugin:workflow:respondToEvent', nodeName: node.name, executionId },
            '[respondToEvent] Managed Cloud execution lacks owner context'
          );
          throw new ElizaError('Workflow response requires owner context in managed Cloud', {
            code: 'WORKFLOW_RESPOND_OWNER_CONTEXT_REQUIRED',
          });
        }
        const autonomyService = resolveAutonomyService(runtime);
        if (!autonomyService) {
          runtime.logger.warn(
            { src: 'plugin:workflow:respondToEvent', nodeName: node.name, executionId },
            '[respondToEvent] Autonomy service is unavailable'
          );
          throw new ElizaError('Workflow response could not access an autonomy service', {
            code: 'WORKFLOW_RESPOND_AUTONOMY_UNAVAILABLE',
          });
        }
        const autonomyRoomId = resolveAutonomyRoomId(autonomyService);
        if (!autonomyRoomId) {
          runtime.logger.warn(
            { src: 'plugin:workflow:respondToEvent', nodeName: node.name, executionId },
            '[respondToEvent] Autonomy destination room is unavailable'
          );
          throw new ElizaError('Workflow response could not resolve a destination room', {
            code: 'WORKFLOW_RESPOND_ROOM_UNAVAILABLE',
          });
        }
        roomId = autonomyRoomId;
      }

      const event = extractEventFromInputItems(inputItems);
      const eventText = event
        ? `\n\nEvent: ${event.kind ?? 'unknown'}\nPayload: ${JSON.stringify(event.payload ?? {})}`
        : '';
      const instructionText = `[${displayName}]\n${instructions}${eventText}`;
      if (!executionId) {
        runtime.logger.warn(
          { src: 'plugin:workflow:respondToEvent', nodeName: node.name },
          '[respondToEvent] Workflow execution id is unavailable'
        );
        throw new ElizaError('Workflow response could not identify its execution', {
          code: 'WORKFLOW_RESPOND_EXECUTION_ID_UNAVAILABLE',
        });
      }
      // Smithers may replay a node after a crash that occurred between the side
      // effect and its durable step commit. A deterministic primary key turns
      // that replay into the same memory write instead of a duplicate message.
      const memoryId = stringToUuid(
        `workflow:${executionId}:node:${node.id ?? node.name}:respond-to-event`
      );

      await runtime.createMemory(
        {
          id: memoryId,
          entityId: executionContext?.ownerEntityId
            ? stringToUuid(executionContext.ownerEntityId)
            : runtime.agentId,
          roomId,
          content: {
            text: instructionText,
            source: 'workflow:respondToEvent',
            metadata: {
              workflowExecutionId: executionId,
              nodeName: node.name,
              wakeMode,
              isAutonomousInstruction: true,
              ...(executionContext?.ownerEntityId
                ? { ownerEntityId: executionContext.ownerEntityId }
                : {}),
              ...(executionContext?.sourceRoomId
                ? { sourceRoomId: executionContext.sourceRoomId }
                : {}),
            },
          },
        },
        'messages'
      );

      return [
        [
          {
            json: {
              instructionInjected: true,
              roomId,
              nodeName: node.name,
              wakeMode,
            } as INodeExecutionData['json'],
          },
        ],
      ];
    },
  };
}

function createCodeNode(): INodeType {
  return {
    description: {
      displayName: 'Code',
      name: 'workflows-nodes-base.code',
      group: ['transform'],
      version: [1, 2],
      description: 'Runs JavaScript in a QuickJS sandbox.',
      defaults: { name: 'Code' },
      inputs: ['main'] as never,
      outputs: ['main'] as never,
      properties: [
        {
          displayName: 'JavaScript Code',
          name: 'jsCode',
          type: 'string',
          default: 'return items;',
        },
        { displayName: 'Mode', name: 'mode', type: 'string', default: 'runOnceForAllItems' },
      ] as never,
    },
    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
      const inputItems = this.getInputData();
      const sourceItems = inputItems.length > 0 ? inputItems : [{ json: {} }];
      const parameters = this.getNode().parameters as Record<string, unknown>;
      const jsCode = readString(parameters.jsCode, 'return items;');
      const mode = readString(parameters.mode, 'runOnceForAllItems');
      if (mode === 'runOnceForEachItem') {
        const out: INodeExecutionData[] = [];
        for (const item of sourceItems) {
          const result = await runQuickJsCode(jsCode, [item]);
          out.push(...normalizeExecutionItems(result, [item]));
        }
        return [out];
      }
      const result = await runQuickJsCode(jsCode, sourceItems);
      return [normalizeExecutionItems(result, sourceItems)];
    },
  };
}

class EmbeddedNodeTypes implements INodeTypes {
  private readonly nodes = new Map<string, INodeType>();

  constructor() {
    for (const node of [
      createScheduleTriggerNode(),
      createManualTriggerNode(),
      createWebhookNode(),
      createRespondToWebhookNode(),
      createRespondToEventNode(),
      createSetNode(),
      createHttpRequestNode(),
      createNoOpNode(),
      createIfNode(),
      createFilterNode(),
      createSwitchNode(),
      createMergeNode(),
      createSplitInBatchesNode(),
      createWaitNode(),
      createDateTimeNode(),
      createCryptoNode(),
      createItemListsNode(),
      createDeviceStatusNode(),
      createCodeNode(),
    ]) {
      const canonical = node.description.name;
      this.nodes.set(canonical, node);
    }
  }

  getByName(nodeType: string): INodeType {
    return this.getByNameAndVersion(nodeType);
  }

  getByNameAndVersion(nodeType: string): INodeType {
    const node = this.nodes.get(nodeType);
    if (!node) {
      throw new Error(`Node type not available in embedded workflow runtime: ${nodeType}`);
    }
    return node;
  }

  getKnownTypes(): Record<string, { sourcePath: string; className: string }> {
    return Object.fromEntries(
      [...this.nodes.keys()].map((name) => [
        name,
        { sourcePath: 'embedded', className: name.split('.').at(-1) ?? name },
      ])
    );
  }

  has(nodeType: string): boolean {
    return this.nodes.has(nodeType);
  }

  names(): string[] {
    return [...this.nodes.keys()];
  }

  versions(): Map<string, number[]> {
    const out = new Map<string, number[]>();
    for (const [name, node] of this.nodes) {
      const version = node.description.version;
      out.set(name, Array.isArray(version) ? version : [version]);
    }
    return out;
  }
}

export class EmbeddedWorkflowService extends Service {
  static override readonly serviceType = EMBEDDED_WORKFLOW_SERVICE_TYPE;

  override capabilityDescription =
    'Feature-flagged embedded workflow runtime for local plugin-owned workflow execution.';

  private readonly nodeTypes = new EmbeddedNodeTypes();
  private readonly hostCapabilities = detectHostCapabilities();
  private schemaReady: Promise<void> | null = null;
  private readonly recoveryController = new AbortController();
  private recoveryPromise: Promise<void> | null = null;
  private readonly executionController = new AbortController();
  private shutdownReason: ElizaError | null = null;
  private readonly activeAdmissionSettlements = new Set<Promise<void>>();
  private readonly activeExecutionSettlements = new Set<Promise<void>>();
  private readonly shutdownCleanupErrors: unknown[] = [];
  private readonly executionOwnerId = randomUUID();
  private readonly workflowLifecycleTails = new Map<string, Promise<void>>();
  // A takeover cannot become eligible while a delegated node may still be in
  // flight: Smithers kills the run at its workflow deadline, and this outer
  // lease extends one teardown grace beyond that maximum.
  private readonly executionLeaseDurationMs =
    resolveSmithersTimeoutMs() + EXECUTION_LEASE_DEADLINE_GRACE_MS;

  static async start(runtime: IAgentRuntime): Promise<EmbeddedWorkflowService> {
    const service = new EmbeddedWorkflowService(runtime);
    logger.info(
      { src: 'plugin:workflow:embedded' },
      'Embedded workflow service registered (lazy runtime load)'
    );
    if (runtime.db) {
      await service.ensureSchema();
      if (shouldSeedDefaultWorkflows(runtime)) {
        await service.seedDefaultWorkflows();
      }
      service.startExecutionRecovery();
      await service.rehydrateSchedules();
    }
    return service;
  }

  override async stop(): Promise<void> {
    const reason =
      this.shutdownReason ??
      new ElizaError('Embedded workflow service stopped', {
        code: 'WORKFLOW_SERVICE_STOPPED',
        severity: 'ephemeral',
      });
    this.shutdownReason = reason;
    if (!this.recoveryController.signal.aborted) {
      this.recoveryController.abort(reason);
    }
    if (!this.executionController.signal.aborted) {
      this.executionController.abort(reason);
    }
    await this.recoveryPromise;
    // Active runs settle cooperatively after cancellation. Their persisted rows
    // are released without becoming terminal so a replacement service can
    // immediately recover the same Smithers execution id.
    await Promise.all([...this.activeAdmissionSettlements, ...this.activeExecutionSettlements]);
    if (this.shutdownCleanupErrors.length > 0) {
      throw new AggregateError(
        this.shutdownCleanupErrors,
        'Embedded workflow service could not release every active execution for recovery'
      );
    }
  }

  get host(): string {
    return EMBEDDED_HOST;
  }

  getRuntimeNodeTypeVersions(): Map<string, number[]> {
    return this.nodeTypes.versions();
  }

  getRegisteredNodeTypes(): string[] {
    return this.nodeTypes.names();
  }

  supportsWorkflow(workflow: WorkflowDefinition): { supported: boolean; missing: string[] } {
    const missing = workflow.nodes
      .filter((node) => !node.disabled && !this.nodeTypes.has(node.type))
      .map((node) => node.type);
    return { supported: missing.length === 0, missing: [...new Set(missing)] };
  }

  private getDb(): NodePgDatabase {
    const db = this.runtime.db;
    if (!db) {
      throw new Error(
        'Database not available for EmbeddedWorkflowService. Embedded workflow requires plugin-sql/PGlite/Postgres persistence.'
      );
    }
    return db as NodePgDatabase;
  }

  private get tenantAgentId(): string {
    const agentId = this.runtime.agentId;
    if (!agentId || agentId === LEGACY_UNSCOPED_WORKFLOW_AGENT_ID) {
      throw new ElizaError('Workflow persistence requires a live agent tenant id', {
        code: 'WORKFLOW_AGENT_TENANT_REQUIRED',
        context: { agentId },
      });
    }
    return agentId;
  }

  private assertAcceptingExecutions(): void {
    if (this.shutdownReason) throw this.shutdownReason;
  }

  private async trackExecutionAdmission<T>(operation: () => Promise<T>): Promise<T> {
    this.assertAcceptingExecutions();
    const operationPromise = operation();
    const settlement = operationPromise.then(
      () => undefined,
      () => undefined
    );
    this.activeAdmissionSettlements.add(settlement);
    try {
      return await operationPromise;
    } finally {
      this.activeAdmissionSettlements.delete(settlement);
    }
  }

  /**
   * Definition rows and scheduler tasks form one lifecycle boundary. Serializing
   * mutations for a workflow prevents a later operation from observing the
   * intermediate DB-first state while its predecessor is still reconciling tasks.
   */
  private async withWorkflowLifecycleLock<T>(
    workflowId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const predecessor = this.workflowLifecycleTails.get(workflowId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor.then(() => gate);
    this.workflowLifecycleTails.set(workflowId, tail);
    await predecessor;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.workflowLifecycleTails.get(workflowId) === tail) {
        this.workflowLifecycleTails.delete(workflowId);
      }
    }
  }

  /**
   * The constraint/index names are the durable v1 migration marker. Reading
   * PostgreSQL catalogs keeps an already-migrated startup on a SELECT-only fast
   * path; the advisory lock and ACCESS EXCLUSIVE DDL are reserved for installs
   * that genuinely still need the tenant re-key.
   */
  private async isAgentScopeSchemaReady(db: Pick<NodePgDatabase, 'execute'>): Promise<boolean> {
    const primaryKeys = sql.join(
      WORKFLOW_AGENT_SCOPE_PRIMARY_KEYS.map((name) => sql`${name}`),
      sql`, `
    );
    const indexes = sql.join(
      WORKFLOW_AGENT_SCOPE_INDEXES.map((name) => sql`${name}`),
      sql`, `
    );
    const result = await db.execute(sql`
      SELECT
        (
          SELECT count(*)::int
          FROM pg_catalog.pg_constraint AS constraint_record
          JOIN pg_catalog.pg_namespace AS namespace_record
            ON namespace_record.oid = constraint_record.connamespace
          WHERE namespace_record.nspname = 'workflow'
            AND constraint_record.conname IN (${primaryKeys})
        ) AS primary_key_count,
        (
          SELECT count(*)::int
          FROM pg_catalog.pg_class AS index_record
          JOIN pg_catalog.pg_namespace AS namespace_record
            ON namespace_record.oid = index_record.relnamespace
          WHERE namespace_record.nspname = 'workflow'
            AND index_record.relkind = 'i'
            AND index_record.relname IN (${indexes})
        ) AS index_count
    `);
    const resultRecord = isRecord(result) ? result : null;
    const rows = resultRecord && Array.isArray(resultRecord.rows) ? resultRecord.rows : [];
    const first = rows.find(isRecord);
    return (
      Number(first?.primary_key_count) === WORKFLOW_AGENT_SCOPE_PRIMARY_KEYS.length &&
      Number(first?.index_count) === WORKFLOW_AGENT_SCOPE_INDEXES.length
    );
  }

  private async ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = (async () => {
        const db = this.getDb();
        if (await this.isAgentScopeSchemaReady(db)) return;
        await db.transaction(async (tx) => {
          // A shared database can start several AgentRuntime instances at once.
          // Serializing the re-key migration prevents competing DDL while still
          // allowing every service instance to keep its own lazy readiness gate.
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext('eliza-workflow-agent-scope-v1'))`
          );
          // Another runtime may have completed the migration while this one
          // waited for the shared advisory lock.
          if (await this.isAgentScopeSchemaReady(tx)) return;
          await tx.execute(sql`CREATE SCHEMA IF NOT EXISTS "workflow"`);
          await tx.execute(sql`
          CREATE TABLE IF NOT EXISTS "workflow"."credential_mappings" (
            "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            "user_id" text NOT NULL,
            "cred_type" text NOT NULL,
            "workflow_credential_id" text NOT NULL,
            "created_at" timestamp DEFAULT now() NOT NULL,
            "updated_at" timestamp DEFAULT now() NOT NULL
          )
        `);
          await tx.execute(sql`
          CREATE TABLE IF NOT EXISTS "workflow"."embedded_workflows" (
            "id" text PRIMARY KEY,
            "name" text NOT NULL,
            "active" boolean DEFAULT false NOT NULL,
            "workflow" jsonb NOT NULL,
            "created_at" text NOT NULL,
            "updated_at" text NOT NULL,
            "version_id" text NOT NULL
          )
        `);
          await tx.execute(sql`
          CREATE TABLE IF NOT EXISTS "workflow"."workflow_revisions" (
            "id" text PRIMARY KEY,
            "workflow_id" text NOT NULL,
            "version_id" text NOT NULL,
            "name" text NOT NULL,
            "active" boolean DEFAULT false NOT NULL,
            "workflow" jsonb NOT NULL,
            "created_at" text NOT NULL,
            "updated_at" text NOT NULL,
            "captured_at" text NOT NULL,
            "operation" text NOT NULL
          )
        `);
          await tx.execute(sql`
          CREATE TABLE IF NOT EXISTS "workflow"."embedded_executions" (
            "id" text PRIMARY KEY,
            "workflow_id" text NOT NULL,
            "status" text NOT NULL,
            "mode" text NOT NULL,
            "finished" boolean DEFAULT false NOT NULL,
            "started_at" text NOT NULL,
            "stopped_at" text,
            "execution" jsonb NOT NULL,
            "idempotency_key" text,
            "execution_owner_id" text,
            "execution_lease_expires_at" timestamp with time zone
          )
        `);
          // These additive columns keep rolling upgrades compatible with
          // execution rows written before durable claims and leases existed.
          await tx.execute(sql`
          ALTER TABLE "workflow"."embedded_executions"
          ADD COLUMN IF NOT EXISTS "idempotency_key" text
        `);
          await tx.execute(sql`
          ALTER TABLE "workflow"."embedded_executions"
          ADD COLUMN IF NOT EXISTS "execution_owner_id" text
        `);
          await tx.execute(sql`
          ALTER TABLE "workflow"."embedded_executions"
          ADD COLUMN IF NOT EXISTS "execution_lease_expires_at" timestamp with time zone
        `);
          await tx.execute(sql`
          ALTER TABLE "workflow"."embedded_executions"
          ALTER COLUMN "execution_lease_expires_at" TYPE timestamp with time zone
          USING "execution_lease_expires_at"::timestamp with time zone
        `);
          await tx.execute(sql`
          CREATE TABLE IF NOT EXISTS "workflow"."embedded_credentials" (
            "id" text PRIMARY KEY,
            "name" text NOT NULL,
            "type" text NOT NULL,
            "data" jsonb NOT NULL,
            "is_resolvable" boolean DEFAULT true NOT NULL,
            "created_at" text NOT NULL,
            "updated_at" text NOT NULL
          )
        `);
          await tx.execute(sql`
          CREATE TABLE IF NOT EXISTS "workflow"."embedded_tags" (
            "id" text PRIMARY KEY,
            "name" text NOT NULL,
            "created_at" text NOT NULL,
            "updated_at" text NOT NULL
          )
        `);
          const tenantTables = [
            ['credential_mappings', 'credential_mappings_pkey', 'credential_mappings_tenant_pkey'],
            ['embedded_workflows', 'embedded_workflows_pkey', 'embedded_workflows_tenant_pkey'],
            ['workflow_revisions', 'workflow_revisions_pkey', 'workflow_revisions_tenant_pkey'],
            ['embedded_executions', 'embedded_executions_pkey', 'embedded_executions_tenant_pkey'],
            [
              'embedded_credentials',
              'embedded_credentials_pkey',
              'embedded_credentials_tenant_pkey',
            ],
            ['embedded_tags', 'embedded_tags_pkey', 'embedded_tags_tenant_pkey'],
          ] as const;

          for (const [tableName, legacyPrimaryKey, tenantPrimaryKey] of tenantTables) {
            const qualifiedTable = `"workflow"."${tableName}"`;
            await tx.execute(
              sql.raw(`ALTER TABLE ${qualifiedTable} ADD COLUMN IF NOT EXISTS "agent_id" text`)
            );
            await tx.execute(
              sql.raw(
                `UPDATE ${qualifiedTable} SET "agent_id" = '${LEGACY_UNSCOPED_WORKFLOW_AGENT_ID}' WHERE "agent_id" IS NULL`
              )
            );
            // Retaining the sentinel default makes a rolling upgrade fail closed:
            // an older writer can create only quarantined rows, never live-tenant rows.
            await tx.execute(
              sql.raw(
                `ALTER TABLE ${qualifiedTable} ALTER COLUMN "agent_id" SET DEFAULT '${LEGACY_UNSCOPED_WORKFLOW_AGENT_ID}'`
              )
            );
            await tx.execute(
              sql.raw(`ALTER TABLE ${qualifiedTable} ALTER COLUMN "agent_id" SET NOT NULL`)
            );
            await tx.execute(
              sql.raw(
                `ALTER TABLE ${qualifiedTable} DROP CONSTRAINT IF EXISTS "${legacyPrimaryKey}"`
              )
            );
            await tx.execute(
              sql.raw(`
                DO $$
                BEGIN
                  IF NOT EXISTS (
                    SELECT 1
                    FROM pg_constraint
                    WHERE conname = '${tenantPrimaryKey}'
                      AND conrelid = '${qualifiedTable}'::regclass
                  ) THEN
                    ALTER TABLE ${qualifiedTable}
                    ADD CONSTRAINT "${tenantPrimaryKey}" PRIMARY KEY ("agent_id", "id");
                  END IF;
                END
                $$
              `)
            );
          }

          const legacyIndexes = [
            'idx_user_cred',
            'idx_embedded_workflows_active',
            'idx_embedded_workflows_updated_at',
            'idx_workflow_revisions_workflow_id',
            'idx_workflow_revisions_workflow_version',
            'idx_workflow_revisions_captured_at',
            'idx_embedded_executions_workflow_id',
            'idx_embedded_executions_status',
            'idx_embedded_executions_started_at',
            'idx_embedded_executions_idempotency_key',
            'idx_embedded_credentials_type',
            'idx_embedded_tags_name',
          ] as const;
          for (const indexName of legacyIndexes) {
            await tx.execute(sql.raw(`DROP INDEX IF EXISTS "workflow"."${indexName}"`));
          }

          const tenantIndexes = [
            `CREATE UNIQUE INDEX IF NOT EXISTS "idx_credential_mappings_agent_user_cred" ON "workflow"."credential_mappings" ("agent_id", "user_id", "cred_type")`,
            `CREATE INDEX IF NOT EXISTS "idx_embedded_workflows_agent_active" ON "workflow"."embedded_workflows" ("agent_id", "active")`,
            `CREATE INDEX IF NOT EXISTS "idx_embedded_workflows_agent_updated_at" ON "workflow"."embedded_workflows" ("agent_id", "updated_at")`,
            `CREATE INDEX IF NOT EXISTS "idx_workflow_revisions_agent_workflow_id" ON "workflow"."workflow_revisions" ("agent_id", "workflow_id")`,
            `CREATE UNIQUE INDEX IF NOT EXISTS "idx_workflow_revisions_agent_workflow_version" ON "workflow"."workflow_revisions" ("agent_id", "workflow_id", "version_id")`,
            `CREATE INDEX IF NOT EXISTS "idx_workflow_revisions_agent_captured_at" ON "workflow"."workflow_revisions" ("agent_id", "captured_at")`,
            `CREATE INDEX IF NOT EXISTS "idx_embedded_executions_agent_workflow_id" ON "workflow"."embedded_executions" ("agent_id", "workflow_id")`,
            `CREATE INDEX IF NOT EXISTS "idx_embedded_executions_agent_status" ON "workflow"."embedded_executions" ("agent_id", "status")`,
            `CREATE INDEX IF NOT EXISTS "idx_embedded_executions_agent_started_at" ON "workflow"."embedded_executions" ("agent_id", "started_at")`,
            `CREATE INDEX IF NOT EXISTS "idx_embedded_executions_agent_idempotency_key" ON "workflow"."embedded_executions" ("agent_id", "idempotency_key")`,
            `CREATE INDEX IF NOT EXISTS "idx_embedded_executions_agent_recovery_lease" ON "workflow"."embedded_executions" ("agent_id", "finished", "status", "execution_lease_expires_at")`,
            `CREATE INDEX IF NOT EXISTS "idx_embedded_credentials_agent_type" ON "workflow"."embedded_credentials" ("agent_id", "type")`,
            `CREATE UNIQUE INDEX IF NOT EXISTS "idx_embedded_tags_agent_name" ON "workflow"."embedded_tags" ("agent_id", "name")`,
          ] as const;
          for (const statement of tenantIndexes) {
            await tx.execute(sql.raw(statement));
          }
        });
      })();
    }
    await this.schemaReady;
  }

  async createWorkflow(workflow: WorkflowDefinition): Promise<WorkflowDefinitionResponse> {
    this.assertRegisteredNodes(workflow);
    this.assertHostSupports(workflow);
    await this.ensureSchema();
    const db = this.getDb();
    const id = workflow.id || randomUUID();
    const createdAt = nowIso();
    const versionId = randomUUID();
    const stored = normalizeWorkflowPayload(workflow, id, false);
    await db.insert(embeddedWorkflows).values({
      agentId: this.tenantAgentId,
      id,
      name: stored.name,
      active: false,
      createdAt,
      updatedAt: createdAt,
      versionId,
      workflow: stored,
    });
    return responseFromWorkflow(stored, createdAt, createdAt, versionId);
  }

  async updateWorkflow(
    id: string,
    workflow: WorkflowDefinition
  ): Promise<WorkflowDefinitionResponse> {
    return this.withWorkflowLifecycleLock(id, () => this.updateWorkflowUnlocked(id, workflow));
  }

  private async updateWorkflowUnlocked(
    id: string,
    workflow: WorkflowDefinition
  ): Promise<WorkflowDefinitionResponse> {
    this.assertRegisteredNodes(workflow);
    const existing = await this.getStoredWorkflow(id);
    const db = this.getDb();
    const updatedAt = nowIso();
    const versionId = randomUUID();
    let stored = normalizeWorkflowPayload(workflow, id, existing.workflow.active ?? false);
    // This CRUD surface has no authenticated principal of its own. The facade
    // stamps new definitions, but updates must carry the already-persisted
    // server-owned routing context rather than trusting reserved caller meta.
    stored = withWorkflowExecutionContext(
      stored,
      readWorkflowExecutionContext(existing.workflow) ?? {}
    );
    this.assertHostSupports(stored);
    if (stored.active) {
      this.assertScheduleActivationAllowed(stored);
      stored = this.resolveManagedScheduleExecutionContext(id, stored).workflow;
    }
    await this.captureWorkflowRevision(id, existing, 'update');
    await db
      .update(embeddedWorkflows)
      .set({
        name: stored.name,
        active: stored.active ?? false,
        workflow: stored,
        updatedAt,
        versionId,
      })
      .where(and(eq(embeddedWorkflows.agentId, this.tenantAgentId), eq(embeddedWorkflows.id, id)));
    try {
      if (stored.active) await this.armSchedules(id);
      else await this.clearSchedules(id);
    } catch (error) {
      // error-policy:J2 restore the workflow row after the scheduler has restored
      // its own snapshot, then surface one lifecycle failure with operation context.
      return this.rollbackWorkflowRowAfterScheduleFailure(id, existing, 'update', error);
    }
    return responseFromWorkflow(stored, existing.createdAt, updatedAt, versionId);
  }

  async listWorkflows(params?: {
    active?: boolean;
    tags?: string[];
    limit?: number;
    cursor?: string;
  }): Promise<{ data: WorkflowDefinitionResponse[]; nextCursor?: string }> {
    await this.ensureSchema();
    const db = this.getDb();
    const rows = await db
      .select()
      .from(embeddedWorkflows)
      .where(eq(embeddedWorkflows.agentId, this.tenantAgentId))
      .orderBy(desc(embeddedWorkflows.updatedAt));
    const data = rows
      .map((row) => ({
        workflow: cloneJson(row.workflow),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        versionId: row.versionId,
      }))
      .filter((entry) => params?.active === undefined || entry.workflow.active === params.active)
      .filter((entry) => {
        if (!params?.tags?.length) return true;
        const tagIds = new Set(entry.workflow.tags?.map((tag) => tag.id) ?? []);
        return params.tags.every((tag) => tagIds.has(tag));
      })
      .map((entry) =>
        responseFromWorkflow(entry.workflow, entry.createdAt, entry.updatedAt, entry.versionId)
      );
    return { data: typeof params?.limit === 'number' ? data.slice(0, params.limit) : data };
  }

  async getWorkflow(id: string): Promise<WorkflowDefinitionResponse> {
    const entry = await this.getStoredWorkflow(id);
    return responseFromWorkflow(entry.workflow, entry.createdAt, entry.updatedAt, entry.versionId);
  }

  async deleteWorkflow(id: string): Promise<void> {
    return this.withWorkflowLifecycleLock(id, () => this.deleteWorkflowUnlocked(id));
  }

  private async deleteWorkflowUnlocked(id: string): Promise<void> {
    await this.ensureSchema();
    const existing = await this.getStoredWorkflow(id);
    const db = this.getDb();
    await this.captureWorkflowRevision(id, existing, 'delete');
    await db
      .delete(embeddedWorkflows)
      .where(and(eq(embeddedWorkflows.agentId, this.tenantAgentId), eq(embeddedWorkflows.id, id)));
    try {
      await this.clearSchedules(id);
    } catch (error) {
      // error-policy:J2 a failed task deletion restores the deleted definition
      // after the scheduler has compensated its own partial mutation.
      return this.rollbackWorkflowRowAfterScheduleFailure(id, existing, 'delete', error);
    }
  }

  async activateWorkflow(id: string): Promise<WorkflowDefinitionResponse> {
    return this.withWorkflowLifecycleLock(id, () => this.activateWorkflowUnlocked(id));
  }

  private async activateWorkflowUnlocked(id: string): Promise<WorkflowDefinitionResponse> {
    const entry = await this.getStoredWorkflow(id);
    const previous: StoredWorkflowRow = {
      ...entry,
      workflow: cloneJson(entry.workflow),
    };
    this.assertHostSupports(entry.workflow);
    this.assertScheduleActivationAllowed(entry.workflow);
    const prepared = this.resolveManagedScheduleExecutionContext(id, entry.workflow).workflow;
    const db = this.getDb();
    await this.captureWorkflowRevision(id, entry, 'activate');
    entry.workflow = prepared;
    entry.workflow.active = true;
    entry.updatedAt = nowIso();
    entry.versionId = randomUUID();
    await db
      .update(embeddedWorkflows)
      .set({
        active: true,
        workflow: entry.workflow,
        updatedAt: entry.updatedAt,
        versionId: entry.versionId,
      })
      .where(and(eq(embeddedWorkflows.agentId, this.tenantAgentId), eq(embeddedWorkflows.id, id)));
    try {
      await this.armSchedules(id);
    } catch (error) {
      // error-policy:J2 keep the prior inactive row aligned with the scheduler's
      // restored task snapshot when activation cannot arm every task.
      return this.rollbackWorkflowRowAfterScheduleFailure(id, previous, 'activate', error);
    }
    return responseFromWorkflow(entry.workflow, entry.createdAt, entry.updatedAt, entry.versionId);
  }

  async deactivateWorkflow(id: string): Promise<WorkflowDefinitionResponse> {
    return this.withWorkflowLifecycleLock(id, () => this.deactivateWorkflowUnlocked(id));
  }

  private async deactivateWorkflowUnlocked(id: string): Promise<WorkflowDefinitionResponse> {
    const entry = await this.getStoredWorkflow(id);
    const previous: StoredWorkflowRow = {
      ...entry,
      workflow: cloneJson(entry.workflow),
    };
    const db = this.getDb();
    await this.captureWorkflowRevision(id, entry, 'deactivate');
    entry.workflow.active = false;
    entry.updatedAt = nowIso();
    entry.versionId = randomUUID();
    await db
      .update(embeddedWorkflows)
      .set({
        active: false,
        workflow: entry.workflow,
        updatedAt: entry.updatedAt,
        versionId: entry.versionId,
      })
      .where(and(eq(embeddedWorkflows.agentId, this.tenantAgentId), eq(embeddedWorkflows.id, id)));
    try {
      await this.clearSchedules(id);
    } catch (error) {
      // error-policy:J2 restore the prior active definition after scheduler
      // compensation so a failed deactivation never strands mismatched state.
      return this.rollbackWorkflowRowAfterScheduleFailure(id, previous, 'deactivate', error);
    }
    return responseFromWorkflow(entry.workflow, entry.createdAt, entry.updatedAt, entry.versionId);
  }

  async updateWorkflowTags(id: string, tagIds: string[]): Promise<WorkflowTag[]> {
    return this.withWorkflowLifecycleLock(id, () => this.updateWorkflowTagsUnlocked(id, tagIds));
  }

  private async updateWorkflowTagsUnlocked(id: string, tagIds: string[]): Promise<WorkflowTag[]> {
    const entry = await this.getStoredWorkflow(id);
    const db = this.getDb();
    const tags: WorkflowTag[] = [];
    for (const tagId of tagIds) {
      const rows = await db
        .select()
        .from(embeddedTags)
        .where(and(eq(embeddedTags.agentId, this.tenantAgentId), eq(embeddedTags.id, tagId)))
        .limit(1);
      const tag = rows[0];
      if (!tag) throw new WorkflowApiError(`Tag not found: ${tagId}`, 404);
      tags.push({ id: tag.id, name: tag.name, createdAt: tag.createdAt, updatedAt: tag.updatedAt });
    }
    await this.captureWorkflowRevision(id, entry, 'tags');
    entry.workflow.tags = cloneJson(tags);
    entry.updatedAt = nowIso();
    entry.versionId = randomUUID();
    await db
      .update(embeddedWorkflows)
      .set({
        workflow: entry.workflow,
        updatedAt: entry.updatedAt,
        versionId: entry.versionId,
      })
      .where(and(eq(embeddedWorkflows.agentId, this.tenantAgentId), eq(embeddedWorkflows.id, id)));
    return cloneJson(tags);
  }

  async listWorkflowRevisions(
    workflowId: string,
    limit = 20
  ): Promise<{ data: WorkflowRevision[] }> {
    await this.ensureSchema();
    const db = this.getDb();
    const rows = await db
      .select()
      .from(workflowRevisions)
      .where(
        and(
          eq(workflowRevisions.agentId, this.tenantAgentId),
          eq(workflowRevisions.workflowId, workflowId)
        )
      )
      .orderBy(desc(workflowRevisions.capturedAt))
      .limit(Math.min(Math.max(1, limit), 50));
    return {
      data: rows.map((row) =>
        revisionFromRow({
          id: row.id,
          workflowId: row.workflowId,
          workflow: row.workflow,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          versionId: row.versionId,
          capturedAt: row.capturedAt,
          operation: row.operation as WorkflowRevisionOperation,
        })
      ),
    };
  }

  async restoreWorkflowRevision(
    workflowId: string,
    versionId: string
  ): Promise<WorkflowDefinitionResponse> {
    return this.withWorkflowLifecycleLock(workflowId, () =>
      this.restoreWorkflowRevisionUnlocked(workflowId, versionId)
    );
  }

  private async restoreWorkflowRevisionUnlocked(
    workflowId: string,
    versionId: string
  ): Promise<WorkflowDefinitionResponse> {
    await this.ensureSchema();
    const db = this.getDb();
    const revisionRows = await db
      .select()
      .from(workflowRevisions)
      .where(
        and(
          eq(workflowRevisions.agentId, this.tenantAgentId),
          eq(workflowRevisions.workflowId, workflowId),
          eq(workflowRevisions.versionId, versionId)
        )
      )
      .limit(1);
    const revision = revisionRows[0];
    if (!revision) {
      throw new WorkflowApiError(`Workflow revision not found: ${workflowId}/${versionId}`, 404);
    }

    const current = await this.getStoredWorkflow(workflowId);
    let restored = normalizeWorkflowPayload(revision.workflow, workflowId, revision.active);
    // Tags carry the live ownership boundary. The first revision is captured
    // before a newly deployed workflow receives its owner tag, so replaying
    // revision content must never replace current authorization metadata.
    if (current.workflow.tags === undefined) delete restored.tags;
    else restored.tags = cloneJson(current.workflow.tags);
    restored = withWorkflowExecutionContext(
      restored,
      readWorkflowExecutionContext(current.workflow) ?? {}
    );
    this.assertRegisteredNodes(restored);
    this.assertHostSupports(restored);
    if (restored.active) {
      this.assertScheduleActivationAllowed(restored);
      restored = this.resolveManagedScheduleExecutionContext(workflowId, restored).workflow;
    }
    await this.captureWorkflowRevision(workflowId, current, 'restore');

    const updatedAt = nowIso();
    const nextVersionId = randomUUID();
    await db
      .update(embeddedWorkflows)
      .set({
        name: restored.name,
        active: restored.active ?? false,
        workflow: restored,
        updatedAt,
        versionId: nextVersionId,
      })
      .where(
        and(eq(embeddedWorkflows.agentId, this.tenantAgentId), eq(embeddedWorkflows.id, workflowId))
      );
    try {
      if (restored.active) await this.armSchedules(workflowId);
      else await this.clearSchedules(workflowId);
    } catch (error) {
      // error-policy:J2 revision restore is one lifecycle operation across the
      // workflow row and task store; compensate both before surfacing failure.
      return this.rollbackWorkflowRowAfterScheduleFailure(workflowId, current, 'restore', error);
    }
    return responseFromWorkflow(restored, current.createdAt, updatedAt, nextVersionId);
  }

  async createCredential(credential: {
    name: string;
    type: string;
    data: Record<string, unknown>;
  }): Promise<WorkflowCredential> {
    await this.ensureSchema();
    const db = this.getDb();
    const id = randomUUID();
    const timestamp = nowIso();
    const stored: StoredCredential = {
      id,
      name: credential.name,
      type: credential.type,
      data: cloneJson(credential.data),
      isResolvable: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await db.insert(embeddedCredentials).values({
      agentId: this.tenantAgentId,
      id,
      name: stored.name,
      type: stored.type,
      data: cloneJson(credential.data),
      isResolvable: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const { data: _data, ...response } = stored;
    return cloneJson(response);
  }

  async deleteCredential(id: string): Promise<void> {
    await this.ensureSchema();
    await this.getDb()
      .delete(embeddedCredentials)
      .where(
        and(eq(embeddedCredentials.agentId, this.tenantAgentId), eq(embeddedCredentials.id, id))
      );
  }

  async listExecutions(params?: {
    workflowId?: string;
    status?: WorkflowExecution['status'];
    limit?: number;
    cursor?: string;
  }): Promise<{ data: WorkflowExecution[]; nextCursor?: string }> {
    await this.ensureSchema();
    const limit = params?.limit;
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      throw new WorkflowApiError('Workflow execution limit must be a positive integer', 400);
    }
    const cursor = params?.cursor ? decodeExecutionCursor(params.cursor) : undefined;
    const query = this.getDb()
      .select()
      .from(embeddedExecutions)
      .where(
        and(
          eq(embeddedExecutions.agentId, this.tenantAgentId),
          params?.workflowId ? eq(embeddedExecutions.workflowId, params.workflowId) : undefined,
          params?.status ? eq(embeddedExecutions.status, params.status) : undefined,
          cursor
            ? or(
                lt(embeddedExecutions.startedAt, cursor.startedAt),
                and(
                  eq(embeddedExecutions.startedAt, cursor.startedAt),
                  lt(embeddedExecutions.id, cursor.id)
                )
              )
            : undefined
        )
      )
      .orderBy(desc(embeddedExecutions.startedAt), desc(embeddedExecutions.id));
    const rows = limit === undefined ? await query : await query.limit(limit + 1);
    const hasMore = limit !== undefined && rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const data = pageRows.map((row) => sanitizeWorkflowExecution(row.execution));
    const last = pageRows.at(-1);
    return {
      data,
      ...(hasMore && last
        ? {
            nextCursor: encodeExecutionCursor({
              version: 1,
              startedAt: last.startedAt,
              id: last.id,
            }),
          }
        : {}),
    };
  }

  async getExecution(id: string): Promise<WorkflowExecution> {
    await this.ensureSchema();
    const rows = await this.getDb()
      .select()
      .from(embeddedExecutions)
      .where(and(eq(embeddedExecutions.agentId, this.tenantAgentId), eq(embeddedExecutions.id, id)))
      .limit(1);
    const execution = rows[0]?.execution;
    if (!execution) throw new WorkflowApiError(`Execution not found: ${id}`, 404);
    return sanitizeWorkflowExecution(execution);
  }

  async deleteExecution(id: string): Promise<void> {
    await this.ensureSchema();
    await this.getDb()
      .delete(embeddedExecutions)
      .where(
        and(eq(embeddedExecutions.agentId, this.tenantAgentId), eq(embeddedExecutions.id, id))
      );
  }

  async listTags(): Promise<{ data: WorkflowTag[] }> {
    await this.ensureSchema();
    const rows = await this.getDb()
      .select()
      .from(embeddedTags)
      .where(eq(embeddedTags.agentId, this.tenantAgentId))
      .orderBy(embeddedTags.name);
    return { data: rows.map((row) => tagFromRow(row)) };
  }

  async createTag(name: string): Promise<WorkflowTag> {
    await this.ensureSchema();
    const db = this.getDb();
    const normalizedName = normalizeTagName(name);
    const timestamp = nowIso();
    const tag = {
      id: randomUUID(),
      name: normalizedName,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const inserted = await db
      .insert(embeddedTags)
      .values({ agentId: this.tenantAgentId, ...tag })
      .onConflictDoNothing({ target: [embeddedTags.agentId, embeddedTags.name] })
      .returning();
    if (inserted[0]) return tagFromRow(inserted[0]);

    const existingRows = await db
      .select()
      .from(embeddedTags)
      .where(
        and(eq(embeddedTags.agentId, this.tenantAgentId), eq(embeddedTags.name, normalizedName))
      )
      .limit(1);
    const existing = existingRows[0];
    if (!existing) {
      throw new ElizaError('Workflow tag conflict did not resolve to a durable row', {
        code: 'WORKFLOW_TAG_CONFLICT_UNRESOLVED',
        context: { agentId: this.tenantAgentId, name: normalizedName },
      });
    }
    return tagFromRow(existing);
  }

  async getOrCreateTag(name: string): Promise<WorkflowTag> {
    await this.ensureSchema();
    const normalizedName = normalizeTagName(name);
    const rows = await this.getDb()
      .select()
      .from(embeddedTags)
      .where(eq(embeddedTags.agentId, this.tenantAgentId));
    // Legacy rows may retain display-case names. New writes use the normalized
    // value covered by the unique index, so concurrent callers share one row.
    const existing = rows.find((tag) => tag.name.toLowerCase() === normalizedName);
    return existing ? tagFromRow(existing) : this.createTag(normalizedName);
  }

  async executeWorkflow(id: string, options: ExecuteOptions = {}): Promise<WorkflowExecution> {
    const result = await this.executeWorkflowWithDedup(id, options);
    return result.execution;
  }

  /**
   * Execute a workflow while reporting whether a durable idempotency claim
   * already existed. The pending row is committed under a transaction-scoped
   * advisory lock before Smithers can perform any node side effects.
   */
  executeWorkflowWithDedup(
    id: string,
    options: ExecuteOptions = {}
  ): Promise<WorkflowExecutionClaimResult> {
    return this.trackExecutionAdmission(async () => {
      const entry = await this.getStoredWorkflow(id);
      this.assertAcceptingExecutions();
      const mode = options.mode ?? 'manual';
      const throwOnError = options.throwOnError ?? true;
      const executionContext = resolveWorkflowExecutionContext(entry.workflow, {
        ownerEntityId: options.ownerEntityId,
        sourceRoomId: options.sourceRoomId,
      });
      if (!options.idempotencyKey) {
        return {
          execution: await this.runWorkflow(
            entry.workflow,
            mode,
            options.triggerData,
            undefined,
            throwOnError,
            options.scheduleNodeId,
            executionContext
          ),
          dedup: false,
        };
      }

      const claim = await this.claimIdempotentExecution(
        entry.workflow,
        mode,
        options.triggerData,
        options.idempotencyKey,
        options.scheduleNodeId,
        executionContext
      );
      if (!claim.claimed) {
        return { execution: sanitizeWorkflowExecution(claim.execution), dedup: true };
      }

      return {
        execution: await this.executePendingWorkflow(
          entry.workflow,
          claim.execution,
          options.triggerData,
          options.idempotencyKey,
          throwOnError
        ),
        dedup: false,
      };
    });
  }

  /**
   * Look up the most recent execution row tagged with this idempotency
   * key for the given workflow. Returns null when none exists. The
   * dispatch layer uses this to dedup repeated delivery of one scheduled
   * occurrence — see WorkflowDispatchService.execute.
   */
  async findExecutionByIdempotencyKey(
    workflowId: string,
    idempotencyKey: string
  ): Promise<WorkflowExecution | null> {
    await this.ensureSchema();
    const rows = await this.getDb()
      .select()
      .from(embeddedExecutions)
      .where(
        and(
          eq(embeddedExecutions.agentId, this.tenantAgentId),
          eq(embeddedExecutions.workflowId, workflowId),
          eq(embeddedExecutions.idempotencyKey, idempotencyKey)
        )
      )
      .orderBy(desc(embeddedExecutions.startedAt))
      .limit(1);
    const row = rows[0];
    return row ? sanitizeWorkflowExecution(row.execution) : null;
  }

  executeWebhook(
    path: string,
    payload: Record<string, unknown>,
    method = 'POST'
  ): Promise<WorkflowExecution> {
    return this.trackExecutionAdmission(async () => {
      await this.ensureSchema();
      const normalizedPath = normalizeWebhookPath(path);
      const normalizedMethod = method.toUpperCase();
      const rows = await this.getDb()
        .select()
        .from(embeddedWorkflows)
        .where(
          and(eq(embeddedWorkflows.agentId, this.tenantAgentId), eq(embeddedWorkflows.active, true))
        );
      this.assertAcceptingExecutions();

      for (const row of rows) {
        const workflow = cloneJson(row.workflow);
        const webhookNode = workflow.nodes.find((node) => {
          if (node.disabled || node.type !== 'workflows-nodes-base.webhook') return false;
          const nodePath = normalizeWebhookPath(node.parameters.path);
          const nodeMethod = readString(node.parameters.httpMethod, 'POST').toUpperCase();
          return nodePath === normalizedPath && nodeMethod === normalizedMethod;
        });
        if (!webhookNode) continue;
        webhookNode.parameters = {
          ...webhookNode.parameters,
          __embeddedPayload: {
            ...payload,
            headers: isRecord(payload.headers) ? payload.headers : {},
            method: normalizedMethod,
            path: normalizedPath,
          },
        };
        return this.runWorkflow(workflow, 'webhook');
      }

      throw new WorkflowApiError(`Webhook not found: ${normalizedMethod} /${normalizedPath}`, 404);
    });
  }

  triggerSchedulesOnce(workflowId?: string): Promise<WorkflowExecution[]> {
    return this.trackExecutionAdmission(async () => {
      // Fire scheduled workflows once on demand (used by tests / debug). Reads
      // active workflows directly from the DB rather than from in-process state
      // because scheduling state now lives in core's task table.
      const executions: WorkflowExecution[] = [];
      if (workflowId) {
        const entry = await this.getStoredWorkflow(workflowId);
        this.assertAcceptingExecutions();
        if (!entry.workflow.active) return executions;
        executions.push(await this.runWorkflow(entry.workflow, 'trigger'));
        return executions;
      }
      await this.ensureSchema();
      const rows = await this.getDb()
        .select()
        .from(embeddedWorkflows)
        .where(
          and(eq(embeddedWorkflows.agentId, this.tenantAgentId), eq(embeddedWorkflows.active, true))
        );
      this.assertAcceptingExecutions();
      for (const row of rows) {
        const wf = cloneJson(row.workflow);
        executions.push(await this.runWorkflow(wf, 'trigger'));
      }
      return executions;
    });
  }

  private async captureWorkflowRevision(
    workflowId: string,
    entry: StoredWorkflowRow,
    operation: WorkflowRevisionOperation
  ): Promise<void> {
    await this.ensureSchema();
    await this.getDb()
      .insert(workflowRevisions)
      .values({
        agentId: this.tenantAgentId,
        id: randomUUID(),
        workflowId,
        versionId: entry.versionId,
        name: entry.workflow.name,
        active: entry.workflow.active === true,
        workflow: cloneJson(entry.workflow),
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        capturedAt: nowIso(),
        operation,
      })
      .onConflictDoNothing();
  }

  private async getStoredWorkflow(id: string): Promise<StoredWorkflowRow> {
    await this.ensureSchema();
    const rows = await this.getDb()
      .select()
      .from(embeddedWorkflows)
      .where(and(eq(embeddedWorkflows.agentId, this.tenantAgentId), eq(embeddedWorkflows.id, id)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new WorkflowApiError(`Workflow not found: ${id}`, 404);
    return {
      workflow: cloneJson(row.workflow),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      versionId: row.versionId,
    };
  }

  private async restoreStoredWorkflowRow(id: string, entry: StoredWorkflowRow): Promise<void> {
    const workflow = cloneJson(entry.workflow);
    await this.getDb()
      .insert(embeddedWorkflows)
      .values({
        agentId: this.tenantAgentId,
        id,
        name: workflow.name,
        active: workflow.active === true,
        workflow,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        versionId: entry.versionId,
      })
      .onConflictDoUpdate({
        target: [embeddedWorkflows.agentId, embeddedWorkflows.id],
        set: {
          name: workflow.name,
          active: workflow.active === true,
          workflow,
          updatedAt: entry.updatedAt,
          versionId: entry.versionId,
        },
      });
  }

  private async rollbackWorkflowRowAfterScheduleFailure(
    id: string,
    entry: StoredWorkflowRow,
    operation: string,
    error: unknown
  ): Promise<never> {
    try {
      await this.restoreStoredWorkflowRow(id, entry);
    } catch (rollbackError) {
      // error-policy:J2 both failures are needed to diagnose cross-store drift;
      // neither a failed schedule mutation nor a failed DB rollback is optional.
      throw new ElizaError('Workflow row and schedule rollback both failed', {
        code: 'WORKFLOW_LIFECYCLE_ROLLBACK_FAILED',
        cause: new AggregateError([error, rollbackError]),
        context: { workflowId: id, operation },
      });
    }
    throw new ElizaError(`Workflow ${operation} failed and was rolled back`, {
      code: 'WORKFLOW_LIFECYCLE_RECONCILE_FAILED',
      cause: error,
      context: { workflowId: id, operation },
    });
  }

  private assertRegisteredNodes(workflow: WorkflowDefinition): void {
    const missing = workflow.nodes
      .filter((node) => !node.disabled && !this.nodeTypes.has(node.type))
      .map((node) => `${node.name} (${node.type})`);
    if (missing.length > 0) {
      throw new WorkflowApiError(
        `Embedded workflow runtime does not support node(s): ${missing.join(', ')}`,
        400
      );
    }
  }

  /**
   * Verify the host can host every active node's capability requirements
   * (fs, inbound, longRunning, childProcess, net). On failure, throw a
   * 400 with one actionable line per offending node.
   */
  private assertHostSupports(workflow: WorkflowDefinition): void {
    const host = this.hostCapabilities;
    const issues: string[] = [];
    for (const node of workflow.nodes) {
      if (node.disabled) continue;
      if (!this.nodeTypes.has(node.type)) continue;
      const nodeType = this.nodeTypes.getByNameAndVersion(node.type);
      const caps = (nodeType.description as { capabilities?: NodeCapabilities }).capabilities;
      if (!caps) continue;
      if (caps.requiresFs && !host.fs) {
        issues.push(
          `${node.name} (${node.type}) needs filesystem access; host '${host.label}' has no fs — run on a server agent`
        );
      }
      if (caps.requiresInbound && !host.inbound) {
        issues.push(
          `${node.name} needs an authenticated, reachable inbound webhook; host '${host.label}' can't receive — pair Eliza Cloud or enable plugin-tunnel`
        );
      }
      if (caps.requiresLongRunning && !host.longRunning) {
        issues.push(
          `${node.name} needs a long-running process; host '${host.label}' is short-lived — schedule via the cloud cron handler`
        );
      }
      if (caps.requiresChildProcess && !host.childProcess) {
        issues.push(
          `${node.name} spawns a child process; not allowed on '${host.label}' — run on a server agent`
        );
      }
      if (caps.requiresNet && !host.net) {
        issues.push(
          `${node.name} needs raw sockets; not available on '${host.label}' — use the HTTP Request node or run on a server agent`
        );
      }
    }
    if (issues.length > 0) {
      throw new WorkflowApiError(
        `Workflow incompatible with host '${host.label}':\n  - ${issues.join('\n  - ')}`,
        400
      );
    }
  }

  /**
   * A scale-to-zero container has no clock while it sleeps, so accepting an
   * active schedule would promise wall-clock delivery the runtime cannot make.
   * Drafting and manual execution remain available; only the lifecycle change
   * that would arm an enabled schedule requires continuous hosting.
   */
  private assertScheduleActivationAllowed(workflow: WorkflowDefinition): void {
    if (!isScaleToZeroCloudRuntime(this.runtime) || !hasEnabledScheduleTrigger(workflow)) return;
    throw new WorkflowApiError(
      'Scheduled workflows require an always-on agent runtime. Confirm continuous billing before activating this workflow.',
      409,
      {
        success: false,
        code: 'workflow_requires_always_on',
        error:
          'Scheduled workflows require an always-on agent runtime. Confirm continuous billing before activating this workflow.',
        capability: 'scheduled_workflows',
        currentExecutionTier: DEDICATED_LAZY_EXECUTION_TIER,
        requiredExecutionTier: 'dedicated-always',
        upgradeRequired: true,
        upgrade: {
          automatic: false,
          available: true,
          requiresContinuousBillingConfirmation: true,
        },
      }
    );
  }

  /** Legacy definitions predate the reserved execution-context field. In
   * managed Cloud, only the complete server-created owner tag for this exact
   * agent is strong enough to migrate one before a schedule is armed. */
  private resolveManagedScheduleExecutionContext(
    workflowId: string,
    workflow: WorkflowDefinition
  ): { workflow: WorkflowDefinition; migrated: boolean } {
    if (!isManagedCloudRuntime(this.runtime) || !hasEnabledScheduleTrigger(workflow)) {
      return { workflow, migrated: false };
    }
    const currentContext = readWorkflowExecutionContext(workflow);
    if (currentContext?.ownerEntityId) return { workflow, migrated: false };

    const owner = resolveCanonicalWorkflowOwnerTag(this.runtime, workflow);
    if (owner.status !== 'resolved') {
      throw workflowOwnerTagMigrationError(workflowId, owner.status);
    }
    return {
      workflow: withWorkflowExecutionContext(workflow, {
        ownerEntityId: owner.ownerEntityId,
        sourceRoomId: currentContext?.sourceRoomId,
      }),
      migrated: true,
    };
  }

  /** Re-create core Tasks for every active workflow on service start.
   *  Tasks themselves persist across restart; this is a reconcile step that
   *  ensures workflows whose schedule changed (or whose tasks were never
   *  created in the first place) end up correctly scheduled.
   *
   *  Also performs a one-shot migration: any pre-existing legacy
   *  `workflow.run` / `workflow.webhook` task rows are deleted so the new
   *  `TRIGGER_DISPATCH` path is the single source of scheduled runs. */
  private async rehydrateSchedules(): Promise<void> {
    await this.ensureSchema();
    await this.deleteLegacyScheduleTasks();
    const rows = await this.getDb()
      .select()
      .from(embeddedWorkflows)
      .where(
        and(eq(embeddedWorkflows.agentId, this.tenantAgentId), eq(embeddedWorkflows.active, true))
      );
    for (const row of rows) {
      if (isScaleToZeroCloudRuntime(this.runtime) && hasEnabledScheduleTrigger(row.workflow)) {
        await this.deactivateWorkflow(row.id);
        const policyError = new ElizaError(
          'Scheduled workflow was deactivated because this Cloud agent scales to zero',
          {
            code: 'WORKFLOW_SCHEDULE_REQUIRES_ALWAYS_ON',
            context: {
              workflowId: row.id,
              currentExecutionTier: DEDICATED_LAZY_EXECUTION_TIER,
              requiredExecutionTier: 'dedicated-always',
            },
            severity: 'ephemeral',
          }
        );
        logger.warn(
          { src: 'plugin:workflow:embedded', workflowId: row.id },
          'Deactivated scheduled workflow on a scale-to-zero Cloud runtime'
        );
        this.runtime.reportError('EmbeddedWorkflowService.rehydrateSchedules', policyError, {
          workflowId: row.id,
          currentExecutionTier: DEDICATED_LAZY_EXECUTION_TIER,
        });
        continue;
      }
      try {
        await this.armSchedules(row.id);
      } catch (error) {
        if (!isWorkflowOwnerTagMigrationError(error)) throw error;
        await this.deactivateWorkflow(row.id);
        logger.warn(
          {
            src: 'plugin:workflow:embedded',
            workflowId: row.id,
            code: WORKFLOW_OWNER_TAG_MIGRATION_REQUIRED_CODE,
          },
          'Deactivated scheduled workflow whose legacy owner could not be migrated safely'
        );
        this.runtime.reportError('EmbeddedWorkflowService.rehydrateSchedules', error, {
          workflowId: row.id,
          code: WORKFLOW_OWNER_TAG_MIGRATION_REQUIRED_CODE,
        });
      }
    }
  }

  /**
   * Seed exactly ONE default workflow on first run, routed through the single
   * scheduler (its `scheduleTrigger` node arms a `TRIGGER_DISPATCH` core Task —
   * the one clock's trigger consumer — not a second scheduling mechanism).
   *
   * Idempotent and deletion-respecting: a persistent per-install cache marker
   * (`DEFAULT_WORKFLOW_SEED_MARKER_CACHE_KEY`) is set the first time the default
   * is seeded and consulted on every boot. Once the marker is present the
   * default is never re-seeded — so a user who deletes it does NOT get a zombie
   * re-seed on the next restart. Seeding also stays a no-op when the default
   * row already exists (covers a pre-marker install that seeded under the old
   * row-existence check). A non-empty workflow store also suppresses seeding:
   * existing installs with user-created workflows are not a first run, even if
   * the default row/marker is missing.
   */
  private async seedDefaultWorkflows(): Promise<void> {
    // Deletion-respecting gate. Three outcomes:
    //  - 'seeded'      → we've already seeded on this install; stop (even if the
    //                    user has since deleted the default).
    //  - 'unavailable' → the cache read FAILED, so we cannot prove this is a
    //                    first run. Fail CLOSED: skip seeding rather than risk
    //                    resurrecting a default the user deleted (the marker
    //                    would have been present but unreadable). A genuine
    //                    first-run install with a healthy cache falls through.
    //  - 'not-seeded'  → no marker (cache healthy, or cache unsupported); seed.
    const seedState = await this.getDefaultWorkflowSeedState();
    if (seedState === 'seeded' || seedState === 'unavailable') return;

    const rows = await this.getDb()
      .select({ id: embeddedWorkflows.id })
      .from(embeddedWorkflows)
      .where(eq(embeddedWorkflows.agentId, this.tenantAgentId))
      .limit(1);
    // Pre-marker install that already has workflows: backfill the marker so
    // future boots take the fast path and the deletion-respecting guard is
    // active. We do NOT roll back or alter these rows on a marker-write
    // failure — they are legitimate existing workflows the user may rely on,
    // not rows we just created. Instead, if the marker cannot be persisted we
    // log and retry the backfill on every subsequent boot until it sticks; the
    // marker-less window is unavoidable for rows that predate the marker, and
    // seeding is still bounded because the non-empty store keeps existing.
    if (rows.length > 0) {
      const backfilled = await this.markDefaultWorkflowsSeeded();
      if (!backfilled) {
        logger.warn(
          { src: 'plugin:workflow:embedded' },
          'Could not backfill default-workflow seed marker for an existing workflow store; will retry next boot'
        );
      }
      return;
    }

    // Upgrade-safety: on an install upgraded from a pre-marker build, a user who
    // deleted the default BEFORE this marker existed has neither a marker NOR a
    // row — which would otherwise look like a first run and re-seed. The delete
    // left a `delete` revision in workflow_revisions, so treat that as the
    // missing deletion signal: if one exists, DO NOT re-seed, and backfill the
    // marker so future boots skip fast without re-querying revisions.
    const priorDeletion = await this.getPriorDefaultWorkflowDeletionState();
    if (priorDeletion === 'deleted') {
      const backfilled = await this.markDefaultWorkflowsSeeded();
      if (!backfilled) {
        logger.warn(
          { src: 'plugin:workflow:embedded' },
          'Prior default-workflow deletion detected but seed marker backfill failed; will retry next boot'
        );
      }
      logger.info(
        { src: 'plugin:workflow:embedded' },
        'Skipped default-workflow seed: a prior deletion revision exists (upgrade-preserved deletion)'
      );
      return;
    }

    const workflow = buildDeviceHealthCheckWorkflow();
    this.assertRegisteredNodes(workflow);
    this.assertHostSupports(workflow);

    // Insert the default row FIRST, then record the marker, and roll the row
    // back if the marker cannot be persisted. This makes the (row, marker) pair
    // effectively atomic across the two stores without a distributed
    // transaction, resolving both failure modes:
    //   - marker-then-row: a mid-way insert failure would leave a marker with
    //     no row → the default is suppressed forever. Avoided.
    //   - row-then-marker (no rollback): a marker-write failure would leave an
    //     active default with no marker → a later delete + healthy-cache reboot
    //     resurrects it as a zombie. Avoided by the rollback below.
    // The end state is always one of: BOTH present (seeded), or NEITHER present
    // (clean not-seeded → retried next boot). A cache-less runtime returns true
    // from markDefaultWorkflowsSeeded (nothing to persist) and relies on the
    // row-existence guard.
    const timestamp = nowIso();
    const versionId = randomUUID();
    const stored = normalizeWorkflowPayload(workflow, DEVICE_HEALTH_CHECK_WORKFLOW_ID, true);
    await this.getDb().insert(embeddedWorkflows).values({
      agentId: this.tenantAgentId,
      id: DEVICE_HEALTH_CHECK_WORKFLOW_ID,
      name: stored.name,
      active: true,
      workflow: stored,
      createdAt: timestamp,
      updatedAt: timestamp,
      versionId,
    });

    const markerPersisted = await this.markDefaultWorkflowsSeeded();
    if (!markerPersisted) {
      // Roll back the just-inserted row so we never leave a marker-less active
      // default behind. Also clear any schedules the insert-path may have armed.
      await this.clearSchedules(DEVICE_HEALTH_CHECK_WORKFLOW_ID);
      await this.getDb()
        .delete(embeddedWorkflows)
        .where(
          and(
            eq(embeddedWorkflows.agentId, this.tenantAgentId),
            eq(embeddedWorkflows.id, DEVICE_HEALTH_CHECK_WORKFLOW_ID)
          )
        );
      logger.warn(
        { src: 'plugin:workflow:embedded' },
        'Rolled back default-workflow seed: could not persist the seed marker (will retry next boot)'
      );
      return;
    }

    await this.runWorkflow(
      stored,
      'manual',
      { source: 'default-workflow-seed' },
      DEVICE_HEALTH_CHECK_RUN_KEY,
      false
    );
  }

  /**
   * Resolve whether the default workflow has been seeded on this install.
   *
   * - `'seeded'`      — the persistent marker is present.
   * - `'not-seeded'`  — no marker and the cache is healthy (or the runtime has
   *   no cache support at all, so there is nothing to lose by seeding).
   * - `'unavailable'` — the cache read FAILED. We cannot distinguish "never
   *   seeded" from "seeded-but-marker-unreadable", so the caller must fail
   *   closed and NOT seed — otherwise a transient cache outage after a user
   *   deletion would resurrect the deleted default. This is the exact zombie
   *   re-seed the marker exists to prevent.
   */
  private async getDefaultWorkflowSeedState(): Promise<'seeded' | 'not-seeded' | 'unavailable'> {
    // No cache support (older runtimes): there is no marker to read and none to
    // resurrect, so treat as a plain first run and let the row-existence check
    // downstream guard against a duplicate.
    if (typeof this.runtime.getCache !== 'function') return 'not-seeded';
    try {
      const marker = await this.runtime.getCache<{ seededAt?: string }>(
        DEFAULT_WORKFLOW_SEED_MARKER_CACHE_KEY
      );
      return marker && typeof marker === 'object' && marker.seededAt ? 'seeded' : 'not-seeded';
    } catch {
      // error-policy:J4 fail closed: a deleted default must not come back just
      // because the cache was momentarily unreadable.
      logger.warn(
        { src: 'plugin:workflow:embedded' },
        'Default-workflow seed marker read failed; skipping seed this boot to preserve any prior deletion'
      );
      return 'unavailable';
    }
  }

  /**
   * Resolve whether workflow_revisions holds a `delete` revision for the
   * default workflow id — the signal that a user deleted it (possibly on a
   * pre-marker build). Used to preserve that deletion across an upgrade so
   * "no marker + no row" is not misread as a first run. This check must fail
   * closed and observably: treating an unreadable deletion history as "none"
   * can resurrect a default workflow the user already deleted.
   */
  private async getPriorDefaultWorkflowDeletionState(): Promise<'deleted' | 'none'> {
    try {
      await this.ensureSchema();
      const rows = await this.getDb()
        .select({ id: workflowRevisions.id })
        .from(workflowRevisions)
        .where(
          and(
            eq(workflowRevisions.agentId, this.tenantAgentId),
            eq(workflowRevisions.workflowId, DEVICE_HEALTH_CHECK_WORKFLOW_ID),
            eq(workflowRevisions.operation, 'delete')
          )
        )
        .limit(1);
      return rows.length > 0 ? 'deleted' : 'none';
    } catch (error) {
      // error-policy:J2 context-adding rethrow; default seeding must fail closed
      // when the deletion-history guard cannot be evaluated.
      const wrapped = new ElizaError('Failed to check prior default-workflow deletion revisions', {
        code: 'WORKFLOW_DEFAULT_SEED_DELETION_CHECK_FAILED',
        cause: error,
        context: { workflowId: DEVICE_HEALTH_CHECK_WORKFLOW_ID },
        severity: 'ephemeral',
      });
      const diagnosticError = toSafeWorkflowExecutionError(wrapped, {
        workflowId: DEVICE_HEALTH_CHECK_WORKFLOW_ID,
      });
      if (typeof this.runtime.reportError === 'function') {
        this.runtime.reportError('EmbeddedWorkflowService.seedDefaultWorkflows', diagnosticError, {
          workflowId: DEVICE_HEALTH_CHECK_WORKFLOW_ID,
        });
      } else {
        logger.error(
          {
            src: 'plugin:workflow:embedded',
            error: serializeWorkflowExecutionError(diagnosticError, {
              workflowId: DEVICE_HEALTH_CHECK_WORKFLOW_ID,
            }),
          },
          'Default-workflow deletion-history check failed'
        );
      }
      throw wrapped;
    }
  }

  /** Persist the once-per-install seed marker.
   *
   * Returns `true` when the marker is durably recorded — or when the runtime
   * has no cache at all, in which case there is no marker to lose and the
   * caller relies on the row-existence guard instead. Returns `false` only when
   * a cache IS present but the write failed; the caller then aborts seeding so
   * we never create an active default that lacks its marker (which a later
   * deletion + healthy-cache reboot would resurrect). */
  private async markDefaultWorkflowsSeeded(): Promise<boolean> {
    if (typeof this.runtime.setCache !== 'function') return true;
    try {
      // setCache is typed `Promise<boolean>`: a `false` result means the write
      // did NOT persist, which we must treat exactly like a thrown failure so
      // the caller rolls back the seeded row (no marker-less default lingers).
      const persisted = await this.runtime.setCache(DEFAULT_WORKFLOW_SEED_MARKER_CACHE_KEY, {
        seededAt: nowIso(),
        workflowId: DEVICE_HEALTH_CHECK_WORKFLOW_ID,
      });
      if (persisted === false) {
        logger.warn(
          { src: 'plugin:workflow:embedded' },
          'Default-workflow seed marker write reported not-persisted'
        );
        return false;
      }
      return true;
    } catch {
      // error-policy:J4 a failed marker write turns into an explicit
      // not-persisted result; the caller rolls back any just-created row.
      logger.warn(
        { src: 'plugin:workflow:embedded' },
        'Failed to persist default-workflow seed marker'
      );
      return false;
    }
  }

  /** Remove legacy `workflow.run` / `workflow.webhook` Tasks left behind
   *  by earlier service versions. Returns the count so callers (and the
   *  migration log) can verify the cleanup. */
  private async deleteLegacyScheduleTasks(): Promise<number> {
    if (
      typeof this.runtime.getTasks !== 'function' ||
      typeof this.runtime.deleteTask !== 'function'
    ) {
      return 0;
    }
    const tasks = await this.runtime.getTasks({
      tags: [WORKFLOW_TASK_TAG],
      agentIds: [this.runtime.agentId],
    });
    if (!tasks.length) return 0;
    let removed = 0;
    for (const task of tasks) {
      if (!task.id) continue;
      if (
        task.name === LEGACY_WORKFLOW_RUN_TASK_NAME ||
        task.name === LEGACY_WORKFLOW_WEBHOOK_TASK_NAME
      ) {
        await this.runtime.deleteTask(task.id);
        removed += 1;
      }
    }
    if (removed > 0) {
      logger.info(
        { src: 'plugin:workflow:embedded', removed },
        `Removed ${removed} legacy workflow task row(s); schedules will re-arm via TRIGGER_DISPATCH`
      );
    }
    return removed;
  }

  /** Build a `TriggerConfig` for a workflow schedule node. The resulting
   *  config is what the agent's `executeTriggerTask` reads off the task
   *  metadata when the scheduler fires. */
  private buildScheduleTrigger(
    workflowId: string,
    workflowName: string,
    scheduleNodeId: string,
    intervalMs: number,
    executionContext: WorkflowExecutionContext | undefined
  ): TriggerConfig {
    const triggerId = stringToUuid(`${workflowId}:schedule:${scheduleNodeId}`);
    return {
      version: TRIGGER_SCHEMA_VERSION,
      triggerId,
      displayName: `Scheduled workflow run: ${workflowName}`,
      instructions: `Run workflow ${workflowName}`,
      triggerType: 'interval',
      enabled: true,
      wakeMode: 'inject_now',
      createdBy: executionContext?.ownerEntityId ?? 'workflow.schedule',
      intervalMs,
      runCount: 0,
      kind: 'workflow',
      workflowId,
      workflowName,
    };
  }

  private scheduleTaskWorkflowId(task: Task): string | undefined {
    return isRecord(task.metadata) && typeof task.metadata.workflowId === 'string'
      ? task.metadata.workflowId
      : undefined;
  }

  private scheduleTaskNodeId(task: Task): string | undefined {
    return isRecord(task.metadata) && typeof task.metadata.scheduleNodeId === 'string'
      ? task.metadata.scheduleNodeId
      : undefined;
  }

  private async listWorkflowScheduleTasks(workflowId: string): Promise<Task[]> {
    if (typeof this.runtime.getTasks !== 'function') return [];
    const tasks = await this.runtime.getTasks({
      tags: [WORKFLOW_TASK_TAG],
      agentIds: [this.runtime.agentId],
    });
    return tasks
      .filter((task) => this.scheduleTaskWorkflowId(task) === workflowId)
      .map((task) => structuredClone(task));
  }

  private buildScheduleTasks(
    workflowId: string,
    workflow: WorkflowDefinition,
    existingTasks: Task[]
  ): Task[] {
    const nowMs = Date.now();
    const executionContext = readWorkflowExecutionContext(workflow);
    const claimedExisting = new Set<Task>();
    return workflow.nodes
      .filter((node) => !node.disabled && node.type === 'workflows-nodes-base.scheduleTrigger')
      .map((node) => {
        const intervalMs = resolveScheduleIntervalMs(node.parameters);
        const scheduleNodeId = resolveScheduleNodeId(workflowId, node);
        const existing = existingTasks.find(
          (task) => !claimedExisting.has(task) && this.scheduleTaskNodeId(task) === scheduleNodeId
        );
        if (existing) claimedExisting.add(existing);
        const existingMetadata = isRecord(existing?.metadata) ? existing.metadata : undefined;
        const existingTrigger = isRecord(existingMetadata?.trigger)
          ? existingMetadata.trigger
          : undefined;
        const existingInterval =
          typeof existingMetadata?.baseInterval === 'number'
            ? existingMetadata.baseInterval
            : existingMetadata?.updateInterval;
        const preservesCadence = existing !== undefined && existingInterval === intervalMs;
        const preservedNextRunAtMs =
          preservesCadence && typeof existingTrigger?.nextRunAtMs === 'number'
            ? existingTrigger.nextRunAtMs
            : undefined;
        const nextRunAtMs = preservedNextRunAtMs ?? nowMs + intervalMs;
        const trigger = this.buildScheduleTrigger(
          workflowId,
          workflow.name,
          scheduleNodeId,
          intervalMs,
          executionContext
        );
        const triggerId =
          preservesCadence && typeof existingTrigger?.triggerId === 'string'
            ? (existingTrigger.triggerId as UUID)
            : trigger.triggerId;
        const idempotencyKey = buildScheduleIdempotencyKey(workflowId, scheduleNodeId, nextRunAtMs);
        return {
          id:
            existing?.id ??
            stringToUuid(`${workflowId}:schedule-task:${encodeURIComponent(scheduleNodeId)}`),
          agentId: this.runtime.agentId,
          ...(executionContext?.ownerEntityId
            ? { entityId: stringToUuid(executionContext.ownerEntityId) }
            : {}),
          name: TRIGGER_TASK_NAME,
          description: trigger.displayName,
          tags: [...TRIGGER_TASK_TAGS, WORKFLOW_TASK_TAG],
          metadata: {
            ...(preservesCadence && existingMetadata ? structuredClone(existingMetadata) : {}),
            blocking: true,
            updatedAt:
              preservesCadence && typeof existingMetadata?.updatedAt === 'number'
                ? existingMetadata.updatedAt
                : nowMs,
            updateInterval: intervalMs,
            baseInterval: intervalMs,
            kind: WORKFLOW_TASK_KIND,
            workflowId,
            scheduleNodeId,
            idempotencyKey,
            ...(executionContext?.ownerEntityId
              ? { ownerEntityId: executionContext.ownerEntityId }
              : {}),
            ...(executionContext?.sourceRoomId
              ? { sourceRoomId: executionContext.sourceRoomId }
              : {}),
            ...(executionContext?.ownerEntityId
              ? {
                  ownership: {
                    ownerEntityId: executionContext.ownerEntityId,
                    ...(executionContext.sourceRoomId
                      ? { sourceRoomId: executionContext.sourceRoomId }
                      : {}),
                  },
                }
              : {}),
            trigger: {
              ...trigger,
              triggerId,
              nextRunAtMs,
            },
          },
        } satisfies Task;
      });
  }

  private comparableScheduleTask(
    task: Task
  ): Pick<Task, 'id' | 'agentId' | 'name' | 'description' | 'tags' | 'metadata'> {
    return {
      id: task.id,
      agentId: task.agentId,
      name: task.name,
      description: task.description,
      tags: task.tags,
      metadata: task.metadata,
    };
  }

  private async restoreScheduleTaskSnapshot(workflowId: string, snapshot: Task[]): Promise<void> {
    const current = await this.listWorkflowScheduleTasks(workflowId);
    if (current.length > 0 && typeof this.runtime.deleteTask !== 'function') {
      throw new Error('Workflow scheduler cannot delete tasks while restoring a snapshot');
    }
    for (const task of current) {
      if (!task.id) throw new Error('Workflow scheduler returned a task without an id');
      await this.runtime.deleteTask(task.id);
    }
    if (snapshot.length > 0 && typeof this.runtime.createTask !== 'function') {
      throw new Error('Workflow scheduler cannot recreate tasks while restoring a snapshot');
    }
    for (const task of snapshot) await this.runtime.createTask(structuredClone(task));
  }

  /** Reconcile one recurring task per schedule node without moving an unchanged
   *  task's durable deadline. Mutations are compensating: any partial failure
   *  restores the exact pre-operation task snapshot before surfacing an error. */
  private async reconcileSchedules(
    workflowId: string,
    workflow: WorkflowDefinition | null
  ): Promise<void> {
    const snapshot = await this.listWorkflowScheduleTasks(workflowId);
    const desired = workflow ? this.buildScheduleTasks(workflowId, workflow, snapshot) : [];
    if (desired.length > 0 && typeof this.runtime.createTask !== 'function') {
      throw new ElizaError('Workflow scheduler is unavailable for an active scheduled workflow', {
        code: 'WORKFLOW_SCHEDULER_UNAVAILABLE',
        context: { workflowId },
      });
    }

    const retained = new Set<Task>();
    const toCreate: Task[] = [];
    for (const desiredTask of desired) {
      const existing = snapshot.find(
        (task) =>
          !retained.has(task) &&
          this.scheduleTaskNodeId(task) === this.scheduleTaskNodeId(desiredTask)
      );
      if (
        existing &&
        isDeepStrictEqual(
          this.comparableScheduleTask(existing),
          this.comparableScheduleTask(desiredTask)
        )
      ) {
        retained.add(existing);
      } else {
        if (existing) retained.add(existing);
        toCreate.push(desiredTask);
      }
    }
    const toDelete = snapshot.filter(
      (task) =>
        !retained.has(task) ||
        toCreate.some(
          (desiredTask) => this.scheduleTaskNodeId(desiredTask) === this.scheduleTaskNodeId(task)
        )
    );
    if (toDelete.length === 0 && toCreate.length === 0) return;
    if (toDelete.length > 0 && typeof this.runtime.deleteTask !== 'function') {
      throw new ElizaError('Workflow scheduler cannot remove obsolete schedule tasks', {
        code: 'WORKFLOW_SCHEDULER_UNAVAILABLE',
        context: { workflowId },
      });
    }

    try {
      for (const task of toDelete) {
        if (!task.id) throw new Error('Workflow scheduler returned a task without an id');
        await this.runtime.deleteTask(task.id);
      }
      for (const task of toCreate) await this.runtime.createTask(task);
    } catch (error) {
      // error-policy:J2 schedule reconciliation is a cross-store boundary; add
      // workflow context only after restoring the pre-operation task snapshot.
      try {
        await this.restoreScheduleTaskSnapshot(workflowId, snapshot);
      } catch (rollbackError) {
        // error-policy:J2 surface both the original scheduler failure and the
        // failed compensation so operators never mistake partial state for safe rollback.
        throw new ElizaError('Workflow schedule reconciliation and rollback both failed', {
          code: 'WORKFLOW_SCHEDULE_ROLLBACK_FAILED',
          cause: new AggregateError([error, rollbackError]),
          context: { workflowId },
        });
      }
      throw new ElizaError('Workflow schedule reconciliation failed and was rolled back', {
        code: 'WORKFLOW_SCHEDULE_RECONCILE_FAILED',
        cause: error,
        context: { workflowId },
      });
    }
  }

  private async armSchedules(workflowId: string): Promise<void> {
    const entry = await this.getStoredWorkflow(workflowId);
    const prepared = this.resolveManagedScheduleExecutionContext(workflowId, entry.workflow);
    if (prepared.migrated) {
      await this.getDb()
        .update(embeddedWorkflows)
        .set({ workflow: prepared.workflow })
        .where(
          and(
            eq(embeddedWorkflows.agentId, this.tenantAgentId),
            eq(embeddedWorkflows.id, workflowId)
          )
        );
      logger.info(
        { src: 'plugin:workflow:embedded', workflowId },
        'Migrated scheduled workflow owner context from its canonical owner tag'
      );
    }
    await this.reconcileSchedules(workflowId, prepared.workflow);
  }

  /** Remove every core Task tagged for this workflow with rollback on a
   *  partially failed delete sequence. */
  private async clearSchedules(workflowId: string): Promise<void> {
    await this.reconcileSchedules(workflowId, null);
  }

  private async savePendingExecution(
    execution: WorkflowExecution,
    idempotencyKey?: string
  ): Promise<void> {
    await this.ensureSchema();
    const key = idempotencyKey ?? null;
    await this.getDb()
      .insert(embeddedExecutions)
      .values({
        agentId: this.tenantAgentId,
        id: execution.id,
        workflowId: execution.workflowId,
        status: execution.status,
        mode: execution.mode,
        finished: execution.finished,
        startedAt: execution.startedAt,
        stoppedAt: execution.stoppedAt ?? null,
        execution: cloneJson(execution),
        idempotencyKey: key,
        executionOwnerId: this.executionOwnerId,
        executionLeaseExpiresAt: sql`CURRENT_TIMESTAMP + (${this.executionLeaseDurationMs} * INTERVAL '1 millisecond')`,
      });
  }

  private async finalizeOwnedExecution(
    execution: WorkflowExecution,
    idempotencyKey?: string
  ): Promise<void> {
    const rows = await this.getDb()
      .update(embeddedExecutions)
      .set({
        workflowId: execution.workflowId,
        status: execution.status,
        mode: execution.mode,
        finished: execution.finished,
        startedAt: execution.startedAt,
        stoppedAt: execution.stoppedAt ?? null,
        execution: cloneJson(execution),
        idempotencyKey: idempotencyKey ?? null,
        executionOwnerId: null,
        executionLeaseExpiresAt: null,
      })
      .where(
        and(
          eq(embeddedExecutions.agentId, this.tenantAgentId),
          eq(embeddedExecutions.id, execution.id),
          eq(embeddedExecutions.executionOwnerId, this.executionOwnerId)
        )
      )
      .returning({ id: embeddedExecutions.id });
    if (rows.length === 0) {
      throw new ElizaError('Workflow execution ownership was lost before finalization', {
        code: 'WORKFLOW_EXECUTION_LEASE_LOST',
        context: { workflowId: execution.workflowId, executionId: execution.id },
      });
    }
  }

  private async renewExecutionLease(executionId: string): Promise<void> {
    const rows = await this.getDb()
      .update(embeddedExecutions)
      .set({
        executionLeaseExpiresAt: sql`CURRENT_TIMESTAMP + (${this.executionLeaseDurationMs} * INTERVAL '1 millisecond')`,
      })
      .where(
        and(
          eq(embeddedExecutions.agentId, this.tenantAgentId),
          eq(embeddedExecutions.id, executionId),
          eq(embeddedExecutions.finished, false),
          eq(embeddedExecutions.status, 'running'),
          eq(embeddedExecutions.executionOwnerId, this.executionOwnerId)
        )
      )
      .returning({ id: embeddedExecutions.id });
    if (rows.length === 0) {
      throw new ElizaError('Workflow execution lease is no longer owned by this runtime', {
        code: 'WORKFLOW_EXECUTION_LEASE_LOST',
        context: { executionId },
      });
    }
  }

  private startExecutionLeaseHeartbeat(
    executionId: string,
    externalSignals: readonly AbortSignal[]
  ): { signal: AbortSignal; stop: () => Promise<void> } {
    const controller = new AbortController();
    const abortListeners = new Map<AbortSignal, () => void>();
    for (const externalSignal of externalSignals) {
      const onExternalAbort = (): void => controller.abort(externalSignal.reason);
      abortListeners.set(externalSignal, onExternalAbort);
      if (externalSignal.aborted) onExternalAbort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    const heartbeat = (async () => {
      while (!controller.signal.aborted) {
        await waitForDelay(EXECUTION_LEASE_HEARTBEAT_MS, controller.signal);
        if (controller.signal.aborted) break;
        try {
          await this.renewExecutionLease(executionId);
        } catch (error) {
          const safeError = toSafeWorkflowExecutionError(error, {
            fallbackCode: 'WORKFLOW_EXECUTION_LEASE_LOST',
            executionId,
          });
          this.runtime.reportError?.('EmbeddedWorkflowService.executionLeaseHeartbeat', safeError, {
            executionId,
          });
          controller.abort(safeError);
        }
      }
    })();
    return {
      signal: controller.signal,
      stop: async () => {
        for (const [externalSignal, onExternalAbort] of abortListeners) {
          externalSignal.removeEventListener('abort', onExternalAbort);
        }
        if (!controller.signal.aborted) controller.abort(new Error('Execution lease stopped'));
        await heartbeat;
      },
    };
  }

  private async claimIdempotentExecution(
    workflowData: WorkflowDefinition,
    mode: WorkflowExecuteMode,
    triggerData: Record<string, unknown> | undefined,
    idempotencyKey: string,
    scheduleNodeId: string | undefined,
    executionContext: WorkflowExecutionContext | undefined
  ): Promise<{ execution: WorkflowExecution; claimed: boolean }> {
    await this.ensureSchema();
    const tenantAgentId = this.tenantAgentId;
    const workflowId = workflowData.id ?? '';
    const lockIdentity = JSON.stringify([tenantAgentId, workflowId, idempotencyKey]);

    return this.getDb().transaction(async (tx) => {
      // The lock serializes claimants without imposing a new unique constraint
      // that would reject historical duplicate rows already present in stores.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockIdentity}))`);
      const existingRows = await tx
        .select()
        .from(embeddedExecutions)
        .where(
          and(
            eq(embeddedExecutions.agentId, tenantAgentId),
            eq(embeddedExecutions.workflowId, workflowId),
            eq(embeddedExecutions.idempotencyKey, idempotencyKey)
          )
        )
        .orderBy(desc(embeddedExecutions.startedAt))
        .limit(1);
      const existing = existingRows[0];
      if (existing) {
        return { execution: sanitizeWorkflowExecution(existing.execution), claimed: false };
      }

      const pending = this.createPendingExecution(
        workflowData,
        mode,
        triggerData,
        idempotencyKey,
        scheduleNodeId,
        executionContext
      );
      await tx.insert(embeddedExecutions).values({
        agentId: tenantAgentId,
        id: pending.id,
        workflowId: pending.workflowId,
        status: pending.status,
        mode: pending.mode,
        finished: pending.finished,
        startedAt: pending.startedAt,
        stoppedAt: pending.stoppedAt ?? null,
        execution: cloneJson(pending),
        idempotencyKey,
        executionOwnerId: this.executionOwnerId,
        executionLeaseExpiresAt: sql`CURRENT_TIMESTAMP + (${this.executionLeaseDurationMs} * INTERVAL '1 millisecond')`,
      });
      return { execution: pending, claimed: true };
    });
  }

  /**
   * Re-drive executions whose host disappeared while Smithers still owns a
   * durable run. The pending row supplies the stable execution id and frozen
   * workflow definition. A shared Smithers backend skips persisted nodes;
   * host-local backends retain at-least-once semantics after lease expiry.
   */
  private startExecutionRecovery(): void {
    const signal = this.recoveryController.signal;
    this.recoveryPromise = (async () => {
      while (!signal.aborted) {
        try {
          await this.recoverUnfinishedExecutions(signal);
        } catch (error) {
          if (signal.aborted) return;
          // error-policy:J7 recovery polling is supervised in the background;
          // scan failures remain observable and the durable rows remain eligible.
          const safeError = toSafeWorkflowExecutionError(error);
          this.runtime.reportError?.('EmbeddedWorkflowService.recoverExecutions', safeError, {});
          logger.warn(
            {
              src: 'plugin:workflow:embedded',
              error: serializeWorkflowExecutionError(safeError),
            },
            'unfinished workflow recovery scan failed'
          );
        }
        await waitForDelay(EXECUTION_RECOVERY_POLL_MS, signal);
      }
    })();
  }

  private recoveryEligibility() {
    return or(
      lte(embeddedExecutions.executionLeaseExpiresAt, sql`CURRENT_TIMESTAMP`),
      and(
        isNull(embeddedExecutions.executionLeaseExpiresAt),
        sql`${embeddedExecutions.startedAt}::timestamp with time zone <= CURRENT_TIMESTAMP - (${this.executionLeaseDurationMs} * INTERVAL '1 millisecond')`
      )
    );
  }

  private async claimExecutionForRecovery(executionId: string) {
    const rows = await this.getDb()
      .update(embeddedExecutions)
      .set({
        executionOwnerId: this.executionOwnerId,
        executionLeaseExpiresAt: sql`CURRENT_TIMESTAMP + (${this.executionLeaseDurationMs} * INTERVAL '1 millisecond')`,
      })
      .where(
        and(
          eq(embeddedExecutions.agentId, this.tenantAgentId),
          eq(embeddedExecutions.id, executionId),
          eq(embeddedExecutions.finished, false),
          eq(embeddedExecutions.status, 'running'),
          this.recoveryEligibility()
        )
      )
      .returning();
    return rows[0];
  }

  private async deferOwnedExecutionRecovery(executionId: string, delayMs: number): Promise<void> {
    await this.getDb()
      .update(embeddedExecutions)
      .set({
        executionOwnerId: null,
        executionLeaseExpiresAt: sql`CURRENT_TIMESTAMP + (${delayMs} * INTERVAL '1 millisecond')`,
      })
      .where(
        and(
          eq(embeddedExecutions.agentId, this.tenantAgentId),
          eq(embeddedExecutions.id, executionId),
          eq(embeddedExecutions.executionOwnerId, this.executionOwnerId)
        )
      );
  }

  private async releaseExecutionForShutdown(executionId: string): Promise<void> {
    try {
      await this.deferOwnedExecutionRecovery(executionId, 0);
    } catch (cause) {
      // error-policy:J2 a clean stop must not conceal a failed durable handoff;
      // preserve the database cause and make stop() fail observably.
      const error = new ElizaError('Workflow shutdown could not release its execution lease', {
        code: 'WORKFLOW_SHUTDOWN_LEASE_RELEASE_FAILED',
        cause,
        context: { executionId },
      });
      this.shutdownCleanupErrors.push(error);
      throw error;
    }
  }

  private async recoverUnfinishedExecutions(signal: AbortSignal): Promise<void> {
    const rows = await this.getDb()
      .select()
      .from(embeddedExecutions)
      .where(
        and(
          eq(embeddedExecutions.agentId, this.tenantAgentId),
          eq(embeddedExecutions.finished, false),
          eq(embeddedExecutions.status, 'running'),
          this.recoveryEligibility()
        )
      )
      .orderBy(embeddedExecutions.startedAt);

    for (const row of rows) {
      signal.throwIfAborted();
      const claimed = await this.claimExecutionForRecovery(row.id);
      if (!claimed) continue;
      const pending = cloneJson(claimed.execution);
      try {
        const workflow =
          readSmithersResumeWorkflow(pending) ??
          (await this.getStoredWorkflow(claimed.workflowId)).workflow;
        const triggerData = isRecord(pending.customData?.triggerData)
          ? cloneJson(pending.customData.triggerData)
          : undefined;
        const recovered = await this.executePendingWorkflow(
          workflow,
          pending,
          triggerData,
          claimed.idempotencyKey ?? undefined,
          true,
          false,
          signal
        );
        logger.info(
          {
            src: 'plugin:workflow:embedded',
            workflowId: claimed.workflowId,
            executionId: claimed.id,
            status: recovered.status,
          },
          'recovered unfinished workflow execution'
        );
      } catch (error) {
        if (signal.aborted) {
          await this.releaseExecutionForShutdown(claimed.id);
        } else {
          await this.deferOwnedExecutionRecovery(claimed.id, EXECUTION_RECOVERY_RETRY_MS);
        }
        if (signal.aborted) throw error;
        // error-policy:J7 a failed startup recovery remains `running` so a later
        // startup can retry it; report the failed attempt without fabricating a
        // terminal workflow result.
        const safeError = toSafeWorkflowExecutionError(error, {
          workflowId: claimed.workflowId,
          executionId: claimed.id,
        });
        this.runtime.reportError?.('EmbeddedWorkflowService.recoverExecution', safeError, {
          workflowId: claimed.workflowId,
          executionId: claimed.id,
        });
        logger.warn(
          {
            src: 'plugin:workflow:embedded',
            workflowId: claimed.workflowId,
            executionId: claimed.id,
            error: serializeWorkflowExecutionError(safeError, {
              workflowId: claimed.workflowId,
              executionId: claimed.id,
            }),
          },
          'unfinished workflow recovery failed; execution remains resumable'
        );
      }
    }
  }

  private buildIncomingConnections(
    workflowData: WorkflowDefinition
  ): Map<string, IncomingConnection[]> {
    const incoming = new Map<string, IncomingConnection[]>();
    for (const [source, outputsByType] of Object.entries(workflowData.connections)) {
      const mainOutputs = outputsByType.main;
      mainOutputs.forEach((connections, sourceOutputIndex) => {
        for (const connection of connections) {
          if (connection.type !== 'main') continue;
          const destination = incoming.get(connection.node) ?? [];
          destination.push({
            source,
            sourceOutputIndex,
            destinationInputIndex: connection.index,
          });
          incoming.set(connection.node, destination);
        }
      });
    }
    return incoming;
  }

  private resolveStartNodes(
    workflowData: WorkflowDefinition,
    mode: WorkflowExecuteMode,
    incoming: Map<string, IncomingConnection[]>,
    scheduleNodeId?: string
  ): { startNodes: Set<string>; matchedModeTrigger: boolean } {
    const enabledNodes = workflowData.nodes.filter((node) => !node.disabled);
    const start = new Set<string>();

    if (mode === 'webhook') {
      for (const node of enabledNodes) {
        if (
          node.type === 'workflows-nodes-base.webhook' &&
          isRecord(node.parameters.__embeddedPayload)
        ) {
          start.add(node.name);
        }
      }
      if (start.size === 0) {
        for (const node of enabledNodes) {
          if (node.type === 'workflows-nodes-base.webhook') start.add(node.name);
        }
      }
    } else if (mode === 'trigger') {
      const scheduleNodes = enabledNodes.filter(
        (node) => node.type === 'workflows-nodes-base.scheduleTrigger'
      );
      if (scheduleNodeId) {
        const workflowId = workflowData.id ?? workflowData.name;
        const matched = scheduleNodes.find(
          (node) => resolveScheduleNodeId(workflowId, node) === scheduleNodeId
        );
        if (!matched) {
          throw new ElizaError('Scheduled workflow dispatch referenced an unknown schedule node', {
            code: 'WORKFLOW_SCHEDULE_NODE_NOT_FOUND',
            context: { workflowId, scheduleNodeId },
          });
        }
        start.add(matched.name);
      } else {
        // Explicit trigger-mode debug runs do not originate from a scheduled
        // task, so they intentionally exercise every schedule branch.
        for (const node of scheduleNodes) start.add(node.name);
      }
    } else {
      for (const node of enabledNodes) {
        if (node.type === 'workflows-nodes-base.manualTrigger') start.add(node.name);
      }
    }

    const matchedModeTrigger = start.size > 0;
    if (start.size === 0) {
      for (const node of enabledNodes) {
        if ((incoming.get(node.name) ?? []).length === 0) start.add(node.name);
      }
    }

    return { startNodes: start, matchedModeTrigger };
  }

  private collectReachableNodeNames(
    workflowData: WorkflowDefinition,
    startNodes: Set<string>,
    enabledNodeNames: Set<string>
  ): Set<string> {
    const reachable = new Set(startNodes);
    const queue = [...startNodes];

    while (queue.length > 0) {
      const source = queue.shift();
      if (!source) continue;
      const mainOutputs = workflowData.connections[source]?.main ?? [];
      for (const connections of mainOutputs) {
        for (const connection of connections) {
          if (
            connection.type !== 'main' ||
            !enabledNodeNames.has(connection.node) ||
            reachable.has(connection.node)
          ) {
            continue;
          }
          reachable.add(connection.node);
          queue.push(connection.node);
        }
      }
    }

    return reachable;
  }

  private resolveExecutionPlan(
    workflowData: WorkflowDefinition,
    mode: WorkflowExecuteMode,
    scheduleNodeId?: string
  ): SmithersExecutionPlan {
    const allEnabledNodes = workflowData.nodes.filter((node) => !node.disabled);
    const enabledNodeNames = new Set(allEnabledNodes.map((node) => node.name));
    const allIncoming = this.buildIncomingConnections(workflowData);
    const { startNodes, matchedModeTrigger } = this.resolveStartNodes(
      workflowData,
      mode,
      allIncoming,
      scheduleNodeId
    );
    // A mode-specific trigger is an execution boundary: disconnected trigger
    // branches belong to other invocations and must not leak side effects into
    // this run. Workflows without a matching trigger retain root-node fallback
    // semantics for imported or programmatic graphs.
    const reachableNodeNames = matchedModeTrigger
      ? this.collectReachableNodeNames(workflowData, startNodes, enabledNodeNames)
      : enabledNodeNames;
    const enabledNodes = allEnabledNodes.filter((node) => reachableNodeNames.has(node.name));
    const nodeByName = new Map(enabledNodes.map((node) => [node.name, node]));
    const incoming = new Map<string, IncomingConnection[]>();
    for (const [destination, connections] of allIncoming) {
      if (!reachableNodeNames.has(destination)) continue;
      incoming.set(
        destination,
        connections.filter((connection) => reachableNodeNames.has(connection.source))
      );
    }
    const orderedNodes: WorkflowNode[] = [];
    const executed = new Set<string>();

    while (executed.size < enabledNodes.length) {
      let progressed = false;

      for (const node of enabledNodes) {
        if (executed.has(node.name)) continue;

        const incomingConnections =
          incoming.get(node.name)?.filter((connection) => nodeByName.has(connection.source)) ?? [];
        const isStartNode = startNodes.has(node.name);
        const dependenciesComplete = incomingConnections.every((connection) =>
          executed.has(connection.source)
        );

        if (!isStartNode && !dependenciesComplete) continue;

        orderedNodes.push(node);
        executed.add(node.name);
        progressed = true;
      }

      if (!progressed) {
        const unresolved = enabledNodes
          .filter((node) => !executed.has(node.name))
          .map((node) => node.name)
          .join(', ');
        throw new Error(`Unable to resolve workflow execution order for node(s): ${unresolved}`);
      }
    }

    return {
      enabledNodes: orderedNodes,
      startNodes: [...startNodes],
      incoming: Object.fromEntries(incoming.entries()),
    };
  }

  private async executeNode(
    node: WorkflowNode,
    inputData: INodeExecutionData[][],
    executionId: string,
    executionContext: WorkflowExecutionContext | undefined,
    signal: AbortSignal
  ): Promise<INodeExecutionData[][]> {
    signal.throwIfAborted();
    // This conditional renewal is the outer-database fencing check. It runs
    // immediately before every delegated node (including every side-effecting
    // node), and the lease it grants outlives Smithers' maximum run deadline.
    await this.renewExecutionLease(executionId);
    signal.throwIfAborted();
    const nodeType = this.nodeTypes.getByNameAndVersion(node.type);
    const context: IExecuteFunctions = {
      getNode: () => node,
      getInputData: (inputIndex = 0) => inputData[inputIndex] ?? [],
      getRuntime: () => this.runtime,
      getExecutionId: () => executionId,
      getExecutionContext: () => executionContext,
      getAbortSignal: () => signal,
    };
    const output = await nodeType.execute.call(context);
    signal.throwIfAborted();
    return output.length > 0 ? output : [[]];
  }

  private async runWorkflow(
    workflowData: WorkflowDefinition,
    mode: WorkflowExecuteMode,
    triggerData?: Record<string, unknown>,
    idempotencyKey?: string,
    throwOnError = true,
    scheduleNodeId?: string,
    executionContext?: WorkflowExecutionContext
  ): Promise<WorkflowExecution> {
    const pending = this.createPendingExecution(
      workflowData,
      mode,
      triggerData,
      idempotencyKey,
      scheduleNodeId,
      executionContext
    );
    await this.savePendingExecution(pending, idempotencyKey);

    return this.executePendingWorkflow(
      workflowData,
      pending,
      triggerData,
      idempotencyKey,
      throwOnError
    );
  }

  private createPendingExecution(
    workflowData: WorkflowDefinition,
    mode: WorkflowExecuteMode,
    triggerData?: Record<string, unknown>,
    idempotencyKey?: string,
    scheduleNodeId?: string,
    executionContext?: WorkflowExecutionContext
  ): WorkflowExecution {
    const resolvedContext = resolveWorkflowExecutionContext(workflowData, executionContext);
    const pending: WorkflowExecution = {
      id: randomUUID(),
      finished: false,
      mode,
      startedAt: nowIso(),
      workflowId: workflowData.id ?? '',
      status: 'running',
      customData: {
        ...(triggerData ? { triggerData } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(scheduleNodeId ? { scheduleNodeId } : {}),
        ...(resolvedContext?.ownerEntityId ? { ownerEntityId: resolvedContext.ownerEntityId } : {}),
        ...(resolvedContext?.sourceRoomId ? { sourceRoomId: resolvedContext.sourceRoomId } : {}),
        [SMITHERS_RESUME_STATE_KEY]: {
          version: 1,
          workflow: cloneJson(workflowData),
        } satisfies SmithersResumeState,
      },
    };
    return pending;
  }

  private async executePendingWorkflow(
    workflowData: WorkflowDefinition,
    pending: WorkflowExecution,
    triggerData: Record<string, unknown> | undefined,
    idempotencyKey: string | undefined,
    throwOnError: boolean,
    persistFailure = true,
    signal?: AbortSignal
  ): Promise<WorkflowExecution> {
    if (this.shutdownReason) {
      if (persistFailure) await this.releaseExecutionForShutdown(pending.id);
      throw this.shutdownReason;
    }
    const executionPromise = this.executePendingWorkflowRun(
      workflowData,
      pending,
      triggerData,
      idempotencyKey,
      throwOnError,
      persistFailure,
      signal
    );
    const settlement = executionPromise.then(
      () => undefined,
      () => undefined
    );
    this.activeExecutionSettlements.add(settlement);
    try {
      return await executionPromise;
    } finally {
      this.activeExecutionSettlements.delete(settlement);
    }
  }

  private async executePendingWorkflowRun(
    workflowData: WorkflowDefinition,
    pending: WorkflowExecution,
    triggerData: Record<string, unknown> | undefined,
    idempotencyKey: string | undefined,
    throwOnError: boolean,
    persistFailure: boolean,
    signal?: AbortSignal
  ): Promise<WorkflowExecution> {
    const lease = this.startExecutionLeaseHeartbeat(pending.id, [
      this.executionController.signal,
      ...(signal ? [signal] : []),
    ]);
    let completed: WorkflowExecution | undefined;
    let runFailed = false;
    let runError: unknown;
    try {
      const scheduleNodeId =
        typeof pending.customData?.scheduleNodeId === 'string'
          ? pending.customData.scheduleNodeId
          : undefined;
      const executionContext = readPendingExecutionContext(pending);
      const plan = this.resolveExecutionPlan(workflowData, pending.mode, scheduleNodeId);
      const execution = await runWorkflowWithSmithers({
        tenantId: this.tenantAgentId,
        workflow: workflowData,
        executionId: pending.id,
        pending,
        mode: pending.mode,
        triggerData,
        plan,
        signal: lease.signal,
        runNode: (node, inputData, signal) =>
          this.executeNode(node, inputData, pending.id, executionContext, signal),
      });
      completed = execution;
    } catch (error) {
      runFailed = true;
      runError = error;
    } finally {
      await lease.stop();
    }

    if (runFailed) {
      if (this.executionController.signal.aborted) {
        if (persistFailure) await this.releaseExecutionForShutdown(pending.id);
        throw runError;
      }
      if (!persistFailure) throw runError;
      const safeError = serializeWorkflowExecutionError(runError, {
        workflowId: pending.workflowId,
        executionId: pending.id,
      });
      const failedExecution: WorkflowExecution = {
        ...pending,
        finished: true,
        status: 'error',
        stoppedAt: nowIso(),
        data: {
          resultData: {
            error: safeError,
          },
        },
      };
      await this.finalizeOwnedExecution(failedExecution, idempotencyKey);
      if (!throwOnError) {
        return cloneJson(failedExecution);
      }
      throw toSafeWorkflowExecutionError(runError, {
        workflowId: pending.workflowId,
        executionId: pending.id,
      });
    }

    if (!completed) {
      throw new ElizaError('Workflow execution completed without a result', {
        code: 'WORKFLOW_EXECUTION_RESULT_MISSING',
        context: { workflowId: pending.workflowId, executionId: pending.id },
      });
    }
    await this.finalizeOwnedExecution(completed, idempotencyKey);
    return cloneJson(completed);
  }
}
