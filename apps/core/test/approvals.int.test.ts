import { UnitOfWork, createPool } from '@manuling/db';
import { ConsumerRunner, InMemoryEventBus, OutboxRelay } from '@manuling/events';
import { type RequestContext, RequestContexts, newId } from '@manuling/kernel';
import {
  APPROVAL_PORT,
  type ApprovalPort,
  type ApprovalRequest,
} from '@manuling/platform/contracts';
import {
  APPROVAL_TASK_QUEUE,
  ApprovalActivities,
  ApprovalOrchestrator,
  ProvisioningService,
  type ProvisionedTenant,
  approvalActivityFunctions,
  approvalWorkflowsPath,
} from '@manuling/platform/module';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CallOptions, type Harness, startHarness, tenantInput } from './support.js';

/**
 * Approvals end to end (step 0.8): real Postgres + API + outbox relay + orchestrator consumer
 * + Temporal worker on the time-skipping test server (SLA timers fire instantly via env.sleep).
 */
let h: Harness;
let env: TestWorkflowEnvironment;
let worker: Worker;
let workerRun: Promise<void>;
let relayPool: pg.Pool;
let relay: OutboxRelay;
let port: ApprovalPort;
let uow: UnitOfWork;
let alpha: ProvisionedTenant;
let beta: ProvisionedTenant;
const users: Record<string, string> = {}; // name → user id
const roles = new Map<string, string>();

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT';
const T = 'alpha-works';
const as =
  (sub: string) =>
  (m: Method, url: string, o: CallOptions = {}) =>
    h.call(m, url, { sub, tenant: T, ...o });
const asOwner = as('sub-owner');

async function member(name: string, assignments: object[]): Promise<void> {
  const email = `${name}@alpha.test`;
  const res = await asOwner('POST', '/v1/platform/users/invitations', {
    payload: { email, displayName: name, assignments },
  });
  expect(res.statusCode, res.body).toBe(201);
  await h.call('GET', '/v1/platform/me', {
    sub: `sub-${name}`,
    tenant: T,
    claims: { email, email_verified: true },
  });
  users[name] = res.json<{ user: { id: string } }>().user.id;
}

/** Moves outbox rows to consumers until quiet (what core-worker does continuously). */
async function pump(): Promise<void> {
  for (let i = 0; i < 20; i++) if ((await relay.runOnce()).published === 0) return;
}

async function eventually<T>(
  fn: () => Promise<T | undefined>,
  what: string,
  timeoutMs = 20_000,
): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    await pump();
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const ctx = (t: ProvisionedTenant): RequestContext => ({
  correlationId: 'approvals-test',
  source: 'system',
  locale: 'en-IN',
  timezone: 'Asia/Kolkata',
  companyIds: [t.companyId],
  tenantId: t.tenantId,
  actor: { type: 'system', id: 'test' },
});
const submit = (req: Partial<ApprovalRequest> & { entityId: string }, t = alpha) =>
  RequestContexts.run(ctx(t), () =>
    port.submit({
      companyId: t.companyId,
      entityType: 'platform.test_document',
      attributes: { amount: '400000.00' },
      requesterId: users['requester']!,
      ...req,
    }),
  );

interface Task {
  id: string;
  assigneeId: string;
  status: string;
  stepId: string;
  escalationLevel: number;
  decidedOnBehalfOf: string | null;
}
interface Instance {
  status: string;
  outcomeReason: string | null;
  tasks: Task[];
}
const instance = async (id: string) =>
  (await asOwner('GET', `/v1/platform/approval-instances/${id}`)).json<Instance>();
const pendingTasks = async (id: string, stepId?: string) =>
  (await instance(id)).tasks.filter(
    (t) => t.status === 'pending' && (!stepId || t.stepId === stepId),
  );
const waitForTasks = (id: string, stepId: string, count = 1) =>
  eventually(async () => {
    const tasks = await pendingTasks(id, stepId);
    return tasks.length >= count ? tasks : undefined;
  }, `${count} pending task(s) on ${stepId}`);
const waitForStatus = (id: string, status: string) =>
  eventually(async () => {
    const i = await instance(id);
    return i.status === status ? i : undefined;
  }, `instance ${status}`);

async function publishFlow(flow: object): Promise<void> {
  const draft = await asOwner(
    'POST',
    `/v1/platform/companies/${alpha.companyId}/workflows/drafts`,
    {
      payload: { docType: 'platform.test_document', name: 'Test document approval', flow },
    },
  );
  expect(draft.statusCode, draft.body).toBe(201);
  const versions = draft.json<{ versions: { id: string; status: string }[] }>().versions;
  const publish = await asOwner(
    'POST',
    `/v1/platform/workflow-versions/${versions.find((v) => v.status === 'draft')!.id}/publish`,
  );
  expect(publish.statusCode, publish.body).toBe(200);
}

beforeAll(async () => {
  h = await startHarness('manuling_approvals_test');
  const provisioning = h.app.get(ProvisioningService);
  alpha = await provisioning.provision(tenantInput('alpha-works', 'sub-owner', 'ALPHA'));
  beta = await provisioning.provision(tenantInput('beta-forge', 'sub-beta', 'BETA'));
  port = h.app.get<ApprovalPort>(APPROVAL_PORT);
  uow = h.app.get(UnitOfWork);
  for (const r of (await asOwner('GET', '/v1/platform/roles')).json<{
    items: { id: string; code: string }[];
  }>().items) {
    roles.set(r.code, r.id);
  }
  // A custom approver role whose limit (amount ≤ 5,00,000) comes from the assignment condition (W3).
  const approverRole = await asOwner('POST', '/v1/platform/roles', {
    payload: {
      code: 'doc_approver',
      name: 'Document approver',
      permissions: ['platform.company.update', 'platform.company.read'],
    },
  });
  await member('requester', [{ roleId: roles.get('viewer') }]);
  await member('plant_head', [
    {
      roleId: approverRole.json<{ id: string }>().id,
      conditions: [{ attr: 'amount', op: 'lte', value: '500000' }],
    },
  ]);
  await member('finance_one', [{ roleId: roles.get('finance') }]);
  await member('finance_two', [{ roleId: roles.get('finance') }]);
  await member('admin_two', [{ roleId: roles.get('administrator') }]);
  await member('deputy', [{ roleId: roles.get('viewer') }]);
  const me = await asOwner('GET', '/v1/platform/me');
  users['owner'] = me.json<{ user: { id: string } }>().user.id;

  env = await TestWorkflowEnvironment.createTimeSkipping();
  worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: APPROVAL_TASK_QUEUE,
    workflowsPath: fileURLToPath(approvalWorkflowsPath),
    activities: approvalActivityFunctions(h.app.get(ApprovalActivities)),
  });
  workerRun = worker.run();
  const bus = new InMemoryEventBus();
  await new ConsumerRunner(uow, bus).start([new ApprovalOrchestrator(env.client)]);
  relayPool = createPool({ connectionString: h.relayUrl, max: 2 });
  relay = new OutboxRelay(relayPool, bus);
  await relay.acquireLeadership();
}, 180_000);

afterAll(async () => {
  worker?.shutdown();
  await workerRun?.catch(() => undefined);
  await relay?.stop();
  await relayPool?.end();
  await env?.teardown();
  await h?.stop();
});

describe('design', () => {
  it('rejects invalid flows and dry-runs valid ones', async () => {
    const bad = await asOwner(
      'POST',
      `/v1/platform/companies/${alpha.companyId}/workflows/drafts`,
      {
        payload: {
          docType: 'platform.test_document',
          name: 'Bad',
          flow: { steps: [{ id: 'x', approvers: { type: 'nope' } }] },
        },
      },
    );
    expect(bad.json()).toMatchObject({ status: 422, code: 'platform.workflow.invalid' });

    const dry = await asOwner(
      'POST',
      `/v1/platform/companies/${alpha.companyId}/workflows/validate`,
      {
        payload: {
          flow: {
            steps: [
              {
                id: 'small',
                approvers: { type: 'permission', permission: 'platform.company.update' },
              },
              {
                id: 'large',
                when: [{ attr: 'amount', op: 'gt', value: '1000000' }],
                approvers: { type: 'role', role: 'finance' },
              },
            ],
          },
          attributes: { amount: '600000.00' },
          requesterId: users['requester'],
        },
      },
    );
    const steps = dry.json<{ steps: { id: string; applies: boolean; approverIds: string[] }[] }>()
      .steps;
    // plant_head's limit is 5,00,000, so only the unconditional owner and admin_two qualify.
    expect(steps[0]).toMatchObject({ id: 'small', applies: true });
    expect(steps[0]!.approverIds.sort()).toEqual([users['admin_two'], users['owner']].sort());
    expect(steps[1]).toMatchObject({ id: 'large', applies: false, approverIds: [] });
  });

  it('needs no approval when no workflow is published', async () => {
    expect(await submit({ entityId: 'no-flow', entityType: 'platform.other_document' })).toEqual({
      required: false,
    });
  });
});

describe('two-step approval', () => {
  beforeAll(async () => {
    await publishFlow({
      steps: [
        {
          id: 'plant',
          approvers: { type: 'permission', permission: 'platform.company.update' },
          mode: 'any',
        },
        { id: 'finance', approvers: { type: 'role', role: 'finance' }, mode: { quorum: 2 } },
      ],
    });
  });

  it('runs any-of then quorum steps to ApprovalCompleted(approved)', async () => {
    const submission = await submit({ entityId: 'doc-1' });
    expect(submission.required).toBe(true);
    const id = (submission as { instanceId: string }).instanceId;

    const plant = await waitForTasks(id, 'plant', 3);
    expect(plant.map((t) => t.assigneeId).sort()).toEqual(
      [users['owner'], users['plant_head'], users['admin_two']].sort(),
    );
    const mine = plant.find((t) => t.assigneeId === users['plant_head'])!;
    const approved = await as('sub-plant_head')(
      'POST',
      `/v1/platform/approval-tasks/${mine.id}/approve`,
      { payload: {} },
    );
    expect(approved.json()).toMatchObject({ status: 'approved' });

    const finance = await waitForTasks(id, 'finance', 2);
    expect(
      (await instance(id)).tasks.filter((t) => t.stepId === 'plant' && t.status === 'cancelled'),
    ).toHaveLength(2);
    for (const name of ['finance_one', 'finance_two']) {
      const task = finance.find((t) => t.assigneeId === users[name])!;
      await as(`sub-${name}`)('POST', `/v1/platform/approval-tasks/${task.id}/approve`, {
        payload: { comment: 'ok' },
      });
    }
    const done = await waitForStatus(id, 'approved');
    expect(done.outcomeReason).toBeNull();
    const completed = await h.sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.outbox WHERE event_type = 'platform.ApprovalCompleted.v1' AND envelope->'data'->>'instanceId' = $1`,
      [id],
    );
    expect(completed[0]!.n).toBe(1);
  }, 60_000);

  it('respects approval limits, ends on rejection, and requires a reason', async () => {
    const id = (
      (await submit({ entityId: 'doc-2', attributes: { amount: '750000.00' } })) as {
        instanceId: string;
      }
    ).instanceId;
    const tasks = await waitForTasks(id, 'plant', 2);
    expect(tasks.map((t) => t.assigneeId)).not.toContain(users['plant_head']);

    const owners = tasks.find((t) => t.assigneeId === users['owner'])!;
    const noReason = await asOwner('POST', `/v1/platform/approval-tasks/${owners.id}/reject`, {
      payload: {},
    });
    expect(noReason.json()).toMatchObject({
      status: 422,
      code: 'platform.approval.comment_required',
    });
    await asOwner('POST', `/v1/platform/approval-tasks/${owners.id}/reject`, {
      payload: { comment: 'Over budget' },
    });
    const done = await waitForStatus(id, 'rejected');
    expect(done.outcomeReason).toBe('rejected_by_approver');
  }, 60_000);

  it('enforces separation of duties and one open approval per document', async () => {
    const id = ((await submit({ entityId: 'doc-3' })) as { instanceId: string }).instanceId;
    await expect(submit({ entityId: 'doc-3' })).rejects.toMatchObject({
      code: 'platform.approval.already_open',
    });
    const tasks = await waitForTasks(id, 'plant', 3);
    // The requester is never assigned…
    expect(tasks.map((t) => t.assigneeId)).not.toContain(users['requester']);
    // …and cannot act on someone else's task even as their delegate.
    await as('sub-plant_head')('POST', '/v1/platform/delegations', {
      payload: { toUserId: users['requester'], validFrom: '2026-01-01', validTo: '2030-12-31' },
    });
    const task = tasks.find((t) => t.assigneeId === users['plant_head'])!;
    const own = await as('sub-requester')(
      'POST',
      `/v1/platform/approval-tasks/${task.id}/approve`,
      { payload: {} },
    );
    expect(own.json()).toMatchObject({ status: 403, code: 'platform.approval.own_request' });
    // A stranger cannot see the task at all.
    const stranger = await as('sub-finance_one')(
      'POST',
      `/v1/platform/approval-tasks/${task.id}/approve`,
      { payload: {} },
    );
    expect(stranger.statusCode).toBe(404);

    // Cancel by the requester stops the workflow and closes the tasks.
    const cancel = await as('sub-requester')(
      'POST',
      `/v1/platform/approval-instances/${id}/cancel`,
      { payload: { reason: 'Withdrawn' } },
    );
    expect(cancel.json()).toMatchObject({ status: 'cancelled', outcomeReason: 'Withdrawn' });
    await pump();
    expect((await pendingTasks(id)).length).toBe(0);
  }, 60_000);

  it('lets a delegate decide on behalf of the assignee', async () => {
    await as('sub-finance_two')('POST', '/v1/platform/delegations', {
      payload: {
        toUserId: users['deputy'],
        validFrom: '2026-01-01',
        validTo: '2030-12-31',
        docTypes: ['platform.test_document'],
      },
    });
    const id = ((await submit({ entityId: 'doc-4' })) as { instanceId: string }).instanceId;
    const plant = await waitForTasks(id, 'plant', 3);
    await asOwner(
      'POST',
      `/v1/platform/approval-tasks/${plant.find((t) => t.assigneeId === users['owner'])!.id}/approve`,
      { payload: {} },
    );
    await waitForTasks(id, 'finance', 2);

    const inbox = (await as('sub-deputy')('GET', '/v1/platform/approval-tasks')).json<{
      items: { id: string; delegatedFrom: string | null; entityId: string }[];
    }>().items;
    const delegated = inbox.find((i) => i.entityId === 'doc-4')!;
    expect(delegated.delegatedFrom).toBe(users['finance_two']);
    const decided = await as('sub-deputy')(
      'POST',
      `/v1/platform/approval-tasks/${delegated.id}/approve`,
      { payload: {} },
    );
    expect(decided.json()).toMatchObject({
      status: 'approved',
      decidedOnBehalfOf: users['finance_two'],
    });
  }, 60_000);

  it('keeps other tenants out', async () => {
    const id = ((await submit({ entityId: 'doc-5' })) as { instanceId: string }).instanceId;
    const foreign = await h.call('GET', `/v1/platform/approval-instances/${id}`, {
      sub: 'sub-beta',
      tenant: 'beta-forge',
    });
    expect(foreign.statusCode).toBe(404);
    expect(await submit({ entityId: 'doc-5' }, beta).catch((e: unknown) => e)).toEqual({
      required: false,
    });
  });
});

describe('SLA timers (time-skipping)', () => {
  it('escalates after the SLA and completes with the escalated approver', async () => {
    await publishFlow({
      steps: [
        {
          id: 'review',
          approvers: { type: 'users', userIds: [users['plant_head']] },
          slaHours: 24,
          reminderHours: 8,
          onTimeout: { action: 'escalate', to: { type: 'role', role: 'administrator' } },
        },
      ],
    });
    const id = ((await submit({ entityId: `sla-${newId()}` })) as { instanceId: string })
      .instanceId;
    await waitForTasks(id, 'review', 1);

    await env.sleep('25 hours'); // reminders at 8 h and 16 h, escalation at 24 h
    const escalated = await eventually(async () => {
      const tasks = (await instance(id)).tasks;
      return tasks.some((t) => t.escalationLevel === 1 && t.status === 'pending')
        ? tasks
        : undefined;
    }, 'escalation');
    expect(escalated.find((t) => t.assigneeId === users['plant_head'])!.status).toBe('expired');
    const reminders = await h.sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.outbox WHERE event_type = 'platform.ApprovalReminderDue.v1' AND envelope->'data'->>'instanceId' = $1`,
      [id],
    );
    expect(reminders[0]!.n).toBeGreaterThanOrEqual(2);

    const adminTask = escalated.find(
      (t) => t.escalationLevel === 1 && t.assigneeId === users['admin_two'],
    )!;
    await as('sub-admin_two')('POST', `/v1/platform/approval-tasks/${adminTask.id}/approve`, {
      payload: {},
    });
    await waitForStatus(id, 'approved');
  }, 90_000);

  it('rejects on timeout when the step says so', async () => {
    await publishFlow({
      steps: [
        {
          id: 'quick',
          approvers: { type: 'role', role: 'finance' },
          slaHours: 2,
          onTimeout: { action: 'reject' },
        },
      ],
    });
    const id = ((await submit({ entityId: `timeout-${newId()}` })) as { instanceId: string })
      .instanceId;
    await waitForTasks(id, 'quick', 2);
    await env.sleep('3 hours');
    const done = await waitForStatus(id, 'rejected');
    expect(done.outcomeReason).toBe('sla_expired');
  }, 90_000);
});
