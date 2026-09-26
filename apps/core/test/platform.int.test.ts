import { Migrator, findTenantRlsViolations, foundationMigrations } from '@manuling/db';
import { newId } from '@manuling/kernel';
import {
  OidcTokenVerifier,
  ProvisioningService,
  type ProvisionedTenant,
  platformMigrations,
} from '@manuling/platform/module';
import {
  type EphemeralPostgres,
  type TestIdp,
  createTestIdp,
  startEphemeralPostgres,
  withClient,
} from '@manuling/testing';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { type LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config/config.js';

let server: EphemeralPostgres;
let adminUrl: string;
let app: NestFastifyApplication;
let idp: TestIdp;
let alpha: ProvisionedTenant;
let beta: ProvisionedTenant;

const tenantInput = (slug: string, sub: string, code: string) => ({
  slug,
  name: `${slug} works`,
  edition: 'starter' as const,
  defaultLocale: 'en-IN',
  defaultTimezone: 'Asia/Kolkata',
  company: { code, legalName: `${slug} Pvt. Ltd.`, baseCurrency: 'INR', countryCode: 'IN' },
  plant: { code: 'P1', name: 'Main plant', regionCode: 'IN-KA', timezone: 'Asia/Kolkata' },
  firstFiscalYear: 2026,
  admin: { idpSubject: sub, email: `admin@${slug}.test`, displayName: `${slug} admin` },
});

interface CallOptions {
  sub?: string;
  tenant?: string;
  token?: string;
  headers?: Record<string, string>;
  payload?: unknown;
}

async function call(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  o: CallOptions = {},
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { ...o.headers };
  const token = o.token ?? (o.sub ? await idp.token(o.sub) : undefined);
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (o.tenant) headers['x-tenant'] = o.tenant;
  return app.inject({
    method,
    url,
    headers,
    ...(o.payload === undefined ? {} : { payload: o.payload as object }),
  });
}

const asAlphaAdmin = (method: 'GET' | 'POST' | 'PATCH', url: string, o: CallOptions = {}) =>
  call(method, url, { sub: 'sub-alpha-admin', tenant: 'alpha-works', ...o });
const asBetaAdmin = (method: 'GET' | 'POST' | 'PATCH', url: string, o: CallOptions = {}) =>
  call(method, url, { sub: 'sub-beta-admin', tenant: 'beta-forge', ...o });

beforeAll(async () => {
  server = await startEphemeralPostgres();
  adminUrl = await server.createDatabase('manuling_platform_test');
  await withClient(adminUrl, async (c) => {
    await new Migrator(c).migrate([foundationMigrations, platformMigrations]);
    await c.query(`CREATE ROLE mnl_app LOGIN PASSWORD 'app' IN ROLE app_rw`);
  });
  idp = await createTestIdp();
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: server.urlFor('manuling_platform_test', 'mnl_app', 'app'),
    OIDC_ISSUER: idp.issuer,
    OIDC_AUDIENCE: idp.audience,
    TENANT_BASE_DOMAIN: 'manuling.test',
  });
  app = await createApiApp(config, {
    tokenVerifier: new OidcTokenVerifier({
      issuer: idp.issuer,
      audience: idp.audience,
      keys: idp.keys,
    }),
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const provisioning = app.get(ProvisioningService);
  alpha = await provisioning.provision(tenantInput('alpha-works', 'sub-alpha-admin', 'ALPHA'));
  beta = await provisioning.provision(tenantInput('beta-forge', 'sub-beta-admin', 'BETA'));
  const gamma = await provisioning.provision(tenantInput('gamma-cast', 'sub-gamma-admin', 'GAMMA'));

  // Extra fixtures written as the owner role (bypassing the API on purpose).
  await withClient(adminUrl, async (c) => {
    const user = `INSERT INTO platform.app_user (id, tenant_id, idp_subject, email, display_name, user_type, status, locale, source)
                  VALUES ($1, $2, $3, $4, $5, 'internal', $6, $7, 'system')`;
    const viewerId = newId();
    await c.query(user, [
      viewerId,
      alpha.tenantId,
      'sub-alpha-viewer',
      'viewer@alpha.test',
      'Viewer',
      'active',
      'kn-IN',
    ]);
    await c.query(
      `INSERT INTO platform.user_role (id, tenant_id, user_id, role_id, status, source)
       SELECT $1, $2, $3, id, 'active', 'system' FROM platform.role WHERE tenant_id = $2 AND code = 'viewer'`,
      [newId(), alpha.tenantId, viewerId],
    );
    await c.query(user, [
      newId(),
      alpha.tenantId,
      'sub-alpha-disabled',
      'gone@alpha.test',
      'Gone',
      'disabled',
      null,
    ]);
    await c.query(`UPDATE platform.tenant SET status = 'suspended' WHERE id = $1`, [
      gamma.tenantId,
    ]);
  });
});

afterAll(async () => {
  await app?.close();
  await server?.stop();
});

describe('schema', () => {
  it('protects every platform table with RLS', async () => {
    await withClient(adminUrl, async (c) => expect(await findTenantRlsViolations(c)).toEqual([]));
  });
});

describe('authentication', () => {
  it('requires a bearer token (401 with WWW-Authenticate)', async () => {
    const res = await call('GET', '/v1/platform/me', { tenant: 'alpha-works' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.json()).toMatchObject({ code: 'auth.token_missing' });
  });

  it('rejects invalid, expired, foreign-key and wrong-audience tokens', async () => {
    for (const token of [
      'garbage',
      await idp.token('sub-alpha-admin', { expiresInSeconds: -120 }),
      await idp.token('sub-alpha-admin', { foreignKey: true }),
      await idp.token('sub-alpha-admin', { audience: 'account' }),
      await idp.token('sub-alpha-admin', { issuer: 'https://evil.test/realms/manuling' }),
    ]) {
      const res = await call('GET', '/v1/platform/me', { tenant: 'alpha-works', token });
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
    }
  });

  it('requires a workspace, from the header or the subdomain', async () => {
    const none = await call('GET', '/v1/platform/me', { sub: 'sub-alpha-admin' });
    expect(none.statusCode).toBe(400);
    expect(none.json()).toMatchObject({ code: 'http.tenant_required' });

    const byHost = await call('GET', '/v1/platform/me', {
      sub: 'sub-alpha-admin',
      headers: { host: 'alpha-works.manuling.test' },
    });
    expect(byHost.statusCode).toBe(200);

    const conflicting = await call('GET', '/v1/platform/me', {
      sub: 'sub-alpha-admin',
      tenant: 'beta-forge',
      headers: { host: 'alpha-works.manuling.test' },
    });
    expect(conflicting.json()).toMatchObject({ status: 400, code: 'http.tenant_ambiguous' });
  });

  it('gives outsiders the same 403 for unknown and foreign workspaces', async () => {
    const foreign = await call('GET', '/v1/platform/me', {
      sub: 'sub-alpha-admin',
      tenant: 'beta-forge',
    });
    const unknown = await call('GET', '/v1/platform/me', {
      sub: 'sub-alpha-admin',
      tenant: 'no-such-tenant',
    });
    const stranger = await call('GET', '/v1/platform/me', {
      sub: 'sub-nobody',
      tenant: 'alpha-works',
    });
    for (const res of [foreign, unknown, stranger]) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'auth.not_a_member' });
    }
  });

  it('blocks disabled users and suspended workspaces', async () => {
    const disabled = await call('GET', '/v1/platform/me', {
      sub: 'sub-alpha-disabled',
      tenant: 'alpha-works',
    });
    expect(disabled.json()).toMatchObject({ status: 403, code: 'auth.user_disabled' });
    const suspended = await call('GET', '/v1/platform/me', {
      sub: 'sub-gamma-admin',
      tenant: 'gamma-cast',
    });
    expect(suspended.json()).toMatchObject({ status: 403, code: 'auth.tenant_suspended' });
  });

  it('returns the caller and workspace, using the user locale when set', async () => {
    const admin = await asAlphaAdmin('GET', '/v1/platform/me', {
      headers: { 'accept-language': 'hi' },
    });
    expect(admin.statusCode).toBe(200);
    expect(admin.json()).toMatchObject({
      user: { id: alpha.adminUserId, locale: 'hi-IN', timezone: 'Asia/Kolkata' },
      tenant: { id: alpha.tenantId, slug: 'alpha-works', edition: 'starter' },
      companyIds: [alpha.companyId],
    });
    expect(admin.json<{ permissions: string[] }>().permissions).toContain(
      'platform.subscription.manage',
    );
    const viewer = await call('GET', '/v1/platform/me', {
      sub: 'sub-alpha-viewer',
      tenant: 'alpha-works',
      headers: { 'accept-language': 'hi' },
    });
    expect(viewer.json()).toMatchObject({ user: { locale: 'kn-IN' } });
    const perms = viewer.json<{ permissions: string[] }>().permissions;
    expect(perms).toContain('platform.company.read');
    expect(perms.every((p) => p.endsWith('.read'))).toBe(true);
  });
});

describe('companies', () => {
  let companyId: string;

  it('lists the provisioned company', async () => {
    const res = await asAlphaAdmin('GET', '/v1/platform/companies');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      items: [{ id: alpha.companyId, code: 'ALPHA', fiscalYearStartMonth: 4 }],
    });
  });

  it('lets admins create companies (201, ETag, Location) but not other users', async () => {
    const payload = {
      code: 'alpha-exp',
      legalName: 'Alpha Exports LLP',
      baseCurrency: 'INR',
      countryCode: 'IN',
    };
    const denied = await call('POST', '/v1/platform/companies', {
      sub: 'sub-alpha-viewer',
      tenant: 'alpha-works',
      payload,
    });
    expect(denied.json()).toMatchObject({ status: 403, code: 'authz.permission_denied' });

    const res = await asAlphaAdmin('POST', '/v1/platform/companies', { payload });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; code: string; version: number }>();
    companyId = body.id;
    expect(body).toMatchObject({ code: 'ALPHA-EXP', version: 1 });
    expect(res.headers['etag']).toBe('"v1"');
    expect(res.headers['location']).toBe(`/v1/platform/companies/${companyId}`);

    const dup = await asAlphaAdmin('POST', '/v1/platform/companies', { payload });
    expect(dup.json()).toMatchObject({ status: 409, code: 'db.unique_violation' });
  });

  it('validates bodies strictly, so immutable fields cannot be patched', async () => {
    const bad = await asAlphaAdmin('POST', '/v1/platform/companies', {
      payload: { code: 'x y', legalName: 'X', baseCurrency: 'INR', countryCode: 'IN' },
    });
    expect(bad.json()).toMatchObject({ status: 422, errors: [{ path: 'code' }] });
    const immutable = await asAlphaAdmin('PATCH', `/v1/platform/companies/${companyId}`, {
      headers: { 'if-match': '"v1"' },
      payload: { baseCurrency: 'USD' },
    });
    expect(immutable.statusCode).toBe(422);
  });

  it('enforces optimistic concurrency with If-Match', async () => {
    const url = `/v1/platform/companies/${companyId}`;
    const missing = await asAlphaAdmin('PATCH', url, { payload: { legalName: 'Renamed' } });
    expect(missing.json()).toMatchObject({ status: 428, code: 'http.if_match_required' });

    const ok = await asAlphaAdmin('PATCH', url, {
      headers: { 'if-match': '"v1"' },
      payload: { legalName: 'Alpha Exports LLP (Mysuru)' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['etag']).toBe('"v2"');
    expect(ok.json()).toMatchObject({ legalName: 'Alpha Exports LLP (Mysuru)', version: 2 });

    const stale = await asAlphaAdmin('PATCH', url, {
      headers: { 'if-match': '"v1"' },
      payload: { legalName: 'Lost update' },
    });
    expect(stale.json()).toMatchObject({
      status: 412,
      code: 'kernel.concurrency_conflict',
      params: { actualVersion: 2 },
    });

    const get = await asAlphaAdmin('GET', url);
    expect(get.headers['etag']).toBe('"v2"');
  });

  it('pages with opaque cursors', async () => {
    for (const code of ['ZA', 'ZB', 'ZC']) {
      await asAlphaAdmin('POST', '/v1/platform/companies', {
        payload: { code, legalName: code, baseCurrency: 'INR', countryCode: 'IN' },
      });
    }
    const first = await asAlphaAdmin('GET', '/v1/platform/companies?limit=2');
    const page1 = first.json<{ items: { code: string }[]; nextCursor: string }>();
    expect(page1.items.map((c) => c.code)).toEqual(['ALPHA', 'ALPHA-EXP']);
    const second = await asAlphaAdmin(
      'GET',
      `/v1/platform/companies?limit=2&cursor=${page1.nextCursor}`,
    );
    expect(second.json<{ items: { code: string }[] }>().items.map((c) => c.code)).toEqual([
      'ZA',
      'ZB',
    ]);
    const bad = await asAlphaAdmin('GET', '/v1/platform/companies?cursor=zzz');
    expect(bad.json()).toMatchObject({ status: 422, code: 'http.cursor_invalid' });
  });

  it('isolates tenants: foreign ids are simply not found', async () => {
    const read = await asBetaAdmin('GET', `/v1/platform/companies/${alpha.companyId}`);
    expect(read.json()).toMatchObject({ status: 404, code: 'kernel.not_found' });
    const write = await asBetaAdmin('PATCH', `/v1/platform/companies/${alpha.companyId}`, {
      headers: { 'if-match': '"v1"' },
      payload: { legalName: 'Hijacked' },
    });
    expect(write.statusCode).toBe(404);
    const plant = await asBetaAdmin('POST', `/v1/platform/companies/${alpha.companyId}/plants`, {
      payload: { code: 'X', name: 'X', timezone: 'Asia/Kolkata' },
    });
    expect(plant.statusCode).toBe(404);
    const list = await asBetaAdmin('GET', '/v1/platform/companies');
    expect(list.json<{ items: { id: string }[] }>().items.map((c) => c.id)).toEqual([
      beta.companyId,
    ]);
  });

  it('rejects malformed ids', async () => {
    const res = await asAlphaAdmin('GET', '/v1/platform/companies/not-a-uuid');
    expect(res.json()).toMatchObject({ status: 422, code: 'http.request_invalid' });
  });
});

describe('plants and fiscal years', () => {
  it('creates and updates plants with region validation', async () => {
    const url = `/v1/platform/companies/${alpha.companyId}/plants`;
    const created = await asAlphaAdmin('POST', url, {
      payload: {
        code: 'blr1',
        name: 'Peenya, Bengaluru',
        regionCode: 'IN-KA',
        timezone: 'Asia/Kolkata',
      },
    });
    expect(created.statusCode).toBe(201);
    const plant = created.json<{ id: string }>();
    const wrongCountry = await asAlphaAdmin('POST', url, {
      payload: { code: 'X', name: 'X', regionCode: 'US-CA', timezone: 'Asia/Kolkata' },
    });
    expect(wrongCountry.json()).toMatchObject({ status: 422, errors: [{ path: 'regionCode' }] });

    const list = await asAlphaAdmin('GET', url);
    expect(list.json<{ items: { code: string }[] }>().items.map((p) => p.code)).toEqual([
      'BLR1',
      'P1',
    ]);

    const patched = await asAlphaAdmin('PATCH', `/v1/platform/plants/${plant.id}`, {
      headers: { 'if-match': '"v1"' },
      payload: { regionCode: null, status: 'inactive' },
    });
    expect(patched.json()).toMatchObject({ regionCode: null, status: 'inactive', version: 2 });
  });

  it('opens consecutive Indian fiscal years and rejects overlaps', async () => {
    const url = `/v1/platform/companies/${alpha.companyId}/fiscal-years`;
    const next = await asAlphaAdmin('POST', url, { payload: { startYear: 2027 } });
    expect(next.statusCode).toBe(201);
    expect(next.json()).toMatchObject({
      code: '2027-28',
      startDate: '2027-04-01',
      endDate: '2028-03-31',
      status: 'open',
    });

    const overlap = await asAlphaAdmin('POST', url, { payload: { startYear: 2026 } });
    expect(overlap.json()).toMatchObject({ status: 422, code: 'platform.fiscal_year.overlaps' });

    const list = await asAlphaAdmin('GET', url);
    expect(list.json<{ items: { code: string }[] }>().items.map((f) => f.code)).toEqual([
      '2026-27',
      '2027-28',
    ]);

    const lock = await asAlphaAdmin('PATCH', `/v1/platform/companies/${alpha.companyId}`, {
      headers: { 'if-match': '"v1"' },
      payload: { fiscalYearStartMonth: 1 },
    });
    expect(lock.json()).toMatchObject({
      status: 422,
      code: 'platform.company.fiscal_calendar_locked',
    });
  });
});

describe('Idempotency-Key', () => {
  const payload = {
    code: 'IDEM',
    legalName: 'Idempotent Traders',
    baseCurrency: 'INR',
    countryCode: 'IN',
  };

  it('replays the original response for an identical retry', async () => {
    const headers = { 'idempotency-key': 'order-create-0001' };
    const first = await asAlphaAdmin('POST', '/v1/platform/companies', { headers, payload });
    expect(first.statusCode).toBe(201);
    const retry = await asAlphaAdmin('POST', '/v1/platform/companies', { headers, payload });
    expect(retry.statusCode).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.headers['etag']).toBe(first.headers['etag']);
    expect(retry.headers['location']).toBe(first.headers['location']);
    expect(retry.json()).toEqual(first.json());
  });

  it('rejects the same key with a different body', async () => {
    const res = await asAlphaAdmin('POST', '/v1/platform/companies', {
      headers: { 'idempotency-key': 'order-create-0001' },
      payload: { ...payload, code: 'OTHER' },
    });
    expect(res.json()).toMatchObject({ status: 422, code: 'http.idempotency_key_reused' });
  });

  it('releases the key when the request fails, and scopes keys per tenant', async () => {
    const headers = { 'idempotency-key': 'retry-after-fix-01' };
    const failed = await asAlphaAdmin('POST', '/v1/platform/companies', { headers, payload });
    expect(failed.statusCode).toBe(409); // duplicate code IDEM
    const fixed = await asAlphaAdmin('POST', '/v1/platform/companies', {
      headers,
      payload: { ...payload, code: 'IDEM2' },
    });
    expect(fixed.statusCode).toBe(201);

    const otherTenant = await asBetaAdmin('POST', '/v1/platform/companies', {
      headers: { 'idempotency-key': 'order-create-0001' },
      payload,
    });
    expect(otherTenant.statusCode).toBe(201);
    expect(otherTenant.headers['idempotent-replayed']).toBeUndefined();
  });

  it('validates the key format', async () => {
    const res = await asAlphaAdmin('POST', '/v1/platform/companies', {
      headers: { 'idempotency-key': 'short' },
      payload,
    });
    expect(res.json()).toMatchObject({ status: 422, code: 'http.idempotency_key_invalid' });
  });
});

describe('provisioning', () => {
  it('refuses a duplicate workspace slug', async () => {
    await expect(
      app.get(ProvisioningService).provision(tenantInput('alpha-works', 'sub-x', 'X')),
    ).rejects.toMatchObject({
      code: 'db.unique_violation',
    });
  });
});

describe('OpenAPI', () => {
  it('documents the platform endpoints with bearer security', async () => {
    const doc = (await app.inject({ method: 'GET', url: '/openapi.json' })).json<{
      paths: Record<string, unknown>;
      components: { securitySchemes: Record<string, unknown> };
    }>();
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/v1/platform/me',
        '/v1/platform/companies',
        '/v1/platform/companies/{id}',
      ]),
    );
    expect(doc.components.securitySchemes).toHaveProperty('bearer');
  });
});
