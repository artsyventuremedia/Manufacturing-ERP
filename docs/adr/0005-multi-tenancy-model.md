# ADR-0005: Multi-tenancy — pooled RLS cells + dedicated cells

- Status: Accepted (2026-09-25)
- Date: 2026-09-24

## Context

Starter customers need very low cost per tenant. Enterprise and regulated customers need isolation, their own backup schedules, data residency and sometimes on-prem. PRD §8 prescribes shared DB + RLS for SMB and dedicated DB or deployment for enterprise, all from one codebase.

## Decision

1. **Cell architecture.** A _cell_ is one full deployment of the stack (Helm chart) with its own Postgres, Kafka and Temporal.
   - **Pooled cells** host many tenants (target ≤ 2,000 SMB tenants per cell, tuned by load tests).
   - **Dedicated cells** host one tenant: SaaS-dedicated, private cloud or on-prem.
   - The same code and schema run in both. A dedicated cell is simply a pool of one.
2. **Control plane** (separate DB) holds the tenant registry (`tenant → cell, region, edition`), provisioning, licensing and metering. An edge router resolves `{tenant}.domain` (or a custom domain) to a cell.
3. **Within a cell: shared schema, `tenant_id` column + PostgreSQL row-level security.**
   - The app connects as role `app_rw`, which has no `BYPASSRLS` and does not own the tables.
   - Every tenant table gets `ENABLE` + `FORCE ROW LEVEL SECURITY` with the policy `tenant_id = current_setting('app.tenant_id')::uuid`, for both `USING` and `WITH CHECK`.
   - `app.tenant_id` is set with `SET LOCAL` inside each transaction (ADR-0004). Connection pooling in transaction mode (PgBouncer) is safe because the setting is transaction-scoped.
   - Composite `(tenant_id, id)` unique keys and composite FKs make cross-tenant references impossible even for code bugs that run with the right session.
   - Migrations and platform jobs use a separate `app_admin` role, and it is audited.
4. **Company/plant scoping** is authorisation (ADR-0009), not tenancy. It is enforced in the application policy layer, with optional RLS on `company_id` for tenants that require legal-entity isolation.
5. **Tenant mobility:** tools to export one tenant from a pooled cell (logical dump filtered by tenant_id, plus object-store prefix and event replay) and import it into a dedicated cell. This supports upsell to Enterprise with no data re-entry.
6. **Noisy neighbours:** per-tenant rate limits (Redis), statement timeouts, Temporal task-queue fairness keyed by tenant, and a per-tenant resource-usage dashboard. Heavy jobs (MRP, APS) run in worker pools with per-tenant concurrency caps.
7. **Isolation testing:** a CI suite creates two tenants and, for **every** table and endpoint, attempts cross-tenant read, write and FK references. It must fail closed.
8. **Object storage** keys are prefixed with `tenants/{tenant_id}/`, with IAM policies per cell. Kafka messages carry `tenantid` and are partitioned by tenant + aggregate.

## Consequences

- Low marginal cost for SMB, with isolation defended in depth (app + DB).
- Every query pays a small RLS overhead. Indexes lead with `tenant_id`.
- Cross-tenant analytics for the vendor (benchmarks) must use an anonymised pipeline, never direct queries.

## Alternatives considered

- **Schema per tenant**: migration fan-out gets painful at thousands of tenants, and catalogue bloat.
- **Database per tenant for everyone**: too costly for SMB. It remains available as a dedicated cell.
