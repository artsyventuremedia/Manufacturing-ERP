# CLAUDE.md

**Manuling**: AI-native manufacturing ERP by Artsy Technologies Pvt. Ltd. Code scope `@manuling/*`. First pilot runs on SaaS (India region).

## Source of truth

- Requirements: [docs/PRD.md](docs/PRD.md). Follow §16 engineering rules at all times.
- Architecture: [docs/architecture/](docs/architecture/README.md) · Decisions: [docs/adr/](docs/adr/README.md)
- Progress: [docs/STATUS.md](docs/STATUS.md) · Open questions: [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md)

## Current phase

Phase 0 (Foundation). Steps 0.1–0.7 are done. Next is 0.8 Workflow/approval engine (Temporal). See docs/STATUS.md.

## Commands

- `pnpm install` → `pnpm lint` · `pnpm typecheck` · `pnpm build` · `pnpm test` · `pnpm test:integration` (real Postgres via embedded binaries, no Docker)
- `pnpm dev:stack` (Docker) → `pnpm --filter @manuling/core migrate` → `pnpm --filter @manuling/core dev`
- `pnpm --filter @manuling/core seed:demo -- --admin-sub <keycloak-id>` seeds the demo workspace (see infra/keycloak/README.md)
- `pnpm --filter @manuling/core openapi` regenerates `docs/api/openapi.json`; `... events:schemas` regenerates `docs/events/` (CI fails if either is stale)

## Gotchas

- Workspace packages resolve to `src/` through the `@manuling/source` export condition. Tests and dev run without a build.
- Zod schemas that appear in OpenAPI must import `z` from `@manuling/http` (it applies the OpenAPI extension first).
- Record every write with the module's change log (audit row + outbox event, same transaction). Event payloads are defined in `contracts/events.ts` and validated before append; `.v1` changes must be additive.
- Document numbers come only from `NUMBERING_PORT.next(...)`, called inside the document's UnitOfWork (gapless series roll back with it). Never generate numbers in module code.
- `uow.runIndependent` commits separately and uses its own pool; use only for effects that must survive the caller's rollback.
- Long local test runs: keep the Mac awake (`caffeinate -i pnpm test:integration`); sleep suspends embedded Postgres and looks like a hang.
- The outbox relay uses its own DB login (member of `outbox_relay`, sees all tenants). Never give that login to the API.
- NestJS DI classes must be value imports (ESLint type-import rule is off in `apps/core` and `packages/http`).
- Every route must be `@Public()`, `@AnyMember()` or `@RequirePermission('module.entity.action')`, or the app refuses to boot (ADR-0014). Register new permissions with `permissionRegistry.register` in the module's `authorisation/permissions.ts`; check resource scope in use cases with `AccessControl.assert(...)`.
- Every route is authenticated unless marked `@Public()`. Tenant = `X-Tenant` header or subdomain; membership = `platform.app_user` (ADR-0013).
- Global interceptor order matters: RequestContextInterceptor → AccessDenialInterceptor → IdempotencyInterceptor (all registered by PlatformModule).
- Drizzle wraps pg errors (`cause`). Always map through `mapDatabaseError` (UnitOfWork already does).

## Non-negotiables (summary; details in ADRs)

- Modular monolith: modules import each other only via `@manuling/<module>/contracts` (ADR-0002). Domain code may import only `@manuling/kernel` and `@manuling/authz/core`.
- Every tenant table: `tenant_id`, RLS forced, composite `(tenant_id, id)` FKs. All DB access goes through `UnitOfWork` (ADR-0004, ADR-0005).
- Ledgers are INSERT-only. Corrections are reversals. Stock + GL post in one transaction (ADR-0006).
- State changes emit events via the outbox in the same transaction. Consumers are idempotent (ADR-0007).
- Money/qty: Decimal value objects, `NUMERIC` in the DB, strings in JSON. Never `number` (ADR-0008).
- Every endpoint declares `@RequirePermission`. Every UI string is an i18n key (en, kn, hi).
- Tax/statutory logic lives only in `localisation/*` packs (ADR-0011).
- Update `docs/STATUS.md` and `CHANGELOG.md` after each step. Record new significant decisions as ADRs.
- Demo company for seeds: "Mysuru Precision Components Pvt. Ltd."
