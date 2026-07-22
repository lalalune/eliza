/**
 * Adapter that runs a workflow's node graph through the Smithers orchestrator.
 * Translates the plugin's WorkflowDefinition into the Smithers execution plan,
 * spawns a Bun worker (Smithers needs `bun:sqlite`) to run it, and maps the
 * result back to a WorkflowExecution with engine metrics. Definitions and
 * trigger data cross a dedicated pipe so provider secrets and run payloads do
 * not enter the worker environment; each run has a wall-clock deadline.
 *
 * Consumed by EmbeddedWorkflowService as the node-execution backend. Reads
 * optional `SMITHERS_DB_*`, `ELIZA_SMITHERS_TIMEOUT_MS`, and `BUN_BIN` env vars.
 * Failed delegated nodes are echoed before Smithers' wrapper error so execution
 * diagnostics retain the original node error.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ElizaError, logger, resolveStateDir } from '@elizaos/core';
import type {
  WorkflowDefinition,
  WorkflowExecution,
  WorkflowExecutionEngineMetrics,
  WorkflowNode,
} from '../types/index';

interface SmithersNodeExecutionData {
  json: Record<string, unknown>;
  binary?: Record<string, unknown>;
  pairedItem?: { item: number } | Array<{ item: number }>;
}

interface SmithersIncomingConnection {
  source: string;
  sourceOutputIndex: number;
  destinationInputIndex: number;
}

export interface SmithersExecutionPlan {
  enabledNodes: WorkflowNode[];
  startNodes: string[];
  incoming: Record<string, SmithersIncomingConnection[]>;
}

export interface SmithersWorkflowRunOptions {
  tenantId: string;
  workflow: WorkflowDefinition;
  executionId: string;
  pending: WorkflowExecution;
  mode: WorkflowExecution['mode'];
  triggerData?: Record<string, unknown>;
  plan: SmithersExecutionPlan;
  timeoutMs?: number;
  signal?: AbortSignal;
  runNode: (
    node: WorkflowNode,
    inputData: SmithersNodeExecutionData[][],
    signal: AbortSignal
  ) => Promise<SmithersNodeExecutionData[][]>;
}

const DEFAULT_SMITHERS_TIMEOUT_MS = 300_000;
const SMITHERS_WORKER_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'TZ',
  'SYSTEMROOT',
  'WINDIR',
  'PATHEXT',
  'COMSPEC',
] as const;

type SmithersRunMetrics = Omit<WorkflowExecutionEngineMetrics, 'provider'>;

interface SmithersProtocolRequest {
  type: 'executeNode';
  requestId: string;
  nodeName: string;
  inputData: SmithersNodeExecutionData[][];
}

interface SmithersProtocolResponse {
  requestId: string;
  ok: boolean;
  outputData?: SmithersNodeExecutionData[][];
  error?: {
    message: string;
    stack?: string;
    code?: string;
    context?: Record<string, unknown>;
  };
}

interface SmithersProtocolResult {
  type: 'workflowResult';
  execution: WorkflowExecution;
  metrics?: SmithersRunMetrics;
}

function sanitizeWorkflowName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '') || 'workflow';
}

export function resolveSmithersDbPath(tenantId: string, workflowId: string): string {
  if (!tenantId.trim()) {
    throw new ElizaError('Smithers database paths require an agent tenant id', {
      code: 'SMITHERS_TENANT_REQUIRED',
      context: { workflowId },
    });
  }
  const safeTenantId = sanitizeWorkflowName(tenantId);
  const safeId = sanitizeWorkflowName(workflowId || 'anonymous');
  return join(resolveStateDir(), 'smithers', safeTenantId, `${safeId}.sqlite`);
}

function resolveBunBinary(): string {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') return process.execPath;
  return process.env.BUN_BIN || 'bun';
}

/**
 * Resolve the Smithers storage backend configuration from environment variables.
 *
 * SMITHERS_DB_PROVIDER: "sqlite" (default) | "postgres" | "pglite"
 * SMITHERS_DB_URL:      PostgreSQL connection string (used when provider = "postgres")
 * SMITHERS_DB_DATA_DIR: PGlite data directory (used when provider = "pglite")
 *
 * The resolved config is threaded through the subprocess payload so the worker
 * selects the matching durability layer inside its package-local process.
 */
export function resolveSmithersDbConfig(): {
  provider: 'sqlite' | 'postgres' | 'pglite';
  connectionString?: string;
  dataDir?: string;
} {
  const provider = (process.env.SMITHERS_DB_PROVIDER ?? 'sqlite').trim().toLowerCase();
  if (provider !== 'sqlite' && provider !== 'postgres' && provider !== 'pglite') {
    throw new ElizaError(`Unsupported Smithers database provider: ${provider}`, {
      code: 'SMITHERS_DB_PROVIDER_INVALID',
      context: { provider },
    });
  }
  if (provider === 'postgres') {
    const connectionString = process.env.SMITHERS_DB_URL?.trim();
    if (!connectionString) {
      throw new ElizaError('SMITHERS_DB_URL is required for the postgres backend', {
        code: 'SMITHERS_DB_URL_REQUIRED',
        context: { provider },
      });
    }
    return { provider, connectionString };
  }
  if (provider === 'pglite') {
    const dataDir = process.env.SMITHERS_DB_DATA_DIR?.trim();
    if (!dataDir) {
      throw new ElizaError('SMITHERS_DB_DATA_DIR is required for the pglite backend', {
        code: 'SMITHERS_DB_DATA_DIR_REQUIRED',
        context: { provider },
      });
    }
    return { provider, dataDir };
  }
  return { provider };
}

export function resolveSmithersTimeoutMs(explicitTimeoutMs?: number): number {
  const configured =
    explicitTimeoutMs ??
    (process.env.ELIZA_SMITHERS_TIMEOUT_MS
      ? Number(process.env.ELIZA_SMITHERS_TIMEOUT_MS)
      : DEFAULT_SMITHERS_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) {
    throw new ElizaError('Smithers timeout must be a positive number of milliseconds', {
      code: 'SMITHERS_TIMEOUT_INVALID',
      context: { configured },
    });
  }
  return configured;
}

async function resolvePluginRoot(): Promise<string> {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const manifestPath = join(dir, 'package.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: string };
      if (manifest.name === '@elizaos/plugin-workflow') return dir;
    } catch {
      // error-policy:J3 each missing or unreadable manifest is the explicit
      // "not the package root" probe result, so continue walking upward.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new ElizaError('Smithers worker could not locate the plugin package root', {
    code: 'SMITHERS_PLUGIN_ROOT_MISSING',
    context: { runtimeModule: fileURLToPath(import.meta.url) },
  });
}

function toErrorPayload(error: unknown): {
  message: string;
  stack?: string;
  code?: string;
  context?: Record<string, unknown>;
} {
  if (error instanceof ElizaError) {
    return {
      message: error.message,
      stack: error.stack,
      code: error.code,
      context: error.context,
    };
  }
  if (error instanceof Error) return { message: error.message, stack: error.stack };
  if (error !== null && typeof error === 'object') {
    const candidate = error as Record<string, unknown>;
    return {
      message: typeof candidate.message === 'string' ? candidate.message : String(error),
      stack: typeof candidate.stack === 'string' ? candidate.stack : undefined,
      code: typeof candidate.code === 'string' ? candidate.code : undefined,
      context:
        candidate.context !== null && typeof candidate.context === 'object'
          ? (candidate.context as Record<string, unknown>)
          : undefined,
    };
  }
  return { message: String(error) };
}

export function buildSmithersWorkerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SMITHERS_WORKER_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Each run uses a fresh Bun process so Smithers' global runtime and SQLite
 * connection cannot leak state across workflow executions. The worker's physical
 * module path also anchors Bun's dependency resolution to plugin-workflow.
 */
function resolveSmithersWorkerPath(): string {
  const runtimePath = fileURLToPath(import.meta.url);
  const workerExtension = runtimePath.endsWith('.ts') ? 'ts' : 'js';
  return fileURLToPath(new URL(`./smithers-worker.${workerExtension}`, import.meta.url));
}

export async function runWorkflowWithSmithers({
  tenantId,
  workflow,
  executionId,
  pending,
  mode,
  triggerData,
  plan,
  timeoutMs: explicitTimeoutMs,
  signal: externalSignal,
  runNode,
}: SmithersWorkflowRunOptions): Promise<WorkflowExecution> {
  const dbPath = resolveSmithersDbPath(tenantId, workflow.id ?? workflow.name);
  await mkdir(dirname(dbPath), { recursive: true });
  const dbConfig = resolveSmithersDbConfig();

  const payload = JSON.stringify({
    dbPath,
    dbConfig,
    executionId,
    workflowName: sanitizeWorkflowName(workflow.name),
    input: { mode, triggerData: triggerData ?? {}, workflowId: workflow.id ?? '' },
    pending,
    plan,
    triggerData: triggerData ?? {},
    rootDir: process.cwd(),
  });
  const pluginRoot = await resolvePluginRoot();
  const timeoutMs = resolveSmithersTimeoutMs(explicitTimeoutMs);
  const bunBinary = resolveBunBinary();
  const workerPath = resolveSmithersWorkerPath();
  const workerArgs = [`--cwd=${pluginRoot}`, workerPath];
  const proc = spawn(bunBinary, workerArgs, {
    cwd: pluginRoot,
    env: buildSmithersWorkerEnv(),
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  const payloadInput = proc.stdio[3];
  if (!payloadInput || typeof (payloadInput as { end?: unknown }).end !== 'function') {
    proc.kill('SIGKILL');
    throw new ElizaError('Smithers worker payload pipe was not created', {
      code: 'SMITHERS_PAYLOAD_PIPE_MISSING',
      context: { workflowId: workflow.id ?? '', executionId },
    });
  }
  (payloadInput as NodeJS.WritableStream).end(payload);
  const byName = new Map(plan.enabledNodes.map((node) => [node.name, node]));
  let executionResult: WorkflowExecution | null = null;
  let runMetrics: SmithersRunMetrics | null = null;
  let protocolError: ElizaError | null = null;
  const nodeExecutionErrors = new Map<string, unknown>();
  let stdinEnded = false;
  let externallyAborted = externalSignal?.aborted === true;
  const executionAbort = new AbortController();

  const killWorker = (reason: unknown): void => {
    if (!executionAbort.signal.aborted) executionAbort.abort(reason);
    try {
      proc.kill('SIGKILL');
    } catch (error) {
      // error-policy:J6 best-effort worker teardown; close/error remains the
      // authoritative observation for the subprocess lifecycle.
      logger.warn(
        {
          error,
          workflowId: workflow.id ?? '',
          executionId,
        },
        '[SmithersRuntime] Failed to terminate workflow worker'
      );
    }
  };

  const onExternalAbort = (): void => {
    externallyAborted = true;
    killWorker(externalSignal?.reason);
  };
  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const endStdin = (): void => {
    if (stdinEnded) return;
    stdinEnded = true;
    proc.stdin.end();
  };

  const writeResponse = (response: SmithersProtocolResponse): void => {
    if (proc.stdin.writable) proc.stdin.write(`${JSON.stringify(response)}\n`);
  };

  // Node executions are dispatched concurrently so a parallel level's nodes
  // actually run in parallel; their promises are drained before completion.
  const inflight: Promise<void>[] = [];
  const handleLine = (line: string): void => {
    // The subprocess shares stdout with Smithers' own logging; only our protocol
    // JSON is relevant, so ignore anything that isn't an object line.
    const trimmed = line.trim();
    if (trimmed?.[0] !== '{') return;
    let message: SmithersProtocolRequest | SmithersProtocolResult;
    try {
      message = JSON.parse(trimmed) as SmithersProtocolRequest | SmithersProtocolResult;
    } catch {
      return;
    }
    if (message.type === 'workflowResult') {
      if (!message.execution || typeof message.execution !== 'object') {
        protocolError = new ElizaError('Smithers returned an invalid workflow result', {
          code: 'SMITHERS_PROTOCOL_INVALID',
          context: { workflowId: workflow.id ?? '', executionId },
        });
        killWorker(protocolError);
        return;
      }
      executionResult = message.execution;
      runMetrics = message.metrics ?? null;
      endStdin();
      return;
    }
    if (message.type !== 'executeNode') return;
    if (
      typeof message.requestId !== 'string' ||
      typeof message.nodeName !== 'string' ||
      !Array.isArray(message.inputData)
    ) {
      protocolError = new ElizaError('Smithers returned an invalid node execution request', {
        code: 'SMITHERS_PROTOCOL_INVALID',
        context: { workflowId: workflow.id ?? '', executionId },
      });
      killWorker(protocolError);
      return;
    }
    const node = byName.get(message.nodeName);
    if (!node) {
      writeResponse({
        requestId: message.requestId,
        ok: false,
        error: { message: `Smithers requested unknown workflow node "${message.nodeName}"` },
      });
      return;
    }
    inflight.push(
      (async () => {
        try {
          const outputData = await runNode(node, message.inputData, executionAbort.signal);
          nodeExecutionErrors.delete(message.nodeName);
          writeResponse({ requestId: message.requestId, ok: true, outputData });
        } catch (error) {
          if (!executionAbort.signal.aborted) {
            nodeExecutionErrors.set(message.nodeName, error);
          }
          writeResponse({ requestId: message.requestId, ok: false, error: toErrorPayload(error) });
        }
      })()
    );
  };

  let stdoutBuffer = '';
  let stderr = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) handleLine(line);
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  let timedOut = false;
  const exitCode = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      timedOut = true;
      killWorker(new Error(`Smithers workflow deadline exceeded after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.once('error', (error) => {
      clearTimeout(timeout);
      if (!executionAbort.signal.aborted) executionAbort.abort(error);
      reject(error);
    });
    proc.once('close', (code) => {
      clearTimeout(timeout);
      resolve(code ?? 1);
    });
  });
  externalSignal?.removeEventListener('abort', onExternalAbort);
  if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
  if (exitCode === 0) {
    await Promise.all(inflight);
  } else {
    if (!executionAbort.signal.aborted) {
      executionAbort.abort(new Error(`Smithers workflow worker exited with code ${exitCode}`));
    }
    // Cooperative node work should settle promptly after cancellation, while a
    // third-party node that ignores AbortSignal must not hold the API forever.
    const serviceStopRequiresDrain =
      externalSignal?.reason instanceof ElizaError &&
      externalSignal.reason.code === 'WORKFLOW_SERVICE_STOPPED';
    if (serviceStopRequiresDrain) {
      await Promise.allSettled(inflight);
    } else {
      await Promise.race([
        Promise.allSettled(inflight),
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ]);
    }
  }

  endStdin();

  if (protocolError) throw protocolError;
  if (externallyAborted) {
    throw new ElizaError('Smithers workflow execution was aborted', {
      code: 'SMITHERS_WORKFLOW_ABORTED',
      context: { workflowId: workflow.id ?? '', executionId },
      severity: 'ephemeral',
    });
  }
  if (timedOut) {
    throw new ElizaError(`Smithers workflow execution timed out after ${timeoutMs}ms`, {
      code: 'SMITHERS_WORKFLOW_TIMEOUT',
      context: { workflowId: workflow.id ?? '', executionId, timeoutMs },
      severity: 'ephemeral',
    });
  }

  if (exitCode !== 0) {
    const nodeExecutionError = [...nodeExecutionErrors]
      .filter(([nodeName]) => byName.get(nodeName)?.continueOnFail !== true)
      .values()
      .next();
    if (!nodeExecutionError.done) {
      const [nodeName, error] = nodeExecutionError.value;
      const payload = toErrorPayload(error);
      throw new ElizaError(`Node "${nodeName}" failed: ${payload.message}`, {
        code: error instanceof ElizaError ? error.code : 'WORKFLOW_NODE_EXECUTION_FAILED',
        cause: error,
        context:
          error instanceof ElizaError
            ? error.context
            : { workflowId: workflow.id ?? '', executionId, nodeName },
        severity: error instanceof ElizaError ? error.severity : undefined,
      });
    }
    throw new ElizaError(
      `Smithers workflow execution failed: ${stderr.trim() || `exit ${exitCode}`}`,
      {
        code: 'SMITHERS_WORKFLOW_FAILED',
        context: {
          workflowId: workflow.id ?? '',
          executionId,
          exitCode,
          command: `${bunBinary} --cwd=${pluginRoot} ${workerPath}`,
          cwd: pluginRoot,
        },
        severity: 'ephemeral',
      }
    );
  }
  if (!executionResult) {
    throw new ElizaError(
      'Smithers workflow execution completed without returning a workflow result',
      {
        code: 'SMITHERS_WORKFLOW_RESULT_MISSING',
        context: { workflowId: workflow.id ?? '', executionId },
      }
    );
  }
  const completedExecution = executionResult as WorkflowExecution;
  const completedMetrics = runMetrics as SmithersRunMetrics | null;
  const executionWithMetrics: WorkflowExecution = completedExecution.data?.resultData?.engine
    ? completedExecution
    : completedMetrics
      ? {
          ...completedExecution,
          data: {
            ...completedExecution.data,
            resultData: {
              ...completedExecution.data?.resultData,
              engine: {
                provider: 'smithers',
                nodes: completedMetrics.nodes,
                levels: completedMetrics.levels,
                maxConcurrency: completedMetrics.maxConcurrency,
                started: completedMetrics.started,
                finished: completedMetrics.finished,
                failed: completedMetrics.failed,
                skipped: completedMetrics.skipped,
                retries: completedMetrics.retries,
              },
            },
          },
        }
      : completedExecution;

  logger.info(
    {
      src: 'plugin:workflow:smithers',
      workflowId: workflow.id ?? '',
      executionId,
      ...(runMetrics ?? {}),
    },
    'workflow executed'
  );

  return executionWithMetrics;
}
