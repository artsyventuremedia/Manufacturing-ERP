# 11 — Data and API Architecture

Status: **Draft for approval** · 2026-09-27 · Answers brief v2 deliverables 5 and 6 (and §53, §59, §60, §65, §86–§88) · Builds on ADR-0004 (data access), ADR-0005 (tenancy), ADR-0006 (ledgers), ADR-0007 (events), ADR-0008 (money, ids), [03](03-erd-phase0-1.md) (ERD)

---

## 1. Data stores and workload separation (brief §60)

| Store                              | Holds                                                                      | Workload                                                                | State                                       |
| ---------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------- |
| PostgreSQL (OLTP)                  | All transactional truth: masters, documents, ledgers, audit, outbox        | Short transactions under RLS; the app never runs analytics queries here | ☑                                           |
| Postgres read replica → ClickHouse | Analytics read models built from events (CDC/outbox)                       | Dashboards, reports, KPIs, ML training                                  | P1 replica, ClickHouse when volume needs it |
| TimescaleDB (separate cluster)     | Machine telemetry                                                          | High-rate inserts, time-bucket queries, retention policies              | P3                                          |
| Valkey                             | Cache (tenant-prefixed keys), rate-limit buckets, short-lived locks        | Never the source of truth                                               | 0.14/0.15                                   |
| Search                             | Postgres FTS + pg_trgm behind `SearchPort`; OpenSearch when scale needs it | Global search, typeahead                                                | P1                                          |
| pgvector                           | Embeddings per tenant                                                      | RAG ([07](07-ai-architecture.md))                                       | P1                                          |
| S3-compatible object storage       | Documents, attachments, exports, backups; keys prefixed by tenant          | Streamed upload/download with signed URLs                               | 0.13                                        |
| Kafka                              | Domain events (CloudEvents), 7+ days retention                             | Feeds consumers and analytics sinks                                     | ☑                                           |
| Temporal                           | Workflow state (approvals ☑, notifications, MRP runs, imports)             | Durable timers, retries, long-running processes                         | ☑                                           |

**Lakehouse strategy:** not before Phase 4. Events plus ClickHouse cover BI; a lakehouse (Iceberg on object storage) is added only when enterprise tenants need cross-system analytics. Recorded here so that no module designs around one earlier.

## 2. Database design rules (brief §86)

Already enforced in migrations (see [03](03-erd-phase0-1.md) §0):

- `id uuid` (UUIDv7), `tenant_id` on every tenant table with RLS, composite `(tenant_id, id)` foreign keys.
- `created_at`, `created_by`, `updated_at`, `updated_by`, `version` (optimistic concurrency), `source` (ui, api, import, agent, system) on editable tables. **Append-only tables (ledgers, audit, outbox) have no `updated_*` columns**: they are never updated, and a trigger rejects updates and deletes.
- Money and quantities are `NUMERIC` with scale per currency and UoM; never floats (ADR-0008).
- **No hard deletes of business data.** Masters use `status` (active/inactive/archived); documents use their state machine (cancelled/reversed). Soft-delete flags are not used, because they leak into every query; the lifecycle state carries the meaning.
- History: the audit log keeps before/after values of every change; versioned masters (BOM, routing, item revision, workflow version ☑) are immutable once released.
- Enums are `text` with `CHECK` constraints (adding a value is a cheap migration; Postgres enums are not).
- Index policy: every foreign key, every list filter and sort key; GIN indexes for `ext`/`data` JSON; partial indexes for "open" states.
- Partitioning: ledgers and audit by tenant hash and time (`pg_partman`) when a table passes ~100 M rows.

## 3. Backup and disaster recovery (brief §65)

| Target             | Value                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| RPO                | 15 minutes (continuous WAL archiving; SaaS uses PITR with 35-day retention)                                     |
| RTO                | 4 hours for a full region loss; 1 hour for single-database restore                                              |
| Backups            | Encrypted (KMS), copied to a second region (India-to-India for residency), immutable retention                  |
| Restore testing    | Monthly automated restore into an isolated environment, with checksums and a smoke test suite; results recorded |
| Per-tenant restore | Logical export per tenant (for dedicated cells, a database restore)                                             |

Implemented as part of 0.14/0.15 (runbooks) and the infrastructure-as-code in Phase 1.

## 4. API architecture (brief §53, §87, §88)

### Conventions (built ☑ in `@manuling/http`)

| Concern               | Convention                                                                                                                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Style                 | REST, resource-oriented, `/v1/<context>/<resources>`; OpenAPI 3.1 generated from Zod, checked in CI (`docs/api/openapi.json`)                                                                            |
| Validation            | Zod on body, params and query; unknown properties rejected (`strict`)                                                                                                                                    |
| Errors                | RFC 9457 problem details: `type`, `title`, `status`, `code` (stable, e.g. `platform.workflow.invalid`), `detail`, `errors[]` with JSON paths, `correlationId`, `timestamp`. No stack traces or internals |
| Auth                  | Bearer JWT (OIDC); tenant from `X-Tenant` or subdomain; every route declares its access rule                                                                                                             |
| Pagination            | Keyset cursors (`limit`, `cursor`, `nextCursor`), max 200                                                                                                                                                |
| Filtering and sorting | Typed query params per resource; custom fields as `ext.<field>` and `ext.<field>[gte]` ☑                                                                                                                 |
| Concurrency           | `ETag` + `If-Match` on updates; 412 on mismatch                                                                                                                                                          |
| Idempotency           | `Idempotency-Key` on POST (24 h), replayed responses ☑                                                                                                                                                   |
| Money                 | Decimal strings with currency (ADR-0008)                                                                                                                                                                 |
| Versioning            | Additive changes within v1; breaking changes → v2 path with a deprecation window of 12 months                                                                                                            |
| Localisation          | `Accept-Language` for messages; data values are never translated                                                                                                                                         |

### Additions planned

| Capability                            | Design                                                                                                                                                                                                        | When                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| API keys and OAuth client credentials | Keycloak service accounts for OAuth; hashed, scoped, expiring API keys mapped to a service principal with a role                                                                                              | P1                      |
| Webhooks                              | Tenants subscribe to event types; deliveries are signed (HMAC-SHA256, timestamped), retried by Temporal with backoff, with a delivery log and replay (the same pattern as notification deliveries, step 0.10) | P1                      |
| WebSocket / SSE                       | SSE for notifications and live dashboards first (simpler, proxy-friendly); WebSocket for shop-floor terminals if needed                                                                                       | 0.12 / P3               |
| Event API                             | Outbound event stream per tenant (webhooks now; Kafka topics for enterprise dedicated cells)                                                                                                                  | P1 / P4                 |
| Rate limits                           | Token bucket per tenant, user and key, with edition-based quotas; `RateLimit-*` headers; 429 problem                                                                                                          | 0.15                    |
| Developer portal                      | Rendered OpenAPI plus event catalogue (`docs/events/*.json`), SDK generation (TypeScript first), sandbox tenants                                                                                              | P1 (docs) / P4 (portal) |
| Bulk                                  | Asynchronous import jobs (Temporal) with preview, validation report and rollback                                                                                                                              | P1                      |

## 5. Performance and SLOs (brief §59)

| SLO                               | Target                               | Measured by                                                             |
| --------------------------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| API reads/writes p95              | < 300 ms (standard), < 1 s (reports) | OpenTelemetry histograms per route                                      |
| Availability                      | 99.9% monthly (SaaS)                 | Synthetic probes + error budget                                         |
| Event latency (commit → consumer) | p95 < 2 s                            | Outbox relay and consumer lag metrics (0.5 s measured on the dev stack) |
| Screen interactive                | < 2 s on 4G                          | Web vitals from real users                                              |
| MRP net change                    | 50,000 items, 1,000 orders < 5 min   | Benchmark in CI (nightly)                                               |

**Load tests (k6):** 100 and 1,000 concurrent users per tenant in CI (nightly); 10,000 per cell before GA; **100,000+ is a platform figure across cells**, reached by adding cells (ADR-0005) rather than one bigger database. We will not claim a single-cell 100,000-user number that has not been measured.
