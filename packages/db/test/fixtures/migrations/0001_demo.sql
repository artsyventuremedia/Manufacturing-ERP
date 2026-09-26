-- Test-only schema exercising the foundation helpers.
CREATE SCHEMA demo;
SELECT platform.grant_app_access('demo');

CREATE TABLE demo.widget (
  id        uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  name      text NOT NULL,
  amount    numeric(20,6) NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id)
);
SELECT platform.enable_tenant_rls('demo.widget');

-- Composite FK: a row can only reference a widget of the SAME tenant (ADR-0005 §3).
CREATE TABLE demo.widget_part (
  id        uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  widget_id uuid NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, widget_id) REFERENCES demo.widget (tenant_id, id)
);
SELECT platform.enable_tenant_rls('demo.widget_part');

CREATE TABLE demo.ledger (
  id        uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  qty       numeric(20,6) NOT NULL
);
SELECT platform.enable_tenant_rls('demo.ledger');
SELECT platform.make_append_only('demo.ledger');
