-- Custom fields, custom objects and UI layouts (Phase 0 step 0.9,
-- docs/plans/phase0-step0.9-customisation.md). No runtime DDL: custom values live in JSON.

CREATE TABLE platform.custom_field_def (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  entity        text NOT NULL CHECK (entity ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  api_name      text NOT NULL CHECK (api_name ~ '^[a-z][a-zA-Z0-9]{1,39}$'),
  data_type     text NOT NULL CHECK (data_type IN ('text', 'long_text', 'integer', 'decimal', 'boolean', 'date',
                  'datetime', 'select', 'multi_select', 'email', 'url', 'phone', 'reference')),
  label         jsonb NOT NULL CHECK (jsonb_typeof(label) = 'object'),
  help          jsonb,
  required      boolean NOT NULL DEFAULT false,
  default_value jsonb,
  options       jsonb,
  settings      jsonb NOT NULL DEFAULT '{}',
  position      integer NOT NULL DEFAULT 0,
  status        text NOT NULL CHECK (status IN ('active', 'archived')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  version       integer NOT NULL DEFAULT 1 CHECK (version > 0),
  source        text NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, entity, api_name)
);
SELECT platform.enable_tenant_rls('platform.custom_field_def');

-- A field's type is fixed once created (C3).
CREATE FUNCTION platform.custom_field_type_fixed() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.data_type <> OLD.data_type OR NEW.api_name <> OLD.api_name OR NEW.entity <> OLD.entity THEN
    RAISE EXCEPTION USING ERRCODE = 'MN001', MESSAGE = 'A custom field''s entity, name and type cannot change';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER custom_field_type_fixed BEFORE UPDATE ON platform.custom_field_def
  FOR EACH ROW EXECUTE FUNCTION platform.custom_field_type_fixed();

CREATE TABLE platform.custom_object_def (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL,
  api_name       text NOT NULL CHECK (api_name ~ '^[a-z][a-z0-9_]{2,39}$'),
  label          jsonb NOT NULL CHECK (jsonb_typeof(label) = 'object'),
  plural_label   jsonb NOT NULL CHECK (jsonb_typeof(plural_label) = 'object'),
  description    text CHECK (length(description) <= 1000),
  company_scoped boolean NOT NULL DEFAULT true,
  title_field    text,
  status         text NOT NULL CHECK (status IN ('active', 'archived')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer NOT NULL DEFAULT 1 CHECK (version > 0),
  source         text NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, api_name)
);
SELECT platform.enable_tenant_rls('platform.custom_object_def');

CREATE TABLE platform.custom_record (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  object_def_id uuid NOT NULL,
  company_id    uuid,
  data          jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(data) = 'object'),
  status        text NOT NULL CHECK (status IN ('active', 'archived')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  version       integer NOT NULL DEFAULT 1 CHECK (version > 0),
  source        text NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, object_def_id) REFERENCES platform.custom_object_def (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id)
);
SELECT platform.enable_tenant_rls('platform.custom_record');
CREATE INDEX custom_record_object_idx ON platform.custom_record (tenant_id, object_def_id, created_at DESC, id DESC);
CREATE INDEX custom_record_data_gin ON platform.custom_record USING gin (data jsonb_path_ops);

-- Filter support for custom fields on core entities (C1).
CREATE INDEX company_ext_gin ON platform.company USING gin (ext jsonb_path_ops);
CREATE INDEX plant_ext_gin ON platform.plant USING gin (ext jsonb_path_ops);

-- Field policies may address custom fields as "ext.<field>" (C4).
ALTER TABLE platform.field_policy DROP CONSTRAINT field_policy_field_check;
ALTER TABLE platform.field_policy
  ADD CONSTRAINT field_policy_field_check CHECK (field ~ '^(ext\.)?[a-zA-Z][a-zA-Z0-9]*$');

CREATE TABLE platform.ui_layout (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL,
  entity     text NOT NULL CHECK (entity ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  kind       text NOT NULL CHECK (kind IN ('form', 'list')),
  layout     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version    integer NOT NULL DEFAULT 1 CHECK (version > 0),
  source     text NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, entity, kind)
);
SELECT platform.enable_tenant_rls('platform.ui_layout');
