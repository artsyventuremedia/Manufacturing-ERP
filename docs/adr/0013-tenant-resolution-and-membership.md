# ADR-0013: Tenant resolution and membership

- Status: Accepted (2026-09-25)
- Date: 2026-09-25
- Refines: ADR-0009 §1–2 (how Keycloak Organizations relate to tenancy)

## Context

ADR-0009 made Keycloak Organizations represent tenants. When building authentication (Phase 0 step 0.4), relying on token claims for tenancy raised three problems:

- Keycloak's `organization` claim format has changed between versions.
- One person can belong to several workspaces (a CA firm serving many manufacturers, or an implementation partner).
- A claim-based design ties tenancy to one identity provider, but customers will bring their own (Entra ID, Google).

## Decision

1. **The workspace comes from the request:** the `X-Tenant` header (API clients) or the subdomain `{slug}.{TENANT_BASE_DOMAIN}` (web app). If both are present and disagree, the request is rejected with 400.
2. **The user comes from the token:** a verified OIDC access token (issuer, audience, expiry and signature checked against JWKS) gives the IdP `sub`.
3. **Membership lives in our database:** `platform.app_user (tenant_id, idp_subject)`, read inside the tenant's RLS scope. Unknown workspaces and non-members get the same `403 auth.not_a_member`, so outsiders cannot enumerate workspace slugs.
4. The slug → tenant lookup uses `platform.tenant_directory`, a global, read-only table for the app. It holds only slug, id and status, and a `SECURITY DEFINER` trigger keeps it in sync with `platform.tenant`.
5. Keycloak Organizations remain the mechanism for **per-tenant IdP brokering and home-realm discovery** (enterprise SSO). They are not the source of truth for membership.

## Consequences

- Each request makes two small indexed reads (directory + membership). If profiling shows the need, a short-TTL per-process cache keyed by (slug, sub) can be added, invalidated when a user is disabled.
- Inviting users means creating `app_user` rows (admin UI in step 0.5). No just-in-time provisioning from IdP logins, so an IdP account alone never grants access.
