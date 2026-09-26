# Architecture Decision Records

Format: [MADR](https://adr.github.io/madr/)-lite. Statuses: Proposed → Accepted → Superseded/Deprecated. An ADR is changed only to fix typos. To change a decision, write a new ADR that supersedes the old one.

| #                                                | Title                                                                   | Status   |
| ------------------------------------------------ | ----------------------------------------------------------------------- | -------- |
| [0001](0001-record-architecture-decisions.md)    | Record architecture decisions                                           | Accepted |
| [0002](0002-modular-monolith.md)                 | Modular monolith with hexagonal bounded contexts                        | Accepted |
| [0003](0003-technology-stack.md)                 | Technology stack                                                        | Accepted |
| [0004](0004-data-access-and-migrations.md)       | Data access (Drizzle) and migration strategy                            | Accepted |
| [0005](0005-multi-tenancy-model.md)              | Multi-tenancy: pooled RLS cells + dedicated cells                       | Accepted |
| [0006](0006-ledger-design.md)                    | Append-only double-entry ledgers for inventory and GL                   | Accepted |
| [0007](0007-event-bus-and-outbox.md)             | Event bus: transactional outbox + Kafka API                             | Accepted |
| [0008](0008-money-quantity-and-ids.md)           | Money, quantity and identifier representation                           | Accepted |
| [0009](0009-identity-and-authorisation.md)       | Identity (Keycloak) and in-app authorisation                            | Accepted |
| [0010](0010-workflow-engine.md)                  | Durable workflows and approvals on Temporal                             | Accepted |
| [0011](0011-localisation-country-packs.md)       | Localisation as country-pack plugins                                    | Accepted |
| [0012](0012-tally-coexistence-strategy.md)       | Tally: one-time migration + one-way export bridge                       | Accepted |
| [0013](0013-tenant-resolution-and-membership.md) | Tenant resolution from request, membership in our DB                    | Accepted |
| [0014](0014-authorisation-model.md)              | Authorisation model (access rules, scopes, templates, SoD, invitations) | Accepted |
| [0015](0015-approval-engine.md)                  | Approval engine: Postgres truth, Temporal time, outbox hand-offs        | Accepted |
