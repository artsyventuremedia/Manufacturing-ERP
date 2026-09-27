import { ProvisioningService, type ProvisionedTenant } from '@manuling/platform/module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CallOptions, type Harness, startHarness, tenantInput } from './support.js';

let h: Harness;
let alpha: ProvisionedTenant;
let beta: ProvisionedTenant;
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
}

async function defineField(body: object): Promise<{ id: string; version: number }> {
  const res = await asOwner('POST', '/v1/platform/custom-fields', { payload: body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

beforeAll(async () => {
  h = await startHarness('manuling_customisation_test');
  const p = h.app.get(ProvisioningService);
  alpha = await p.provision(tenantInput('alpha-works', 'sub-owner', 'ALPHA'));
  beta = await p.provision(tenantInput('beta-forge', 'sub-beta', 'BETA'));
  for (const r of (await asOwner('GET', '/v1/platform/roles')).json<{
    items: { id: string; code: string }[];
  }>().items) {
    roles.set(r.code, r.id);
  }

  await defineField({
    entity: 'platform.company',
    apiName: 'region',
    dataType: 'select',
    label: { en: 'Region', kn: 'ಪ್ರದೇಶ' },
    options: [
      { value: 'south', label: { en: 'South' } },
      { value: 'north', label: { en: 'North' } },
    ],
  });
  await defineField({
    entity: 'platform.company',
    apiName: 'creditDays',
    dataType: 'integer',
    label: { en: 'Credit days' },
    required: true,
    defaultValue: 30,
    settings: { min: '0', max: '180' },
  });
  await defineField({
    entity: 'platform.company',
    apiName: 'internalRating',
    dataType: 'decimal',
    label: { en: 'Internal rating' },
    settings: { scale: 1 },
  });
  await defineField({
    entity: 'platform.plant',
    apiName: 'shifts',
    dataType: 'integer',
    label: { en: 'Shifts per day' },
  });
}, 180_000);

afterAll(async () => {
  await h?.stop();
});

describe('custom fields on core entities', () => {
  let companyId: string;

  it('validates, defaults and returns ext on create', async () => {
    const bad = await asOwner('POST', '/v1/platform/companies', {
      payload: {
        code: 'C1',
        legalName: 'C1',
        baseCurrency: 'INR',
        countryCode: 'IN',
        ext: { region: 'east', creditDays: 500, nope: 1 },
      },
    });
    expect(bad.statusCode).toBe(422);
    expect(
      bad
        .json<{ errors: { path: string }[] }>()
        .errors.map((e) => e.path)
        .sort(),
    ).toEqual(['ext.creditDays', 'ext.nope', 'ext.region']);

    const res = await asOwner('POST', '/v1/platform/companies', {
      payload: {
        code: 'C1',
        legalName: 'Chamundi Castings',
        baseCurrency: 'INR',
        countryCode: 'IN',
        ext: { region: 'south', internalRating: '4.5' },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      ext: { region: 'south', creditDays: 30, internalRating: '4.5' },
    });
    companyId = res.json<{ id: string }>().id;
  });

  it('merges on update, clears with null and enforces required', async () => {
    const url = `/v1/platform/companies/${companyId}`;
    const cleared = await asOwner('PATCH', url, {
      headers: { 'if-match': '"v1"' },
      payload: { ext: { internalRating: null, region: 'north' } },
    });
    expect(cleared.json()).toMatchObject({ ext: { region: 'north', creditDays: 30 } });
    expect(cleared.json<{ ext: object }>().ext).not.toHaveProperty('internalRating');

    const required = await asOwner('PATCH', url, {
      headers: { 'if-match': '"v2"' },
      payload: { ext: { creditDays: null } },
    });
    expect(required.json()).toMatchObject({
      status: 422,
      errors: [{ path: 'ext.creditDays', code: 'platform.custom_field.required' }],
    });
  });

  it('filters lists by custom fields', async () => {
    await asOwner('POST', '/v1/platform/companies', {
      payload: {
        code: 'C2',
        legalName: 'Kabini Plastics',
        baseCurrency: 'INR',
        countryCode: 'IN',
        ext: { region: 'south', creditDays: 90 },
      },
    });
    const codes = async (q: string) =>
      (await asOwner('GET', `/v1/platform/companies?${q}`))
        .json<{ items: { code: string }[] }>()
        .items.map((c) => c.code)
        .sort();
    expect(await codes('ext.region=south')).toEqual(['C2']);
    expect(await codes('ext.creditDays[gte]=60')).toEqual(['C2']);
    // ALPHA predates the field and has no value, so range filters do not match it.
    expect(await codes('ext.creditDays[lte]=30')).toEqual(['C1']);
    const bad = await asOwner('GET', '/v1/platform/companies?ext.region[gte]=a');
    expect(bad.json()).toMatchObject({ status: 422, code: 'platform.custom_field.filter_invalid' });
  });

  it('works for plants too', async () => {
    const res = await asOwner('POST', `/v1/platform/companies/${alpha.companyId}/plants`, {
      payload: { code: 'P9', name: 'Night plant', timezone: 'Asia/Kolkata', ext: { shifts: 3 } },
    });
    expect(res.json()).toMatchObject({ ext: { shifts: 3 } });
  });

  it('hides and locks custom fields through field policies (ext.<field>)', async () => {
    const role = await asOwner('POST', '/v1/platform/roles', {
      payload: {
        code: 'sales_desk',
        name: 'Sales desk',
        permissions: ['platform.company.read', 'platform.company.update'],
      },
    });
    const roleId = role.json<{ id: string }>().id;
    const policies = await asOwner('PUT', `/v1/platform/roles/${roleId}/field-policies`, {
      payload: {
        policies: [
          { entity: 'platform.company', field: 'ext.internalRating', access: 'hidden' },
          { entity: 'platform.company', field: 'ext.creditDays', access: 'read' },
        ],
      },
    });
    expect(policies.statusCode, policies.body).toBe(200);
    await member('desk', [{ roleId }]);
    const desk = as('sub-desk');
    const c2 = (await asOwner('GET', '/v1/platform/companies?ext.region=south')).json<{
      items: { id: string }[];
    }>().items[0]!;
    await asOwner('PATCH', `/v1/platform/companies/${c2.id}`, {
      headers: { 'if-match': '"v1"' },
      payload: { ext: { internalRating: '3.0' } },
    });

    const seen = (await desk('GET', `/v1/platform/companies/${c2.id}`)).json<{
      ext: object;
      version: number;
    }>();
    expect(seen.ext).toMatchObject({ region: 'south', creditDays: 90 });
    expect(seen.ext).not.toHaveProperty('internalRating');
    const locked = await desk('PATCH', `/v1/platform/companies/${c2.id}`, {
      headers: { 'if-match': `"v${seen.version}"` },
      payload: { ext: { creditDays: 10 } },
    });
    expect(locked.json()).toMatchObject({
      status: 403,
      code: 'authz.field_read_only',
      params: { field: 'ext.creditDays' },
    });
    const leak = await desk('GET', '/v1/platform/companies?ext.internalRating[gte]=1');
    expect(leak.json()).toMatchObject({ status: 403, code: 'authz.field_hidden' });
  });

  it('archives fields (values kept, hidden) and forbids type changes', async () => {
    const fields = (
      await asOwner('GET', '/v1/platform/custom-fields?entity=platform.company')
    ).json<{ items: { id: string; apiName: string; version: number }[] }>().items;
    const rating = fields.find((f) => f.apiName === 'internalRating')!;
    const archived = await asOwner('PATCH', `/v1/platform/custom-fields/${rating.id}`, {
      headers: { 'if-match': `"v${rating.version}"` },
      payload: { status: 'archived' },
    });
    expect(archived.json()).toMatchObject({ status: 'archived' });
    const companies = (await asOwner('GET', '/v1/platform/companies?ext.region=south')).json<{
      items: { ext: object }[];
    }>().items;
    expect(companies[0]!.ext).not.toHaveProperty('internalRating');
    const stored = await h.sql<{ v: string }>(
      `SELECT ext->>'internalRating' AS v FROM platform.company WHERE code = 'C2'`,
    );
    expect(stored[0]!.v).toBe('3.0');
    await expect(
      h.sql(`UPDATE platform.custom_field_def SET data_type = 'text' WHERE api_name = 'region'`),
    ).rejects.toMatchObject({ code: 'MN001' });
  });
});

describe('custom objects', () => {
  let mouldId: string;

  beforeAll(async () => {
    const obj = await asOwner('POST', '/v1/platform/custom-objects', {
      payload: {
        apiName: 'mould',
        label: { en: 'Mould', kn: 'ಅಚ್ಚು' },
        pluralLabel: { en: 'Moulds' },
      },
    });
    expect(obj.statusCode, obj.body).toBe(201);
    await defineField({
      entity: 'custom.mould',
      apiName: 'mouldCode',
      dataType: 'text',
      label: { en: 'Mould code', kn: 'ಅಚ್ಚು ಕೋಡ್' },
      required: true,
    });
    await defineField({
      entity: 'custom.mould',
      apiName: 'cavities',
      dataType: 'integer',
      label: { en: 'Cavities' },
    });
    await defineField({
      entity: 'custom.mould',
      apiName: 'lastService',
      dataType: 'date',
      label: { en: 'Last service' },
    });
    await defineField({
      entity: 'custom.mould',
      apiName: 'plant',
      dataType: 'reference',
      label: { en: 'Plant' },
      settings: { target: 'platform.plant' },
    });
  });

  it('creates, reads and updates records with validation and references', async () => {
    const url = '/v1/platform/custom-objects/mould/records';
    const noCompany = await asOwner('POST', url, { payload: { data: { mouldCode: 'M-1' } } });
    expect(noCompany.json()).toMatchObject({ status: 422, errors: [{ path: 'companyId' }] });
    const foreignPlant = await asOwner('POST', url, {
      payload: { companyId: alpha.companyId, data: { mouldCode: 'M-1', plant: beta.plantId } },
    });
    expect(foreignPlant.json()).toMatchObject({
      status: 422,
      errors: [{ path: 'data.plant', code: 'platform.custom_field.reference_missing' }],
    });

    const created = await asOwner('POST', url, {
      payload: {
        companyId: alpha.companyId,
        data: { mouldCode: 'M-1', cavities: 4, lastService: '2026-08-01', plant: alpha.plantId },
      },
    });
    expect(created.statusCode).toBe(201);
    mouldId = created.json<{ id: string }>().id;
    const updated = await asOwner('PATCH', `${url}/${mouldId}`, {
      headers: { 'if-match': '"v1"' },
      payload: { data: { cavities: 8 } },
    });
    expect(updated.json()).toMatchObject({
      version: 2,
      data: { mouldCode: 'M-1', cavities: 8, lastService: '2026-08-01' },
    });
    const stale = await asOwner('PATCH', `${url}/${mouldId}`, {
      headers: { 'if-match': '"v1"' },
      payload: { data: { cavities: 2 } },
    });
    expect(stale.statusCode).toBe(412);
  });

  it('lists with filters and paging, and archives', async () => {
    const url = '/v1/platform/custom-objects/mould/records';
    for (const [code, cavities] of [
      ['M-2', 2],
      ['M-3', 16],
      ['=HYPERLINK("x")', 1],
    ] as const) {
      await asOwner('POST', url, {
        payload: { companyId: alpha.companyId, data: { mouldCode: code, cavities } },
      });
    }
    const codes = async (q: string) =>
      (await asOwner('GET', `${url}?${q}`))
        .json<{ items: { data: { mouldCode: string } }[] }>()
        .items.map((r) => r.data.mouldCode)
        .sort();
    expect(await codes('data.cavities[gte]=8')).toEqual(['M-1', 'M-3']);
    const page1 = (await asOwner('GET', `${url}?limit=2`)).json<{
      items: unknown[];
      nextCursor: string;
    }>();
    expect(page1.items).toHaveLength(2);
    expect(
      (await asOwner('GET', `${url}?limit=2&cursor=${page1.nextCursor}`)).json<{
        items: unknown[];
      }>().items,
    ).toHaveLength(2);

    const archived = await asOwner('POST', `${url}/${mouldId}/archive`, {
      headers: { 'if-match': '"v2"' },
    });
    expect(archived.json()).toMatchObject({ status: 'archived' });
    expect(await codes('data.cavities[gte]=8')).toEqual(['M-3']);
    expect(await codes('data.cavities[gte]=8&includeArchived=true')).toEqual(['M-1', 'M-3']);
  });

  it('exports CSV with localised headers and formula-injection protection', async () => {
    const res = await asOwner('GET', '/v1/platform/custom-objects/mould/records/export.csv', {
      headers: { 'accept-language': 'kn' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toBe('attachment; filename="mould.csv"');
    const lines = res.body
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    // Columns follow field position, then name; labels use the caller's locale.
    expect(lines[0]).toBe('Id,Company,Cavities,Last service,ಅಚ್ಚು ಕೋಡ್,Plant,Created,Updated');
    expect(lines).toHaveLength(4); // header + 3 active records
    expect(res.body).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it('checks permissions and tenant isolation', async () => {
    await member('reader', [{ roleId: roles.get('viewer') }]);
    const reader = as('sub-reader');
    expect((await reader('GET', '/v1/platform/custom-objects/mould/records')).statusCode).toBe(200);
    const write = await reader('POST', '/v1/platform/custom-objects/mould/records', {
      payload: { companyId: alpha.companyId, data: { mouldCode: 'X' } },
    });
    expect(write.json()).toMatchObject({ status: 403, code: 'authz.permission_denied' });

    const foreign = await h.call('GET', '/v1/platform/custom-objects/mould/records', {
      sub: 'sub-beta',
      tenant: 'beta-forge',
    });
    expect(foreign.statusCode).toBe(404);
    const events = await h.sql<{ event_type: string }>(
      `SELECT DISTINCT event_type FROM platform.outbox WHERE event_type LIKE 'platform.Custom%' ORDER BY 1`,
    );
    expect(events.map((e) => e.event_type)).toEqual([
      'platform.CustomFieldChanged.v1',
      'platform.CustomFieldDefined.v1',
      'platform.CustomObjectDefined.v1',
      'platform.CustomRecordArchived.v1',
      'platform.CustomRecordChanged.v1',
      'platform.CustomRecordCreated.v1',
    ]);
  });
});

describe('layouts', () => {
  it('stores layouts that reference only real fields', async () => {
    const bad = await asOwner('PUT', '/v1/platform/layouts/platform.company/list', {
      payload: { layout: { columns: ['code', 'ext.nope'] } },
    });
    expect(bad.json()).toMatchObject({ status: 422, code: 'platform.layout.field_unknown' });
    const ok = await asOwner('PUT', '/v1/platform/layouts/custom.mould/form', {
      payload: {
        layout: {
          sections: [
            { title: { en: 'Basics' }, fields: ['data.mouldCode', 'data.cavities', 'companyId'] },
          ],
        },
      },
    });
    expect(ok.statusCode).toBe(200);
    const got = await asOwner('GET', '/v1/platform/layouts/custom.mould/form');
    expect(got.json()).toMatchObject({
      layout: { sections: [{ fields: ['data.mouldCode', 'data.cavities', 'companyId'] }] },
    });
  });
});
