import { AccessControl } from '@manuling/authz';
import { UnitOfWork } from '@manuling/db';
import {
  BusinessRuleViolation,
  ConflictError,
  ForbiddenError,
  LocalDate,
  NotFoundError,
  RequestContexts,
  ValidationError,
  newId,
} from '@manuling/kernel';
import { Injectable } from '@nestjs/common';
import { PLATFORM_PERMISSIONS as P } from '../authorisation/permissions.js';
import {
  type ApprovalPort,
  type ApprovalRequest,
  type ApprovalSubmission,
} from '../contracts/approvals.js';
import {
  ApprovalRepository,
  type DelegationRow,
  type InstanceRow,
  type TaskRow,
} from '../infrastructure/approval.repository.js';
import { IdentityRepository } from '../infrastructure/identity.repository.js';
import { ChangeLog } from './change-log.js';
import { parseStoredFlow } from './workflow-definition.service.js';

export type InstanceWithTasks = InstanceRow & { readonly tasks: readonly TaskRow[] };
export type InboxItem = TaskRow & {
  readonly instance: InstanceRow;
  readonly delegatedFrom: string | null;
};

const ref = (i: InstanceRow) => ({
  instanceId: i.id,
  entityType: i.entityType,
  entityId: i.entityId,
  companyId: i.companyId,
});

/**
 * Approvals as seen by modules (ApprovalPort) and by users (inbox, decisions, cancel,
 * delegation). Decisions are recorded here, in Postgres (W1); the outbox then tells the
 * Temporal workflow to re-evaluate the step (W2).
 */
@Injectable()
export class ApprovalService implements ApprovalPort {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repo: ApprovalRepository,
    private readonly identity: IdentityRepository,
    private readonly changes: ChangeLog,
  ) {}

  // ----- ApprovalPort ----------------------------------------------------------------------

  submit(request: ApprovalRequest): Promise<ApprovalSubmission> {
    RequestContexts.requireTenant();
    return this.uow.run(async () => {
      const definition = await this.repo.findDefinition(request.companyId, request.entityType);
      const version =
        definition && definition.status === 'active'
          ? await this.repo.publishedVersion(definition.id)
          : undefined;
      if (!definition || !version) return { required: false } as const;
      parseStoredFlow(version.flow);

      if (await this.repo.findOpenInstance(request.entityType, request.entityId)) {
        throw new ConflictError(
          'platform.approval.already_open',
          'This document already has an open approval',
          {
            entityType: request.entityType,
            entityId: request.entityId,
          },
        );
      }
      const instance: InstanceRow = {
        id: newId(),
        companyId: request.companyId,
        plantId: request.plantId ?? null,
        definitionId: definition.id,
        versionId: version.id,
        entityType: request.entityType,
        entityId: request.entityId,
        attributes: { ...request.attributes },
        requesterId: request.requesterId,
        status: 'submitted',
        currentStep: null,
        outcomeReason: null,
        submittedAt: new Date(),
        completedAt: null,
      };
      await this.repo.insertInstance(instance);
      await this.changes.record({
        entityType: 'platform.approval_instance',
        entityId: instance.id,
        action: 'submit',
        after: {
          ...ref(instance),
          attributes: instance.attributes,
          workflowVersion: version.number,
        },
        event: {
          type: 'platform.ApprovalSubmitted.v1',
          aggregateType: 'ApprovalInstance',
          data: {
            ...ref(instance),
            requesterId: request.requesterId,
            workflowVersionId: version.id,
          },
        },
      });
      return { required: true, instanceId: instance.id } as const;
    });
  }

  cancel(entityType: string, entityId: string, reason: string): Promise<void> {
    return this.uow.run(async () => {
      const open = await this.repo.findOpenInstance(entityType, entityId);
      if (open) await this.close(open.id, reason);
    });
  }

  // ----- users --------------------------------------------------------------------------------

  /** Pending tasks for the caller, including those of users who delegated to them today. */
  inbox(): Promise<InboxItem[]> {
    const { actor, timezone } = RequestContexts.requireTenant();
    return this.uow.run(
      async () => {
        const today = LocalDate.fromInstant(new Date(), timezone).toString();
        const delegators = await this.repo.activeDelegators(actor.id, today);
        const tasks = await this.repo.inbox([actor.id, ...delegators]);
        const items: InboxItem[] = [];
        for (const t of tasks) {
          if (t.assigneeId === actor.id) {
            items.push({ ...t, delegatedFrom: null });
          } else if (
            (await this.repo.activeDelegators(actor.id, today, t.instance.entityType)).includes(
              t.assigneeId,
            )
          ) {
            items.push({ ...t, delegatedFrom: t.assigneeId });
          }
        }
        return items;
      },
      { readOnly: true },
    );
  }

  decide(
    taskId: string,
    decision: 'approved' | 'rejected',
    comment: string | null,
  ): Promise<TaskRow> {
    const { actor, timezone } = RequestContexts.requireTenant();
    if (decision === 'rejected' && !comment?.trim()) {
      throw new ValidationError(
        'platform.approval.comment_required',
        'Give a reason when rejecting',
        {},
        [
          {
            path: 'comment',
            code: 'platform.approval.comment_required',
            message: 'Required when rejecting',
          },
        ],
      );
    }
    return this.uow.run(async () => {
      const task = await this.repo.findTask(taskId);
      if (!task) throw new NotFoundError('ApprovalTask', taskId);
      const instance = await this.repo.lockInstance(task.instanceId);

      // Who may act: the assignee, or someone the assignee delegated this document type to.
      let onBehalfOf: string | null = null;
      if (task.assigneeId !== actor.id) {
        const today = LocalDate.fromInstant(new Date(), timezone).toString();
        const delegators = await this.repo.activeDelegators(actor.id, today, instance.entityType);
        if (!delegators.includes(task.assigneeId)) throw new NotFoundError('ApprovalTask', taskId);
        onBehalfOf = task.assigneeId;
      }
      if (task.status !== 'pending' || !['submitted', 'in_progress'].includes(instance.status)) {
        throw new ConflictError(
          'platform.approval.task_closed',
          'This approval task is no longer open',
          { status: task.status },
        );
      }
      // W4: separation of duties at decision time.
      if (actor.id === instance.requesterId) {
        throw new ForbiddenError(
          'platform.approval.own_request',
          'You cannot approve your own request',
        );
      }
      const flow = parseStoredFlow((await this.repo.getVersion(instance.versionId)).flow);
      const step = flow.steps[task.stepIndex];
      if (
        step &&
        !step.allowRepeatApprover &&
        (await this.repo.deciderIdsOutsideStep(instance.id, task.stepIndex)).has(actor.id)
      ) {
        throw new ForbiddenError(
          'platform.approval.repeat_approver',
          'You already decided an earlier step of this approval',
        );
      }

      if (
        !(await this.repo.decideTask(
          task.id,
          decision,
          actor.id,
          onBehalfOf,
          comment?.trim() || null,
        ))
      ) {
        throw new ConflictError(
          'platform.approval.task_closed',
          'This approval task was decided by someone else',
        );
      }
      await this.changes.record({
        entityType: 'platform.approval_instance',
        entityId: instance.id,
        action: `task_${decision}`,
        after: { taskId: task.id, stepId: task.stepId, decision, comment, onBehalfOf },
        event: {
          type: 'platform.ApprovalTaskDecided.v1',
          aggregateType: 'ApprovalInstance',
          data: {
            ...ref(instance),
            taskId: task.id,
            stepId: task.stepId,
            decision,
            decidedBy: actor.id,
            onBehalfOf,
          },
        },
      });
      return (await this.repo.findTask(task.id))!;
    });
  }

  /** Visible to the requester, anyone with a task on it, and holders of workflow.read. */
  getInstance(id: string): Promise<InstanceWithTasks> {
    const { actor } = RequestContexts.requireTenant();
    return this.uow.run(
      async () => {
        const instance = await this.repo.findInstance(id);
        if (!instance) throw new NotFoundError('ApprovalInstance', id);
        const tasks = await this.repo.tasksOfInstance(id);
        const involved =
          instance.requesterId === actor.id ||
          tasks.some((t) => t.assigneeId === actor.id || t.decidedBy === actor.id);
        if (!involved && !AccessControl.can(P.workflowRead, { companyId: instance.companyId })) {
          throw new NotFoundError('ApprovalInstance', id);
        }
        return { ...instance, tasks };
      },
      { readOnly: true },
    );
  }

  cancelByUser(id: string, reason: string): Promise<InstanceRow> {
    const { actor } = RequestContexts.requireTenant();
    return this.uow.run(async () => {
      const instance = await this.repo.lockInstance(id);
      if (
        instance.requesterId !== actor.id &&
        !AccessControl.can(P.workflowManage, { companyId: instance.companyId })
      ) {
        throw new NotFoundError('ApprovalInstance', id);
      }
      if (!['submitted', 'in_progress'].includes(instance.status)) {
        throw new ConflictError('platform.approval.closed', 'This approval is already closed', {
          status: instance.status,
        });
      }
      await this.close(id, reason);
      return this.repo.getInstance(id);
    });
  }

  // ----- delegation ----------------------------------------------------------------------------

  delegations(): Promise<DelegationRow[]> {
    const { actor } = RequestContexts.requireTenant();
    return this.uow.run(() => this.repo.delegationsOf(actor.id), { readOnly: true });
  }

  delegate(input: {
    toUserId: string;
    validFrom: string;
    validTo: string;
    docTypes?: string[] | undefined;
  }): Promise<DelegationRow> {
    const { actor } = RequestContexts.requireTenant();
    const from = LocalDate.parse(input.validFrom);
    const to = LocalDate.parse(input.validTo);
    if (to.compare(from) < 0) {
      throw new ValidationError(
        'platform.delegation.dates_invalid',
        'validTo must not be before validFrom',
      );
    }
    if (input.toUserId === actor.id) {
      throw new BusinessRuleViolation(
        'platform.delegation.self',
        'You cannot delegate to yourself',
      );
    }
    return this.uow.run(async () => {
      const target = await this.identity.findUser(input.toUserId);
      if (!target || target.status !== 'active') throw new NotFoundError('User', input.toUserId);
      const row: DelegationRow = {
        id: newId(),
        fromUserId: actor.id,
        toUserId: input.toUserId,
        validFrom: from.toString(),
        validTo: to.toString(),
        docTypes: input.docTypes && input.docTypes.length > 0 ? [...new Set(input.docTypes)] : null,
        status: 'active',
      };
      await this.repo.insertDelegation(row);
      await this.changes.record({
        entityType: 'platform.delegation',
        entityId: row.id,
        action: 'create',
        after: row,
      });
      return row;
    });
  }

  revokeDelegation(id: string): Promise<void> {
    const { actor } = RequestContexts.requireTenant();
    return this.uow.run(async () => {
      const d = await this.repo.findDelegation(id);
      if (!d || d.fromUserId !== actor.id) throw new NotFoundError('Delegation', id);
      await this.repo.revokeDelegation(id);
      await this.changes.record({
        entityType: 'platform.delegation',
        entityId: id,
        action: 'revoke',
        before: d,
        after: { ...d, status: 'revoked' },
      });
    });
  }

  private async close(instanceId: string, reason: string): Promise<void> {
    const instance = await this.repo.getInstance(instanceId);
    if (!(await this.repo.closeInstance(instanceId, 'cancelled', reason))) return;
    await this.repo.closePendingTasks(instanceId, 'cancelled');
    await this.changes.record({
      entityType: 'platform.approval_instance',
      entityId: instanceId,
      action: 'cancel',
      after: { reason },
      event: {
        type: 'platform.ApprovalCancelled.v1',
        aggregateType: 'ApprovalInstance',
        data: { ...ref(instance), reason },
      },
    });
    await this.changes.record({
      entityType: 'platform.approval_instance',
      entityId: instanceId,
      action: 'complete',
      after: { outcome: 'cancelled', reason },
      event: {
        type: 'platform.ApprovalCompleted.v1',
        aggregateType: 'ApprovalInstance',
        data: { ...ref(instance), outcome: 'cancelled', reason },
      },
    });
  }
}
