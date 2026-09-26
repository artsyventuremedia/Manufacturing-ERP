# Plan: Phase 0 step 0.6 (audit log, outbox, events)

Status: done · 2026-09-26 (see docs/STATUS.md) · Implements ADR-0007 and PRD §10/§12 (audit)

## Scope

1. **Audit trail** (`platform.audit_log`, append-only). One row per change: entity, action, before/after JSON, changed fields, actor (type, id, on-behalf-of), source, correlation id, client IP. Written **in the same transaction** as the change through `AuditTrail.record(...)`.
   - **Tamper evidence (opt-in per tenant):** SHA-256 hash chain per tenant (`prev_hash` → `hash`) serialised by a chain-head row, plus a verification endpoint.
   - **Permission denials** by authenticated users are audited as `access_denied`.
   - `GET /v1/platform/audit-log` with `platform.audit.read`, a permission excluded from Viewer.
2. **Transactional outbox** (`platform.outbox`). Writes go through `EventOutbox.append(...)` in the same transaction and are wrapped as CloudEvents 1.0 (tenant, correlation, causation, actor).
   - A dedicated `outbox_relay` database role reads across tenants through its own RLS policy. The app role still sees only its tenant.
3. **Relay** (core-worker): leader-elected with a Postgres advisory lock. It claims batches in order, publishes with key `tenant:aggregate`, marks rows published, and retries with backoff while recording the error. Published rows are pruned after 7 days.
4. **Event bus port** with two adapters:
   - Kafka, via Confluent's official `@confluentinc/kafka-javascript`. Topics: `manuling.<context>.events.v1`.
   - In-memory, for tests and Docker-less development. Selected with `EVENT_BUS=kafka|memory`.
5. **Consumers:** `EventConsumer` handlers run inside the event's tenant context. A `platform.inbox` table deduplicates deliveries, making at-least-once delivery safe. Up to 5 attempts with backoff, then the event goes to `platform.dead_letter`.
6. **Event contracts:** Zod schemas in `modules/platform/src/contracts/events.ts`, exported as JSON Schema to `docs/events/` (CI fails if stale).
7. **Wiring:** every platform write from 0.4 and 0.5 emits audit rows and events (tenant provisioned, company/plant/fiscal year, users, roles, assignments, field policies, SoD rules).
8. **Tests:**
   - Rollback leaves neither audit nor outbox rows; diffs are correct.
   - The hash chain verifies, and tampering is detected.
   - The relay publishes in order, only one leader runs, retries happen, and published rows are marked.
   - Duplicate delivery is processed once; the dead-letter table is used after max attempts.
   - Cross-tenant: the app role cannot read other tenants' audit or outbox rows.

## Not verifiable on this machine

- The Kafka adapter against a real broker (no Docker). CI or the dev stack must exercise it; it is marked in STATUS.
