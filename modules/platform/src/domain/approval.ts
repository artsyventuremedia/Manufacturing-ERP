import { type Condition, type ResourceAttributes, evaluateConditions } from '@manuling/authz/core';
import { ValidationError } from '@manuling/kernel';
import { parseConditions } from './role.js';

/** Who may decide a step (W3: approval limits come from role conditions via `permission`). */
export type ApproverSpec =
  | { readonly type: 'users'; readonly userIds: readonly string[] }
  | { readonly type: 'role'; readonly role: string }
  | { readonly type: 'permission'; readonly permission: string };

export type StepMode = 'any' | 'all' | { readonly quorum: number };

export type TimeoutPolicy =
  { readonly action: 'escalate'; readonly to: ApproverSpec } | { readonly action: 'reject' };

export interface ApprovalStep {
  readonly id: string;
  readonly name: string;
  readonly when: readonly Condition[];
  readonly approvers: ApproverSpec;
  readonly mode: StepMode;
  readonly slaHours: number | null;
  readonly reminderHours: number | null;
  readonly onTimeout: TimeoutPolicy | null;
  /** Lets one person decide this step even if they decided an earlier step (W4). */
  readonly allowRepeatApprover: boolean;
}

export interface ApprovalFlow {
  readonly steps: readonly ApprovalStep[];
}

const STEP_ID = /^[a-z][a-z0-9_]{1,39}$/;
const ROLE_CODE = /^[a-z][a-z0-9_]{1,39}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_STEPS = 10;
const MIN_HOURS = 1 / 60; // one minute
const MAX_HOURS = 24 * 365;

export interface FlowReferenceCheck {
  readonly isKnownPermission: (code: string) => boolean;
}

/**
 * Validates DSL JSON (plan W5) into an ApprovalFlow, reporting every problem with a JSON path
 * so the designer UI can point at it.
 */
export function parseFlow(raw: unknown, refs: FlowReferenceCheck): ApprovalFlow {
  const errors: { path: string; code: string; message: string }[] = [];
  const fail = (path: string, message: string) =>
    errors.push({ path, code: 'platform.workflow.invalid', message });

  if (
    typeof raw !== 'object' ||
    raw === null ||
    !Array.isArray((raw as { steps?: unknown }).steps)
  ) {
    throw invalidFlow([
      { path: 'steps', code: 'platform.workflow.invalid', message: 'A flow needs a "steps" list' },
    ]);
  }
  const rawSteps = (raw as { steps: unknown[] }).steps;
  if (rawSteps.length === 0 || rawSteps.length > MAX_STEPS)
    fail('steps', `Use 1–${MAX_STEPS} steps`);

  const ids = new Set<string>();
  const steps: ApprovalStep[] = [];
  rawSteps.forEach((s, i) => {
    const path = `steps.${i}`;
    if (typeof s !== 'object' || s === null) return fail(path, 'Each step must be an object');
    const step = s as Record<string, unknown>;

    const id = step['id'];
    if (typeof id !== 'string' || !STEP_ID.test(id))
      fail(`${path}.id`, 'Use 2–40 lowercase letters, digits or "_"');
    else if (ids.has(id)) fail(`${path}.id`, `Duplicate step id "${id}"`);
    else ids.add(id);

    const name =
      typeof step['name'] === 'string' && step['name'].trim()
        ? step['name'].trim()
        : typeof id === 'string'
          ? id
          : '';

    let when: Condition[] = [];
    if (step['when'] !== undefined) {
      try {
        when = parseConditions(step['when']);
      } catch (err) {
        fail(`${path}.when`, err instanceof Error ? err.message : 'Invalid conditions');
      }
    }

    const approvers = parseApprovers(step['approvers'], `${path}.approvers`, refs, fail);
    const mode = parseMode(step['mode'], `${path}.mode`, fail);
    const slaHours = parseHours(step['slaHours'], `${path}.slaHours`, fail);
    const reminderHours = parseHours(step['reminderHours'], `${path}.reminderHours`, fail);
    if (reminderHours !== null && slaHours !== null && reminderHours >= slaHours) {
      fail(`${path}.reminderHours`, 'Reminders must come before the SLA deadline');
    }

    let onTimeout: TimeoutPolicy | null = null;
    const t = step['onTimeout'];
    if (t !== undefined && t !== null) {
      const action = (t as { action?: unknown }).action;
      if (action === 'reject') onTimeout = { action: 'reject' };
      else if (action === 'escalate') {
        const to = parseApprovers((t as { to?: unknown }).to, `${path}.onTimeout.to`, refs, fail);
        if (to) onTimeout = { action: 'escalate', to };
      } else fail(`${path}.onTimeout.action`, 'Use "escalate" or "reject"');
      if (slaHours === null) fail(`${path}.slaHours`, 'onTimeout needs slaHours');
    }

    if (approvers && mode && typeof id === 'string') {
      steps.push({
        id,
        name,
        when,
        approvers,
        mode,
        slaHours,
        reminderHours,
        onTimeout,
        allowRepeatApprover: step['allowRepeatApprover'] === true,
      });
    }
  });

  if (errors.length > 0) throw invalidFlow(errors);
  return { steps };
}

function parseApprovers(
  raw: unknown,
  path: string,
  refs: FlowReferenceCheck,
  fail: (path: string, message: string) => void,
): ApproverSpec | undefined {
  if (typeof raw !== 'object' || raw === null) {
    fail(path, 'Approvers are required');
    return undefined;
  }
  const a = raw as Record<string, unknown>;
  switch (a['type']) {
    case 'users': {
      const ids = a['userIds'];
      if (
        !Array.isArray(ids) ||
        ids.length === 0 ||
        ids.length > 50 ||
        !ids.every((x) => typeof x === 'string' && UUID.test(x))
      ) {
        fail(`${path}.userIds`, 'Give 1–50 user ids');
        return undefined;
      }
      return {
        type: 'users',
        userIds: [...new Set((ids as string[]).map((x) => x.toLowerCase()))],
      };
    }
    case 'role':
      if (typeof a['role'] !== 'string' || !ROLE_CODE.test(a['role'])) {
        fail(`${path}.role`, 'Give a role code');
        return undefined;
      }
      return { type: 'role', role: a['role'] };
    case 'permission':
      if (typeof a['permission'] !== 'string' || !refs.isKnownPermission(a['permission'])) {
        fail(`${path}.permission`, 'Give a registered permission code');
        return undefined;
      }
      return { type: 'permission', permission: a['permission'] };
    default:
      fail(`${path}.type`, 'Use "users", "role" or "permission"');
      return undefined;
  }
}

function parseMode(
  raw: unknown,
  path: string,
  fail: (path: string, message: string) => void,
): StepMode | undefined {
  if (raw === undefined || raw === 'any') return 'any';
  if (raw === 'all') return 'all';
  const quorum =
    typeof raw === 'object' && raw !== null ? (raw as { quorum?: unknown }).quorum : undefined;
  if (typeof quorum === 'number' && Number.isInteger(quorum) && quorum >= 1 && quorum <= 50)
    return { quorum };
  fail(path, 'Use "any", "all" or { "quorum": n }');
  return undefined;
}

function parseHours(
  raw: unknown,
  path: string,
  fail: (path: string, message: string) => void,
): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < MIN_HOURS || raw > MAX_HOURS) {
    fail(path, 'Use a number of hours between 1 minute and 1 year');
    return null;
  }
  return raw;
}

function invalidFlow(errors: { path: string; code: string; message: string }[]): ValidationError {
  return new ValidationError(
    'platform.workflow.invalid',
    'The approval flow is invalid',
    { count: errors.length },
    errors,
  );
}

/** Whether a step applies to a document (all `when` conditions hold; none = always). */
export function stepApplies(
  step: ApprovalStep,
  attributes: ResourceAttributes,
  requesterId: string,
): boolean {
  return evaluateConditions(step.when, attributes, requesterId);
}

export type StepState = 'pending' | 'approved' | 'rejected';

/**
 * Step outcome from its current (non-expired) tasks. Any rejection rejects the step.
 * `all` needs every task approved; a quorum larger than the approver pool needs them all.
 */
export function stepOutcome(
  mode: StepMode,
  tasks: { approved: number; rejected: number; total: number },
): StepState {
  if (tasks.rejected > 0) return 'rejected';
  const needed =
    mode === 'any' ? 1 : mode === 'all' ? tasks.total : Math.min(mode.quorum, tasks.total);
  return tasks.total > 0 && tasks.approved >= needed ? 'approved' : 'pending';
}

export function hoursToMs(hours: number | null): number | null {
  return hours === null ? null : Math.round(hours * 3_600_000);
}
