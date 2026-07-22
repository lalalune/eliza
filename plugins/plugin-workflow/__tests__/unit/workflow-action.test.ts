/** Unit tests for the WORKFLOW action's op dispatch against a mocked WorkflowService (deterministic). */
import { describe, expect, mock, test } from 'bun:test';
import {
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  stringToUuid,
} from '@elizaos/core';
import { workflowAction } from '../../src/actions/workflow';
import { clearPendingWorkflowDraft } from '../../src/lib/pending-workflow-draft';
import { WORKFLOW_SERVICE_TYPE, type WorkflowService } from '../../src/services/workflow-service';
import { WorkflowApiError } from '../../src/types/index';
import { createValidWorkflow, createWorkflowResponse } from '../fixtures/workflows';

function makeRuntime(
  service: Partial<WorkflowService>,
  canonicalOwnerId = 'user-test',
  cache = new Map<string, unknown>(),
  cacheBoundary: {
    deleteCache?: IAgentRuntime['deleteCache'];
    reportError?: IAgentRuntime['reportError'];
    contentMetadata?: Record<string, unknown>;
  } = {}
): IAgentRuntime {
  return {
    agentId: 'agent-test',
    character: { name: 'Workflow Test Agent', settings: {} },
    getSetting: (key: string) => (key === 'ELIZA_ADMIN_ENTITY_ID' ? canonicalOwnerId : undefined),
    getService: (type: string) => (type === WORKFLOW_SERVICE_TYPE ? service : null),
    getCache: <T>(key: string) => Promise.resolve(cache.get(key) as T | undefined),
    setCache: <T>(key: string, value: T) => {
      cache.set(key, value);
      return Promise.resolve(true);
    },
    deleteCache: cacheBoundary.deleteCache ?? ((key: string) => Promise.resolve(cache.delete(key))),
    reportError: cacheBoundary.reportError ?? (() => {}),
  } as IAgentRuntime;
}

const message = {
  id: 'message-test',
  entityId: 'user-test',
  roomId: 'room-test',
  content: { text: 'Manage my workflows.' },
} as Memory;

async function runAction(
  service: Partial<WorkflowService>,
  parameters: Record<string, unknown>,
  callback?: HandlerCallback,
  identity: {
    canonicalOwnerId?: string;
    messageEntityId?: string;
    cache?: Map<string, unknown>;
    deleteCache?: IAgentRuntime['deleteCache'];
    reportError?: IAgentRuntime['reportError'];
  } = {}
) {
  if (!workflowAction.handler) throw new Error('workflow action missing handler');
  return workflowAction.handler(
    makeRuntime(service, identity.canonicalOwnerId, identity.cache, {
      deleteCache: identity.deleteCache,
      reportError: identity.reportError,
    }),
    {
      ...message,
      entityId: identity.messageEntityId ?? message.entityId,
      content: {
        ...message.content,
        ...(identity.contentMetadata ? { metadata: identity.contentMetadata } : {}),
      },
    } as Memory,
    undefined,
    { parameters } as HandlerOptions,
    callback
  );
}

describe('workflowAction chat operations', () => {
  test('uses the attested Cloud chat principal instead of the local canonical owner', async () => {
    const previousCloud = process.env.ELIZA_CLOUD_PROVISIONED;
    process.env.ELIZA_CLOUD_PROVISIONED = '1';
    const cloudPrincipal = stringToUuid('cloud-chat-user');
    const listWorkflows = mock(() => Promise.resolve([]));
    try {
      const result = await runAction(
        { listWorkflows } as Partial<WorkflowService>,
        { action: 'list' },
        undefined,
        {
          canonicalOwnerId: 'local-canonical-owner',
          messageEntityId: cloudPrincipal,
          contentMetadata: {
            elizaCloudPrincipal: { id: cloudPrincipal, attested: true },
          },
        }
      );

      expect(result.success).toBe(true);
      expect(listWorkflows).toHaveBeenCalledWith(cloudPrincipal);
    } finally {
      if (previousCloud === undefined) delete process.env.ELIZA_CLOUD_PROVISIONED;
      else process.env.ELIZA_CLOUD_PROVISIONED = previousCloud;
    }
  });

  test('rejects a spoofed Cloud marker whose identity differs from the message sender', async () => {
    const previousCloud = process.env.ELIZA_CLOUD_PROVISIONED;
    process.env.ELIZA_CLOUD_PROVISIONED = '1';
    const listWorkflows = mock(() => Promise.resolve([]));
    try {
      await runAction(
        { listWorkflows } as Partial<WorkflowService>,
        { action: 'list' },
        undefined,
        {
          canonicalOwnerId: 'local-canonical-owner',
          messageEntityId: stringToUuid('actual-sender'),
          contentMetadata: {
            elizaCloudPrincipal: {
              id: stringToUuid('spoofed-cloud-user'),
              attested: true,
            },
          },
        }
      );

      expect(listWorkflows).toHaveBeenCalledWith('local-canonical-owner');
    } finally {
      if (previousCloud === undefined) delete process.env.ELIZA_CLOUD_PROVISIONED;
      else process.env.ELIZA_CLOUD_PROVISIONED = previousCloud;
    }
  });

  test('exposes clarification answers without exposing server-owned drafts to the model', () => {
    const parameters = workflowAction.parameters ?? [];
    const parameterNames = parameters.map((parameter) => parameter.name);
    const resolutions = parameters.find((parameter) => parameter.name === 'resolutions');

    expect(parameterNames).not.toContain('draft');
    expect(resolutions?.schema).toMatchObject({
      type: 'array',
      items: {
        type: 'object',
        properties: {
          paramPath: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['paramPath', 'value'],
        additionalProperties: false,
      },
    });
  });

  test('treats an already-absent pending draft delete as idempotent', async () => {
    const deleteCache = mock(() => Promise.resolve(false));

    await expect(
      clearPendingWorkflowDraft({ deleteCache } as IAgentRuntime, {
        ownerEntityId: 'user-test',
        roomId: 'room-test',
        cacheKey: 'workflow_draft:v2:user-test:room:room-test',
      })
    ).resolves.toBeUndefined();
    expect(deleteCache).toHaveBeenCalledTimes(1);
  });

  test('marks pending-draft cancellation as chat-only action output', async () => {
    const cache = new Map<string, unknown>();
    const draft = createValidWorkflow({
      _meta: {
        requiresClarification: [
          {
            kind: 'recipient',
            question: 'Who should receive the summary?',
            paramPath: 'nodes["Gmail"].parameters.sendTo',
          },
        ],
      },
    });
    const service = {
      generateWorkflowDraft: mock(() => Promise.resolve(draft)),
    } as Partial<WorkflowService>;

    await runAction(
      service,
      { action: 'create', seedPrompt: 'Email a summary every day.' },
      undefined,
      { cache }
    );
    const canceled = await runAction(service, { action: 'cancel_draft' }, undefined, { cache });
    const absent = await runAction(service, { action: 'cancel_draft' }, undefined, { cache });

    expect(canceled).toMatchObject({
      success: true,
      values: { status: 'canceled', workflowName: draft.name },
    });
    expect(absent).toMatchObject({
      success: true,
      values: { status: 'no_pending_draft' },
    });
  });

  test('creates and lists a workflow under the same chat owner', async () => {
    const storedByOwner = new Map<string, ReturnType<typeof createWorkflowResponse>[]>();
    const draft = createValidWorkflow();
    const stored = createWorkflowResponse({ id: 'wf-created', name: draft.name });
    const generateWorkflowDraft = mock((_seedPrompt: string, _options: { userId: string }) =>
      Promise.resolve(draft)
    );
    const deployWorkflow = mock(
      (
        workflow: ReturnType<typeof createValidWorkflow>,
        ownerId: string,
        _options?: { activate?: boolean }
      ) => {
        storedByOwner.set(ownerId, [stored]);
        return Promise.resolve({
          id: stored.id,
          name: workflow.name,
          active: Boolean(stored.active),
          nodeCount: workflow.nodes.length,
          missingCredentials: [],
        });
      }
    );
    const listWorkflows = mock((ownerId: string) =>
      Promise.resolve(storedByOwner.get(ownerId) ?? [])
    );
    const service = {
      generateWorkflowDraft,
      deployWorkflow,
      listWorkflows,
    } as Partial<WorkflowService>;

    const created = await runAction(service, {
      action: 'create',
      seedPrompt: 'Send me a daily summary.',
    });
    const listed = await runAction(service, { action: 'list' });

    expect(generateWorkflowDraft).toHaveBeenCalledWith('Send me a daily summary.', {
      userId: 'user-test',
    });
    expect(deployWorkflow).toHaveBeenCalledWith(draft, 'user-test', {
      activate: undefined,
    });
    expect(listWorkflows).toHaveBeenCalledWith('user-test');
    expect(created.success).toBe(true);
    expect(created.values).toMatchObject({ active: false });
    expect(listed.success).toBe(true);
    expect(listed.data).toEqual({
      workflows: [{ id: 'wf-created', name: 'Test Workflow', active: false, nodeCount: 2 }],
      total: 1,
    });
  });

  test('stores a linked connector owner workflow under the canonical app identity', async () => {
    const storedByOwner = new Map<string, ReturnType<typeof createWorkflowResponse>[]>();
    const draft = createValidWorkflow();
    const stored = createWorkflowResponse({ id: 'wf-linked-owner', name: draft.name });
    const generateWorkflowDraft = mock((_prompt: string, _options: { userId: string }) =>
      Promise.resolve(draft)
    );
    const deployWorkflow = mock(
      (
        definition: ReturnType<typeof createValidWorkflow>,
        ownerId: string,
        _options?: { activate?: boolean }
      ) => {
        storedByOwner.set(ownerId, [stored]);
        return Promise.resolve({
          id: stored.id,
          name: definition.name,
          active: false,
          nodeCount: definition.nodes.length,
          missingCredentials: [],
        });
      }
    );
    const listWorkflows = mock((ownerId: string) =>
      Promise.resolve(storedByOwner.get(ownerId) ?? [])
    );
    const getWorkflow = mock((workflowId: string, ownerId: string) => {
      const owned = storedByOwner.get(ownerId)?.find((item) => item.id === workflowId);
      if (!owned) return Promise.reject(new Error(`Workflow not found: ${workflowId}`));
      return Promise.resolve(owned);
    });
    const service = {
      generateWorkflowDraft,
      deployWorkflow,
      listWorkflows,
      getWorkflow,
    } as Partial<WorkflowService>;
    const identity = {
      canonicalOwnerId: 'canonical-app-owner',
      messageEntityId: 'linked-slack-owner',
    };

    const created = await runAction(
      service,
      { action: 'create', seedPrompt: 'Post a recap to Slack.' },
      undefined,
      identity
    );
    const listed = await runAction(service, { action: 'list' }, undefined, {
      ...identity,
      messageEntityId: 'canonical-app-owner',
    });
    const opened = await runAction(
      service,
      { action: 'get', workflowId: 'wf-linked-owner' },
      undefined,
      { ...identity, messageEntityId: 'canonical-app-owner' }
    );

    expect(generateWorkflowDraft).toHaveBeenCalledWith('Post a recap to Slack.', {
      userId: 'canonical-app-owner',
    });
    expect(deployWorkflow).toHaveBeenCalledWith(draft, 'canonical-app-owner', {
      activate: undefined,
    });
    expect(listWorkflows).toHaveBeenCalledWith('canonical-app-owner');
    expect(getWorkflow).toHaveBeenCalledWith('wf-linked-owner', 'canonical-app-owner');
    expect(created.success).toBe(true);
    expect(listed.success).toBe(true);
    expect(opened.success).toBe(true);
  });

  test('returns unresolved creation questions without deploying or activating the draft', async () => {
    const draft = createValidWorkflow({
      _meta: {
        requiresClarification: [
          {
            kind: 'recipient',
            platform: 'gmail',
            question: 'Who should receive the summary?',
            paramPath: 'nodes["Gmail"].parameters.sendTo',
          },
        ],
      },
    });
    const generateWorkflowDraft = mock(() => Promise.resolve(draft));
    const deployWorkflow = mock(() =>
      Promise.resolve({
        id: 'must-not-exist',
        name: draft.name,
        active: true,
        nodeCount: draft.nodes.length,
        missingCredentials: [],
      })
    );
    const callback = mock(() => Promise.resolve());

    const result = await runAction(
      { generateWorkflowDraft, deployWorkflow } as Partial<WorkflowService>,
      {
        action: 'create',
        seedPrompt: 'Email a summary every day.',
        active: true,
      },
      callback as HandlerCallback
    );

    expect(deployWorkflow).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.values).toEqual({ status: 'needs_clarification', clarificationCount: 1 });
    expect(result.data).toEqual({
      status: 'needs_clarification',
      draft,
      clarifications: [
        expect.objectContaining({
          question: 'Who should receive the summary?',
          paramPath: 'nodes["Gmail"].parameters.sendTo',
        }),
      ],
    });
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          status: 'needs_clarification',
          clarificationCount: 1,
        }),
      })
    );
  });

  test('resolves a pending chat draft and exposes the deployed workflow in the canonical feed', async () => {
    const ownerId = 'canonical-app-owner';
    const draft = createValidWorkflow({
      _meta: {
        requiresClarification: [
          {
            kind: 'recipient',
            platform: 'gmail',
            question: 'Who should receive the summary?',
            paramPath: 'nodes["Gmail"].parameters.sendTo',
          },
        ],
      },
    });
    const storedByOwner = new Map<string, ReturnType<typeof createWorkflowResponse>[]>();
    const deployWorkflow = mock(
      (resolved: ReturnType<typeof createValidWorkflow>, canonicalOwnerId: string) => {
        const recipient = resolved.nodes.find((node) => node.name === 'Gmail')?.parameters.sendTo;
        expect(recipient).toBe('owner@example.com');
        expect(resolved._meta?.requiresClarification).toBeUndefined();
        const stored = createWorkflowResponse({ id: 'wf-resolved', name: resolved.name });
        storedByOwner.set(canonicalOwnerId, [stored]);
        return Promise.resolve({
          id: stored.id,
          name: stored.name,
          active: false,
          nodeCount: stored.nodes.length,
          missingCredentials: [],
        });
      }
    );
    const listWorkflows = mock((canonicalOwnerId: string) =>
      Promise.resolve(storedByOwner.get(canonicalOwnerId) ?? [])
    );
    const service = { deployWorkflow, listWorkflows } as Partial<WorkflowService>;
    const identity = { canonicalOwnerId: ownerId, messageEntityId: 'linked-slack-owner' };

    const resolved = await runAction(
      service,
      {
        action: 'create',
        draft,
        resolutions: [
          { paramPath: 'nodes["Gmail"].parameters.sendTo', value: 'owner@example.com' },
        ],
      },
      undefined,
      identity
    );
    const listed = await runAction(service, { action: 'list' }, undefined, {
      canonicalOwnerId: ownerId,
      messageEntityId: ownerId,
    });

    expect(deployWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ name: draft.name }),
      ownerId,
      { activate: undefined }
    );
    expect(draft._meta?.requiresClarification).toHaveLength(1);
    expect(listWorkflows).toHaveBeenCalledWith(ownerId);
    expect(resolved.success).toBe(true);
    expect(listed.data).toEqual({
      workflows: [{ id: 'wf-resolved', name: 'Test Workflow', active: false, nodeCount: 2 }],
      total: 1,
    });
  });

  test('treats a whitespace-only chat clarification path as free-form and deploys once', async () => {
    const draft = createValidWorkflow({
      _meta: {
        requiresClarification: [
          {
            kind: 'free_text',
            question: 'What context should the workflow remember?',
            paramPath: '',
          },
        ],
      },
    });
    const deployWorkflow = mock((resolved: ReturnType<typeof createValidWorkflow>) => {
      expect(resolved._meta?.requiresClarification).toBeUndefined();
      expect(resolved._meta?.userNotes).toEqual(['Remember the release context.']);
      return Promise.resolve({
        id: 'wf-free-text-resolved',
        name: resolved.name,
        active: false,
        nodeCount: resolved.nodes.length,
        missingCredentials: [],
      });
    });

    const result = await runAction({ deployWorkflow } as Partial<WorkflowService>, {
      action: 'create',
      draft,
      resolutions: [{ paramPath: '   ', value: 'Remember the release context.' }],
    });

    expect(deployWorkflow).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: true,
      values: { workflowId: 'wf-free-text-resolved' },
    });
  });

  test('preserves canonical draft compatibility for direct handler callers', async () => {
    const draft = createValidWorkflow();
    const deployWorkflow = mock(() =>
      Promise.resolve({
        id: 'wf-direct-draft',
        name: draft.name,
        active: false,
        nodeCount: draft.nodes.length,
        missingCredentials: [],
      })
    );

    const result = await runAction({ deployWorkflow } as Partial<WorkflowService>, {
      action: 'create',
      draft,
    });

    expect(deployWorkflow).toHaveBeenCalledWith(draft, 'user-test', { activate: undefined });
    expect(result).toMatchObject({
      success: true,
      values: { workflowId: 'wf-direct-draft', active: false },
    });
  });

  test('rejects malformed direct clarification entries before mutating a pending draft', async () => {
    const cache = new Map<string, unknown>();
    const draft = createValidWorkflow({
      _meta: {
        requiresClarification: [
          {
            kind: 'recipient',
            question: 'Who should receive the summary?',
            paramPath: 'nodes["Gmail"].parameters.sendTo',
          },
        ],
      },
    });
    const deployWorkflow = mock(() =>
      Promise.resolve({
        id: 'must-not-deploy',
        name: draft.name,
        active: false,
        nodeCount: draft.nodes.length,
        missingCredentials: [],
      })
    );
    const service = {
      generateWorkflowDraft: mock(() => Promise.resolve(draft)),
      deployWorkflow,
    } as Partial<WorkflowService>;

    await runAction(
      service,
      { action: 'create', seedPrompt: 'Email a summary every day.' },
      undefined,
      { cache }
    );
    const result = await runAction(
      service,
      { action: 'create', resolutions: ['owner@example.com'] },
      undefined,
      { cache }
    );

    expect(result).toEqual({
      success: false,
      text: 'Clarification resolutions must be an array of { paramPath, value } entries.',
    });
    expect(deployWorkflow).not.toHaveBeenCalled();
    expect(cache.size).toBe(1);
  });

  test('retains a resolved pending draft until deployment returns a verified id', async () => {
    const cache = new Map<string, unknown>();
    const draft = createValidWorkflow({
      _meta: {
        requiresClarification: [
          {
            kind: 'recipient',
            question: 'Who should receive the summary?',
            paramPath: 'nodes["Gmail"].parameters.sendTo',
          },
        ],
      },
    });
    let deployAttempts = 0;
    const deployWorkflow = mock(
      async (resolved: ReturnType<typeof createValidWorkflow>, _ownerId: string) => {
        expect(resolved.nodes.find((node) => node.name === 'Gmail')?.parameters.sendTo).toBe(
          'owner@example.com'
        );
        deployAttempts += 1;
        if (deployAttempts === 1) {
          return {
            id: '',
            name: resolved.name,
            active: false,
            nodeCount: resolved.nodes.length,
            missingCredentials: [],
          };
        }
        if (deployAttempts === 2) {
          throw new Error('temporary deployment failure');
        }
        return {
          id: 'wf-retried',
          name: resolved.name,
          active: false,
          nodeCount: resolved.nodes.length,
          missingCredentials: [],
        };
      }
    );
    const service = {
      generateWorkflowDraft: mock(() => Promise.resolve(draft)),
      deployWorkflow,
    } as Partial<WorkflowService>;
    const identity = { cache };

    const pending = await runAction(
      service,
      { action: 'create', seedPrompt: 'Email a summary every day.' },
      undefined,
      identity
    );
    expect(pending.values).toMatchObject({ status: 'needs_clarification' });
    expect(cache.size).toBe(1);

    const resolution = {
      action: 'create',
      resolutions: [{ paramPath: 'nodes["Gmail"].parameters.sendTo', value: 'owner@example.com' }],
    };
    const missingId = await runAction(service, resolution, undefined, identity);
    expect(missingId).toMatchObject({ success: false });
    expect(missingId.text).toContain('no deployable result');
    expect(cache.size).toBe(1);

    const transientFailure = await runAction(service, resolution, undefined, identity);
    expect(transientFailure).toMatchObject({ success: false });
    expect(transientFailure.text).toContain('temporary deployment failure');
    expect(cache.size).toBe(1);

    const retried = await runAction(service, resolution, undefined, identity);
    expect(retried).toMatchObject({ success: true, values: { workflowId: 'wf-retried' } });
    expect(deployWorkflow).toHaveBeenCalledTimes(3);
    expect(cache.size).toBe(0);
  });

  test('atomically claims one pending draft before concurrent confirmations deploy', async () => {
    const cache = new Map<string, unknown>();
    const draft = createValidWorkflow({
      _meta: {
        requiresClarification: [
          {
            kind: 'recipient',
            question: 'Who should receive the summary?',
            paramPath: 'nodes["Gmail"].parameters.sendTo',
          },
        ],
      },
    });
    let enterDeployment: (() => void) | undefined;
    let releaseDeployment: (() => void) | undefined;
    const deploymentEntered = new Promise<void>((resolve) => {
      enterDeployment = resolve;
    });
    const deploymentReleased = new Promise<void>((resolve) => {
      releaseDeployment = resolve;
    });
    const deployWorkflow = mock(async (resolved: ReturnType<typeof createValidWorkflow>) => {
      enterDeployment?.();
      await deploymentReleased;
      return {
        id: 'wf-single-confirmation',
        name: resolved.name,
        active: false,
        nodeCount: resolved.nodes.length,
        missingCredentials: [],
      };
    });
    const service = {
      generateWorkflowDraft: mock(() => Promise.resolve(draft)),
      deployWorkflow,
    } as Partial<WorkflowService>;
    const identity = { cache };
    const resolution = {
      action: 'create',
      resolutions: [{ paramPath: 'nodes["Gmail"].parameters.sendTo', value: 'owner@example.com' }],
    };

    await runAction(
      service,
      { action: 'create', seedPrompt: 'Email a summary every day.' },
      undefined,
      identity
    );
    const firstConfirmation = runAction(service, resolution, undefined, identity);
    await deploymentEntered;
    const secondConfirmation = runAction(service, resolution, undefined, identity);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(deployWorkflow).toHaveBeenCalledTimes(1);
    releaseDeployment?.();

    const [first, second] = await Promise.all([firstConfirmation, secondConfirmation]);
    expect(first).toMatchObject({
      success: true,
      values: { workflowId: 'wf-single-confirmation' },
    });
    expect(second).toEqual({
      success: false,
      text: 'No pending workflow draft exists in this conversation for those resolutions.',
    });
    expect(deployWorkflow).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(0);
  });

  test('does not deploy when the pending draft cannot be claimed from cache', async () => {
    const cache = new Map<string, unknown>();
    const draft = createValidWorkflow({
      _meta: {
        requiresClarification: [
          {
            kind: 'recipient',
            question: 'Who should receive the summary?',
            paramPath: 'nodes["Gmail"].parameters.sendTo',
          },
        ],
      },
    });
    const cacheFailure = new Error('cache backend unavailable');
    const deployWorkflow = mock(() =>
      Promise.resolve({
        id: 'must-not-commit',
        name: draft.name,
        active: false,
        nodeCount: draft.nodes.length,
        missingCredentials: [],
      })
    );
    const service = {
      generateWorkflowDraft: mock(() => Promise.resolve(draft)),
      deployWorkflow,
    } as Partial<WorkflowService>;
    const identity = {
      cache,
      deleteCache: mock(() => Promise.reject(cacheFailure)),
    };

    await runAction(
      service,
      { action: 'create', seedPrompt: 'Email a summary every day.' },
      undefined,
      identity
    );
    const result = await runAction(
      service,
      {
        action: 'create',
        resolutions: [
          { paramPath: 'nodes["Gmail"].parameters.sendTo', value: 'owner@example.com' },
        ],
      },
      undefined,
      identity
    );

    expect(result).toEqual({ success: false, text: 'cache backend unavailable' });
    expect(deployWorkflow).not.toHaveBeenCalled();
    expect(cache.size).toBe(1);
  });

  test('lists workflows for chat review and selection', async () => {
    const listWorkflows = mock(() =>
      Promise.resolve([
        {
          id: 'wf-1',
          versionId: 'v-1',
          name: 'Daily summary',
          active: true,
          nodes: [{ id: 'n1', name: 'Manual Trigger', type: 'manual', parameters: {} }],
          connections: {},
          createdAt: '2026-06-20T12:00:00.000Z',
          updatedAt: '2026-06-20T12:00:00.000Z',
        },
      ])
    );

    const result = await runAction({ listWorkflows } as Partial<WorkflowService>, {
      action: 'list',
      limit: 5,
    });

    expect(listWorkflows).toHaveBeenCalledWith('user-test');
    expect(result.success).toBe(true);
    expect(result.values).toEqual({ count: 1 });
    expect(result.data).toEqual({
      workflows: [{ id: 'wf-1', name: 'Daily summary', active: true, nodeCount: 1 }],
      total: 1,
    });
  });

  test('gets a workflow definition for chat review', async () => {
    const getWorkflow = mock(() =>
      Promise.resolve({
        id: 'wf-1',
        versionId: 'v-1',
        name: 'Daily summary',
        active: true,
        nodes: [
          { id: 'trigger', name: 'Manual Trigger', type: 'manual', parameters: {} },
          { id: 'set', name: 'Set Summary', type: 'set', parameters: {} },
        ],
        connections: {},
        createdAt: '2026-06-20T12:00:00.000Z',
        updatedAt: '2026-06-20T12:00:00.000Z',
      })
    );

    const result = await runAction({ getWorkflow } as Partial<WorkflowService>, {
      action: 'get',
      workflowId: 'wf-1',
    });

    expect(getWorkflow).toHaveBeenCalledWith('wf-1', 'user-test');
    expect(result.success).toBe(true);
    expect(result.values).toEqual({
      workflowId: 'wf-1',
      workflowName: 'Daily summary',
      active: true,
      nodeCount: 2,
    });
    expect(result.data).toEqual({
      workflow: expect.objectContaining({ id: 'wf-1', name: 'Daily summary' }),
    });
  });

  test('activates, deactivates, and deletes through chat with list-safe delete values', async () => {
    const workflow = createWorkflowResponse({
      id: 'wf-lifecycle',
      name: 'Lifecycle workflow',
      active: false,
    });
    let active = false;
    const getWorkflow = mock(() => Promise.resolve({ ...workflow, active }));
    const activateWorkflow = mock((_workflowId: string, _ownerId: string) => {
      active = true;
      return Promise.resolve();
    });
    const deactivateWorkflow = mock((_workflowId: string, _ownerId: string) => {
      active = false;
      return Promise.resolve();
    });
    const deleteWorkflow = mock((_workflowId: string, _ownerId: string) => Promise.resolve());
    const service = {
      getWorkflow,
      activateWorkflow,
      deactivateWorkflow,
      deleteWorkflow,
    } as Partial<WorkflowService>;

    const activated = await runAction(service, {
      action: 'activate',
      workflowId: 'wf-lifecycle',
    });
    const deactivated = await runAction(service, {
      action: 'deactivate',
      workflowId: 'wf-lifecycle',
    });
    const deleted = await runAction(service, {
      action: 'delete',
      workflowId: 'wf-lifecycle',
    });

    expect(activateWorkflow).toHaveBeenCalledWith('wf-lifecycle', 'user-test');
    expect(deactivateWorkflow).toHaveBeenCalledWith('wf-lifecycle', 'user-test');
    expect(deleteWorkflow).toHaveBeenCalledWith('wf-lifecycle', 'user-test');
    expect(getWorkflow).toHaveBeenCalledTimes(3);
    expect(activated).toMatchObject({
      success: true,
      values: { workflowId: 'wf-lifecycle', active: true },
    });
    expect(deactivated).toMatchObject({
      success: true,
      values: { workflowId: 'wf-lifecycle', active: false },
    });
    // Deletion returns the removed id as data for logs, not as handoff values:
    // the chat client therefore opens the refreshed list instead of a 404 editor.
    expect(deleted.values).toBeUndefined();
    expect(deleted).toMatchObject({
      success: true,
      data: { workflowId: 'wf-lifecycle', workflowName: 'Lifecycle workflow' },
    });
  });

  test('returns actionable always-on subscription guidance when chat activation is blocked', async () => {
    const workflow = createWorkflowResponse({
      id: 'wf-lazy-schedule',
      name: 'Lazy schedule',
      active: false,
    });
    const getWorkflow = mock(() => Promise.resolve(workflow));
    const activateWorkflow = mock(() =>
      Promise.reject(
        new WorkflowApiError(
          'Scheduled workflows require an always-on agent runtime. Confirm continuous billing before activating this workflow.',
          409,
          { code: 'workflow_requires_always_on' }
        )
      )
    );

    const result = await runAction({ getWorkflow, activateWorkflow } as Partial<WorkflowService>, {
      action: 'activate',
      workflowId: workflow.id,
    });

    expect(result).toMatchObject({
      success: false,
      text: expect.stringContaining('Confirm continuous billing'),
    });
  });

  test('does not misreport workflow-store failures as missing workflows', async () => {
    const getWorkflow = mock(() => Promise.reject(new Error('workflow store unavailable')));
    const activateWorkflow = mock(() => Promise.resolve());
    const deactivateWorkflow = mock(() => Promise.resolve());
    const deleteWorkflow = mock(() => Promise.resolve());
    const service = {
      getWorkflow,
      activateWorkflow,
      deactivateWorkflow,
      deleteWorkflow,
    } as Partial<WorkflowService>;

    for (const action of ['modify', 'activate', 'deactivate', 'delete']) {
      const result = await runAction(service, { action, workflowId: 'wf-unavailable' });
      expect(result).toEqual({ success: false, text: 'workflow store unavailable' });
    }

    expect(activateWorkflow).not.toHaveBeenCalled();
    expect(deactivateWorkflow).not.toHaveBeenCalled();
    expect(deleteWorkflow).not.toHaveBeenCalled();
  });

  test('runs a workflow immediately and returns execution details', async () => {
    const runWorkflow = mock(() =>
      Promise.resolve({
        id: 'exec-1',
        workflowId: 'wf-1',
        mode: 'manual',
        startedAt: '2026-06-20T12:00:00.000Z',
        stoppedAt: '2026-06-20T12:00:01.000Z',
        finished: true,
        status: 'success',
      })
    );
    const callback = mock(() => Promise.resolve());

    const result = await runAction(
      { runWorkflow } as Partial<WorkflowService>,
      { action: 'run', workflowId: 'wf-1' },
      callback as HandlerCallback
    );

    expect(runWorkflow).toHaveBeenCalledWith('wf-1', { throwOnError: false }, 'user-test');
    expect(result.success).toBe(true);
    expect(result.values).toEqual({
      workflowId: 'wf-1',
      executionId: 'exec-1',
      status: 'success',
    });
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ workflowId: 'wf-1', executionId: 'exec-1' }),
      })
    );
  });

  test('lists revisions so chat can offer rollback choices', async () => {
    const listWorkflowRevisions = mock(() =>
      Promise.resolve([
        {
          id: 'rev-1',
          workflowId: 'wf-1',
          versionId: 'v-1',
          name: 'Previous workflow',
          active: true,
          workflow: { name: 'Previous workflow', nodes: [], connections: {} },
          createdAt: '2026-06-20T12:00:00.000Z',
          updatedAt: '2026-06-20T12:00:00.000Z',
          capturedAt: '2026-06-20T12:01:00.000Z',
          operation: 'update' as const,
        },
      ])
    );

    const result = await runAction({ listWorkflowRevisions } as Partial<WorkflowService>, {
      action: 'revisions',
      workflowId: 'wf-1',
      limit: 5,
    });

    expect(listWorkflowRevisions).toHaveBeenCalledWith('wf-1', 5, 'user-test');
    expect(result.success).toBe(true);
    expect(result.values).toEqual({ workflowId: 'wf-1', count: 1 });
    expect(result.data).toEqual({
      revisions: expect.arrayContaining([expect.objectContaining({ versionId: 'v-1' })]),
    });
  });

  test('restores a selected workflow revision', async () => {
    const restoreWorkflowRevision = mock(() =>
      Promise.resolve({
        id: 'wf-1',
        versionId: 'v-restored',
        name: 'Restored workflow',
        active: true,
        nodes: [],
        connections: {},
        createdAt: '2026-06-20T12:00:00.000Z',
        updatedAt: '2026-06-20T12:02:00.000Z',
      })
    );

    const result = await runAction({ restoreWorkflowRevision } as Partial<WorkflowService>, {
      action: 'restore',
      workflowId: 'wf-1',
      versionId: 'v-old',
    });

    expect(restoreWorkflowRevision).toHaveBeenCalledWith('wf-1', 'v-old', 'user-test');
    expect(result.success).toBe(true);
    expect(result.values).toEqual({
      workflowId: 'wf-1',
      workflowName: 'Restored workflow',
      versionId: 'v-old',
    });
    expect(result.data).toEqual({
      workflow: {
        id: 'wf-1',
        name: 'Restored workflow',
        active: true,
        nodeCount: 0,
      },
    });
  });

  test('diagnoses the latest failed execution for chat troubleshooting', async () => {
    const listExecutions = mock(() =>
      Promise.resolve({
        data: [
          {
            id: 'exec-failed',
            workflowId: 'wf-1',
            mode: 'manual' as const,
            startedAt: '2026-06-20T12:00:00.000Z',
            stoppedAt: '2026-06-20T12:00:01.000Z',
            finished: true,
            status: 'error' as const,
            data: {
              resultData: {
                lastNodeExecuted: 'Send Slack',
                engine: {
                  provider: 'smithers' as const,
                  nodes: 3,
                  levels: 2,
                  maxConcurrency: 2,
                  started: 3,
                  finished: 2,
                  failed: 1,
                  skipped: 0,
                  retries: 1,
                },
                error: { message: 'Missing Slack credential' },
                runData: {
                  'Send Slack': [
                    {
                      executionTime: 12,
                      error: { message: 'Missing Slack credential' },
                      data: { main: [] },
                    },
                  ],
                },
              },
            },
          },
        ],
      })
    );
    const callback = mock(() => Promise.resolve());

    const result = await runAction(
      { listExecutions } as Partial<WorkflowService>,
      { action: 'diagnose', workflowId: 'wf-1' },
      callback as HandlerCallback
    );

    expect(listExecutions).toHaveBeenCalledWith({ workflowId: 'wf-1', limit: 10 }, 'user-test');
    expect(result.success).toBe(true);
    expect(result.values).toEqual({
      workflowId: 'wf-1',
      executionId: 'exec-failed',
      status: 'error',
      error: 'Missing Slack credential',
    });
    expect(result.text).toContain('Missing Slack credential');
    expect(result.data).toEqual({
      execution: expect.objectContaining({ id: 'exec-failed' }),
      summary: expect.objectContaining({ statusLabel: 'Failed' }),
      diagnostics: expect.stringContaining('Engine: 3 nodes / 2 levels / 2 max parallel'),
    });
    expect(String((result.data as { diagnostics: string }).diagnostics)).toContain(
      'Send Slack: error; 0 items; 12 ms; error=Missing Slack credential'
    );
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          workflowId: 'wf-1',
          executionId: 'exec-failed',
          status: 'error',
        }),
      })
    );
  });

  test('diagnoses an execution directly by id', async () => {
    const getExecutionDetail = mock(() =>
      Promise.resolve({
        id: 'exec-1',
        workflowId: 'wf-1',
        mode: 'manual' as const,
        startedAt: '2026-06-20T12:00:00.000Z',
        stoppedAt: '2026-06-20T12:00:01.000Z',
        finished: true,
        status: 'success' as const,
        data: { resultData: { runData: {} } },
      })
    );

    const result = await runAction({ getExecutionDetail } as Partial<WorkflowService>, {
      action: 'diagnose',
      executionId: 'exec-1',
    });

    expect(getExecutionDetail).toHaveBeenCalledWith('exec-1', 'user-test');
    expect(result.success).toBe(true);
    expect(result.values).toEqual({
      workflowId: 'wf-1',
      executionId: 'exec-1',
      status: 'success',
    });
    expect(result.data).toEqual({
      execution: expect.objectContaining({ id: 'exec-1' }),
      summary: expect.objectContaining({ statusLabel: 'Succeeded' }),
      diagnostics: expect.stringContaining('Nodes: none recorded'),
    });
  });

  test('generates evaluation samples from workflow executions for chat optimization', async () => {
    const getWorkflowEvaluationSuite = mock(() =>
      Promise.resolve({
        workflowId: 'wf-1',
        workflowName: 'Daily summary',
        workflowVersionId: 'v-1',
        generatedAt: '2026-06-20T12:00:00.000Z',
        sampleCount: 1,
        samples: [
          {
            id: 'wf-1:exec-1',
            workflowId: 'wf-1',
            workflowName: 'Daily summary',
            workflowVersionId: 'v-1',
            executionId: 'exec-1',
            createdAt: '2026-06-20T12:00:00.000Z',
            input: { mode: 'manual' as const },
            expected: { status: 'success' as const, passed: true, nodes: [] },
            score: { pass: true, value: 1, reason: 'Execution completed successfully.' },
            tags: ['smithers'],
          },
        ],
        jsonl: '{"id":"wf-1:exec-1"}',
        optimizer: {
          engine: 'smithers-gepa' as const,
          target: 'workflow-generation' as const,
          suiteName: 'daily-summary',
          caseFile: 'evals/daily-summary.jsonl',
          recommendedCommand:
            'bunx smithers-orchestrator eval <workflow.tsx> --cases evals/daily-summary.jsonl --suite daily-summary',
          recommendedEvalCommand:
            'bunx smithers-orchestrator eval <workflow.tsx> --cases evals/daily-summary.jsonl --suite daily-summary',
          recommendedOptimizeCommand: 'bunx smithers-orchestrator optimize',
          recommendedObservabilityCommand: 'bunx smithers-orchestrator observability --detach',
          recommendedMetricsCommand:
            'bunx smithers-orchestrator up <workflow.tsx> --serve --metrics',
          notes: [],
        },
      })
    );

    const result = await runAction({ getWorkflowEvaluationSuite } as Partial<WorkflowService>, {
      action: 'eval_samples',
      workflowId: 'wf-1',
      limit: 5,
    });

    expect(getWorkflowEvaluationSuite).toHaveBeenCalledWith('wf-1', 5, 'user-test');
    expect(result.success).toBe(true);
    expect(result.values).toEqual({
      workflowId: 'wf-1',
      count: 1,
      caseFile: 'evals/daily-summary.jsonl',
      suiteName: 'daily-summary',
    });
    expect(result.text).toContain('Save cases to evals/daily-summary.jsonl.');
    expect(result.text).toContain('Optimize: bunx smithers-orchestrator optimize');
    expect(result.data).toEqual({
      suite: expect.objectContaining({
        workflowId: 'wf-1',
        sampleCount: 1,
        jsonl: '{"id":"wf-1:exec-1"}',
      }),
    });
  });
});

describe('automation vocabulary (#16570)', () => {
  test('carries the automation simile family a live agent actually guessed', () => {
    const similes = new Set(workflowAction.similes ?? []);
    // The two exact names from the production repro must resolve, plus the
    // core family the "automations" UI vocabulary produces.
    for (const guessed of [
      'AUTOMATION_DELETE',
      'AUTOMATION_CANCEL',
      'DELETE_AUTOMATION',
      'CANCEL_AUTOMATION',
      'LIST_AUTOMATIONS',
      'CREATE_AUTOMATION',
      'DISABLE_AUTOMATION',
    ]) {
      expect(similes.has(guessed)).toBe(true);
    }
  });

  test('describes itself with the automation vocabulary so keyword retrieval matches', () => {
    expect(workflowAction.description.toLowerCase()).toContain('automation');
    expect(workflowAction.descriptionCompressed?.toLowerCase()).toContain('automation');
  });

  test('routes automation cancellation to lifecycle ops without colliding with draft cancellation', () => {
    const opParam = (workflowAction.parameters ?? []).find((p) => p.name === 'action');
    const allowed = (opParam?.schema as { enum?: string[] } | undefined)?.enum ?? [];
    expect(allowed).toContain('delete');
    expect(allowed).toContain('deactivate');
    expect(allowed).toContain('cancel_draft');
    expect(allowed).not.toContain('cancel');
  });
});
