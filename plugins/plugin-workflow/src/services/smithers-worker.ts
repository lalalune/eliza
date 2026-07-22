/**
 * Package-local Smithers worker process. Its physical module location anchors
 * Bun dependency resolution to plugin-workflow, independent of the launching
 * agent's cwd. Run data arrives over fd 3; node calls and results use the
 * line-delimited stdin/stdout protocol owned by smithers-runtime.
 */

import { writeSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { __builderInternals, Smithers, type WorkflowGraph } from '@smithers-orchestrator/engine';
import { Effect, Schema } from 'effect';
import type { WorkflowNode } from '../types/index';

interface NodeExecutionData {
  json: Record<string, unknown>;
  binary?: Record<string, unknown>;
  pairedItem?: { item: number } | Array<{ item: number }>;
}

type NodeOutputData = NodeExecutionData[][];

interface IncomingConnection {
  source: string;
  sourceOutputIndex: number;
  destinationInputIndex: number;
}

interface WorkerPayload {
  dbPath: string;
  dbConfig:
    | { provider?: 'sqlite' }
    | { provider: 'postgres'; connectionString: string }
    | { provider: 'pglite'; dataDir: string };
  executionId: string;
  workflowName: string;
  input: Record<string, unknown>;
  pending: Record<string, unknown>;
  plan: {
    enabledNodes: WorkflowNode[];
    incoming: Record<string, IncomingConnection[]>;
    startNodes: string[];
  };
  triggerData: Record<string, unknown>;
  rootDir: string;
}

interface ProtocolErrorPayload {
  message?: string;
  stack?: string;
  code?: string;
  context?: Record<string, unknown>;
}

interface ProtocolResponse {
  requestId: string;
  ok: boolean;
  outputData?: NodeOutputData;
  error?: ProtocolErrorPayload;
}

interface PendingRequest {
  resolve: (outputData: NodeOutputData) => void;
  reject: (error: Error) => void;
}

interface NodeFailure {
  nodeName: string;
  message: string;
}

interface StepRunEntry {
  startTime: number;
  executionTime: number;
  data: { main: NodeOutputData };
  source: Array<{
    previousNode: string;
    previousNodeOutput: number;
    previousNodeRun: number;
  }>;
}

interface StepResult {
  nodeName: string;
  outputData: NodeOutputData;
  runEntry: StepRunEntry;
  skipped: boolean;
  retries: number;
}

interface WorkerMetrics {
  nodes: number;
  levels: number;
  maxConcurrency: number;
  started: number;
  finished: number;
  failed: number;
  skipped: number;
  retries: number;
}

interface NodeExecutionError extends Error {
  code?: string;
  context?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function isNodeExecutionData(value: unknown): value is NodeExecutionData {
  return isRecord(value) && isRecord(value.json);
}

function isNodeOutputData(value: unknown): value is NodeOutputData {
  return (
    Array.isArray(value) &&
    value.every(
      (output) => Array.isArray(output) && output.every((item) => isNodeExecutionData(item))
    )
  );
}

function parseIncoming(value: unknown): Record<string, IncomingConnection[]> {
  if (!isRecord(value)) throw new Error('Smithers worker payload has invalid incoming edges');
  const incoming: Record<string, IncomingConnection[]> = {};
  for (const [nodeName, connections] of Object.entries(value)) {
    if (!Array.isArray(connections)) {
      throw new Error(`Smithers worker payload has invalid connections for ${nodeName}`);
    }
    incoming[nodeName] = connections.map((connection) => {
      if (
        !isRecord(connection) ||
        typeof connection.source !== 'string' ||
        typeof connection.sourceOutputIndex !== 'number' ||
        typeof connection.destinationInputIndex !== 'number'
      ) {
        throw new Error(`Smithers worker payload has an invalid edge for ${nodeName}`);
      }
      return {
        source: connection.source,
        sourceOutputIndex: connection.sourceOutputIndex,
        destinationInputIndex: connection.destinationInputIndex,
      };
    });
  }
  return incoming;
}

function parseWorkflowNode(value: unknown): WorkflowNode {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    typeof value.type !== 'string' ||
    typeof value.typeVersion !== 'number' ||
    !Array.isArray(value.position) ||
    value.position.length !== 2 ||
    typeof value.position[0] !== 'number' ||
    typeof value.position[1] !== 'number' ||
    !isRecord(value.parameters)
  ) {
    throw new Error('Smithers worker payload contains an invalid workflow node');
  }
  return {
    ...value,
    name: value.name,
    type: value.type,
    typeVersion: value.typeVersion,
    position: [value.position[0], value.position[1]],
    parameters: value.parameters,
  };
}

function parseWorkerPayload(value: unknown): WorkerPayload {
  if (
    !isRecord(value) ||
    typeof value.dbPath !== 'string' ||
    typeof value.executionId !== 'string' ||
    typeof value.workflowName !== 'string' ||
    !isRecord(value.input) ||
    !isRecord(value.pending) ||
    !isRecord(value.plan) ||
    !Array.isArray(value.plan.enabledNodes) ||
    !Array.isArray(value.plan.startNodes) ||
    !value.plan.startNodes.every((name) => typeof name === 'string') ||
    !isRecord(value.triggerData) ||
    typeof value.rootDir !== 'string'
  ) {
    throw new Error('Smithers worker payload is invalid');
  }
  const rawDbConfig = isRecord(value.dbConfig) ? value.dbConfig : {};
  const provider = rawDbConfig.provider;
  let dbConfig: WorkerPayload['dbConfig'];
  if (provider === 'postgres' && typeof rawDbConfig.connectionString === 'string') {
    dbConfig = { provider, connectionString: rawDbConfig.connectionString };
  } else if (provider === 'pglite' && typeof rawDbConfig.dataDir === 'string') {
    dbConfig = { provider, dataDir: rawDbConfig.dataDir };
  } else if (provider === undefined || provider === 'sqlite') {
    dbConfig = { provider: 'sqlite' };
  } else {
    throw new Error('Smithers worker payload has an invalid database configuration');
  }
  return {
    dbPath: value.dbPath,
    dbConfig,
    executionId: value.executionId,
    workflowName: value.workflowName,
    input: value.input,
    pending: value.pending,
    plan: {
      enabledNodes: value.plan.enabledNodes.map(parseWorkflowNode),
      incoming: parseIncoming(value.plan.incoming),
      startNodes: [...value.plan.startNodes],
    },
    triggerData: value.triggerData,
    rootDir: value.rootDir,
  };
}

function parseProtocolResponse(value: unknown): ProtocolResponse | null {
  if (!isRecord(value) || typeof value.requestId !== 'string' || typeof value.ok !== 'boolean') {
    return null;
  }
  const outputData = value.outputData;
  if (outputData !== undefined && !isNodeOutputData(outputData)) return null;
  const rawError = value.error;
  const error: ProtocolErrorPayload | undefined = isRecord(rawError)
    ? {
        ...(typeof rawError.message === 'string' ? { message: rawError.message } : {}),
        ...(typeof rawError.stack === 'string' ? { stack: rawError.stack } : {}),
        ...(typeof rawError.code === 'string' ? { code: rawError.code } : {}),
        ...(isRecord(rawError.context) ? { context: rawError.context } : {}),
      }
    : undefined;
  return {
    requestId: value.requestId,
    ok: value.ok,
    ...(outputData ? { outputData } : {}),
    ...(error ? { error } : {}),
  };
}

// A pipe may not contain the full payload when the worker reaches this line.
// Awaiting its complete body avoids treating an early partial read as JSON.
let payload: WorkerPayload;
try {
  const parsed: unknown = JSON.parse(await Bun.file(3).text());
  payload = parseWorkerPayload(parsed);
} catch (error) {
  writeSync(2, `${errorMessage(error)}\n`);
  process.exit(1);
}
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const pending = new Map<string, PendingRequest>();
let requestSeq = 0;
const metrics: WorkerMetrics = {
  nodes: 0,
  levels: 0,
  maxConcurrency: 0,
  started: 0,
  finished: 0,
  failed: 0,
  skipped: 0,
  retries: 0,
};
let lastNodeError: NodeFailure | null = null;

function emit(message: Record<string, unknown>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function isStepRunEntry(value: unknown): value is StepRunEntry {
  if (!isRecord(value) || !isRecord(value.data) || !isNodeOutputData(value.data.main)) {
    return false;
  }
  if (
    typeof value.startTime !== 'number' ||
    typeof value.executionTime !== 'number' ||
    !Array.isArray(value.source)
  ) {
    return false;
  }
  return value.source.every(
    (source) =>
      isRecord(source) &&
      typeof source.previousNode === 'string' &&
      typeof source.previousNodeOutput === 'number' &&
      typeof source.previousNodeRun === 'number'
  );
}

function isStepResult(value: unknown): value is StepResult {
  return (
    isRecord(value) &&
    typeof value.nodeName === 'string' &&
    isNodeOutputData(value.outputData) &&
    isStepRunEntry(value.runEntry) &&
    typeof value.skipped === 'boolean' &&
    typeof value.retries === 'number'
  );
}

function currentNodeFailure(): NodeFailure | null {
  return lastNodeError;
}

// Smithers 0.28's public graph-factory declaration incorrectly types `needs`
// as compiled handles even though the factory and compiler consume graph refs.
// Constructing the documented graph expression through the exported helper
// keeps that dependency edge fully typed without assertions.
function makeWorkflowStep(
  id: string,
  needs: Record<string, WorkflowGraph>,
  run: (context: Record<string, unknown>) => Promise<unknown>
): WorkflowGraph {
  return __builderInternals.makeGraph({
    _tag: 'Step',
    id,
    options: {
      output: Schema.Unknown,
      ...(Object.keys(needs).length > 0 ? { needs } : {}),
      run,
    },
  });
}

void (async () => {
  for await (const line of rl) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // error-policy:J3 malformed protocol input is an explicit invalid message;
      // it is ignored without resolving any pending node request as successful.
      continue;
    }
    const response = parseProtocolResponse(parsed);
    if (!response) continue;
    const entry = pending.get(response.requestId);
    if (!entry) continue;
    pending.delete(response.requestId);
    if (!response.ok) {
      const error: NodeExecutionError = new Error(
        response.error?.message ?? 'Node execution failed'
      );
      if (response.error?.stack) error.stack = response.error.stack;
      if (response.error?.code) error.code = response.error.code;
      if (response.error?.context) error.context = response.error.context;
      entry.reject(error);
      continue;
    }
    entry.resolve(response.outputData ?? [[]]);
  }
})();

function sendNodeRequest(nodeName: string, inputData: NodeOutputData): Promise<NodeOutputData> {
  const requestId = String(++requestSeq);
  return new Promise<NodeOutputData>((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    emit({ type: 'executeNode', requestId, nodeName, inputData }).catch((error: unknown) => {
      // error-policy:J1 translate a failed worker-protocol write into the
      // pending node promise observed by the workflow execution boundary.
      pending.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function collectInputData(
  nodeName: string,
  incoming: Record<string, IncomingConnection[]>,
  dependencyResults: Record<string, StepResult>
): NodeOutputData {
  const inputData: NodeOutputData = [];
  for (const connection of incoming[nodeName] ?? []) {
    const dependency = dependencyResults[connection.source];
    if (!dependency) {
      throw new Error(`Missing dependency output for ${connection.source} -> ${nodeName}`);
    }
    const sourceItems = dependency.outputData[connection.sourceOutputIndex] ?? [];
    inputData[connection.destinationInputIndex] = [
      ...(inputData[connection.destinationInputIndex] ?? []),
      ...sourceItems,
    ];
  }
  return inputData.length > 0 ? inputData : [[]];
}

function hasInputItems(inputData: NodeOutputData): boolean {
  return inputData.some((items) => items.length > 0);
}

function makeStepId(index: number, node: WorkflowNode): string {
  const raw = node.id ?? node.name;
  const safe = raw.replace(/[^a-zA-Z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '') || 'node';
  return `${String(index).padStart(4, '0')}-${safe}`;
}

// Smithers parallelizes dependency-depth peers, while level ordering preserves
// the n8n data graph's producer-before-consumer invariant.
function computeLevels(
  enabledNodes: WorkflowNode[],
  incoming: Record<string, IncomingConnection[]>,
  startNodes: Set<string>,
  nodeByName: Map<string, WorkflowNode>
): WorkflowNode[][] {
  const depth = new Map<string, number>();
  for (const node of enabledNodes) {
    const connections = (incoming[node.name] ?? []).filter((connection) =>
      nodeByName.has(connection.source)
    );
    if (startNodes.has(node.name) || connections.length === 0) {
      depth.set(node.name, 0);
      continue;
    }
    let nodeDepth = 0;
    for (const connection of connections) {
      const sourceDepth = depth.get(connection.source);
      if (sourceDepth === undefined) {
        throw new Error(
          `Workflow dependency was not ordered before node: ${connection.source} -> ${node.name}`
        );
      }
      nodeDepth = Math.max(nodeDepth, sourceDepth + 1);
    }
    depth.set(node.name, nodeDepth);
  }
  const levels: WorkflowNode[][] = [];
  for (const node of enabledNodes) {
    const nodeDepth = depth.get(node.name);
    if (nodeDepth === undefined)
      throw new Error(`Workflow node has no dependency depth: ${node.name}`);
    const level = levels[nodeDepth] ?? [];
    level.push(node);
    levels[nodeDepth] = level;
  }
  return levels.filter((level) => level.length > 0);
}

// Retry and continue-on-fail remain node policies; Smithers only supplies the
// durable execution envelope and dependency scheduling.
async function runNodeWithPolicy(
  node: WorkflowNode,
  inputData: NodeOutputData
): Promise<{ outputData: NodeOutputData; retries: number }> {
  const maxAttempts = node.retryOnFail ? Math.max(1, node.maxTries ?? 3) : 1;
  let lastError: Error | null = null;
  let retries = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return { outputData: await sendNodeRequest(node.name, inputData), retries };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      lastNodeError = { nodeName: node.name, message: lastError.message };
      if (attempt < maxAttempts) {
        retries += 1;
        metrics.retries += 1;
        await delay(node.waitBetweenTries ?? 1000);
      }
    }
  }
  if (!lastError) throw new Error(`Node execution exhausted without an error: ${node.name}`);
  if (node.continueOnFail) {
    return {
      outputData: [[{ json: { error: lastError.message } }]],
      retries,
    };
  }
  throw lastError;
}

try {
  const enabledNodes = payload.plan.enabledNodes;
  const incoming = payload.plan.incoming;
  const startNodes = new Set<string>(payload.plan.startNodes);
  const nodeByName = new Map<string, WorkflowNode>(enabledNodes.map((node) => [node.name, node]));
  const levels = computeLevels(enabledNodes, incoming, startNodes, nodeByName);
  const terminalNodeName = enabledNodes[enabledNodes.length - 1]?.name;
  metrics.nodes = enabledNodes.length;
  metrics.levels = levels.length;
  metrics.maxConcurrency = levels.reduce((max, level) => Math.max(max, level.length), 0);

  const workflow = Smithers.workflow({ name: payload.workflowName, input: Schema.Unknown });
  type StepHandle = WorkflowGraph;
  const handlesByNode = new Map<string, StepHandle>();

  const buildStep = (node: WorkflowNode, index: number): StepHandle => {
    const incomingConnections = incoming[node.name] ?? [];
    const dependencyKeys = new Map<string, string>();
    const needs: Record<string, StepHandle> = {};
    for (const connection of incomingConnections) {
      if (!nodeByName.has(connection.source) || dependencyKeys.has(connection.source)) continue;
      const sourceHandle = handlesByNode.get(connection.source);
      if (!sourceHandle) {
        throw new Error(
          `Workflow dependency was not built before node: ${connection.source} -> ${node.name}`
        );
      }
      const key = `dependency${dependencyKeys.size}`;
      dependencyKeys.set(connection.source, key);
      needs[key] = sourceHandle;
    }
    const handle = makeWorkflowStep(makeStepId(index, node), needs, async (ctx) => {
      metrics.started += 1;
      const dependencyResults: Record<string, StepResult> = {};
      for (const [source, key] of dependencyKeys) {
        const result = ctx[key];
        if (!isStepResult(result)) {
          throw new Error(`Invalid durable dependency output for ${source} -> ${node.name}`);
        }
        dependencyResults[source] = result;
      }
      const isStartNode = startNodes.has(node.name);
      const inputData: NodeOutputData =
        isStartNode && incomingConnections.length === 0
          ? Object.keys(payload.triggerData).length > 0
            ? [[{ json: payload.triggerData }]]
            : [[]]
          : collectInputData(node.name, incoming, dependencyResults);
      const started = Date.now();
      const shouldSkip =
        !isStartNode && incomingConnections.length > 0 && !hasInputItems(inputData);
      let outputData: NodeOutputData;
      let retries = 0;
      if (shouldSkip) {
        outputData = [[]];
        metrics.skipped += 1;
      } else {
        try {
          const result = await runNodeWithPolicy(node, inputData);
          outputData = result.outputData;
          retries = result.retries;
        } catch (error) {
          metrics.failed += 1;
          throw error;
        }
      }
      const runEntry: StepRunEntry = {
        startTime: started,
        executionTime: Date.now() - started,
        data: { main: cloneJson(outputData) },
        source: incomingConnections.map((connection) => ({
          previousNode: connection.source,
          previousNodeOutput: connection.sourceOutputIndex,
          previousNodeRun: 0,
        })),
      };
      metrics.finished += 1;
      return {
        nodeName: node.name,
        outputData,
        runEntry,
        skipped: shouldSkip,
        retries,
      } satisfies StepResult;
    });
    handlesByNode.set(node.name, handle);
    return handle;
  };

  let stepIndex = 0;
  const levelGraphs = levels.map((level) => {
    const handles = level.map((node) => buildStep(node, stepIndex++));
    return handles.length === 1 ? handles[0] : workflow.parallel(...handles);
  });

  const resultNeeds: Record<string, StepHandle> = {};
  enabledNodes.forEach((node, index) => {
    const handle = handlesByNode.get(node.name);
    if (!handle) throw new Error(`Workflow node handle was not built: ${node.name}`);
    resultNeeds[`node${index}`] = handle;
  });
  const resultStep = makeWorkflowStep('eliza-workflow-result', resultNeeds, async (ctx) => {
    const runData: Record<string, StepRunEntry[]> = {};
    let durableSkipped = 0;
    let durableRetries = 0;
    let durableFinished = 0;
    enabledNodes.forEach((node, index) => {
      const result = ctx[`node${index}`];
      if (!isStepResult(result) || result.nodeName !== node.name) {
        throw new Error(`Missing durable output for workflow node: ${node.name}`);
      }
      runData[node.name] = [result.runEntry];
      durableFinished += 1;
      if (result.skipped) durableSkipped += 1;
      if (Number.isInteger(result.retries) && result.retries > 0) {
        durableRetries += result.retries;
      }
    });
    const stoppedAt = new Date().toISOString();
    return {
      ...payload.pending,
      finished: true,
      status: 'success',
      stoppedAt,
      data: {
        resultData: {
          runData,
          lastNodeExecuted: terminalNodeName,
          engine: {
            provider: 'smithers',
            nodes: enabledNodes.length,
            levels: levels.length,
            maxConcurrency: levels.reduce((max, level) => Math.max(max, level.length), 0),
            started: durableFinished,
            finished: durableFinished,
            failed: 0,
            skipped: durableSkipped,
            retries: durableRetries,
          },
        },
      },
    };
  });

  const graph = workflow.sequence(...levelGraphs, resultStep);
  const built = workflow.from(graph);
  // The configured backend is an operational contract. Falling back to a local
  // database would make a shared deployment look healthy while losing durability.
  const dbConfig = payload.dbConfig;
  const smithersLayer =
    dbConfig.provider === 'postgres'
      ? Smithers.postgres({ connectionString: dbConfig.connectionString })
      : dbConfig.provider === 'pglite'
        ? Smithers.pglite({ dataDir: dbConfig.dataDir })
        : Smithers.sqlite({ filename: payload.dbPath });
  const execution = await Effect.runPromise(
    built
      .execute(payload.input, {
        runId: payload.executionId,
        force: false,
        rootDir: payload.rootDir,
        allowNetwork: true,
      })
      .pipe(Effect.provide(smithersLayer))
  );
  // process.exit() does not drain stdout, so completion waits until the parent
  // has received the entire result message.
  await emit({ type: 'workflowResult', execution, metrics });
  process.exit(0);
} catch (error) {
  const nodeFailure = currentNodeFailure();
  const nodeDiagnostic = nodeFailure
    ? `Node "${nodeFailure.nodeName}" failed: ${nodeFailure.message}\n`
    : '';
  writeSync(2, `${nodeDiagnostic}${errorMessage(error)}\n`);
  process.exit(1);
}
