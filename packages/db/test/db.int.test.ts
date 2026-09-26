import { fileURLToPath } from 'node:url';
import {
  ConflictError,
  ForbiddenError,
  InvariantViolation,
  Money,
  type RequestContext,
  RequestContexts,
  ValidationError,
  newId,
} from '@manuling/kernel';
import { type EphemeralPostgres, startEphemeralPostgres } from '@manuling/testing';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Migrator,
  UnitOfWork,
  appRoleBypassesRls,
  createPool,
  findTenantRlsViolations,
  foundationMigrations,
} from '../src/index.js';

const demoMigrations = {
  name: 'demo',
  directory: fileURLToPath(new URL('./fixtures/migrations', import.meta.url)),
};

const TENANT_A = newId();
const TENANT_B = newId();
const USER = newId();

function ctx(tenantId?: string): RequestContext {
  return {
    correlationId: 'test',
    source: 'system',
    locale: 'en-IN',
    timezone: 'Asia/Kolkata',
    companyIds: [],
    ...(tenantId ? { tenantId, actor: { type: 'user' as const, id: USER } } : {}),
  };
}

let server: EphemeralPostgres;
let admin: pg.Client;
let pool: pg.Pool;
let uow: UnitOfWork;

async function asTenant<T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> {
  return RequestContexts.run(ctx(tenantId), fn);
}

async function countWidgets(): Promise<number> {
  return uow.run(async ({ db }) => {
    const res = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM demo.widget`);
    return Number(res.rows[0]!.n);
  });
}

beforeAll(async () => {
  server = await startEphemeralPostgres();
  const dbUrl = await server.createDatabase('manuling_db_test');
  admin = new pg.Client({ connectionString: dbUrl });
  await admin.connect();
  await new Migrator(admin).migrate([foundationMigrations, demoMigrations]);
  await admin.query(`CREATE ROLE mnl_app LOGIN PASSWORD 'app' IN ROLE app_rw`);
  pool = createPool({
    connectionString: server.urlFor('manuling_db_test', 'mnl_app', 'app'),
    max: 4,
  });
  uow = new UnitOfWork(pool, { statementTimeoutMs: 5_000 });
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
  await server?.stop();
});

describe('foundation migration', () => {
  it('leaves no tenant table without RLS, and the app role cannot bypass it', async () => {
    expect(await findTenantRlsViolations(admin)).toEqual([]);
    expect(await appRoleBypassesRls(admin)).toBe(false);
  });

  it('flags a tenant table created without enable_tenant_rls', async () => {
    await admin.query('CREATE TABLE demo.sneaky (id uuid PRIMARY KEY, tenant_id uuid NOT NULL)');
    try {
      expect(await findTenantRlsViolations(admin)).toEqual([
        { schemaName: 'demo', tableName: 'sneaky', problem: 'rls_disabled' },
      ]);
    } finally {
      await admin.query('DROP TABLE demo.sneaky');
    }
  });

  it('refuses enable_tenant_rls on a table without tenant_id NOT NULL', async () => {
    await admin.query('CREATE TABLE demo.bad (id uuid PRIMARY KEY, tenant_id uuid)');
    try {
      await expect(admin.query("SELECT platform.enable_tenant_rls('demo.bad')")).rejects.toThrow(
        /tenant_id uuid NOT NULL/,
      );
    } finally {
      await admin.query('DROP TABLE demo.bad');
    }
  });

  it('is idempotent and detects edited migrations', async () => {
    const again = await new Migrator(admin).migrate([foundationMigrations, demoMigrations]);
    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied).toBe(3); // foundation 0001 + 0002, demo 0001

    await admin.query(
      "UPDATE platform_meta.schema_migration SET checksum = 'tampered' WHERE migration_set = 'demo'",
    );
    await expect(new Migrator(admin).migrate([demoMigrations])).rejects.toBeInstanceOf(
      InvariantViolation,
    );
    await admin.query(
      "UPDATE platform_meta.schema_migration SET checksum = $1 WHERE migration_set = 'demo'",
      [
        (await import('node:crypto'))
          .createHash('sha256')
          .update(
            await (
              await import('node:fs/promises')
            ).readFile(new URL('./fixtures/migrations/0001_demo.sql', import.meta.url), 'utf8'),
          )
          .digest('hex'),
      ],
    );
  });
});

describe('tenant isolation (RLS)', () => {
  const widgetA = newId();

  it('tenant A writes and reads its own rows', async () => {
    await asTenant(TENANT_A, () =>
      uow.run(({ db }) =>
        db.execute(sql`INSERT INTO demo.widget (id, tenant_id, name, amount)
                       VALUES (${widgetA}, ${TENANT_A}, 'bracket', ${Money.of('1234.56', 'INR').toStorage()})`),
      ),
    );
    expect(await asTenant(TENANT_A, countWidgets)).toBe(1);
  });

  it('tenant B cannot see, update or reference tenant A rows', async () => {
    expect(await asTenant(TENANT_B, countWidgets)).toBe(0);

    const updated = await asTenant(TENANT_B, () =>
      uow.run(({ db }) =>
        db.execute(sql`UPDATE demo.widget SET name = 'hacked' WHERE id = ${widgetA}`),
      ),
    );
    expect(updated.rowCount).toBe(0);

    // Composite FK stops cross-tenant references even though FK checks bypass RLS.
    await expect(
      asTenant(TENANT_B, () =>
        uow.run(({ db }) =>
          db.execute(sql`INSERT INTO demo.widget_part (id, tenant_id, widget_id)
                         VALUES (${newId()}, ${TENANT_B}, ${widgetA})`),
        ),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects writing a row stamped with another tenant id', async () => {
    await expect(
      asTenant(TENANT_B, () =>
        uow.run(({ db }) =>
          db.execute(
            sql`INSERT INTO demo.widget (id, tenant_id, name) VALUES (${newId()}, ${TENANT_A}, 'x')`,
          ),
        ),
      ),
    ).rejects.toMatchObject({ code: 'db.tenant_isolation_violation' });
  });

  it('fails closed without a tenant in context', async () => {
    expect(await asTenant(undefined, countWidgets)).toBe(0);
    await expect(
      asTenant(undefined, () =>
        uow.run(({ db }) =>
          db.execute(
            sql`INSERT INTO demo.widget (id, tenant_id, name) VALUES (${newId()}, ${TENANT_A}, 'x')`,
          ),
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('never grants DELETE to the application (no hard deletes)', async () => {
    await expect(
      asTenant(TENANT_A, () => uow.run(({ db }) => db.execute(sql`DELETE FROM demo.widget`))),
    ).rejects.toMatchObject({ code: 'db.privilege_denied' });
  });
});

describe('UnitOfWork', () => {
  it('requires a request context and exposes the transaction only inside run()', async () => {
    await expect(uow.run(async () => 1)).rejects.toBeInstanceOf(InvariantViolation);
    expect(() => uow.current()).toThrow(InvariantViolation);
  });

  it('applies tenant, user and correlation settings transaction-locally', async () => {
    const row = await asTenant(TENANT_A, () =>
      uow.run(async ({ db }) => {
        const res = await db.execute<{ t: string; u: string; c: string }>(
          sql`SELECT platform.current_tenant_id()::text AS t, platform.current_user_id()::text AS u,
                     platform.current_correlation_id() AS c`,
        );
        return res.rows[0]!;
      }),
    );
    expect(row).toEqual({ t: TENANT_A, u: USER, c: 'test' });

    // A raw pooled connection afterwards carries no tenant: settings did not leak.
    const client = await pool.connect();
    try {
      const res = await client.query<{ t: string | null }>(
        'SELECT platform.current_tenant_id() AS t',
      );
      expect(res.rows[0]!.t).toBeNull();
    } finally {
      client.release();
    }
  });

  it('nested run joins the outer transaction and rolls back as one', async () => {
    const id = newId();
    await expect(
      asTenant(TENANT_A, () =>
        uow.run(async ({ db }) => {
          await db.execute(
            sql`INSERT INTO demo.widget (id, tenant_id, name) VALUES (${id}, ${TENANT_A}, 'n')`,
          );
          await uow.run(async (inner) => {
            expect(inner.client).toBe(uow.current().client);
          });
          throw new Error('boom');
        }),
      ),
    ).rejects.toThrow('boom');
    const found = await asTenant(TENANT_A, () =>
      uow.run(({ db }) => db.execute(sql`SELECT 1 FROM demo.widget WHERE id = ${id}`)),
    );
    expect(found.rowCount).toBe(0);
  });

  it('rejects nested isolation changes', async () => {
    await expect(
      asTenant(TENANT_A, () =>
        uow.run(() => uow.run(async () => 1, { isolation: 'serializable' })),
      ),
    ).rejects.toMatchObject({ code: 'db.nested_isolation_mismatch' });
  });

  it('maps unique violations to ConflictError and keeps NUMERIC exact', async () => {
    const id = newId();
    const insert = () =>
      uow.run(({ db }) =>
        db.execute(sql`INSERT INTO demo.widget (id, tenant_id, name, amount)
                       VALUES (${id}, ${TENANT_A}, 'n', '12345678901234.123456')`),
      );
    await asTenant(TENANT_A, insert);
    await expect(asTenant(TENANT_A, insert)).rejects.toBeInstanceOf(ConflictError);
    const amount = await asTenant(TENANT_A, () =>
      uow.run(async ({ db }) => {
        const res = await db.execute<{ amount: string }>(
          sql`SELECT amount FROM demo.widget WHERE id = ${id}`,
        );
        return res.rows[0]!.amount;
      }),
    );
    expect(amount).toBe('12345678901234.123456');
    expect(Money.of(amount, 'INR').toStorage()).toBe('12345678901234.123456');
  });

  it('enforces read-only transactions', async () => {
    await expect(
      asTenant(TENANT_A, () =>
        uow.run(
          ({ db }) =>
            db.execute(
              sql`INSERT INTO demo.widget (id, tenant_id, name) VALUES (${newId()}, ${TENANT_A}, 'x')`,
            ),
          { readOnly: true },
        ),
      ),
    ).rejects.toMatchObject({ code: 'db.read_only_transaction' });
  });

  it('rejects malformed tenant ids before touching the database', async () => {
    await expect(asTenant('not-a-uuid', () => uow.run(async () => 1))).rejects.toMatchObject({
      code: 'db.invalid_tenant_context',
    });
  });
});

describe('append-only ledgers', () => {
  it('allows inserts but blocks update/delete for the app and even for the owner', async () => {
    const id = newId();
    await asTenant(TENANT_A, () =>
      uow.run(({ db }) =>
        db.execute(
          sql`INSERT INTO demo.ledger (id, tenant_id, qty) VALUES (${id}, ${TENANT_A}, '5')`,
        ),
      ),
    );
    await expect(
      asTenant(TENANT_A, () =>
        uow.run(({ db }) => db.execute(sql`UPDATE demo.ledger SET qty = '6' WHERE id = ${id}`)),
      ),
    ).rejects.toMatchObject({ code: 'db.privilege_denied' });

    // Owner/superuser path is stopped by the trigger.
    await expect(admin.query('UPDATE demo.ledger SET qty = 6')).rejects.toMatchObject({
      code: 'MN001',
    });
    await expect(admin.query('DELETE FROM demo.ledger')).rejects.toMatchObject({ code: 'MN001' });
    await expect(admin.query('TRUNCATE demo.ledger')).rejects.toMatchObject({ code: 'MN001' });
  });
});
