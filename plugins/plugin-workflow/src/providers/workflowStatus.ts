/**
 * `workflow_status` provider: lists each user's workflows with their last
 * execution status for the automation/connectors contexts (ADMIN-gated).
 */
import {
  ElizaError,
  type IAgentRuntime,
  logger,
  type Memory,
  type Provider,
  type State,
} from '@elizaos/core';
import { WORKFLOW_SERVICE_TYPE, type WorkflowService } from '../services/index';
import { getLocalOwnerEntityId, resolveWorkflowOwnerEntityId } from '../utils/context';

export const workflowStatusProvider: Provider = {
  name: 'workflow_status',
  contexts: ['automation', 'connectors'],
  contextGate: { anyOf: ['automation', 'connectors'] },
  cacheScope: 'turn',
  roleGate: { minRole: 'ADMIN' },

  get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    let ownerEntityId = getLocalOwnerEntityId(runtime);
    try {
      const service = runtime.getService<WorkflowService>(WORKFLOW_SERVICE_TYPE);

      if (!service) {
        logger.warn(
          { src: 'plugin:workflow:provider:workflowStatus' },
          'Workflow service not available for provider'
        );
        return {
          text: '',
          data: {},
          values: {},
        };
      }

      ownerEntityId = await resolveWorkflowOwnerEntityId(runtime, _message);

      const workflows = await service.listWorkflows(ownerEntityId);

      if (workflows.length === 0) {
        return {
          text: 'No workflows configured yet.',
          data: {},
          values: {},
        };
      }

      let status = `Current workflows (${workflows.length}):\n\n`;

      for (const workflow of workflows.slice(0, 10)) {
        const statusEmoji = workflow.active ? '✅' : '⏸️';
        status += `${statusEmoji} ${workflow.name} (ID: ${workflow.id})\n`;
        status += `   Nodes: ${workflow.nodes.length || 0}\n`;

        // Try to get last execution (if possible)
        try {
          const executions = await service.getWorkflowExecutions(workflow.id, 1, ownerEntityId);
          if (executions.length > 0) {
            const lastExec = executions[0];
            const execEmoji =
              lastExec.status === 'success' ? '✅' : lastExec.status === 'error' ? '❌' : '⏳';
            status += `   Last run: ${execEmoji} ${lastExec.status} at ${new Date(lastExec.startedAt).toLocaleString()}\n`;
          }
        } catch (error) {
          // error-policy:J4 The workflow list remains useful, but the missing
          // execution status is rendered explicitly and reported to the agent.
          const wrapped = new ElizaError('Failed to load workflow executions', {
            code: 'WORKFLOW_PROVIDER_EXECUTIONS_LOAD_FAILED',
            cause: error,
            context: { workflowId: workflow.id, entityId: ownerEntityId },
            severity: 'ephemeral',
          });
          await runtime.reportError('WorkflowProvider.status.executions', wrapped);
          status += '   Last run: unavailable\n';
        }

        status += '\n';
      }

      if (workflows.length > 10) {
        status += `\n... and ${workflows.length - 10} more workflows.`;
      }

      return {
        text: status,
        data: { workflows },
        values: { workflowCount: workflows.length },
      };
    } catch (error) {
      const wrapped = new ElizaError('Failed to load workflow status', {
        code: 'WORKFLOW_PROVIDER_STATUS_LOAD_FAILED',
        cause: error,
        context: {
          canonicalOwnerId: ownerEntityId,
          messageEntityId: _message.entityId,
        },
        severity: 'ephemeral',
      });
      await runtime.reportError('WorkflowProvider.status', wrapped);
      throw wrapped;
    }
  },
};
