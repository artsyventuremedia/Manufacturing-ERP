# Plan: Phase 0 step 0.4 (identity and tenancy)

Status: done · 2026-09-25 (see docs/STATUS.md)

## Scope

1. `modules/platform` migration: `tenant`, `company`, `plant`, `fiscal_year`, `app_user`, `idempotency_key`. All tenant-scoped with RLS and composite FKs.
2. **Authentication:** OIDC bearer tokens (Keycloak) verified with `jose` against the issuer's JWKS (issuer, audience, expiry and algorithms checked).
3. **Tenant resolution:** subdomain `{slug}.{TENANT_BASE_DOMAIN}` or the `X-Tenant` header. The slug-to-tenant lookup is a narrow `SECURITY DEFINER` function, because it runs before any tenant context exists.
4. **Membership:** token `sub` → `platform.app_user.idp_subject` inside the resolved tenant (RLS applies). Unknown user → 403, suspended tenant → 403, disabled user → 403. We do not rely on IdP claims for tenancy, so Keycloak Organizations stay an IdP concern (ADR-0009).
5. **Request context:** a global guard authenticates, and a global interceptor runs the handler inside the full `RequestContext` (tenant, actor, locale and time zone from the user or tenant).
6. **APIs:** `GET /v1/platform/me`; companies, plants and fiscal years (list, get, create, update with If-Match). Writes need `is_tenant_admin` until role permissions arrive in 0.5.
7. **Idempotency-Key** on POST: replays the stored response for the same key and body, 422 when a key is reused with a different body, 409 while the first request is in progress. Keys expire after 24 h.
8. **Provisioning CLI** (the basic control plane): creates the tenant, first company, plant, fiscal year and admin user. It also seeds the demo tenant for "Mysuru Precision Components Pvt. Ltd.".
9. Keycloak dev realm export (`infra/keycloak`).
10. **Tests:** unit tests for domain rules, and integration tests covering 401/403 paths, cross-tenant attacks (header swapping, foreign IDs, forged tenant ids), If-Match and idempotency.

## Deferred

- Role-based permissions and company scoping of `companyIds`: step 0.5.
- Audit log rows for these writes: step 0.6.
- Separate control-plane service and cell routing: Phase 4 (ADR-0005). The CLI covers pilots.
