/**
 * Exercises the real AgentRuntime service registry to prove WorkflowService
 * joins an in-flight registered embedded engine instead of starting a second.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  AgentRuntime,
  createCharacter,
  type IAgentRuntime,
  InMemoryDatabaseAdapter,
} from '@elizaos/core';
import {
  EMBEDDED_WORKFLOW_SERVICE_TYPE,
  EmbeddedWorkflowService,
} from '../../src/services/embedded-workflow-service';
import { WORKFLOW_SERVICE_TYPE, WorkflowService } from '../../src/services/workflow-service';

describe('workflow service startup coordination', () => {
  let runtime: AgentRuntime | null = null;

  afterEach(async () => {
    if (runtime) {
      await runtime.stop();
      await runtime.close();
      runtime = null;
    }
  });

  test('joins one registered embedded startup while service types start concurrently', async () => {
    let embeddedStartCalls = 0;
    let markStartEntered: () => void = () => undefined;
    let releaseStart: () => void = () => undefined;
    const startEntered = new Promise<void>((resolve) => {
      markStartEntered = resolve;
    });
    const startBarrier = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });

    class CoordinatedEmbeddedWorkflowService extends EmbeddedWorkflowService {
      static override readonly serviceType = EMBEDDED_WORKFLOW_SERVICE_TYPE;

      static override async start(
        initializedRuntime: IAgentRuntime
      ): Promise<CoordinatedEmbeddedWorkflowService> {
        embeddedStartCalls += 1;
        markStartEntered();
        await startBarrier;
        return new CoordinatedEmbeddedWorkflowService(initializedRuntime);
      }
    }

    runtime = new AgentRuntime({
      character: createCharacter({ name: 'WorkflowConcurrentStartAgent' }),
      adapter: new InMemoryDatabaseAdapter(),
      logLevel: 'fatal',
      enableAutonomy: false,
    });
    await runtime.initialize();

    await runtime.registerPlugin({
      name: 'workflow-concurrent-start-integration',
      description: 'Registers the embedded and facade services together.',
      services: [CoordinatedEmbeddedWorkflowService, WorkflowService],
    });
    await startEntered;
    releaseStart();

    const [embedded, workflow] = await Promise.all([
      runtime.getServiceLoadPromise(EMBEDDED_WORKFLOW_SERVICE_TYPE),
      runtime.getServiceLoadPromise(WORKFLOW_SERVICE_TYPE),
    ]);

    expect(embeddedStartCalls).toBe(1);
    expect(embedded).toBeInstanceOf(CoordinatedEmbeddedWorkflowService);
    expect(workflow).toBeInstanceOf(WorkflowService);
    expect(runtime.getServiceRegistrationStatus(EMBEDDED_WORKFLOW_SERVICE_TYPE)).toBe('registered');
    expect(runtime.getServiceRegistrationStatus(WORKFLOW_SERVICE_TYPE)).toBe('registered');
    expect(
      runtime
        .getRecentReportedErrors()
        .filter((entry) => entry.scope === 'AgentRuntime.serviceStart')
    ).toEqual([]);
  });
});
