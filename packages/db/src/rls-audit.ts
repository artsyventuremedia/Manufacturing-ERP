import type pg from 'pg';

export interface RlsViolation {
  readonly schemaName: string;
  readonly tableName: string;
  readonly problem: 'rls_disabled' | 'rls_not_forced' | 'missing_tenant_isolation_policy';
}

/**
 * Lists tenant tables (any table with a `tenant_id` column) that are not protected by RLS.
 * CI fails if this returns anything (ADR-0004 §5, ADR-0005 §7).
 */
export async function findTenantRlsViolations(client: pg.ClientBase): Promise<RlsViolation[]> {
  const res = await client.query<{
    schema_name: string;
    table_name: string;
    problem: RlsViolation['problem'];
  }>('SELECT schema_name, table_name, problem FROM platform.tenant_rls_violations()');
  return res.rows.map((r) => ({
    schemaName: r.schema_name,
    tableName: r.table_name,
    problem: r.problem,
  }));
}

/** True if the application role could bypass RLS; must always be false. */
export async function appRoleBypassesRls(client: pg.ClientBase): Promise<boolean> {
  const res = await client.query<{ bypass: boolean }>(
    "SELECT rolbypassrls OR rolsuper AS bypass FROM pg_roles WHERE rolname = 'app_rw'",
  );
  return res.rows[0]?.bypass ?? false;
}
