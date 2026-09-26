-- Document numbering series and counters (Phase 0 step 0.7, docs/plans/phase0-step0.7-numbering.md).

CREATE TABLE platform.numbering_series (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  company_id   uuid NOT NULL,
  code         text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  doc_type     text NOT NULL CHECK (doc_type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  pattern      text NOT NULL CHECK (length(pattern) BETWEEN 3 AND 100),
  gapless      boolean NOT NULL,
  scope        text NOT NULL CHECK (scope IN ('company', 'plant')),
  reset_policy text NOT NULL CHECK (reset_policy IN ('fiscal_year', 'never')),
  start_value  bigint NOT NULL DEFAULT 1 CHECK (start_value >= 0),
  max_length   integer CHECK (max_length BETWEEN 3 AND 100),
  is_default   boolean NOT NULL DEFAULT false,
  status       text NOT NULL CHECK (status IN ('active', 'inactive')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid,
  version      integer NOT NULL DEFAULT 1 CHECK (version > 0),
  source       text NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, company_id, code),
  FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id)
);
SELECT platform.enable_tenant_rls('platform.numbering_series');
-- At most one default active series per company and document type.
CREATE UNIQUE INDEX numbering_series_default_unique
  ON platform.numbering_series (tenant_id, company_id, doc_type)
  WHERE is_default AND status = 'active';

-- One counter per series × plant × fiscal year. Keys that do not apply (company-scoped
-- series, series that never reset) use the nil UUID, so the key is always NOT NULL and a
-- single upsert can allocate atomically.
CREATE TABLE platform.numbering_counter (
  tenant_id       uuid NOT NULL,
  series_id       uuid NOT NULL,
  plant_key       uuid NOT NULL,
  fiscal_year_key uuid NOT NULL,
  next_value      bigint NOT NULL CHECK (next_value >= 0),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, series_id, plant_key, fiscal_year_key),
  FOREIGN KEY (tenant_id, series_id) REFERENCES platform.numbering_series (tenant_id, id)
);
SELECT platform.enable_tenant_rls('platform.numbering_counter');
