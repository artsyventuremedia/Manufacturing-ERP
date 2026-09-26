import { type CloudEvent, type EventConsumer } from '@manuling/events';
import {
  type Client,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
} from '@temporalio/client';

export const APPROVAL_TASK_QUEUE = 'manuling-approvals';
export const approvalWorkflowId = (instanceId: string) => `approval-${instanceId}`;

/** The workflow file for Temporal's bundler (source in dev/tests, compiled JS in dist). */
export const approvalWorkflowsPath = new URL(
  `../workflows/approval.workflow.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`,
  import.meta.url,
);

interface InstanceEventData {
  readonly instanceId: string;
}

/**
 * Bridges the outbox to Temporal (plan W2): starts the workflow when an approval is
 * submitted and signals it on decisions and cancellations. Workflow ids are the instance
 * ids, so redelivered events cannot start duplicates; signals to finished workflows are
 * ignored. Runs in core-worker.
 */
export class ApprovalOrchestrator implements EventConsumer {
  readonly name = 'platform.approval-orchestrator';
  readonly eventTypes = [
    'platform.ApprovalSubmitted.v1',
    'platform.ApprovalTaskDecided.v1',
    'platform.ApprovalCancelled.v1',
  ] as const;

  constructor(
    private readonly client: Client,
    private readonly taskQueue: string = APPROVAL_TASK_QUEUE,
  ) {}

  async handle(event: CloudEvent): Promise<void> {
    const { instanceId } = event.data as InstanceEventData;
    const workflowId = approvalWorkflowId(instanceId);
    switch (event.type) {
      case 'platform.ApprovalSubmitted.v1':
        try {
          await this.client.workflow.start('approvalWorkflow', {
            taskQueue: this.taskQueue,
            workflowId,
            args: [{ tenantId: event.tenantid, instanceId }],
            workflowIdReusePolicy: 'REJECT_DUPLICATE',
          });
        } catch (err) {
          if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
        }
        return;
      case 'platform.ApprovalTaskDecided.v1':
        return this.signal(workflowId, 'taskDecided');
      case 'platform.ApprovalCancelled.v1':
        return this.signal(workflowId, 'cancel');
      default:
        return;
    }
  }

  private async signal(workflowId: string, name: string): Promise<void> {
    try {
      await this.client.workflow.getHandle(workflowId).signal(name);
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) return; // already finished
      throw err;
    }
  }
}
