-- Approval workflows (Phase 0 step 0.8, docs/plans/phase0-step0.8-workflow-approvals.md).
-- Postgres is the source of truth for definitions, instances, tasks and decisions (W1);
-- Temporal only orchestrates time (SLA, reminders, escalation) and step progression.

CREATE TABLE platform.workflow_definition (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL,
  company_id uuid NOT NULL,
  doc_type   text NOT NULL CHECK (doc_type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  name       text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  status     text NOT NULL CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version    integer NOT NULL DEFAULT 1 CHECK (version > 0),
  source     text NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, company_id, doc_type),
  FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id)
);
SELECT platform.enable_tenant_rls('platform.workflow_definition');

-- Published versions are immutable; instances pin the version they started on (W5).
CREATE TABLE platform.workflow_version (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  definition_id uuid NOT NULL,
  number        integer NOT NULL CHECK (number > 0),
  flow          jsonb NOT NULL,
  status        text NOT NULL CHECK (status IN ('draft', 'published', 'superseded')),
  published_at  timestamptz,
  published_by  uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  source        text NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, definition_id, number),
  FOREIGN KEY (tenant_id, definition_id) REFERENCES platform.workflow_definition (tenant_id, id)
);
SELECT platform.enable_tenant_rls('platform.workflow_version');
CREATE UNIQUE INDEX workflow_version_one_draft ON platform.workflow_version (tenant_id, definition_id)
  WHERE status = 'draft';
CREATE UNIQUE INDEX workflow_version_one_published ON platform.workflow_version (tenant_id, definition_id)
  WHERE status = 'published';

-- Published and superseded versions must not change.
CREATE FUNCTION platform.workflow_version_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (NEW.flow IS DISTINCT FROM OLD.flow OR NEW.number <> OLD.number) THEN
    RAISE EXCEPTION USING ERRCODE = 'MN001', MESSAGE = 'Published workflow versions are immutable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER workflow_version_immutable BEFORE UPDATE ON platform.workflow_version
  FOR EACH ROW EXECUTE FUNCTION platform.workflow_version_immutable();

CREATE TABLE platform.workflow_instance (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL,
  company_id     uuid NOT NULL,
  plant_id       uuid,
  definition_id  uuid NOT NULL,
  version_id     uuid NOT NULL,
  entity_type    text NOT NULL,
  entity_id      text NOT NULL,
  attributes     jsonb NOT NULL,
  requester_id   uuid NOT NULL,
  status         text NOT NULL CHECK (status IN ('submitted', 'in_progress', 'approved', 'rejected', 'cancelled')),
  current_step   integer,
  outcome_reason text,
  submitted_at   timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer NOT NULL DEFAULT 1 CHECK (version > 0),
  source         text NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  FOREIGN KEY (tenant_id, version_id) REFERENCES platform.workflow_version (tenant_id, id),
  FOREIGN KEY (tenant_id, requester_id) REFERENCES platform.app_user (tenant_id, id)
);
SELECT platform.enable_tenant_rls('platform.workflow_instance');
-- One open approval per document.
CREATE UNIQUE INDEX workflow_instance_one_open ON platform.workflow_instance (tenant_id, entity_type, entity_id)
  WHERE status IN ('submitted', 'in_progress');

CREATE TABLE platform.approval_task (
  id                   uuid PRIMARY KEY,
  tenant_id            uuid NOT NULL,
  instance_id          uuid NOT NULL,
  step_index           integer NOT NULL CHECK (step_index >= 0),
  step_id              text NOT NULL,
  assignee_id          uuid NOT NULL,
  status               text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'expired')),
  escalation_level     integer NOT NULL DEFAULT 0 CHECK (escalation_level >= 0),
  due_at               timestamptz,
  decided_by           uuid,
  decided_on_behalf_of uuid,
  comment              text CHECK (length(comment) <= 2000),
  decided_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  version              integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, instance_id) REFERENCES platform.workflow_instance (tenant_id, id),
  FOREIGN KEY (tenant_id, assignee_id) REFERENCES platform.app_user (tenant_id, id)
);
SELECT platform.enable_tenant_rls('platform.approval_task');
CREATE INDEX approval_task_assignee_pending ON platform.approval_task (tenant_id, assignee_id) WHERE status = 'pending';
CREATE INDEX approval_task_instance ON platform.approval_task (tenant_id, instance_id, step_index);
-- One live task per person per step and escalation level (idempotent step start).
CREATE UNIQUE INDEX approval_task_unique_assignment
  ON platform.approval_task (tenant_id, instance_id, step_index, escalation_level, assignee_id);

CREATE TABLE platform.delegation (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  from_user_id uuid NOT NULL,
  to_user_id   uuid NOT NULL CHECK (to_user_id <> from_user_id),
  valid_from   date NOT NULL,
  valid_to     date NOT NULL CHECK (valid_to >= valid_from),
  doc_types    text[],
  status       text NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid,
  source       text NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, from_user_id) REFERENCES platform.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, to_user_id) REFERENCES platform.app_user (tenant_id, id)
);
SELECT platform.enable_tenant_rls('platform.delegation');
CREATE INDEX delegation_to_user ON platform.delegation (tenant_id, to_user_id) WHERE status = 'active';
