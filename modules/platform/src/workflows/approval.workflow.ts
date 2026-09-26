/**
 * Approval orchestration (step 0.8, plan W1/W2/W6). Deterministic workflow code: it only
 * sequences steps and keeps time; every read and write happens in activities against
 * Postgres, which remains the source of truth for tasks and decisions.
 *
 * This file is bundled by Temporal into its workflow sandbox, so it must import only
 * `@temporalio/workflow` and types.
 */
import { condition, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type { ApprovalActivityFunctions } from '../application/approval.activities.js';

const activities = proxyActivities<ApprovalActivityFunctions>({
  startToCloseTimeout: '1 minute',
  retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumInterval: '1 minute' },
});

/** A task of the current step was decided in Postgres; re-evaluate the step. */
export const taskDecidedSignal = defineSignal('taskDecided');
/** The instance was cancelled in Postgres; stop. */
export const cancelSignal = defineSignal('cancel');

export interface ApprovalWorkflowInput {
  readonly tenantId: string;
  readonly instanceId: string;
}

export async function approvalWorkflow(input: ApprovalWorkflowInput): Promise<string> {
  let signals = 0;
  let cancelled = false;
  setHandler(taskDecidedSignal, () => void signals++);
  setHandler(cancelSignal, () => void (cancelled = true));
  const { tenantId, instanceId } = input;

  for (let stepIndex = 0; ; stepIndex++) {
    const ref = { tenantId, instanceId, stepIndex };
    let seen = signals; // decisions arriving while the step starts are not missed
    const start = await activities.startStep(ref);
    if (start.kind === 'closed' || cancelled) return 'cancelled';
    if (start.kind === 'done') {
      await activities.complete({ tenantId, instanceId, outcome: 'approved', reason: null });
      return 'approved';
    }
    if (start.kind === 'skipped') continue;
    if (start.kind === 'rejected') {
      await activities.complete({
        tenantId,
        instanceId,
        outcome: 'rejected',
        reason: start.reason,
      });
      return 'rejected';
    }

    let level = 0;
    let deadline = start.slaMs === null ? null : Date.now() + start.slaMs;
    let nextReminder = start.reminderMs === null ? null : Date.now() + start.reminderMs;

    for (;;) {
      const wakeAt = [deadline, nextReminder]
        .filter((t): t is number => t !== null)
        .sort((a, b) => a - b)[0];
      // No deadline: wait for a signal only. (Passing an undefined timeout would not wait.)
      const woke =
        wakeAt === undefined
          ? (await condition(() => cancelled || signals !== seen), true)
          : await condition(() => cancelled || signals !== seen, Math.max(0, wakeAt - Date.now()));
      if (cancelled) return 'cancelled';

      if (woke) {
        seen = signals;
        const state = await activities.evaluateStep(ref);
        if (state === 'closed') return 'cancelled';
        if (state === 'approved') break;
        if (state === 'rejected') {
          await activities.complete({
            tenantId,
            instanceId,
            outcome: 'rejected',
            reason: 'rejected_by_approver',
          });
          return 'rejected';
        }
        continue;
      }

      const now = Date.now();
      if (nextReminder !== null && now >= nextReminder && start.reminderMs !== null) {
        await activities.remind(ref);
        nextReminder = now + start.reminderMs;
      }
      if (deadline !== null && now >= deadline) {
        const timeout = await activities.timeoutStep({ ...ref, level });
        if (timeout.kind === 'closed') return 'cancelled';
        if (timeout.kind === 'rejected') {
          await activities.complete({
            tenantId,
            instanceId,
            outcome: 'rejected',
            reason: timeout.reason,
          });
          return 'rejected';
        }
        if (timeout.kind === 'escalated') {
          level++;
          deadline = timeout.slaMs === null ? null : Date.now() + timeout.slaMs;
          nextReminder = start.reminderMs === null ? null : Date.now() + start.reminderMs;
        } else {
          deadline = null; // nothing to escalate: wait for decisions without a deadline
        }
      }
    }
  }
}
