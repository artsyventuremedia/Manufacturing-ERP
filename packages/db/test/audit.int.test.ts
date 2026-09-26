import { FixedClock, type RequestContext, RequestContexts, newId } from '@manuling/kernel';
import { type EphemeralPostgres, startEphemeralPostgres } from '@manuling/testing';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AuditTrail,
  Migrator,
  UnitOfWork,
  createPool,
  foundationMigrations,
} from '../src/index.js';

const A = newId();
const B = newId();
const USER = newId();
const ctx = (tenantId: string): RequestContext => ({
  correlationId: 'corr-audit-1',
  source: 'ui',
  locale: 'en-IN',
  timezone: 'Asia/Kolkata',
  companyIds: [],
  clientIp: '10.0.0.7',
  tenantId,
  actor: { type: 'user', id: USER },
});

let server: EphemeralPostgres;
let admin: pg.Client;
let pool: pg.Pool;
let uow: UnitOfWork;
let audit: AuditTrail;
const clock = new FixedClock(new Date('2026-09-25T10:00:00.000Z'));

const inTenant = <T>(tenantId: string, fn: () => Promise<T>) =>
  RequestContexts.run(ctx(tenantId), () => uow.run(fn));
const rows = (tenantId: string) =>
  inTenant(
    tenantId,
    async () =>
      (
        await uow
          .current()
          .db.execute<Record<string, unknown>>(
            sql`SELECT * FROM platform.audit_log ORDER BY occurred_at, id`,
          )
      ).rows,
  );

beforeAll(async () => {
  server = await startEphemeralPostgres();
  const url = await server.createDatabase('manuling_audit_test');
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await new Migrator(admin).migrate([foundationMigrations]);
  await admin.query(`CREATE ROLE mnl_app LOGIN PASSWORD 'app' IN ROLE app_rw`);
  pool = createPool({ connectionString: server.urlFor('manuling_audit_test', 'mnl_app', 'app') });
  uow = new UnitOfWork(pool);
  audit = new AuditTrail(uow, clock);
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
  await server?.stop();
});

describe('AuditTrail', () => {
  it('records who, what, when, before/after and changed fields', async () => {
    await inTenant(A, () =>
      audit.record({
        entityType: 'platform.company',
        entityId: 'c1',
        action: 'update',
        before: { legalName: 'Old', version: 1, code: 'MPC' },
        after: { legalName: 'New', version: 2, code: 'MPC', at: new Date('2026-01-01T00:00:00Z') },
      }),
    );
    const [row] = await rows(A);
    expect(row).toMatchObject({
      tenant_id: A,
      entity_type: 'platform.company',
      entity_id: 'c1',
      action: 'update',
      changed_fields: ['at', 'legalName', 'version'],
      actor_type: 'user',
      actor_id: USER,
      source: 'ui',
      correlation_id: 'corr-audit-1',
      client_ip: '10.0.0.7',
      chain_seq: null,
      after: { legalName: 'New', version: 2, code: 'MPC', at: '2026-01-01T00:00:00.000Z' },
    });
  });

  it('skips no-op updates and writes nothing when the transaction rolls back', async () => {
    await inTenant(A, () =>
      audit.record({
        entityType: 'platform.company',
        entityId: 'c1',
        action: 'update',
        before: { a: 1 },
        after: { a: 1 },
      }),
    );
    await expect(
      inTenant(A, async () => {
        await audit.record({
          entityType: 'platform.company',
          entityId: 'c2',
          action: 'create',
          after: { a: 1 },
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await rows(A)).toHaveLength(1);
  });

  it('is tenant-isolated and append-only', async () => {
    expect(await rows(B)).toHaveLength(0);
    await expect(
      inTenant(A, () => uow.current().db.execute(sql`UPDATE platform.audit_log SET action = 'x'`)),
    ).rejects.toMatchObject({ code: 'db.privilege_denied' });
    await expect(admin.query(`DELETE FROM platform.audit_log`)).rejects.toMatchObject({
      code: 'MN001',
    });
  });

  it('chains hashes for opted-in tenants and detects tampering', async () => {
    await inTenant(B, () => audit.enableChain());
    for (let i = 1; i <= 3; i++) {
      clock.advanceMs(1000);
      await inTenant(B, () =>
        audit.record({
          entityType: 'platform.plant',
          entityId: `p${i}`,
          action: 'create',
          after: { code: `P${i}`, name: `Plant ${i}` },
        }),
      );
    }
    const chain = await rows(B);
    expect(chain.map((r) => r['chain_seq'])).toEqual(['1', '2', '3']);
    expect(chain[1]!['prev_hash']).toBe(chain[0]!['hash']);
    expect(await inTenant(B, () => audit.verifyChain())).toEqual({ valid: true, checked: 3 });

    // Tamper as a privileged operator: disable the guard trigger, edit history, re-enable.
    await admin.query('ALTER TABLE platform.audit_log DISABLE TRIGGER append_only_row');
    await admin.query(
      `UPDATE platform.audit_log SET after = '{"code":"P2","name":"Forged"}' WHERE tenant_id = $1 AND chain_seq = 2`,
      [B],
    );
    await admin.query('ALTER TABLE platform.audit_log ENABLE TRIGGER append_only_row');
    expect(await inTenant(B, () => audit.verifyChain())).toEqual({
      valid: false,
      checked: 1,
      brokenAt: 2,
    });
  });

  it('serialises concurrent chained writes without gaps', async () => {
    const tenant = newId();
    await inTenant(tenant, () => audit.enableChain());
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        inTenant(tenant, () =>
          audit.record({
            entityType: 'platform.role',
            entityId: `r${i}`,
            action: 'create',
            after: { i },
          }),
        ),
      ),
    );
    expect(await inTenant(tenant, () => audit.verifyChain())).toEqual({ valid: true, checked: 20 });
  });
});
