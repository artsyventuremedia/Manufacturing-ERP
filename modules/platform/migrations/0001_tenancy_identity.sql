-- Platform: tenancy, organisation structure, identity, idempotency (Phase 0 step 0.4).
-- Conventions: docs/architecture/03-erd-phase0-1.md §0. Every tenant table goes through
-- platform.enable_tenant_rls; cross-table references use composite (tenant_id, id) keys.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- Tenant. A tenant's own row is visible only inside its own context (tenant_id = id).
-- ---------------------------------------------------------------------------
CREATE TABLE platform.tenant (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL CHECK (tenant_id = id),
  slug             text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name             text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  edition          text NOT NULL CHECK (edition IN ('starter', 'growth', 'enterprise')),
  status           text NOT NULL CHECK (status IN ('active', 'suspended')),
  data_region      text NOT NULL DEFAULT 'in',
  default_locale   text NOT NULL,
  default_timezone text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  version          integer NOT NULL DEFAULT 1 CHECK (version > 0),
  source           text NOT NULL,
  UNIQUE (tenant_id, id)
);
SELECT platform.enable_tenant_rls('platform.tenant');

-- Global slug → tenant directory, needed to resolve a request's tenant before any tenant
-- context exists. Holds no business data. The app can only read it; it is maintained by a
-- SECURITY DEFINER trigger on platform.tenant.
CREATE TABLE platform.tenant_directory (
  slug   text PRIMARY KEY,
  id     uuid NOT NULL UNIQUE,
  status text NOT NULL
);
GRANT SELECT ON platform.tenant_directory TO app_rw;

CREATE FUNCTION platform.sync_tenant_directory() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM platform.tenant_directory WHERE id = NEW.id;
  INSERT INTO platform.tenant_directory (slug, id, status) VALUES (NEW.slug, NEW.id, NEW.status);
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION platform.sync_tenant_directory() FROM PUBLIC;

CREATE TRIGGER tenant_directory_sync
  AFTER INSERT OR UPDATE OF slug, status ON platform.tenant
  FOR EACH ROW EXECUTE FUNCTION platform.sync_tenant_directory();

-- ---------------------------------------------------------------------------
-- Company (legal entity)
-- ---------------------------------------------------------------------------
CREATE TABLE platform.company (
  id                      uuid PRIMARY KEY,
  tenant_id               uuid NOT NULL REFERENCES platform.tenant (id),
  code                    text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  legal_name              text NOT NULL CHECK (length(btrim(legal_name)) BETWEEN 1 AND 200),
  base_currency           char(3) NOT NULL CHECK (base_currency ~ '^[A-Z]{3}$'),
  country_code            char(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  fiscal_year_start_month smallint NOT NULL CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  status                  text NOT NULL CHECK (status IN ('active', 'inactive')),
  ext                     jsonb NOT NULL DEFAULT '{}',
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid,
  version                 integer NOT NULL DEFAULT 1 CHECK (version > 0),
  source                  text NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);
SELECT platform.enable_tenant_rls('platform.company');

-- ---------------------------------------------------------------------------
-- Plant
-- ---------------------------------------------------------------------------
CREATE TABLE platform.plant (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  company_id  uuid NOT NULL,
  code        text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  region_code text CHECK (region_code ~ '^[A-Z]{2}-[A-Z0-9]{1,3}$'),
  timezone    text NOT NULL,
  status      text NOT NULL CHECK (status IN ('active', 'inactive')),
  ext         jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid,
  version     integer NOT NULL DEFAULT 1 CHECK (version > 0),
  source      text NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, company_id, code),
  FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id)
);
SELECT platform.enable_tenant_rls('platform.plant');

-- ---------------------------------------------------------------------------
-- Fiscal year. Overlaps within a company are impossible (exclusion constraint).
-- ---------------------------------------------------------------------------
CREATE TABLE platform.fiscal_year (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL,
  company_id uuid NOT NULL,
  code       text NOT NULL CHECK (code ~ '^\d{4}(-\d{2})?$'),
  start_date date NOT NULL,
  end_date   date NOT NULL CHECK (end_date > start_date),
  status     text NOT NULL CHECK (status IN ('open', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version    integer NOT NULL DEFAULT 1 CHECK (version > 0),
  source     text NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, company_id, code),
  FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  EXCLUDE USING gist (
    tenant_id WITH =,
    company_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  )
);
SELECT platform.enable_tenant_rls('platform.fiscal_year');

-- ---------------------------------------------------------------------------
-- Application user: membership of an IdP subject in a tenant.
-- ---------------------------------------------------------------------------
CREATE TABLE platform.app_user (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES platform.tenant (id),
  idp_subject     text NOT NULL CHECK (length(idp_subject) BETWEEN 1 AND 255),
  email           text NOT NULL CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+$'),
  display_name    text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  locale          text,
  timezone        text,
  user_type       text NOT NULL CHECK (user_type IN ('internal', 'portal', 'agent')),
  -- Bootstrap administrator flag; fine-grained roles arrive in step 0.5.
  is_tenant_admin boolean NOT NULL DEFAULT false,
  status          text NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid,
  version         integer NOT NULL DEFAULT 1 CHECK (version > 0),
  source          text NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idp_subject),
  UNIQUE (tenant_id, email)
);
SELECT platform.enable_tenant_rls('platform.app_user');

-- ---------------------------------------------------------------------------
-- Idempotency keys for POST requests (24 h). Not business data, so the app may delete
-- rows to release a key after a failed request.
-- ---------------------------------------------------------------------------
CREATE TABLE platform.idempotency_key (
  tenant_id        uuid NOT NULL,
  key              text NOT NULL CHECK (length(key) BETWEEN 8 AND 255),
  request_hash     text NOT NULL,
  method           text NOT NULL,
  path             text NOT NULL,
  status           text NOT NULL CHECK (status IN ('in_progress', 'completed')),
  response_status  integer,
  response_headers jsonb,
  response_body    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, key)
);
SELECT platform.enable_tenant_rls('platform.idempotency_key');
GRANT DELETE ON platform.idempotency_key TO app_rw;
CREATE INDEX idempotency_key_expires_idx ON platform.idempotency_key (expires_at);
