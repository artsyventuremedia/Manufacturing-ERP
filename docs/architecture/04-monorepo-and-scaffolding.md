# 04 — Monorepo Structure and Scaffolding Plan

Status: **Draft for approval** · Last updated: 2026-09-24

Tooling: **pnpm workspaces + Turborepo** for TypeScript and **uv** for Python, orchestrated from the root via Turborepo tasks. Nx was considered: its module-boundary enforcement is stronger, but Turborepo is simpler, and `dependency-cruiser` plus ESLint boundary rules close the gap (ADR-0003).

---

## 1. Folder structure

```text
/
├── CLAUDE.md                      # Builder instructions (points to docs/PRD.md)
├── CHANGELOG.md
├── package.json · pnpm-workspace.yaml · turbo.json · tsconfig.base.json
├── .github/workflows/             # ci.yml, security.yml, release.yml, isolation-tests.yml
├── .devcontainer/                 # One-command dev environment
│
├── apps/
│   ├── core/                      # NestJS modular-monolith host (one image, two entrypoints)
│   │   ├── src/main.api.ts        #   → core-api (HTTP)
│   │   ├── src/main.worker.ts     #   → core-worker (Temporal workers, outbox relay, consumers)
│   │   └── src/app.module.ts      #   wires modules/* together; no business logic here
│   ├── web/                       # Next.js: office app, portals, command palette, copilot panel
│   ├── mobile/                    # Expo: stores and approvals (P1), operator/technician (P3)
│   ├── control-plane/             # Tenant registry, provisioning, licensing, cell router (NestJS)
│   ├── installer/                 # On-prem installer CLI (preflight, secrets, upgrade, backup)
│   └── edge-agent/                # Phase 3 (language chosen by ADR then)
│
├── modules/                       # Bounded contexts. Each one is a pnpm package
│   ├── platform/                  # tenancy, iam, audit, numbering, workflow, custom-fields,
│   │                              # notifications, documents, entitlements (sub-folders)
│   ├── masterdata/
│   ├── finance/
│   ├── sales/
│   ├── procurement/
│   ├── inventory/
│   ├── engineering/
│   ├── production/
│   ├── analytics/
│   ├── ai/                        # Copilot tool registry, action log (TS side)
│   ├── integration/               # Excel/Tally import, webhooks, connector framework
│   └── …                          # planning, quality, maintenance, costing, hr (later phases)
│
├── localisation/
│   ├── core/                      # Country-pack SPI (interfaces only)
│   └── in/                        # India pack: GST, e-invoice (IRP), EWB, TDS/TCS, ITC-04, 43B(h)
│
├── services/                      # Python (uv workspaces)
│   ├── ai-gateway/                # FastAPI: provider routing, redaction, metering, prompt logs
│   ├── agent-runtime/             # FastAPI: copilot and agents (tool calls → core-api)
│   ├── ml/                        # Forecasting, anomaly detection (P2+)
│   └── optimizer/                 # OR-Tools APS (P3)
│
├── packages/                      # Shared, domain-agnostic libraries
│   ├── kernel/                    # Money, Quantity, Uuid7, DomainError hierarchy, RequestContext,
│   │                              # AggregateRoot, DomainEvent, Clock. ZERO framework deps
│   ├── db/                        # Drizzle setup, tx helper (SET LOCAL tenant), RLS policy
│   │                              # generator, migration runner, ledger guards, test fixtures
│   ├── events/                    # Outbox writer, relay, Kafka client, inbox/idempotency, CloudEvents
│   ├── workflow/                  # Temporal client/worker bootstrap, approval DSL interpreter
│   ├── authz/                     # Permission registry, policy evaluator, @RequirePermission, SoD
│   ├── http/                      # NestJS: problem+json filter, ETag/If-Match, idempotency, pagination
│   ├── contracts/                 # OpenAPI 3.1 specs + event JSON Schemas (source of truth)
│   ├── sdk-ts/                    # Generated API client (from contracts) used by web/mobile/agents
│   ├── ui/                        # Design system: tokens, shadcn/ui-based components, shop-floor kit
│   ├── i18n/                      # Locale bundles (en, kn, hi, …), ICU helpers, Indian number format
│   ├── observability/             # OTel setup, logger (pino), tenant-aware context propagation
│   ├── testing/                   # Testcontainers helpers, factories, tenant-isolation harness
│   ├── eslint-config/ · tsconfig/
│
├── templates/                     # Industry templates (data, not code): CoA, masters, workflows,
│   ├── _base-in/                  # print formats, dashboards
│   ├── auto-components/
│   └── fabrication/ …
│
├── seed/
│   └── mysuru-precision/          # Demo tenant: "Mysuru Precision Components Pvt. Ltd."
│
├── infra/
│   ├── docker/                    # docker-compose.dev.yml (full local stack), Dockerfiles
│   ├── helm/                      # Umbrella chart: core, web, ai, deps (values per edition/cell)
│   ├── terraform/                 # Modules: network, k8s, postgres, kafka, object-store, keycloak
│   ├── keycloak/                  # Realm export, themes (branded + Kannada/Hindi login)
│   └── argocd/
│
├── tools/
│   ├── generators/                # `pnpm gen module <name>`, `pnpm gen entity`, `pnpm gen event`
│   └── scripts/
│
└── docs/
    ├── PRD.md · STATUS.md · OPEN-QUESTIONS.md
    ├── architecture/              # This folder
    ├── adr/
    ├── api/                       # Rendered OpenAPI docs
    ├── runbooks/
    └── user/ · dev/               # User and developer guides per module
```

### Internal layout of every module (hexagonal)

```text
modules/inventory/
├── package.json                   # name: @manuling/inventory · exports only "./contracts" and "./module"
├── src/
│   ├── contracts/                 # PUBLIC: facade interfaces, DTOs, event types, posting ports
│   │   ├── inventory.facade.ts    #   e.g. InventoryPostingPort, StockQueryPort
│   │   └── events.ts
│   ├── domain/                    # Aggregates, value objects, domain services, domain events
│   │                              # (pure TS, no Nest or DB imports)
│   ├── application/               # Command/query handlers, use cases, permission declarations
│   ├── infrastructure/            # Drizzle schema + repositories, Kafka consumers, adapters
│   ├── api/                       # REST controllers (thin), request/response mappers
│   ├── workflows/                 # Temporal workflows/activities owned by this module
│   └── inventory.module.ts        # Nest module
├── migrations/                    # SQL migrations for schema "inventory" (expand/contract)
└── test/
    ├── unit/                      # domain + application (≥80% coverage gate)
    ├── integration/               # Testcontainers Postgres/Kafka
    └── contract/                  # OpenAPI conformance
```

### Enforced boundaries (CI fails on violation)

1. `modules/X` may import from `modules/Y` **only** through `@manuling/y/contracts`.
2. `domain/` may import only `@manuling/kernel`.
3. `packages/*` may never import `modules/*`.
4. Only `modules/X/infrastructure` may touch schema `X`. A SQL lint plus the Postgres grant model (one DB role per module schema in dedicated deployments) enforce this.
5. Every controller method has `@RequirePermission(...)`. An AST lint rule enforces it.
6. Every user-facing string is an i18n key. Lint forbids string literals in JSX.
7. Floating-point arithmetic is forbidden in `domain/` for `Money`/`Quantity` types. A lint rule bans `number` in fields named `*amount|*qty|*price|*rate`.

---

## 2. Scaffolding plan (Phase 0, after approval)

Each step ends with a green CI and a `STATUS.md` update.

| Step                                 | Deliverable                                                                                                                                                                                                                               | Exit criteria                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **0.1 Repo bootstrap**               | pnpm + Turborepo, TS base configs, ESLint/Prettier, commit hooks (lefthook + commitlint), `.devcontainer`, `docker-compose.dev.yml` (Postgres 16 with pgvector, Kafka KRaft, Temporal, Keycloak, Redis, object store, OTel/Grafana stack) | `pnpm dev` brings up the whole stack. CI runs lint + typecheck + test                                |
| **0.2 Kernel + DB foundation**       | `@manuling/kernel` (Money, Quantity, Uuid7, errors), `@manuling/db` (tx wrapper with `SET LOCAL`, RLS policy helper, migration runner, ledger INSERT-only guard)                                                                          | Unit tests for Money/Quantity rounding. RLS integration tests pass                                   |
| **0.3 Core host + HTTP conventions** | `apps/core` with API/worker entrypoints, `@manuling/http` (problem+json, ETag/If-Match, pagination, request context), health/readiness, OpenAPI generation. Idempotency keys moved to 0.4 because they need tenant context                | Contract test harness running                                                                        |
| **0.4 Identity + tenancy**           | Keycloak realm + Organizations, JWT validation, tenant/actor resolution into RequestContext, `Idempotency-Key` store, tenant/company/plant/fiscal-year CRUD, control-plane tenant provisioning (basic)                                    | Login via web shell. Tenant isolation suite (cross-tenant attack tests) green                        |
| **0.5 Authorisation**                | Permission registry, roles, scoped user roles, ABAC conditions, field policies, SoD rules, admin UI                                                                                                                                       | Every endpoint guarded (lint). SoD conflict test                                                     |
| **0.6 Audit + outbox + events**      | audit_log with hash chain option, outbox relay, Kafka publishing, inbox idempotency, event schema registry in `contracts`                                                                                                                 | Event published within 1 s of commit (p95). Duplicate delivery test                                  |
| **0.7 Numbering series**             | Configurable patterns, per company/plant/FY, gapless mode with row-level locking                                                                                                                                                          | Concurrency test: 1,000 parallel invoices with no gaps or duplicates                                 |
| **0.8 Workflow/approval engine**     | Temporal setup, approval DSL (sequential/parallel, conditions, amount thresholds, SLA, escalation, delegation), approval inbox API + UI                                                                                                   | E2E test: PO over threshold escalates after SLA                                                      |
| **0.9 Custom fields & objects**      | Metadata tables, `ext` validation, custom object CRUD, form/list layout metadata                                                                                                                                                          | A custom field shows up in API, UI list, filter and export                                           |
| **0.10 Notifications**               | Channel abstraction (in-app, email, SMS, WhatsApp, push), templates with i18n, user preferences                                                                                                                                           | Approval notification over email + in-app (WhatsApp stubbed with tracked TODO until a BSP is chosen) |
| **0.11 Entitlements & flags**        | Edition/module entitlements from the control plane, guards (API, UI slots, jobs), OpenFeature flags, usage meters                                                                                                                         | A Starter tenant gets 403 + upsell on MRP endpoints                                                  |
| **0.12 Design system + app shell**   | `@manuling/ui` tokens (light/dark, high-contrast shop-floor), shell layout, navigation, command palette, saved views, data grid wrapper, form engine (metadata-driven), i18n en/kn/hi                                                     | WCAG 2.2 AA checks (axe) in CI. Kannada rendering verified                                           |
| **0.13 Documents (DMS core)**        | Upload/versioning to object store, links to any record, virus scan hook, presigned URLs                                                                                                                                                   | Attachment on any entity                                                                             |
| **0.14 Observability & ops**         | OTel everywhere, dashboards, Sentry, structured logs with tenant id, Helm chart v0, Argo CD dev env                                                                                                                                       | Trace from browser click → DB → Kafka consumer visible in Grafana                                    |
| **0.15 Phase 0 hardening**           | Load test baseline (k6), security scan pipeline (Semgrep, Trivy, OSV), ADR updates, docs                                                                                                                                                  | Section 13 p95 targets met on the Phase 0 endpoints                                                  |

The first commits after approval will be steps 0.1–0.3. I'll show the plan for each subsequent step before building it.
