import { UnitOfWork } from '@manuling/db';
import { type RequestContext, RequestContexts } from '@manuling/kernel';
import {
  NUMBERING_PORT,
  type NumberRequest,
  type NumberingPort,
} from '@manuling/platform/contracts';
import { ProvisioningService, type ProvisionedTenant } from '@manuling/platform/module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CallOptions, type Harness, startHarness, tenantInput } from './support.js';

let h: Harness;
let alpha: ProvisionedTenant;
let beta: ProvisionedTenant;
let port: NumberingPort;
let uow: UnitOfWork;
let plant2: string;

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT';
const asOwner = (m: Method, url: string, o: CallOptions = {}) =>
  h.call(m, url, { sub: 'sub-alpha-admin', tenant: 'alpha-works', ...o });

const ctx = (t: ProvisionedTenant): RequestContext => ({
  correlationId: 'numbering-test',
  source: 'system',
  locale: 'en-IN',
  timezone: 'Asia/Kolkata',
  companyIds: [t.companyId],
  tenantId: t.tenantId,
  actor: { type: 'user', id: t.adminUserId },
});
/** Issues a number with sensible defaults; pass `plantId: undefined` to omit the plant. */
const next = (
  req: { [K in keyof NumberRequest]?: NumberRequest[K] | undefined },
  t: ProvisionedTenant = alpha,
) => {
  const merged: Record<string, unknown> = {
    companyId: t.companyId,
    docType: 'sales.invoice',
    documentDate: '2026-09-26',
    plantId: t.plantId,
    ...req,
  };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return RequestContexts.run(ctx(t), () => port.next(merged as unknown as NumberRequest));
};

async function createSeries(
  body: Record<string, unknown>,
): Promise<{ id: string; version: number }> {
  const res = await asOwner('POST', `/v1/platform/companies/${alpha.companyId}/numbering-series`, {
    payload: body,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

beforeAll(async () => {
  h = await startHarness('manuling_numbering_test');
  const provisioning = h.app.get(ProvisioningService);
  alpha = await provisioning.provision(tenantInput('alpha-works', 'sub-alpha-admin', 'ALPHA'));
  beta = await provisioning.provision(tenantInput('beta-forge', 'sub-beta-admin', 'BETA'));
  port = h.app.get<NumberingPort>(NUMBERING_PORT);
  uow = h.app.get(UnitOfWork);
  const p2 = await asOwner('POST', `/v1/platform/companies/${alpha.companyId}/plants`, {
    payload: { code: 'P2', name: 'Second plant', timezone: 'Asia/Kolkata' },
  });
  plant2 = p2.json<{ id: string }>().id;

  // GST-style tax invoice series: gapless, per plant, per fiscal year, ≤ 16 characters.
  await createSeries({
    code: 'SI',
    docType: 'sales.invoice',
    pattern: 'SI/{FYS}/{PLANT}/{####}',
    gapless: true,
    scope: 'plant',
    resetPolicy: 'fiscal_year',
    maxLength: 16,
    isDefault: true,
  });
  // Gap-tolerant internal document series.
  await createSeries({
    code: 'GRN',
    docType: 'procurement.goods_receipt',
    pattern: 'GRN-{YYYY}{MM}-{#####}',
    gapless: false,
    scope: 'company',
    resetPolicy: 'never',
    isDefault: true,
  });
});

afterAll(async () => {
  await h?.stop();
});

describe('gapless series', () => {
  it('renders GST-safe numbers and previews without allocating', async () => {
    const series = (
      await asOwner('GET', `/v1/platform/companies/${alpha.companyId}/numbering-series`)
    ).json<{
      items: { id: string; code: string }[];
    }>().items;
    const si = series.find((s) => s.code === 'SI')!;
    const preview = await asOwner('POST', `/v1/platform/numbering-series/${si.id}/preview`, {
      payload: { documentDate: '2026-09-26', plantId: alpha.plantId },
    });
    expect(preview.json()).toEqual({ number: 'SI/2627/P1/0001', sequence: '1' });
    const again = await asOwner('POST', `/v1/platform/numbering-series/${si.id}/preview`, {
      payload: { documentDate: '2026-09-26', plantId: alpha.plantId },
    });
    expect(again.json()).toEqual({ number: 'SI/2627/P1/0001', sequence: '1' });

    const issued = await next({});
    expect(issued).toMatchObject({ number: 'SI/2627/P1/0001', sequence: '1', seriesId: si.id });
    expect(issued.fiscalYearId).toBe(alpha.fiscalYearId);
  });

  it('issues 1,000 concurrent numbers with no gaps and no duplicates', async () => {
    const results = await Promise.all(Array.from({ length: 1000 }, () => next({})));
    const sequences = results.map((r) => Number(r.sequence)).sort((a, b) => a - b);
    expect(new Set(sequences).size).toBe(1000);
    expect(sequences[0]).toBe(2);
    expect(sequences[999]).toBe(1001);
    expect(new Set(results.map((r) => r.number)).size).toBe(1000);
  }, 120_000);

  it('returns the number when the document transaction rolls back', async () => {
    let inside = '';
    await expect(
      RequestContexts.run(ctx(alpha), () =>
        uow.run(async () => {
          inside = (await next({})).sequence;
          throw new Error('document failed validation');
        }),
      ),
    ).rejects.toThrow('document failed validation');
    expect((await next({})).sequence).toBe(inside);
  });

  it('keeps separate counters per plant and restarts in a new fiscal year', async () => {
    expect((await next({ plantId: plant2 })).number).toBe('SI/2627/P2/0001');

    const fy = await asOwner('POST', `/v1/platform/companies/${alpha.companyId}/fiscal-years`, {
      payload: { startYear: 2027 },
    });
    expect(fy.statusCode).toBe(201);
    expect((await next({ documentDate: '2027-04-01' })).number).toBe('SI/2728/P1/0001');
    // The old year continues where it left off.
    expect(Number((await next({ documentDate: '2027-03-31' })).sequence)).toBeGreaterThan(1000);
  });

  it('rejects dates outside every fiscal year, unknown plants and missing series', async () => {
    await expect(next({ documentDate: '2031-01-01' })).rejects.toMatchObject({
      code: 'platform.numbering.no_fiscal_year',
    });
    await expect(next({ plantId: beta.plantId })).rejects.toMatchObject({
      code: 'kernel.not_found',
    });
    await expect(next({ plantId: undefined })).rejects.toMatchObject({
      code: 'platform.numbering.plant_required',
    });
    await expect(next({ docType: 'sales.credit_note' })).rejects.toMatchObject({
      code: 'platform.numbering.no_series',
    });
  });

  it('refuses numbers longer than the series limit without consuming the counter', async () => {
    const long = await createSeries({
      code: 'LONG',
      docType: 'sales.debit_note',
      pattern: 'DN/{PLANT}/{FY}/{##}',
      gapless: true,
      scope: 'plant',
      resetPolicy: 'fiscal_year',
      maxLength: 12,
      isDefault: true,
    });
    await expect(next({ docType: 'sales.debit_note' })).rejects.toMatchObject({
      code: 'platform.numbering.too_long',
    });
    const preview = await asOwner('POST', `/v1/platform/numbering-series/${long.id}/preview`, {
      payload: { documentDate: '2026-09-26', plantId: alpha.plantId },
    });
    expect(preview.json()).toMatchObject({ status: 422, code: 'platform.numbering.too_long' });
  });
});

describe('gap-tolerant series', () => {
  it('commits allocations independently: rollbacks leave gaps, never duplicates', async () => {
    const first = await next({ docType: 'procurement.goods_receipt', plantId: undefined });
    expect(first.number).toBe('GRN-202609-00001');
    await expect(
      RequestContexts.run(ctx(alpha), () =>
        uow.run(async () => {
          await next({ docType: 'procurement.goods_receipt', plantId: undefined });
          throw new Error('rollback');
        }),
      ),
    ).rejects.toThrow('rollback');
    expect(
      (await next({ docType: 'procurement.goods_receipt', plantId: undefined })).sequence,
    ).toBe('3');

    const burst = await Promise.all(
      Array.from({ length: 200 }, () =>
        next({ docType: 'procurement.goods_receipt', plantId: undefined }),
      ),
    );
    expect(new Set(burst.map((b) => b.sequence)).size).toBe(200);
  });

  it('does not starve the pool when many document transactions allocate at once', async () => {
    // Each document transaction holds a main-pool connection while its gap-tolerant number is
    // allocated in an independent transaction; the separate pool makes this deadlock-free.
    const inDocuments = await Promise.all(
      Array.from({ length: 60 }, () =>
        RequestContexts.run(ctx(alpha), () =>
          uow.run(async () => {
            const issued = await next({ docType: 'procurement.goods_receipt', plantId: undefined });
            await new Promise((r) => setTimeout(r, 5)); // the document keeps working
            return issued.sequence;
          }),
        ),
      ),
    );
    expect(new Set(inDocuments).size).toBe(60);
  }, 60_000);
});

describe('administration', () => {
  it('moves the default, locks the format once used, and validates coherence', async () => {
    const replacement = await createSeries({
      code: 'SI2',
      docType: 'sales.invoice',
      pattern: 'INV/{FYS}/{PLANT}/{###}',
      gapless: true,
      scope: 'plant',
      resetPolicy: 'fiscal_year',
      isDefault: true,
    });
    expect((await next({})).seriesId).toBe(replacement.id);
    expect((await next({ seriesCode: 'SI' })).number).toMatch(/^SI\/2627\/P1\/\d{4}$/);

    const series = (
      await asOwner('GET', `/v1/platform/companies/${alpha.companyId}/numbering-series`)
    ).json<{
      items: { id: string; code: string; isDefault: boolean; version: number }[];
    }>().items;
    const si = series.find((s) => s.code === 'SI')!;
    expect(si.isDefault).toBe(false);
    const locked = await asOwner('PATCH', `/v1/platform/numbering-series/${si.id}`, {
      headers: { 'if-match': `"v${si.version}"` },
      payload: { pattern: 'SI/{FYS}/{PLANT}/{#####}' },
    });
    expect(locked.json()).toMatchObject({ status: 422, code: 'platform.numbering.series_in_use' });

    const incoherent = await asOwner(
      'POST',
      `/v1/platform/companies/${alpha.companyId}/numbering-series`,
      {
        payload: {
          code: 'BAD',
          docType: 'sales.order',
          pattern: 'SO/{PLANT}/{####}',
          gapless: false,
          scope: 'company',
          resetPolicy: 'never',
        },
      },
    );
    expect(incoherent.json()).toMatchObject({
      status: 422,
      code: 'platform.numbering.scope_mismatch',
    });

    const audit = await h.sql(
      `SELECT count(*)::int AS n FROM platform.audit_log WHERE entity_type = 'platform.numbering_series'`,
    );
    expect(audit[0]).toMatchObject({ n: expect.any(Number) });
    expect((audit[0] as { n: number }).n).toBeGreaterThanOrEqual(4);
  });

  it('is tenant-isolated and permission-checked', async () => {
    const foreign = await h.call(
      'GET',
      `/v1/platform/companies/${alpha.companyId}/numbering-series`,
      {
        sub: 'sub-beta-admin',
        tenant: 'beta-forge',
      },
    );
    expect(foreign.statusCode).toBe(404);
    // Alpha's series are invisible under Beta's RLS: nothing about Alpha leaks.
    await expect(next({ companyId: alpha.companyId }, beta)).rejects.toMatchObject({
      code: 'platform.numbering.no_series',
    });
    // Beta has no series of its own yet.
    await expect(next({}, beta)).rejects.toMatchObject({ code: 'platform.numbering.no_series' });
  });
});
