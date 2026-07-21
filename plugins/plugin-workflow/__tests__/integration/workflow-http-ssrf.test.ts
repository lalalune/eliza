/**
 * Drives embedded HTTP Request nodes through the real core SSRF guard with a
 * deterministic DNS-pinned transport, covering blocked and allowed targets.
 */
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { stringToUuid } from '@elizaos/core';
import { drizzle } from 'drizzle-orm/pglite';
import * as dbSchema from '../../src/db/schema';
import {
  __setWorkflowHttpTransportForTests,
  EmbeddedWorkflowService,
} from '../../src/services/embedded-workflow-service';
import { resolveSmithersDbPath } from '../../src/services/smithers-runtime';

test('HTTP Request blocks loopback and metadata targets while allowing a DNS-pinned public redirect', async () => {
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
    expect((exactLimitItem?.body as string).length).toBe(1_048_576);
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
