# Plan: Phase 0 step 0.5 (authorisation)

Status: done · approved 2026-09-25 (D1–D3 as proposed) · see ADR-0014 · Implements ADR-0009 §8–15

## Scope

1. **Permission registry in code.** Each module declares its permissions (`platform.company.create`, …), each linked to an entitlement `feature_key` (used in step 0.11). A `GET /v1/platform/permissions` catalogue drives the role editor.
2. **Every route is guarded.** Routes carry `@RequirePermission('<code>')`. At startup the app refuses to boot if any route has neither `@Public()` nor `@RequirePermission`, and a test asserts it. This is stronger than the lint rule planned in 04-monorepo §1.
3. **Tables** (migration `platform/0002_authorisation`):
   - `role` and `role_permission`, tenant-scoped. System roles are seeded at provisioning.
   - `user_role`: user × role, optional `company_id` / `plant_id` scope, ABAC `conditions`, `valid_from` / `valid_to`.
   - `field_policy`: role × entity × field → hidden / read.
   - `sod_rule`: conflicting permission pairs, with severity warn / block.
4. **Evaluation (`PermissionService`).** A grant applies when the role has the permission, the assignment is currently valid, the scope matches the resource's company/plant, and all conditions hold.
   - Conditions are structured data, not code, e.g. `{ "attr": "amount", "op": "lte", "value": "500000" }`. Operators: eq, ne, lt, lte, gt, gte, in, own-record. Amounts are compared as Decimal.
   - Grants are loaded once per request. Denials are audited in step 0.6.
5. **Company scoping.** `RequestContext.companyIds` is filled from the user's assignments (a tenant-wide role means all companies). Company lists are filtered to those companies, and requests for companies outside them return 404.
6. **Field-level security.** Hidden fields are removed from responses, and writes to read-only fields are rejected with 403 `authz.field_read_only`.
7. **Segregation of duties.** Rules are checked when a role is assigned: a `block` rule rejects the assignment, a `warn` rule allows it and returns a warning. A violations report endpoint is included. Action-time checks based on who created a record arrive with workflows in step 0.8.
8. **Admin APIs:** users (invite, disable, list), roles (CRUD, clone a system role), role assignments, field policies.
9. **Retire `is_tenant_admin`.** Provisioning assigns the Owner role instead. The column is dropped in a later expand/contract migration.
10. **Tests:** evaluator unit tests (scope, validity, conditions, Decimal limits). API tests: 403 without permission, company-scoped 404s, field hiding, read-only rejection, SoD block and warn, the boot-time guard check, and cross-tenant role and assignment attacks.

## Decisions needed from the product owner

- **D1 Invitations:** an admin invites by email; on first login, a token whose **verified** email matches binds that IdP subject to the invitation. Invitations expire after 7 days. Alternatively, admins enter the Keycloak user id directly (clunky).
- **D2 System roles seeded per tenant:** Owner (everything), Administrator (everything except billing/licence), Finance, Sales, Purchase, Stores, Production, Quality, Viewer (read-only). Each has permissions for the modules that exist; the list grows as modules land. Tenants clone and edit these, and system roles stay read-only.
- **D3 SoD default severity:** `warn` for SMB editions and `block` for Enterprise, overridable per rule. Seeded rules: supplier create vs payment approve, PO create vs PO approve, journal post vs journal approve.
