-- Platform: roles, scoped assignments, field policies, segregation of duties, invitations
-- (Phase 0 step 0.5, ADR-0009 §8–15, docs/plans/phase0-step0.5-authorisation.md).

-- ---------------------------------------------------------------------------
-- Invitations live on app_user: an invited user has no IdP subject until first login,
-- when a token with the same *verified* email binds it (plan decision D1).
-- The bootstrap is_tenant_admin flag from step 0.4 is replaced by the Owner role. It is
-- dropped outright because no installation has been deployed yet.
-- ---------------------------------------------------------------------------
ALTER TABLE platform.app_user DROP COLUMN is_tenant_admin;
ALTER TABLE platform.app_user ALTER COLUMN idp_subject DROP NOT NULL;
ALTER TABLE platform.app_user DROP CONSTRAINT app_user_status_check;
ALTER TABLE platform.app_user
  ADD COLUMN invitation_expires_at timestamptz,
  ADD CONSTRAINT app_user_status_check CHECK (status IN ('invited', 'active', 'disabled')),
  ADD CONSTRAINT app_user_subject_bound CHECK (status = 'invited' OR idp_subject IS NOT NULL),
  ADD CONSTRAINT app_user_invitation_expiry CHECK (status <> 'invited' OR invitation_expires_at IS NOT NULL);

-- Lets role assignments prove a plant belongs to the assigned company.
ALTER TABLE platform.plant ADD CONSTRAINT plant_tenant_company_id_key UNIQUE (tenant_id, company_id, id);

-- ---------------------------------------------------------------------------
-- Roles. System roles (is_system) take their permissions from code templates and are
-- read-only; custom roles store permissions in role_permission.
-- ---------------------------------------------------------------------------
CREATE TABLE platform.role (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES platform.tenant (id),
  code        text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  description text CHECK (length(description) <= 500),
  is_system   boolean NOT NULL DEFAULT false,
  status      text NOT NULL CHECK (status IN ('active', 'archived')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid,
  version     integer NOT NULL DEFAULT 1 CHECK (version > 0),
  source      text NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);
SELECT platform.enable_tenant_rls('platform.role');

CREATE TABLE platform.role_permission (
  tenant_id  uuid NOT NULL,
  role_id    uuid NOT NULL,
  permission text NOT NULL CHECK (permission ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  PRIMARY KEY (tenant_id, role_id, permission),
  FOREIGN KEY (tenant_id, role_id) REFERENCES platform.role (tenant_id, id)
);
SELECT platform.enable_tenant_rls('platform.role_permission');
-- Configuration, not transactional history: replacing a role's permission set deletes rows
-- (changes are audited from step 0.6).
GRANT DELETE ON platform.role_permission TO app_rw;

-- ---------------------------------------------------------------------------
-- Role assignments: user × role, optionally scoped to a company or a plant, with ABAC
-- conditions and validity dates. Revocation is a status change, so history is kept.
-- ---------------------------------------------------------------------------
CREATE TABLE platform.user_role (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL,
  user_id    uuid NOT NULL,
  role_id    uuid NOT NULL,
  company_id uuid,
  plant_id   uuid,
  conditions jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(conditions) = 'array'),
  valid_from date,
  valid_to   date CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from),
  status     text NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version    integer NOT NULL DEFAULT 1 CHECK (version > 0),
  source     text NOT NULL,
  UNIQUE (tenant_id, id),
  CHECK (plant_id IS NULL OR company_id IS NOT NULL),
  FOREIGN KEY (tenant_id, user_id) REFERENCES platform.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, role_id) REFERENCES platform.role (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, plant_id) REFERENCES platform.plant (tenant_id, company_id, id)
);
SELECT platform.enable_tenant_rls('platform.user_role');
CREATE UNIQUE INDEX user_role_active_unique ON platform.user_role (tenant_id, user_id, role_id, company_id, plant_id)
  NULLS NOT DISTINCT WHERE status = 'active';
CREATE INDEX user_role_user_idx ON platform.user_role (tenant_id, user_id) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- Field-level security per role (hidden / read; absent = write).
-- ---------------------------------------------------------------------------
CREATE TABLE platform.field_policy (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL,
  role_id    uuid NOT NULL,
  entity     text NOT NULL CHECK (entity ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  field      text NOT NULL CHECK (field ~ '^[a-zA-Z][a-zA-Z0-9]*$'),
  access     text NOT NULL CHECK (access IN ('hidden', 'read')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (tenant_id, role_id, entity, field),
  FOREIGN KEY (tenant_id, role_id) REFERENCES platform.role (tenant_id, id)
);
SELECT platform.enable_tenant_rls('platform.field_policy');
GRANT DELETE ON platform.field_policy TO app_rw;

-- ---------------------------------------------------------------------------
-- Segregation-of-duties rules (plan decision D3).
-- ---------------------------------------------------------------------------
CREATE TABLE platform.sod_rule (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES platform.tenant (id),
  code         text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,59}$'),
  name         text NOT NULL,
  permission_a text NOT NULL,
  permission_b text NOT NULL CHECK (permission_b <> permission_a),
  severity     text NOT NULL CHECK (severity IN ('warn', 'block')),
  is_system    boolean NOT NULL DEFAULT false,
  status       text NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid,
  version      integer NOT NULL DEFAULT 1 CHECK (version > 0),
  source       text NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);
SELECT platform.enable_tenant_rls('platform.sod_rule');
