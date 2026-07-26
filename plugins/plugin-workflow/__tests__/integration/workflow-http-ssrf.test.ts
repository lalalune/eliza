/**
 * Drives embedded HTTP Request nodes through the real core SSRF guard with a
 * deterministic DNS-pinned transport, covering blocked and allowed targets.
 * The body runs in a child because Bun/PGlite can retain invalid Emscripten
 * descriptors after an oversized ReadableStream is cancelled and its raw test
 * database closes; the process boundary keeps that VM state out of later files.
 */
import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { stringToUuid } from '@elizaos/core';
import { drizzle } from 'drizzle-orm/pglite';
import * as dbSchema from '../../src/db/schema';
import {
  __setWorkflowHttpTransportForTests,
  EmbeddedWorkflowService,
} from '../../src/services/embedded-workflow-service';
import { resolveSmithersDbPath } from '../../src/services/smithers-runtime';

const SSRF_CHILD_ENV = 'ELIZA_WORKFLOW_HTTP_SSRF_CHILD';
const SSRF_CHILD_TIMEOUT_MS = 90_000;
const ERROR_SECRET_SENTINEL = 'workflow-secret-sentinel-4f7d91c2';
const testPath = fileURLToPath(import.meta.url);
const pluginRoot = fileURLToPath(new URL('../..', import.meta.url));

function buildChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, [SSRF_CHILD_ENV]: '1' };
  for (const key of Object.keys(env)) {
    const normalized = key.toUpperCase();
    if (
      normalized === 'NODE_V8_COVERAGE' ||
      normalized === 'BUN_TEST' ||
      normalized.startsWith('BUN_TEST_') ||
      normalized.startsWith('VITEST') ||
      normalized.startsWith('NYC_') ||
      normalized.includes('COVERAGE')
    ) {
      delete env[key];
    }
  }
  return env;
}

async function runSsrfProofInIsolatedProcess(): Promise<void> {
  const proc = spawn(process.env.BUN_BIN || process.execPath, ['test', testPath], {
    cwd: pluginRoot,
    env: buildChildEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  proc.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGKILL');
  }, SSRF_CHILD_TIMEOUT_MS);
  const exitCode = await new Promise<number>((resolve, reject) => {
    proc.once('error', reject);
    proc.once('close', (code) => resolve(code ?? 1));
  }).finally(() => clearTimeout(timeout));

  if (timedOut) {
    throw new Error(
      `Isolated workflow HTTP SSRF proof timed out.\nstdout:\n${stdout}\nstderr:\n${stderr}`
    );
  }
  if (exitCode !== 0) {
    throw new Error(
      `Isolated workflow HTTP SSRF proof failed with exit ${exitCode}.\nstdout:\n${stdout}\nstderr:\n${stderr}`
    );
  }
  expect(`${stdout}\n${stderr}`).not.toContain(ERROR_SECRET_SENTINEL);
}

test('HTTP Request blocks loopback and metadata targets while allowing a DNS-pinned public redirect', async () => {
  if (process.env[SSRF_CHILD_ENV] !== '1') {
    await runSsrfProofInIsolatedProcess();
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'workflow-http-ssrf-'));
  const client = new PGlite({ dataDir: join(root, 'pglite') });
  const db = drizzle(client, { schema: dbSchema });
  const agentId = stringToUuid(`workflow-http-ssrf-${crypto.randomUUID()}`);
  const runtime = {
    agentId,
    character: { settings: { WORKFLOW_SEED_DEFAULTS: 'false' } },
    db,
    getSetting: (key: string) => (key === 'WORKFLOW_SEED_DEFAULTS' ? 'false' : undefined),
    getService: () => null,
  } as never;
  const service = await EmbeddedWorkflowService.start(runtime);
  const workflowIds: string[] = [];
  const lookupHosts: string[] = [];
  const transportUrls: string[] = [];
  let oversizedBodyCancelled = false;
  let declaredBodyCancelled = false;
  let lyingLengthBodyCancelled = false;
  let dynamicRequest: { url: string; eventKind: string | null; body: string | null } | undefined;

  __setWorkflowHttpTransportForTests(runtime, {
    lookupFn: async (hostname) => {
      lookupHosts.push(hostname);
      return [{ address: '93.184.216.34', family: 4 }];
    },
    pinnedFetchImpl: async ({ url, init, addresses }) => {
      transportUrls.push(url.toString());
      expect(addresses).toEqual(['93.184.216.34']);
      expect(init.redirect).toBe('manual');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      if (url.pathname === '/start') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://public.example/final' },
        });
      }
      if (url.pathname === '/oversized') {
        let chunk = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              chunk += 1;
              if (chunk === 1) controller.enqueue(new Uint8Array(700_000));
              else if (chunk === 2) controller.enqueue(new Uint8Array(400_000));
            },
            cancel() {
              oversizedBodyCancelled = true;
            },
          }),
          { status: 200, headers: { 'content-type': 'application/octet-stream' } }
        );
      }
      if (url.pathname === '/oversized-declared') {
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              declaredBodyCancelled = true;
              throw new Error(`cancel transport reflected ${ERROR_SECRET_SENTINEL}`);
            },
          }),
          {
            status: 200,
            headers: {
              'content-length': '1048577',
              'content-type': 'text/plain',
            },
          }
        );
      }
      if (url.pathname === '/lying-length') {
        let chunk = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              chunk += 1;
              if (chunk === 1) controller.enqueue(new Uint8Array(700_000));
              else if (chunk === 2) controller.enqueue(new Uint8Array(400_000));
            },
            cancel() {
              lyingLengthBodyCancelled = true;
            },
          }),
          {
            status: 200,
            headers: { 'content-length': '1', 'content-type': 'text/plain' },
          }
        );
      }
      if (url.pathname === '/exact-limit') {
        return new Response(new Uint8Array(1_048_576).fill(97), {
          status: 200,
          headers: {
            'content-length': '1048576',
            'content-type': 'text/plain',
          },
        });
      }
      if (url.pathname === '/not-found') {
        return new Response(JSON.stringify({ error: 'missing' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.pathname === '/server-error') {
        return new Response(JSON.stringify({ error: 'unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.pathname === '/echo-secret') {
        return new Response(
          JSON.stringify({
            authorization: new Headers(init.headers).get('authorization'),
            body: init.body,
            query: url.search,
          }),
          { status: 422, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.pathname === '/items/42') {
        dynamicRequest = {
          url: url.toString(),
          eventKind: new Headers(init.headers).get('x-event-kind'),
          body: typeof init.body === 'string' ? init.body : null,
        };
        return new Response(JSON.stringify({ allowed: true, path: url.pathname }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ allowed: true, path: url.pathname }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const createHttpWorkflow = async (url: string) => {
    const id = `http-guard-${crypto.randomUUID()}`;
    workflowIds.push(id);
    return service.createWorkflow({
      id,
      name: `Guard ${url}`,
      nodes: [
        {
          id: 'manual',
          name: 'Manual Trigger',
          type: 'workflows-nodes-base.manualTrigger',
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
        {
          id: 'http',
          name: 'HTTP Request',
          type: 'workflows-nodes-base.httpRequest',
          typeVersion: 4.2,
          position: [200, 0],
          parameters: { method: 'GET', url },
        },
      ],
      connections: {
        'Manual Trigger': { main: [[{ node: 'HTTP Request', type: 'main', index: 0 }]] },
      },
    });
  };

  try {
    for (const blockedUrl of [
      'http://127.0.0.1/private',
      'http://169.254.169.254/latest/meta-data',
      'http://metadata.google.internal/computeMetadata/v1',
    ]) {
      const workflow = await createHttpWorkflow(blockedUrl);
      const execution = await service.executeWorkflow(workflow.id, { throwOnError: false });
      expect(execution.status).toBe('error');
      expect(execution.data?.resultData?.error?.message).toMatch(/blocked/i);
    }
    expect(lookupHosts).toHaveLength(0);
    expect(transportUrls).toHaveLength(0);

    const publicWorkflow = await createHttpWorkflow('https://public.example/start');
    const execution = await service.executeWorkflow(publicWorkflow.id);
    const item = execution.data?.resultData?.runData?.['HTTP Request']?.[0]?.data?.main?.[0]?.[0]
      ?.json as Record<string, unknown> | undefined;
    expect(execution.status).toBe('success');
    expect(item).toMatchObject({
      statusCode: 200,
      body: { allowed: true, path: '/final' },
    });
    expect(lookupHosts).toEqual(['public.example', 'public.example']);
    expect(transportUrls).toEqual(['https://public.example/start', 'https://public.example/final']);

    const oversizedWorkflow = await createHttpWorkflow('https://public.example/oversized');
    const oversizedExecution = await service.executeWorkflow(oversizedWorkflow.id, {
      throwOnError: false,
    });
    expect(oversizedExecution.status).toBe('error');
    expect(oversizedExecution.data?.resultData?.error?.message).toContain(
      'exceeds maximum size of 1048576 bytes'
    );
    expect(oversizedExecution.data?.resultData?.error?.code).toBe(
      'WORKFLOW_HTTP_RESPONSE_TOO_LARGE'
    );
    expect(oversizedBodyCancelled).toBe(true);
    expect(transportUrls.at(-1)).toBe('https://public.example/oversized');

    const declaredWorkflow = await createHttpWorkflow('https://public.example/oversized-declared');
    const declaredExecution = await service.executeWorkflow(declaredWorkflow.id, {
      throwOnError: false,
    });
    expect(declaredExecution.data?.resultData?.error?.code).toBe(
      'WORKFLOW_HTTP_RESPONSE_TOO_LARGE'
    );
    expect(declaredBodyCancelled).toBe(true);

    const lyingLengthWorkflow = await createHttpWorkflow('https://public.example/lying-length');
    const lyingLengthExecution = await service.executeWorkflow(lyingLengthWorkflow.id, {
      throwOnError: false,
    });
    expect(lyingLengthExecution.data?.resultData?.error?.code).toBe(
      'WORKFLOW_HTTP_RESPONSE_TOO_LARGE'
    );
    expect(lyingLengthBodyCancelled).toBe(true);

    const exactLimitWorkflow = await createHttpWorkflow('https://public.example/exact-limit');
    const exactLimitExecution = await service.executeWorkflow(exactLimitWorkflow.id);
    const exactLimitItem = exactLimitExecution.data?.resultData?.runData?.['HTTP Request']?.[0]
      ?.data?.main?.[0]?.[0]?.json as Record<string, unknown> | undefined;
    expect(exactLimitExecution.status).toBe('success');
    const exactLimitBody = exactLimitItem?.body;
    expect(typeof exactLimitBody).toBe('string');
    if (typeof exactLimitBody !== 'string') {
      throw new Error('expected the exact-limit HTTP response body to be a string');
    }
    expect(exactLimitBody.length).toBe(1_048_576);

    for (const [path, statusCode] of [
      ['/not-found', 404],
      ['/server-error', 503],
    ] as const) {
      const failedWorkflow = await createHttpWorkflow(`https://public.example${path}`);
      const failedExecution = await service.executeWorkflow(failedWorkflow.id, {
        throwOnError: false,
      });
      expect(failedExecution.status).toBe('error');
      expect(failedExecution.data?.resultData?.error).toMatchObject({
        code: 'WORKFLOW_HTTP_STATUS_ERROR',
        context: {
          method: 'GET',
          statusCode,
        },
      });
    }

    const secretWorkflowId = `http-secret-${crypto.randomUUID()}`;
    workflowIds.push(secretWorkflowId);
    const secretWorkflow = await service.createWorkflow({
      id: secretWorkflowId,
      name: 'HTTP error secret boundary',
      nodes: [
        {
          id: 'manual',
          name: 'Manual Trigger',
          type: 'workflows-nodes-base.manualTrigger',
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
        {
          id: 'http',
          name: 'HTTP Request',
          type: 'workflows-nodes-base.httpRequest',
          typeVersion: 4.2,
          position: [200, 0],
          parameters: {
            method: 'POST',
            url: `https://public.example/echo-secret?token=${ERROR_SECRET_SENTINEL}`,
            headers: { authorization: `Bearer ${ERROR_SECRET_SENTINEL}` },
            body: ERROR_SECRET_SENTINEL,
          },
        },
      ],
      connections: {
        'Manual Trigger': { main: [[{ node: 'HTTP Request', type: 'main', index: 0 }]] },
      },
    });
    const secretFailure = await service.executeWorkflow(secretWorkflow.id, {
      throwOnError: false,
    });
    const storedSecretFailure = await service.getExecution(secretFailure.id);
    let thrownSecretFailure: unknown;
    try {
      await service.executeWorkflow(secretWorkflow.id);
    } catch (error) {
      thrownSecretFailure = error;
    }
    expect(thrownSecretFailure).toBeInstanceOf(Error);
    const publicFailureSurfaces = JSON.stringify({
      returned: secretFailure.data?.resultData?.error,
      stored: storedSecretFailure.data?.resultData?.error,
      thrown:
        thrownSecretFailure instanceof Error
          ? {
              message: thrownSecretFailure.message,
              stack: thrownSecretFailure.stack,
              code: (thrownSecretFailure as { code?: unknown }).code,
              context: (thrownSecretFailure as { context?: unknown }).context,
            }
          : thrownSecretFailure,
    });
    expect(publicFailureSurfaces).not.toContain(ERROR_SECRET_SENTINEL);
    expect(secretFailure.data?.resultData?.error).toEqual({
      message: 'HTTP request failed with status 422',
      code: 'WORKFLOW_HTTP_STATUS_ERROR',
      context: {
        workflowId: secretWorkflow.id,
        executionId: secretFailure.id,
        method: 'POST',
        statusCode: 422,
      },
    });
    expect(secretFailure.data?.resultData?.error).not.toHaveProperty('stack');
    expect(secretFailure.data?.resultData?.error).not.toHaveProperty('responseBodyPreview');

    const dynamicWorkflowId = `http-expression-${crypto.randomUUID()}`;
    workflowIds.push(dynamicWorkflowId);
    const dynamicWorkflow = await service.createWorkflow({
      id: dynamicWorkflowId,
      name: 'HTTP and Set expressions',
      nodes: [
        {
          id: 'manual',
          name: 'Manual Trigger',
          type: 'workflows-nodes-base.manualTrigger',
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
        {
          id: 'http',
          name: 'HTTP Request',
          type: 'workflows-nodes-base.httpRequest',
          typeVersion: 4.2,
          position: [200, 0],
          parameters: {
            method: 'POST',
            url: '=https://public.example/items/{{$json.itemId}}',
            headers: { 'x-event-kind': '={{ $json.eventKind }}' },
            jsonBody: {
              message: '={{ $json.eventPayload.text }}',
              eventPayload: '={{ $json.eventPayload }}',
            },
          },
        },
        {
          id: 'set',
          name: 'Set Result',
          type: 'workflows-nodes-base.set',
          typeVersion: 3.4,
          position: [400, 0],
          parameters: {
            assignments: {
              assignments: [
                { name: 'responseAllowed', value: '={{ $json.body.allowed }}' },
                { name: 'responsePath', value: '=path:{{$json.body.path}}' },
              ],
            },
          },
        },
      ],
      connections: {
        'Manual Trigger': { main: [[{ node: 'HTTP Request', type: 'main', index: 0 }]] },
        'HTTP Request': { main: [[{ node: 'Set Result', type: 'main', index: 0 }]] },
      },
    });
    const dynamicExecution = await service.executeWorkflow(dynamicWorkflow.id, {
      triggerData: {
        itemId: 42,
        eventKind: 'MESSAGE_RECEIVED',
        eventPayload: { text: 'hello from chat' },
      },
    });
    const dynamicOutput = dynamicExecution.data?.resultData?.runData?.['Set Result']?.[0]?.data
      ?.main?.[0]?.[0]?.json as Record<string, unknown> | undefined;
    expect(dynamicExecution.status).toBe('success');
    expect(dynamicRequest).toEqual({
      url: 'https://public.example/items/42',
      eventKind: 'MESSAGE_RECEIVED',
      body: JSON.stringify({
        message: 'hello from chat',
        eventPayload: { text: 'hello from chat' },
      }),
    });
    expect(dynamicOutput).toMatchObject({
      responseAllowed: true,
      responsePath: 'path:/items/42',
    });
  } finally {
    __setWorkflowHttpTransportForTests(runtime, undefined);
    await service.stop();
    await client.close();
    await rm(root, { recursive: true, force: true });
    await Promise.all(
      workflowIds.flatMap((workflowId) => {
        const path = resolveSmithersDbPath(agentId, workflowId);
        return [
          rm(path, { force: true }),
          rm(`${path}-wal`, { force: true }),
          rm(`${path}-shm`, { force: true }),
        ];
      })
    );
  }
}, 120_000);
