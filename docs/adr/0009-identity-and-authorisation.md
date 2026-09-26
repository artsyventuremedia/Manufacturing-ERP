# ADR-0009: Identity (Keycloak) and in-app authorisation

- Status: Accepted (2026-09-25)
- Date: 2026-09-24

## Context

We need SSO (OIDC/SAML), MFA, per-tenant enterprise IdPs, portal users (customers and suppliers), device logins for shop-floor kiosks, and agent identities acting on behalf of users. Authorisation needs RBAC + ABAC + field-level security + segregation of duties (PRD §5.1, §12), all tenant-configurable.

## Decision

### Authentication — Keycloak

1. **One realm per cell**, with **Keycloak Organizations** representing tenants. Realm-per-tenant is rejected because it degrades beyond a few hundred realms.
2. Enterprise tenants get **IdP brokering** (Azure AD / Entra, Google Workspace, Okta, generic SAML/OIDC) attached to their organisation, with home-realm discovery by email domain.
3. Web uses Authorization Code + PKCE. Mobile uses AppAuth + PKCE with refresh-token rotation. Access tokens last 5 min, and the token carries `sub`, `org` (tenant) and `amr`.
4. **Shop-floor kiosks:** a device registered with a client credential, plus operator login by badge/QR + PIN, which yields a short-lived operator session scoped to that device's plant.
5. **Portal users** are separate user types in the same realm, limited to portal scopes.
6. **Agents:** OAuth 2.0 Token Exchange (RFC 8693) mints a delegated token (`act` claim = agent, `sub` = invoking user) with reduced scopes and a short lifetime. Background agents run under a service identity that a tenant admin has explicitly granted, and they never exceed the configured approval thresholds.
7. MFA policies per tenant (TOTP, WebAuthn/passkeys; SMS OTP as fallback for SMB). IP allow-listing for enterprise at the gateway.

### Authorisation — in-app policy engine (`@manuling/authz`)

8. **Permissions** are code-declared strings (`{module}.{entity}.{action}`), each linked to an entitlement `feature_key`.
9. **Roles** bundle permissions. System roles are shipped with templates. Tenants can clone and edit them.
10. **Scoped assignments:** user × role × (company?, plant?, warehouse?) with validity dates.
11. **ABAC conditions** on assignments or policies. Examples: `po.total_base <= 500000`, `record.created_by == user.id`, `record.plant_id in user.plants`. Conditions are evaluated in the application layer. Query-time filters are compiled into SQL `WHERE` clauses so list endpoints never leak rows.
12. **Field-level security:** hidden/read/write per role × entity × field. It is applied in response serialisation and request validation, and the generated UI metadata honours it.
13. **Segregation of duties:** conflict rules between permissions are checked when a role is assigned (warn or block) and at action time. An example is "same user created supplier X and approves payment to X". Violations are logged.
14. Every decision is logged at debug level with its reason. Denials are audited.
15. We will evaluate **Cedar** (AWS, Apache 2.0) as the policy language for tenant-authored ABAC rules in Phase 2, behind the same interface.

## Consequences

- Keycloak handles the security-critical protocols. Business authorisation stays in our domain code, where it is testable and tenant-configurable.
- Keycloak is a JVM service (about 1 GB of RAM). That is acceptable on-prem.

## Alternatives considered

Keycloak Authorization Services (too coarse, and hard to express data-level conditions), OpenFGA/SpiceDB (strong for relationship-based access but adds a service. May revisit for document sharing), Auth0/Clerk (not self-hostable for on-prem, data residency concerns).
