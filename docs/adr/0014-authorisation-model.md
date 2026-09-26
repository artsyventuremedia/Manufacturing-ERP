# ADR-0014: Authorisation model

- Status: Accepted (2026-09-25)
- Date: 2026-09-25
- Implements: ADR-0009 §8–15, with product-owner decisions D1–D3 (docs/plans/phase0-step0.5-authorisation.md)

## Decision

1. **Three access rules, enforced at boot.** Every HTTP route is exactly one of `@Public()`, `@AnyMember()` (any authenticated workspace member, e.g. `/me`) or `@RequirePermission('<module>.<entity>.<action>')`. The application **refuses to start** if a route has none of these or names an unregistered permission (`RouteAccessCheck`). This replaces the lint rule planned in 04-monorepo §1, because a runtime check cannot be bypassed.
2. **Two-level checks.** The guard confirms the caller holds the permission in _some_ scope. Use cases then call `AccessControl.assert(permission, { companyId, plantId, attributes })` for the specific resource. Companies outside the caller's scopes are reported as **404**; visible resources without the permission give **403**.
3. **Grants** are role assignments: user × role × optional company or plant scope × ABAC conditions × validity dates. Scope containment: tenant-wide ⊇ company ⊇ plant. Tenant-level actions (such as creating a company) need a tenant-wide grant.
4. **Conditions are data, not code**: `{attr, op, value}` with eq/ne/lt/lte/gt/gte/in and `own`. Numeric comparisons use Decimal, and a missing attribute fails closed. Cedar remains the upgrade path for richer tenant-authored policies (ADR-0009 §15).
5. **Built-in roles take their permissions from code templates** (`role-templates.ts`), so Owner and Administrator automatically cover new modules and functional roles pick up their module's permissions. They are read-only; tenants clone them into custom roles, whose permissions are stored.
6. **Anti-escalation**: nobody can create, edit, clone or assign a role containing permissions they do not hold in the target scope.
7. **Field-level security**: per role × entity × field, hidden or read (absent = write). The most permissive access across the user's active roles wins. Responses are redacted, and writes to non-writable fields return 403.
8. **Segregation of duties**: checked on assignment. `block` rejects with 409; `warn` allows and returns the conflicts. A violations report lists current offenders. Defaults are warn for Starter and Growth and block for Enterprise (D3). Action-time checks based on record ownership arrive with workflows in step 0.8.
9. **Invitations** (D1): an invited `app_user` has no IdP subject. The first sign-in whose token carries the same **verified** email binds it, within 7 days. After that, identity is by subject only.
10. **Owner safeguard**: the workspace always keeps at least one active user with an unconditional, tenant-wide Owner assignment. Users cannot disable themselves.
11. `@manuling/authz/core` is framework-free and importable from domain code. `@manuling/authz` adds the NestJS decorators.

## Consequences

- Each authenticated request loads the caller's assignments, role permissions and field policies (a few indexed reads). Caching per user, invalidated on assignment change, is a later optimisation.
- Permission codes for future modules (for example `procurement.purchase_order.approve`) can already appear in seeded SoD rules. They take effect once the module registers them.
