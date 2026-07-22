/**
 * Verifies that revision replay cannot erase the current owner tag across the
 * real WorkflowService, embedded persistence, and owner-filtered read facade.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { stringToUuid } from '@elizaos/core';
import { WORKFLOW_SERVICE_TYPE, WorkflowService } from '../../src/services/workflow-service';
import type { WorkflowDefinition } from '../../src/types/index';
import { type EmbeddedHarness, makeEmbeddedHarness } from './embedded-harness';

const OWNER_A = stringToUuid('workflow-revision-owner-a');
const OWNER_B = stringToUuid('workflow-revision-owner-b');

const definition: WorkflowDefinition = {
  name: 'Owner-safe revision replay',
  nodes: [
    {
      id: 'manual',
      name: 'Manual Trigger',
      type: 'workflows-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [0, 0],
      parameters: {},
    },
  ],
  connections: {},
};

describe('workflow revision ownership', () => {
  let harness: EmbeddedHarness;
  let service: WorkflowService;

  beforeEach(async () => {
    harness = await makeEmbeddedHarness('workflow-revision-ownership-agent');
    await harness.runtime.registerPlugin({
      name: 'workflow-revision-ownership-harness',
      description: 'Owner-scoped WorkflowService revision integration coverage',
      services: [WorkflowService],
    });
    service = (await harness.runtime.getServiceLoadPromise(
      WORKFLOW_SERVICE_TYPE
    )) as WorkflowService;
  });

  afterEach(async () => {
    await harness.close();
  });

  test('owner A restoring the initial pre-tag revision stays visible only to A', async () => {
    const deployed = await service.deployWorkflow(definition, OWNER_A);
    const revisions = await service.listWorkflowRevisions(deployed.id, 20, OWNER_A);
    const initialPreTagRevision = revisions.find((revision) => revision.operation === 'tags');
    expect(initialPreTagRevision).toBeDefined();
    if (!initialPreTagRevision) throw new Error('expected initial pre-owner-tag revision');

    const restored = await service.restoreWorkflowRevision(
      deployed.id,
      initialPreTagRevision.versionId,
      OWNER_A
    );

    expect(restored.tags).toHaveLength(1);
    expect((await service.listWorkflows(OWNER_A)).map((workflow) => workflow.id)).toEqual([
      deployed.id,
    ]);
    expect(await service.listWorkflows(OWNER_B)).toEqual([]);
    await expect(service.getWorkflow(deployed.id, OWNER_B)).rejects.toMatchObject({
      statusCode: 404,
    });
  }, 60_000);
});
