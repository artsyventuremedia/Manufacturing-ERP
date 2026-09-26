import { newId } from '@manuling/kernel';
import { PLATFORM_EVENTS } from '@manuling/platform/contracts';
import { ProvisioningService, type ProvisionedTenant } from '@manuling/platform/module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CallOptions, type Harness, startHarness, tenantInput } from './support.js';

let h: Harness;
let alpha: ProvisionedTenant;
let beta: ProvisionedTenant;

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT';
const asOwner = (m: Method, url: string, o: CallOptions = {}) =>
  h.call(m, url, { sub: 'sub-alpha-admin', tenant: 'alpha-works', ...o });

interface OutboxRow extends Record<string, unknown> {
  event_type: string;
  aggregate_id: string;
  topic: string;
  partition_key: string;
  envelope: {
    type: string;
    tenantid: string;
    correlationid: string;
    actor: { type: string; id: string };
    data: unknown;
  };
}

const outbox = (tenantId: string) =>
  h.sql<OutboxRow>(`SELECT * FROM platform.outbox WHERE tenant_id = $1 ORDER BY position`, [
    tenantId,
  ]);

beforeAll(async () => {
  h = await startHarness('manuling_audit_events_test');
  const provisioning = h.app.get(ProvisioningService);
  alpha = await provisioning.provision(tenantInput('alpha-works', 'sub-alpha-admin', 'ALPHA'));
  beta = await provisioning.provision(tenantInput('beta-forge', 'sub-beta-admin', 'BETA'));
});

afterAll(async () => {
  await h?.stop();
});

describe('provisioning', () => {
  it('audits the new tenant and publishes TenantProvisioned', async () => {
    const events = await outbox(alpha.tenantId);
    expect(events.map((e) => e.event_type)).toEqual(['platform.TenantProvisioned.v1']);
    expect(events[0]!.envelope).toMatchObject({
      tenantid: alpha.tenantId,
      actor: { type: 'system', id: 'tenant-provisioning' },
      data: { tenantId: alpha.tenantId, slug: 'alpha-works', adminUserId: alpha.adminUserId },
    });
    const audit = await h.sql(
      `SELECT entity_type, action, actor_type FROM platform.audit_log WHERE tenant_id = $1`,
      [alpha.tenantId],
    );
    expect(audit).toEqual([
      { entity_type: 'platform.tenant', action: 'provision', actor_type: 'system' },
    ]);
  });
});

describe('writes produce audit rows and events atomically', () => {
  let companyId: string;

  it('records a company creation with actor, source, IP and correlation', async () => {
    const res = await asOwner('POST', '/v1/platform/companies', {
      headers: { 'x-correlation-id': 'trace-company-0001', 'x-manuling-client': 'web' },
      payload: {
        code: 'EXP',
        legalName: 'Alpha Exports LLP',
        baseCurrency: 'INR',
        countryCode: 'IN',
      },
    });
    expect(res.statusCode).toBe(201);
    companyId = res.json<{ id: string }>().id;

    const [row] = await h.sql(`SELECT * FROM platform.audit_log WHERE entity_id = $1`, [companyId]);
    expect(row).toMatchObject({
      entity_type: 'platform.company',
      action: 'create',
      actor_type: 'user',
      actor_id: alpha.adminUserId,
      source: 'ui',
      correlation_id: 'trace-company-0001',
      client_ip: '127.0.0.1',
      before: null,
      after: { code: 'EXP', legalName: 'Alpha Exports LLP', version: 1 },
    });

    const event = (await outbox(alpha.tenantId)).find((e) => e.aggregate_id === companyId)!;
    expect(event).toMatchObject({
      event_type: 'platform.CompanyCreated.v1',
      topic: 'manuling.platform.events.v1',
      partition_key: `${alpha.tenantId}:${companyId}`,
    });
    expect(event.envelope).toMatchObject({
      correlationid: 'trace-company-0001',
      actor: { type: 'user', id: alpha.adminUserId },
    });
    // Published data satisfies the contract.
    expect(
      PLATFORM_EVENTS['platform.CompanyCreated.v1'].safeParse(event.envelope.data).success,
    ).toBe(true);
  });

  it('records before/after and changed fields on update', async () => {
    const res = await asOwner('PATCH', `/v1/platform/companies/${companyId}`, {
      headers: { 'if-match': '"v1"' },
      payload: { legalName: 'Alpha Exports LLP (Mysuru)' },
    });
    expect(res.statusCode).toBe(200);
    const rows = await h.sql(
      `SELECT action, changed_fields, before->>'legalName' AS before_name, after->>'legalName' AS after_name
         FROM platform.audit_log WHERE entity_id = $1 AND action = 'update'`,
      [companyId],
    );
    expect(rows).toEqual([
      {
        action: 'update',
        changed_fields: ['legalName', 'version'],
        before_name: 'Alpha Exports LLP',
        after_name: 'Alpha Exports LLP (Mysuru)',
      },
    ]);
    const types = (await outbox(alpha.tenantId))
      .filter((e) => e.aggregate_id === companyId)
      .map((e) => e.event_type);
    expect(types).toEqual(['platform.CompanyCreated.v1', 'platform.CompanyChanged.v1']);
  });

  it('writes neither audit nor event when the change fails', async () => {
    const before = (await outbox(alpha.tenantId)).length;
    const dup = await asOwner('POST', '/v1/platform/companies', {
      payload: { code: 'EXP', legalName: 'Duplicate', baseCurrency: 'INR', countryCode: 'IN' },
    });
    expect(dup.statusCode).toBe(409);
    expect(await outbox(alpha.tenantId)).toHaveLength(before);
    const audit = await h.sql(
      `SELECT 1 FROM platform.audit_log WHERE after->>'legalName' = 'Duplicate'`,
    );
    expect(audit).toHaveLength(0);
  });

  it('covers access-control changes: invite, activation, assignment, revocation', async () => {
    const roles = (await asOwner('GET', '/v1/platform/roles')).json<{
      items: { id: string; code: string }[];
    }>().items;
    const viewer = roles.find((r) => r.code === 'viewer')!.id;
    const invite = await asOwner('POST', '/v1/platform/users/invitations', {
      payload: { email: 'eve@alpha.test', displayName: 'Eve', assignments: [{ roleId: viewer }] },
    });
    const userId = invite.json<{ user: { id: string } }>().user.id;
    await h.call('GET', '/v1/platform/me', {
      sub: 'sub-eve',
      tenant: 'alpha-works',
      claims: { email: 'eve@alpha.test', email_verified: true },
    });
    const assignmentId = (await asOwner('GET', `/v1/platform/users/${userId}`)).json<{
      assignments: { id: string }[];
    }>().assignments[0]!.id;
    await asOwner('POST', `/v1/platform/role-assignments/${assignmentId}/revoke`);

    const types = (await outbox(alpha.tenantId)).map((e) => e.event_type);
    expect(types).toEqual(
      expect.arrayContaining([
        'platform.UserInvited.v1',
        'platform.UserRoleAssigned.v1',
        'platform.UserActivated.v1',
        'platform.UserRoleRevoked.v1',
      ]),
    );
    const activation = await h.sql(
      `SELECT actor_type, actor_id FROM platform.audit_log WHERE action = 'accept_invitation'`,
    );
    expect(activation).toEqual([{ actor_type: 'user', actor_id: userId }]);
  });
});

describe('access denials', () => {
  it('audits route-level and use-case-level refusals', async () => {
    const roles = (await asOwner('GET', '/v1/platform/roles')).json<{
      items: { id: string; code: string }[];
    }>().items;
    await asOwner('POST', '/v1/platform/users/invitations', {
      payload: {
        email: 'reader@alpha.test',
        displayName: 'Reader',
        assignments: [{ roleId: roles.find((r) => r.code === 'viewer')!.id }],
      },
    });
    const reader = {
      sub: 'sub-reader',
      tenant: 'alpha-works',
      claims: { email: 'reader@alpha.test', email_verified: true },
    };
    const denied = await h.call('POST', '/v1/platform/companies', {
      ...reader,
      payload: { code: 'NOPE', legalName: 'N', baseCurrency: 'INR', countryCode: 'IN' },
    });
    expect(denied.statusCode).toBe(403);

    const rows = await h.sql<{ entity_id: string; after: { code: string; permission: string } }>(
      `SELECT entity_id, after FROM platform.audit_log WHERE action = 'access_denied' ORDER BY occurred_at`,
    );
    expect(rows.at(-1)).toMatchObject({
      entity_id: 'POST /v1/platform/companies',
      after: { code: 'authz.permission_denied', permission: 'platform.company.create' },
    });
  });
});

describe('audit-log API', () => {
  it('lists newest first with filters and paging, and is excluded from Viewer', async () => {
    const all = await asOwner('GET', '/v1/platform/audit-log?limit=3');
    expect(all.statusCode).toBe(200);
    const page = all.json<{
      items: { occurredAt: string; entityType: string }[];
      nextCursor: string;
    }>();
    expect(page.items).toHaveLength(3);
    const times = page.items.map((i) => i.occurredAt);
    expect([...times].sort().reverse()).toEqual(times);
    const next = await asOwner('GET', `/v1/platform/audit-log?limit=3&cursor=${page.nextCursor}`);
    expect(next.json<{ items: unknown[] }>().items.length).toBeGreaterThan(0);

    const companies = await asOwner('GET', '/v1/platform/audit-log?entityType=platform.company');
    expect(
      companies
        .json<{ items: { entityType: string }[] }>()
        .items.every((i) => i.entityType === 'platform.company'),
    ).toBe(true);

    const viewerRead = await h.call('GET', '/v1/platform/audit-log', {
      sub: 'sub-reader',
      tenant: 'alpha-works',
    });
    expect(viewerRead.json()).toMatchObject({ status: 403, code: 'authz.permission_denied' });
  });

  it('never shows another tenant’s trail', async () => {
    const res = await h.call('GET', '/v1/platform/audit-log?limit=200', {
      sub: 'sub-beta-admin',
      tenant: 'beta-forge',
    });
    const items = res.json<{ items: { entityId: string }[] }>().items;
    expect(items.map((i) => i.entityId)).toEqual([beta.tenantId]);
  });

  it('enables and verifies the hash chain', async () => {
    const enable = await asOwner('POST', '/v1/platform/audit-log/chain');
    expect(enable.statusCode).toBe(204);
    await asOwner('POST', '/v1/platform/companies', {
      payload: {
        code: 'CHN',
        legalName: 'Chained Co',
        baseCurrency: 'INR',
        countryCode: 'IN',
        fiscalYearStartMonth: 4,
      },
    });
    const verification = await asOwner('GET', '/v1/platform/audit-log/chain/verification');
    expect(verification.json()).toEqual({ valid: true, checked: 2 }); // chain enable + company create
    const denied = await h.call('POST', '/v1/platform/audit-log/chain', {
      sub: 'sub-reader',
      tenant: 'alpha-works',
    });
    expect(denied.statusCode).toBe(403);
    expect(newId()).toBeTruthy();
  });
});
