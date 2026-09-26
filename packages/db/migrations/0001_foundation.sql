-- Manuling database foundation (ADR-0004, ADR-0005, ADR-0006).
-- Applied by the migrator as the migration (owner) role before any module schema.

-- ---------------------------------------------------------------------------
-- Roles
--   app_rw : group role the application connects through. NOLOGIN, NO BYPASSRLS,
--            owns nothing, so FORCE ROW LEVEL SECURITY always applies to it.
--   Login users (e.g. manuling_app) are created by infrastructure and granted app_rw.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    CREATE ROLE app_rw NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS platform;
GRANT USAGE ON SCHEMA platform TO app_rw;

-- ---------------------------------------------------------------------------
-- Session context, set per transaction with set_config(..., true) by UnitOfWork.
-- Empty or missing settings resolve to NULL, so RLS fails closed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION platform.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION platform.current_correlation_id() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.correlation_id', true), '') $$;

GRANT EXECUTE ON FUNCTION platform.current_tenant_id(), platform.current_user_id(),
  platform.current_correlation_id() TO app_rw;

-- ---------------------------------------------------------------------------
-- platform.grant_app_access(schema): lets app_rw use a module schema.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform.grant_app_access(p_schema name) RETURNS void
  LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO app_rw', p_schema);
END
$$;

-- ---------------------------------------------------------------------------
-- platform.enable_tenant_rls(table): the ONLY sanctioned way to make a tenant table.
--   * table must have tenant_id uuid NOT NULL
--   * ENABLE + FORCE RLS, policy tenant_isolation for USING and WITH CHECK
--   * grants SELECT/INSERT/UPDATE to app_rw (DELETE is never granted: no hard deletes, PRD §10)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform.enable_tenant_rls(p_table regclass) RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  v_not_null boolean;
BEGIN
  SELECT a.attnotnull INTO v_not_null
    FROM pg_attribute a
   WHERE a.attrelid = p_table AND a.attname = 'tenant_id' AND NOT a.attisdropped
     AND a.atttypid = 'uuid'::regtype;
  IF v_not_null IS DISTINCT FROM true THEN
    RAISE EXCEPTION '% must have a "tenant_id uuid NOT NULL" column', p_table;
  END IF;

  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', p_table);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s AS PERMISSIVE FOR ALL TO PUBLIC '
    'USING (tenant_id = platform.current_tenant_id()) '
    'WITH CHECK (tenant_id = platform.current_tenant_id())', p_table);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %s TO app_rw', p_table);
END
$$;

-- ---------------------------------------------------------------------------
-- Append-only ledgers (ADR-0006 §4): revoke UPDATE/DELETE/TRUNCATE from the app and add
-- triggers so that even privileged roles cannot mutate history by accident.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform.forbid_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'MN001',
    MESSAGE = format('%I.%I is append-only; post a reversal instead', TG_TABLE_SCHEMA, TG_TABLE_NAME),
    HINT = 'ADR-0006';
END
$$;

CREATE OR REPLACE FUNCTION platform.make_append_only(p_table regclass) RETURNS void
  LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %s FROM app_rw', p_table);
  EXECUTE format('DROP TRIGGER IF EXISTS append_only_row ON %s', p_table);
  EXECUTE format('DROP TRIGGER IF EXISTS append_only_truncate ON %s', p_table);
  EXECUTE format(
    'CREATE TRIGGER append_only_row BEFORE UPDATE OR DELETE ON %s '
    'FOR EACH ROW EXECUTE FUNCTION platform.forbid_mutation()', p_table);
  EXECUTE format(
    'CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON %s '
    'FOR EACH STATEMENT EXECUTE FUNCTION platform.forbid_mutation()', p_table);
END
$$;

-- ---------------------------------------------------------------------------
-- CI audit: every table with a tenant_id column must have RLS enabled + forced + policy.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform.tenant_rls_violations()
  RETURNS TABLE (schema_name name, table_name name, problem text)
  LANGUAGE sql STABLE AS $$
  SELECT n.nspname, c.relname,
         CASE
           WHEN NOT c.relrowsecurity THEN 'rls_disabled'
           WHEN NOT c.relforcerowsecurity THEN 'rls_not_forced'
           ELSE 'missing_tenant_isolation_policy'
         END
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
   WHERE c.relkind IN ('r', 'p')
     AND NOT c.relispartition
     AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'platform_meta')
     AND (NOT c.relrowsecurity
          OR NOT c.relforcerowsecurity
          OR NOT EXISTS (SELECT 1 FROM pg_policies p
                          WHERE p.schemaname = n.nspname AND p.tablename = c.relname
                            AND p.policyname = 'tenant_isolation'))
   ORDER BY 1, 2
$$;
