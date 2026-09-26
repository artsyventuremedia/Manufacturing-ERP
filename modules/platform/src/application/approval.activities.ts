import { UnitOfWork } from '@manuling/db';
import { type RequestContext, RequestContexts, newId } from '@manuling/kernel';
import { Injectable } from '@nestjs/common';
import {
  type ApprovalStep,
  type ApproverSpec,
  hoursToMs,
  stepApplies,
  stepOutcome,
} from '../domain/approval.js';
import {
  ApprovalRepository,
  type InstanceRow,
  type TaskRow,
} from '../infrastructure/approval.repository.js';
import { IdentityRepository } from '../infrastructure/identity.repository.js';
import { ApproverResolver } from './approver-resolver.js';
import { ChangeLog } from './change-log.js';
import { parseStoredFlow } from './workflow-definition.service.js';

export interface StepRef {
  readonly tenantId: string;
  readonly instanceId: string;
  readonly stepIndex: number;
}

export type StepStart =
  | { readonly kind: 'done' }
  | { readonly kind: 'closed' }
  | { readonly kind: 'skipped' }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'waiting'; readonly slaMs: number | null; readonly reminderMs: number | null };

export type StepEvaluation = 'pending' | 'approved' | 'rejected' | 'closed';

export type StepTimeout =
  | { readonly kind: 'closed' }
  | { readonly kind: 'keep_waiting' }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'escalated'; readonly slaMs: number | null };

const OPEN = ['submitted', 'in_progress'];

/**
 * Temporal activities for the approval workflow (step 0.8). Each runs in its own
 * transaction under the instance's tenant as `system:approvals`, locks the instance row,
 * and is idempotent, so Temporal retries are safe.
 */
@Injectable()
export class ApprovalActivities {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repo: ApprovalRepository,
    private readonly identity: IdentityRepository,
    private readonly resolver: ApproverResolver,
    private readonly changes: ChangeLog,
  ) {}

  startStep(ref: StepRef): Promise<StepStart> {
    return this.inTenant<StepStart>(ref, async (instance, steps) => {
      const step = steps[ref.stepIndex];
      if (!step) return { kind: 'done' };
      if (!stepApplies(step, instance.attributes, instance.requesterId)) return { kind: 'skipped' };

      const timing = {
        slaMs: hoursToMs(step.slaHours),
        reminderMs: hoursToMs(step.reminderHours),
      } as const;
      if ((await this.repo.tasksOfStep(instance.id, ref.stepIndex)).length > 0) {
        return { kind: 'waiting', ...timing }; // activity retry after tasks were created
      }
      let level = 0;
      let approvers = await this.resolver.resolve(step.approvers, instance);
      if (approvers.length === 0 && step.onTimeout?.action === 'escalate') {
        level = 1;
        approvers = await this.resolver.resolve(step.onTimeout.to, instance);
      }
      if (approvers.length === 0) return { kind: 'rejected', reason: 'no_approvers' };

      await this.repo.setInstanceProgress(instance.id, ref.stepIndex);
      await this.assign(
        instance,
        ref.stepIndex,
        step,
        approvers,
        level,
        'platform.ApprovalTaskAssigned.v1',
      );
      return { kind: 'waiting', ...timing };
    });
  }

  evaluateStep(ref: StepRef): Promise<StepEvaluation> {
    return this.inTenant<StepEvaluation>(
      ref,
      async (instance, steps) => {
        const step = steps[ref.stepIndex];
        if (!step) return 'approved';
        const live = (await this.repo.tasksOfStep(instance.id, ref.stepIndex)).filter(
          (t) => t.status !== 'expired' && t.status !== 'cancelled',
        );
        const state = stepOutcome(step.mode, {
          approved: live.filter((t) => t.status === 'approved').length,
          rejected: live.filter((t) => t.status === 'rejected').length,
          total: live.length,
        });
        if (state !== 'pending')
          await this.repo.closePendingTasks(instance.id, 'cancelled', ref.stepIndex);
        return state;
      },
      'closed',
    );
  }

  timeoutStep(ref: StepRef & { readonly level: number }): Promise<StepTimeout> {
    return this.inTenant<StepTimeout>(
      ref,
      async (instance, steps) => {
        const step = steps[ref.stepIndex];
        const pending = (await this.repo.tasksOfStep(instance.id, ref.stepIndex)).filter(
          (t) => t.status === 'pending',
        );
        if (!step || pending.length === 0 || !step.onTimeout) return { kind: 'keep_waiting' };
        await this.repo.closePendingTasks(instance.id, 'expired', ref.stepIndex);
        if (step.onTimeout.action === 'reject') return { kind: 'rejected', reason: 'sla_expired' };

        const approvers = await this.resolver.resolve(step.onTimeout.to, instance);
        if (approvers.length === 0) return { kind: 'rejected', reason: 'no_escalation_approvers' };
        await this.assign(
          instance,
          ref.stepIndex,
          step,
          approvers,
          ref.level + 1,
          'platform.ApprovalEscalated.v1',
        );
        return { kind: 'escalated', slaMs: hoursToMs(step.slaHours) };
      },
      { kind: 'closed' },
    );
  }

  remind(ref: StepRef): Promise<void> {
    return this.inTenant(
      ref,
      async (instance) => {
        for (const task of (await this.repo.tasksOfStep(instance.id, ref.stepIndex)).filter(
          (t) => t.status === 'pending',
        )) {
          await this.recordTask(instance, task, 'remind', 'platform.ApprovalReminderDue.v1');
        }
      },
      undefined,
    );
  }

  complete(
    ref: Omit<StepRef, 'stepIndex'> & {
      readonly outcome: 'approved' | 'rejected';
      readonly reason: string | null;
    },
  ): Promise<void> {
    return this.inTenant(
      { ...ref, stepIndex: -1 },
      async (instance) => {
        if (!(await this.repo.closeInstance(instance.id, ref.outcome, ref.reason))) return;
        await this.repo.closePendingTasks(instance.id, 'cancelled');
        await this.changes.record({
          entityType: 'platform.approval_instance',
          entityId: instance.id,
          action: 'complete',
          after: { outcome: ref.outcome, reason: ref.reason },
          event: {
            type: 'platform.ApprovalCompleted.v1',
            aggregateType: 'ApprovalInstance',
            data: { ...this.ref(instance), outcome: ref.outcome, reason: ref.reason },
          },
        });
      },
      undefined,
    );
  }

  // ----- internals -------------------------------------------------------------------------

  private async assign(
    instance: InstanceRow,
    stepIndex: number,
    step: ApprovalStep,
    approvers: readonly string[],
    level: number,
    eventType: 'platform.ApprovalTaskAssigned.v1' | 'platform.ApprovalEscalated.v1',
  ): Promise<void> {
    const slaMs = hoursToMs(step.slaHours);
    const dueAt = slaMs === null ? null : new Date(Date.now() + slaMs);
    const created = await this.repo.insertTasks(
      approvers.map((assigneeId) => ({
        id: newId(),
        instanceId: instance.id,
        stepIndex,
        stepId: step.id,
        assigneeId,
        status: 'pending' as const,
        escalationLevel: level,
        dueAt,
      })),
    );
    for (const task of created)
      await this.recordTask(instance, task, level === 0 ? 'assign' : 'escalate', eventType);
  }

  private recordTask(
    instance: InstanceRow,
    task: TaskRow,
    action: string,
    type:
      | 'platform.ApprovalTaskAssigned.v1'
      | 'platform.ApprovalEscalated.v1'
      | 'platform.ApprovalReminderDue.v1',
  ): Promise<void> {
    const data = {
      ...this.ref(instance),
      taskId: task.id,
      stepId: task.stepId,
      assigneeId: task.assigneeId,
      dueAt: task.dueAt?.toISOString() ?? null,
      escalationLevel: task.escalationLevel,
    };
    return this.changes.record({
      entityType: 'platform.approval_instance',
      entityId: instance.id,
      action,
      after: data,
      event: { type, aggregateType: 'ApprovalInstance', data },
    });
  }

  private ref(i: InstanceRow) {
    return {
      instanceId: i.id,
      entityType: i.entityType,
      entityId: i.entityId,
      companyId: i.companyId,
    };
  }

  /**
   * Runs `fn` in a transaction under the instance's tenant (and its time zone), with the
   * instance locked. Closed instances short-circuit to `whenClosed`.
   */
  private inTenant<T>(
    ref: StepRef,
    fn: (instance: InstanceRow, steps: readonly ApprovalStep[]) => Promise<T>,
    whenClosed?: T,
  ): Promise<T> {
    const base: RequestContext = {
      correlationId: `approval-${ref.instanceId}`,
      source: 'system',
      locale: 'en-IN',
      timezone: 'UTC',
      companyIds: [],
      tenantId: ref.tenantId,
      actor: { type: 'system', id: 'approvals' },
    };
    return RequestContexts.run(base, () =>
      this.uow.run(async () => {
        const tenant = await this.identity.findCurrentTenant();
        return RequestContexts.run(
          { ...base, timezone: tenant?.defaultTimezone ?? 'UTC' },
          async () => {
            const instance = await this.repo.lockInstance(ref.instanceId);
            if (!OPEN.includes(instance.status))
              return whenClosed ?? ({ kind: 'closed' } as unknown as T);
            const flow = parseStoredFlow((await this.repo.getVersion(instance.versionId)).flow);
            return fn(instance, flow.steps);
          },
        );
      }),
    );
  }
}

/** Plain functions for Temporal's activity registry (names must match the workflow proxy). */
export function approvalActivityFunctions(a: ApprovalActivities) {
  return {
    startStep: (ref: StepRef) => a.startStep(ref),
    evaluateStep: (ref: StepRef) => a.evaluateStep(ref),
    timeoutStep: (ref: StepRef & { level: number }) => a.timeoutStep(ref),
    remind: (ref: StepRef) => a.remind(ref),
    complete: (ref: {
      tenantId: string;
      instanceId: string;
      outcome: 'approved' | 'rejected';
      reason: string | null;
    }) => a.complete(ref),
  };
}

export type ApprovalActivityFunctions = ReturnType<typeof approvalActivityFunctions>;
export type { ApproverSpec };
