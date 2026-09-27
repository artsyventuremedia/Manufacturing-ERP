# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Brief v2 architecture deliverables (awaiting approval): `docs/BRIEF-v2.md` (the brief as received) and `docs/architecture/05–13`:
  - gap analysis and deliverables index;
  - product layers, module map, dependency graph, editions and reconciled roadmap;
  - AI, security, and data and API architecture;
  - role matrix and process maps;
  - UI information architecture;
  - testing strategy;
  - risks, bottlenecks and conflicts.
- Open questions Q21–Q23.

- Phase 0 step 0.9 (custom fields and objects):
  - Platform migration `0005_customisation`; custom field definitions (13 types), custom objects and records, UI layouts.
  - `ext` on companies and plants (validated, merged, filterable with `ext.<field>` / `ext.<field>[gte]`); field policies can target `ext.<field>`.
  - APIs: `/v1/platform/custom-fields`, `/v1/platform/custom-objects`, `/v1/platform/custom-objects/{apiName}/records` (+ `export.csv`), `/v1/platform/layouts/{entity}/{kind}`.
  - Permissions `platform.customization.manage`, `platform.custom_record.read|write`; `Custom*` events.

- Phase 0 step 0.8 (workflow and approvals, ADR-0015):
  - Platform migration `0004_approvals`; approval DSL, Temporal workflow `approvalWorkflow` and activities; `ApprovalOrchestrator` consumer (outbox → Temporal).
  - `APPROVAL_PORT` (`submit`, `cancel`) for modules; outcome event `platform.ApprovalCompleted.v1`.
  - APIs: workflow drafts, validate (dry run), publish; approval inbox, approve/reject, instance timeline, cancel; delegations.
  - core-worker hosts the Temporal worker (`TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`).

- Local container runtime without admin rights (Colima + Docker CLI + Compose, GitHub CLI, Temporal CLI in `~/.local/bin`); full dev stack verified end to end.
- Kafka adapter: optional topic auto-creation (`KAFKA_AUTO_CREATE_TOPICS`, `KAFKA_TOPIC_PARTITIONS`, `KAFKA_REPLICATION_FACTOR`); real-broker test (`KAFKA_TEST_BROKERS`) running in CI with a Kafka service container.

- Phase 0 step 0.7 (numbering series):
  - Platform migration `0003_numbering` (`numbering_series`, `numbering_counter`).
  - `NumberingPort` (`@manuling/platform/contracts`) for issuing document numbers in-process.
  - `GET|POST /v1/platform/companies/{companyId}/numbering-series`, `PATCH /v1/platform/numbering-series/{id}`, `POST /v1/platform/numbering-series/{id}/preview` (`platform.numbering.read|manage`).
  - `UnitOfWork.runIndependent` with a dedicated `independentPool` (prevents pool starvation from nested independent transactions).
  - Events `platform.NumberingSeriesCreated.v1` / `platform.NumberingSeriesChanged.v1`.

- Phase 0 step 0.6 (audit, outbox, events; ADR-0007):
  - Foundation migration `0002_audit_outbox`: `audit_log` (append-only, optional hash chain), `outbox` (+ `outbox_relay` role), `inbox`, `dead_letter`.
  - `AuditTrail` (`@manuling/db`) and new `@manuling/events` package: CloudEvents envelope, `EventOutbox`, `OutboxRelay`, Kafka and in-memory buses, `ConsumerRunner`.
  - Every platform write records an audit row and a `platform.*` event in the same transaction; permission denials are audited.
  - `GET /v1/platform/audit-log`, `POST /v1/platform/audit-log/chain`, `GET /v1/platform/audit-log/chain/verification` (`platform.audit.read` / `platform.audit.manage`; Viewer excluded).
  - core-worker now runs the outbox relay and event consumers (`EVENT_BUS`, `KAFKA_BROKERS`, `DATABASE_RELAY_URL`); migrate grants `RELAY_DB_USER`.
  - Event contracts exported as JSON Schema to `docs/events/` (`pnpm --filter @manuling/core events:schemas`, checked in CI).

- Architecture baseline: system architecture, context map, Phase 0–1 ERD, monorepo plan (`docs/architecture`).
- ADRs 0001–0011 (`docs/adr`).
- PRD (`docs/PRD.md`), status tracker, open questions.
- ADR-0012: Tally strategy (migration + one-way export bridge).

### Changed

- Dev Temporal pinned to `temporalio/temporal:1.9.1` with a health check; fixed its SQLite volume permissions.
- `provision-tenant` / `seed:demo` accept pnpm's forwarded `--` separator.

- `is_tenant_admin` replaced by the built-in Owner role (column dropped pre-release); writes now require permissions.
- Embedded Postgres test helper time-boxes startup and retries on a fresh port.

- ADRs 0002–0012 accepted. ADR-0003 updated: Node 24 LTS, NestJS 12 on Fastify, TypeScript pinned to 5.9, embedded-postgres for integration tests.
- Idempotency-Key handling moved from step 0.3 to 0.4 (needs tenant context).

- Product named **Manuling**. Package scope `@manuling/*`.
- First pilot deployment set to SaaS.
- ADR-0011: GST Compliance Gateway with capability ports; IRIS IRP is the first e-invoice adapter.
