-- Audit trail, transactional outbox, consumer inbox and dead letters (ADR-0007, PRD §10/§12).

-- ---------------------------------------------------------------------------
-- Audit log: one append-only row per change, written in the changing transaction.
-- Optional per-tenant SHA-256 hash chain (tamper evidence for regulated tenants): a tenant
-- has a chain when a row exists in audit_chain_head.
-- ---------------------------------------------------------------------------
CREATE TABLE platform.audit_log (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL,
  occurred_at    timestamptz NOT NULL,
  entity_type    text NOT NULL CHECK (entity_type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  entity_id      text NOT NULL,
  action         text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]{1,39}$'),
  before         jsonb,
  after          jsonb,
  changed_fields text[] NOT NULL DEFAULT '{}',
  actor_type     text NOT NULL CHECK (actor_type IN ('user', 'agent', 'system', 'integration')),
  actor_id       text NOT NULL,
  on_behalf_of   text,
  source         text NOT NULL,
  correlation_id text NOT NULL,
  client_ip      text,
  chain_seq      bigint,
  prev_hash      text,
  hash           text,
  UNIQUE (tenant_id, chain_seq)
);
SELECT platform.enable_tenant_rls('platform.audit_log');
SELECT platform.make_append_only('platform.audit_log');
CREATE INDEX audit_log_entity_idx ON platform.audit_log (tenant_id, entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_log_time_idx ON platform.audit_log (tenant_id, occurred_at DESC, id DESC);

CREATE TABLE platform.audit_chain_head (
  tenant_id uuid PRIMARY KEY,
  last_seq  bigint NOT NULL DEFAULT 0,
  last_hash text NOT NULL DEFAULT ''
);
SELECT platform.enable_tenant_rls('platform.audit_chain_head');

-- ---------------------------------------------------------------------------
-- Outbox: domain events inserted in the same transaction as the state change.
-- The application can only insert and read its own tenant's rows; the relay role
-- reads and marks rows of all tenants through an additional policy.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'outbox_relay') THEN
    CREATE ROLE outbox_relay NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;
GRANT USAGE ON SCHEMA platform TO outbox_relay;

CREATE TABLE platform.outbox (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  position        bigint GENERATED ALWAYS AS IDENTITY,
  topic           text NOT NULL,
  event_type      text NOT NULL,
  aggregate_type  text NOT NULL,
  aggregate_id    text NOT NULL,
  partition_key   text NOT NULL,
  envelope        jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz,
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text
);
SELECT platform.enable_tenant_rls('platform.outbox');
REVOKE UPDATE ON platform.outbox FROM app_rw;
CREATE POLICY relay_all_tenants ON platform.outbox FOR ALL TO outbox_relay USING (true) WITH CHECK (true);
GRANT SELECT, UPDATE, DELETE ON platform.outbox TO outbox_relay;
CREATE INDEX outbox_pending_idx ON platform.outbox (position) WHERE published_at IS NULL;
CREATE INDEX outbox_published_idx ON platform.outbox (published_at) WHERE published_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Inbox: per-consumer record of processed event ids (at-least-once → exactly-once effect).
-- ---------------------------------------------------------------------------
CREATE TABLE platform.inbox (
  tenant_id    uuid NOT NULL,
  consumer     text NOT NULL CHECK (consumer ~ '^[a-z][a-z0-9_.-]{1,99}$'),
  event_id     uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, consumer, event_id)
);
SELECT platform.enable_tenant_rls('platform.inbox');
GRANT DELETE ON platform.inbox TO app_rw;

-- ---------------------------------------------------------------------------
-- Dead letters: events a consumer could not process after its retries.
-- ---------------------------------------------------------------------------
CREATE TABLE platform.dead_letter (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL,
  consumer   text NOT NULL,
  event_id   uuid NOT NULL,
  event_type text NOT NULL,
  envelope   jsonb NOT NULL,
  error      text NOT NULL,
  attempts   integer NOT NULL,
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'replayed', 'discarded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, consumer, event_id)
);
SELECT platform.enable_tenant_rls('platform.dead_letter');
