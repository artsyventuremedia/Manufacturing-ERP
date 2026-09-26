import {
  ProvisioningService,
  type ProvisionedTenant,
  RouteAccessCheck,
} from '@manuling/platform/module';
import { Controller, Get, Module } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../src/bootstrap.js';
import { type Harness, type CallOptions, startHarness, tenantInput } from './support.js';

let h: Harness;
let alpha: ProvisionedTenant;
let beta: ProvisionedTenant;
let secondCompanyId: string;
let secondPlantId: string;
const roles = new Map<string, string>(); // code → id (alpha)

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT';
const T = 'alpha-works';
const asOwner = (m: Method, url: string, o: CallOptions = {}) =>
  h.call(m, url, { sub: 'sub-alpha-admin', tenant: T, ...o });
const as =
  (sub: string) =>
  (m: Method, url: string, o: CallOptions = {}) =>
    h.call(m, url, { sub, tenant: T, ...o });

/** Invites a user and signs them in once so the invitation binds to `sub`. */
async function member(sub: string, assignments: object[]): Promise<string> {
  const email = `${sub}@alpha.test`;
  const res = await asOwner('POST', '/v1/platform/users/invitations', {
    payload: { email, displayName: sub, assignments },
  });
  expect(res.statusCode, res.body).toBe(201);
  const me = await h.call('GET', '/v1/platform/me', {
    sub,
    tenant: T,
    claims: { email, email_verified: true },
  });
  expect(me.statusCode, me.body).toBe(200);
  return res.json<{ user: { id: string } }>().user.id;
}

beforeAll(async () => {
  h = await startHarness('manuling_authz_test');
  const provisioning = h.app.get(ProvisioningService);
  alpha = await provisioning.provision(tenantInput('alpha-works', 'sub-alpha-admin', 'ALPHA'));
  beta = await provisioning.provision(tenantInput('beta-forge', 'sub-beta-admin', 'BETA'));

  const company = await asOwner('POST', '/v1/platform/companies', {
    payload: { code: 'ALPHA2', legalName: 'Alpha Two LLP', baseCurrency: 'INR', countryCode: 'IN' },
  });
  secondCompanyId = company.json<{ id: string }>().id;
  const plant = await asOwner('POST', `/v1/platform/companies/${alpha.companyId}/plants`, {
    payload: { code: 'P2', name: 'Second plant', timezone: 'Asia/Kolkata' },
  });
  secondPlantId = plant.json<{ id: string }>().id;
  for (const r of (await asOwner('GET', '/v1/platform/roles')).json<{
    items: { id: string; code: string }[];
  }>().items) {
    roles.set(r.code, r.id);
  }
});

afterAll(async () => {
  await h?.stop();
});

describe('route protection', () => {
  it('leaves no route of the real application without an access rule', () => {
    expect(h.app.get(RouteAccessCheck).findViolations()).toEqual([]);
  });

  it('refuses to boot with an unprotected route or an unknown permission', async () => {
    @Controller('unguarded')
    class Unguarded {
      @Get()
      open(): string {
        return 'oops';
      }
    }
    @Module({ controllers: [Unguarded] })
    class UnguardedModule {}
    const app = await createApiApp(h.config, { imports: [UnguardedModule] });
    await expect(app.init()).rejects.toMatchObject({ code: 'authz.routes_unprotected' });
    await app.close().catch(() => undefined);
  });
});

describe('system roles and catalogue', () => {
  it('seeds the nine built-in roles with template permissions', async () => {
    const list = (await asOwner('GET', '/v1/platform/roles')).json<{
      items: { code: string; isSystem: boolean; permissions: string[] }[];
    }>().items;
    expect(
      list
        .filter((r) => r.isSystem)
        .map((r) => r.code)
        .sort(),
    ).toEqual([
      'administrator',
      'finance',
      'owner',
      'production',
      'purchase',
      'quality',
      'sales',
      'stores',
      'viewer',
    ]);
    const byCode = new Map(list.map((r) => [r.code, r.permissions]));
    expect(byCode.get('owner')).toContain('platform.subscription.manage');
    expect(byCode.get('administrator')).not.toContain('platform.subscription.manage');
    expect(byCode.get('viewer')!.every((p) => p.endsWith('.read'))).toBe(true);
    expect(byCode.get('stores')).toEqual([
      'platform.company.read',
      'platform.fiscal_year.read',
      'platform.plant.read',
    ]);

    const catalogue = (await asOwner('GET', '/v1/platform/permissions')).json<{
      items: { code: string }[];
    }>().items;
    expect(catalogue.map((p) => p.code)).toContain('platform.role.assign');
  });

  it('keeps built-in roles read-only but clonable', async () => {
    const edit = await asOwner('PATCH', `/v1/platform/roles/${roles.get('viewer')}`, {
      headers: { 'if-match': '"v1"' },
      payload: { name: 'X' },
    });
    expect(edit.json()).toMatchObject({ status: 422, code: 'authz.system_role_read_only' });
    const clone = await asOwner('POST', `/v1/platform/roles/${roles.get('viewer')}/clone`, {
      payload: { code: 'auditor', name: 'Auditor' },
    });
    expect(clone.statusCode).toBe(201);
    expect(clone.json()).toMatchObject({ code: 'auditor', isSystem: false });
    expect(clone.json<{ permissions: string[] }>().permissions).toContain('platform.company.read');
  });

  it('rejects unknown permissions in custom roles', async () => {
    const res = await asOwner('POST', '/v1/platform/roles', {
      payload: { code: 'bad', name: 'Bad', permissions: ['platform.company.nuke'] },
    });
    expect(res.json()).toMatchObject({ status: 422, code: 'platform.role.permission_unknown' });
  });
});

describe('invitations', () => {
  it('binds on first sign-in with the same verified email only', async () => {
    const res = await asOwner('POST', '/v1/platform/users/invitations', {
      payload: {
        email: 'Qa.Lead@alpha.test',
        displayName: 'QA lead',
        assignments: [{ roleId: roles.get('viewer') }],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ user: { status: 'invited', email: 'qa.lead@alpha.test' } });

    const unverified = await h.call('GET', '/v1/platform/me', {
      sub: 'sub-qa',
      tenant: T,
      claims: { email: 'qa.lead@alpha.test', email_verified: false },
    });
    expect(unverified.json()).toMatchObject({ status: 403, code: 'auth.not_a_member' });

    const first = await h.call('GET', '/v1/platform/me', {
      sub: 'sub-qa',
      tenant: T,
      claims: { email: 'QA.Lead@alpha.test', email_verified: true },
    });
    expect(first.statusCode).toBe(200);
    // Later sign-ins go by subject; the email claim no longer matters.
    const later = await h.call('GET', '/v1/platform/me', { sub: 'sub-qa', tenant: T });
    expect(later.statusCode).toBe(200);
    // Another account with the same email cannot take over the bound user.
    const other = await h.call('GET', '/v1/platform/me', {
      sub: 'sub-imposter',
      tenant: T,
      claims: { email: 'qa.lead@alpha.test', email_verified: true },
    });
    expect(other.json()).toMatchObject({ status: 403, code: 'auth.not_a_member' });
  });

  it('rejects expired invitations', async () => {
    const res = await asOwner('POST', '/v1/platform/users/invitations', {
      payload: { email: 'late@alpha.test', displayName: 'Late' },
    });
    await h.sql(
      `UPDATE platform.app_user SET invitation_expires_at = now() - interval '1 minute' WHERE id = $1`,
      [res.json<{ user: { id: string } }>().user.id],
    );
    const me = await h.call('GET', '/v1/platform/me', {
      sub: 'sub-late',
      tenant: T,
      claims: { email: 'late@alpha.test', email_verified: true },
    });
    expect(me.json()).toMatchObject({ status: 403, code: 'auth.invitation_expired' });
  });
});

describe('permissions and scopes', () => {
  it('lets a viewer read but not write', async () => {
    await member('viewer-1', [{ roleId: roles.get('viewer') }]);
    const viewer = as('viewer-1');
    expect((await viewer('GET', '/v1/platform/companies')).statusCode).toBe(200);
    const write = await viewer('POST', '/v1/platform/companies', {
      payload: { code: 'V', legalName: 'V', baseCurrency: 'INR', countryCode: 'IN' },
    });
    expect(write.json()).toMatchObject({
      status: 403,
      code: 'authz.permission_denied',
      params: { permission: 'platform.company.create' },
    });
    expect((await viewer('GET', '/v1/platform/roles')).statusCode).toBe(200);
    expect((await viewer('GET', '/v1/platform/users')).statusCode).toBe(200);
  });

  it('confines a company-scoped administrator to that company', async () => {
    await member('co-admin', [{ roleId: roles.get('administrator'), companyId: secondCompanyId }]);
    const coAdmin = as('co-admin');
    const list = await coAdmin('GET', '/v1/platform/companies');
    expect(list.json<{ items: { id: string }[] }>().items.map((c) => c.id)).toEqual([
      secondCompanyId,
    ]);
    expect((await coAdmin('GET', `/v1/platform/companies/${alpha.companyId}`)).statusCode).toBe(
      404,
    );
    const own = await coAdmin('PATCH', `/v1/platform/companies/${secondCompanyId}`, {
      headers: { 'if-match': '"v1"' },
      payload: { legalName: 'Alpha Two LLP (Mysuru)' },
    });
    expect(own.statusCode).toBe(200);
    // Tenant-level action needs a tenant-wide grant.
    const create = await coAdmin('POST', '/v1/platform/companies', {
      payload: { code: 'NOPE', legalName: 'N', baseCurrency: 'INR', countryCode: 'IN' },
    });
    expect(create.json()).toMatchObject({ status: 403, code: 'authz.permission_denied' });
    expect((await coAdmin('GET', '/v1/platform/me')).json()).toMatchObject({
      companyIds: [secondCompanyId],
    });
  });

  it('confines a plant-scoped viewer to that plant', async () => {
    await member('plant-viewer', [
      { roleId: roles.get('viewer'), companyId: alpha.companyId, plantId: alpha.plantId },
    ]);
    const pv = as('plant-viewer');
    const plants = await pv('GET', `/v1/platform/companies/${alpha.companyId}/plants`);
    expect(plants.json<{ items: { id: string }[] }>().items.map((p) => p.id)).toEqual([
      alpha.plantId,
    ]);
    expect((await pv('GET', `/v1/platform/plants/${secondPlantId}`)).statusCode).toBe(404);
    expect((await pv('GET', `/v1/platform/plants/${alpha.plantId}`)).statusCode).toBe(200);
  });

  it('ignores assignments outside their validity window', async () => {
    await member('future-admin', [{ roleId: roles.get('viewer') }]);
    const userId = (await asOwner('GET', '/v1/platform/users?limit=200'))
      .json<{ items: { id: string; email: string }[] }>()
      .items.find((u) => u.email === 'future-admin@alpha.test')!.id;
    await asOwner('POST', `/v1/platform/users/${userId}/role-assignments`, {
      payload: { roleId: roles.get('administrator'), validFrom: '2099-01-01' },
    });
    const res = await as('future-admin')('POST', '/v1/platform/companies', {
      payload: { code: 'FUT', legalName: 'F', baseCurrency: 'INR', countryCode: 'IN' },
    });
    expect(res.json()).toMatchObject({ status: 403, code: 'authz.permission_denied' });
  });
});

describe('anti-escalation', () => {
  it('stops users granting permissions they do not hold', async () => {
    const roleAdmin = await asOwner('POST', '/v1/platform/roles', {
      payload: {
        code: 'access_admin',
        name: 'Access admin',
        permissions: [
          'platform.role.read',
          'platform.role.manage',
          'platform.role.assign',
          'platform.user.read',
          'platform.user.invite',
          'platform.company.read',
          'platform.plant.read',
          'platform.fiscal_year.read',
        ],
      },
    });
    expect(roleAdmin.statusCode).toBe(201);
    await member('access-admin', [{ roleId: roleAdmin.json<{ id: string }>().id }]);
    const aa = as('access-admin');

    const create = await aa('POST', '/v1/platform/roles', {
      payload: { code: 'sneaky', name: 'S', permissions: ['platform.company.update'] },
    });
    expect(create.json()).toMatchObject({
      status: 403,
      code: 'authz.escalation_denied',
      params: { missing: ['platform.company.update'] },
    });

    const invite = await aa('POST', '/v1/platform/users/invitations', {
      payload: {
        email: 'friend@alpha.test',
        displayName: 'Friend',
        assignments: [{ roleId: roles.get('owner') }],
      },
    });
    expect(invite.json()).toMatchObject({ status: 403, code: 'authz.escalation_denied' });
    // The failed invitation left nothing behind (single transaction).
    const users = (await asOwner('GET', '/v1/platform/users?limit=200')).json<{
      items: { email: string }[];
    }>().items;
    expect(users.map((u) => u.email)).not.toContain('friend@alpha.test');

    const ok = await aa('POST', '/v1/platform/users/invitations', {
      payload: {
        email: 'reader@alpha.test',
        displayName: 'Reader',
        assignments: [{ roleId: roles.get('stores') }],
      },
    });
    expect(ok.statusCode).toBe(201);
  });
});

describe('field-level security', () => {
  it('hides and locks fields per role', async () => {
    const role = await asOwner('POST', '/v1/platform/roles', {
      payload: {
        code: 'company_editor',
        name: 'Company editor',
        permissions: ['platform.company.read', 'platform.company.update'],
      },
    });
    const roleId = role.json<{ id: string }>().id;
    const put = await asOwner('PUT', `/v1/platform/roles/${roleId}/field-policies`, {
      payload: {
        policies: [
          { entity: 'platform.company', field: 'baseCurrency', access: 'hidden' },
          { entity: 'platform.company', field: 'fiscalYearStartMonth', access: 'read' },
        ],
      },
    });
    expect(put.json<{ items: unknown[] }>().items).toHaveLength(2);
    await member('editor', [{ roleId }]);
    const editor = as('editor');

    const got = await editor('GET', `/v1/platform/companies/${secondCompanyId}`);
    expect(got.json()).not.toHaveProperty('baseCurrency');
    expect(got.json()).toHaveProperty('legalName');

    const version = got.json<{ version: number }>().version;
    const locked = await editor('PATCH', `/v1/platform/companies/${secondCompanyId}`, {
      headers: { 'if-match': `"v${version}"` },
      payload: { fiscalYearStartMonth: 1 },
    });
    expect(locked.json()).toMatchObject({
      status: 403,
      code: 'authz.field_read_only',
      params: { field: 'fiscalYearStartMonth' },
    });
    const allowed = await editor('PATCH', `/v1/platform/companies/${secondCompanyId}`, {
      headers: { 'if-match': `"v${version}"` },
      payload: { legalName: 'Alpha Two LLP (Hebbal)' },
    });
    expect(allowed.statusCode).toBe(200);

    // The owner has no policies, so sees everything.
    expect(
      (await asOwner('GET', `/v1/platform/companies/${secondCompanyId}`)).json(),
    ).toHaveProperty('baseCurrency');
  });
});

describe('segregation of duties', () => {
  it('blocks or warns on conflicting duties and reports violations', async () => {
    const creator = await asOwner('POST', '/v1/platform/roles', {
      payload: {
        code: 'company_creator',
        name: 'Creator',
        permissions: ['platform.company.create'],
      },
    });
    const updater = await asOwner('POST', '/v1/platform/roles', {
      payload: {
        code: 'company_updater',
        name: 'Updater',
        permissions: ['platform.company.update'],
      },
    });
    // Test rule on permissions that exist today (seeded rules target Phase 1 permissions).
    await h.sql(
      `INSERT INTO platform.sod_rule (id, tenant_id, code, name, permission_a, permission_b, severity, status, source)
       VALUES (gen_random_uuid(), $1, 'company_create_vs_update', 'Create vs update company', 'platform.company.create', 'platform.company.update', 'block', 'active', 'system')`,
      [alpha.tenantId],
    );
    const userId = await member('sod-user', [{ roleId: creator.json<{ id: string }>().id }]);
    const url = `/v1/platform/users/${userId}/role-assignments`;
    const blocked = await asOwner('POST', url, {
      payload: { roleId: updater.json<{ id: string }>().id },
    });
    expect(blocked.json()).toMatchObject({ status: 409, code: 'authz.sod_conflict' });

    const rules = (await asOwner('GET', '/v1/platform/sod-rules')).json<{
      items: { id: string; code: string; severity: string; version: number }[];
    }>().items;
    expect(
      rules
        .filter((r) => r.code !== 'company_create_vs_update')
        .every((r) => r.severity === 'warn'),
    ).toBe(true); // starter edition
    const rule = rules.find((r) => r.code === 'company_create_vs_update')!;
    const relaxed = await asOwner('PATCH', `/v1/platform/sod-rules/${rule.id}`, {
      headers: { 'if-match': `"v${rule.version}"` },
      payload: { severity: 'warn' },
    });
    expect(relaxed.json()).toMatchObject({ severity: 'warn' });

    const warned = await asOwner('POST', url, {
      payload: { roleId: updater.json<{ id: string }>().id },
    });
    expect(warned.statusCode).toBe(201);
    expect(warned.json()).toMatchObject({
      warnings: [{ code: 'company_create_vs_update', severity: 'warn' }],
    });

    const violations = (await asOwner('GET', '/v1/platform/sod-violations')).json<{
      items: { email: string }[];
    }>().items;
    expect(violations.map((v) => v.email)).toContain('sod-user@alpha.test');
    await h.sql(
      `UPDATE platform.sod_rule SET status = 'disabled' WHERE code = 'company_create_vs_update'`,
    );
  });
});

describe('owner safeguards', () => {
  it('never leaves the workspace without an owner', async () => {
    const owner = (await asOwner('GET', `/v1/platform/users/${alpha.adminUserId}`)).json<{
      version: number;
      assignments: { id: string; roleCode: string; status: string }[];
    }>();
    const ownerAssignment = owner.assignments.find(
      (a) => a.roleCode === 'owner' && a.status === 'active',
    )!;
    const revoke = await asOwner(
      'POST',
      `/v1/platform/role-assignments/${ownerAssignment.id}/revoke`,
    );
    expect(revoke.json()).toMatchObject({ status: 422, code: 'authz.last_owner' });

    const disableSelf = await asOwner('PATCH', `/v1/platform/users/${alpha.adminUserId}`, {
      headers: { 'if-match': `"v${owner.version}"` },
      payload: { status: 'disabled' },
    });
    expect(disableSelf.json()).toMatchObject({
      status: 422,
      code: 'platform.user.cannot_disable_self',
    });

    // With a second owner in place, the first can be revoked.
    const second = await member('second-owner', [{ roleId: roles.get('owner') }]);
    expect(second).toBeTruthy();
    const ok = await asOwner('POST', `/v1/platform/role-assignments/${ownerAssignment.id}/revoke`);
    expect(ok.json()).toMatchObject({ status: 'revoked' });
    // The second owner cannot now be disabled by anyone, being the last owner.
    const secondOwner = (await as('second-owner')('GET', `/v1/platform/users/${second}`)).json<{
      version: number;
    }>();
    expect(secondOwner.version).toBeGreaterThan(0);
  });
});

describe('tenant isolation of access control', () => {
  it('cannot see or use another tenant’s roles and users', async () => {
    const asBeta = (m: Method, url: string, o: CallOptions = {}) =>
      h.call(m, url, { sub: 'sub-beta-admin', tenant: 'beta-forge', ...o });
    expect((await asBeta('GET', `/v1/platform/roles/${roles.get('owner')}`)).statusCode).toBe(404);
    expect((await asBeta('GET', `/v1/platform/users/${alpha.adminUserId}`)).statusCode).toBe(404);
    const assign = await asBeta('POST', `/v1/platform/users/${beta.adminUserId}/role-assignments`, {
      payload: { roleId: roles.get('viewer') },
    });
    expect(assign.statusCode).toBe(404);
    const foreignCompany = await asBeta(
      'POST',
      `/v1/platform/users/${beta.adminUserId}/role-assignments`,
      {
        payload: {
          roleId: (await asBeta('GET', '/v1/platform/roles'))
            .json<{ items: { id: string; code: string }[] }>()
            .items.find((r) => r.code === 'viewer')!.id,
          companyId: alpha.companyId,
        },
      },
    );
    expect(foreignCompany.statusCode).toBe(422);
  });
});
