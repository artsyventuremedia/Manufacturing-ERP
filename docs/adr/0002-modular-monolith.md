# ADR-0002: Modular monolith with hexagonal bounded contexts

- Status: Accepted (2026-09-25)
- Date: 2026-09-24

## Context

The PRD asks for about 20 bounded contexts, deployment everywhere from a single on-prem server to multi-region SaaS, strict transactional correctness between inventory and finance, and the option to extract services later (PRD §8). Microservices from day one would multiply operational cost, break single-transaction posting, and slow a small team.

## Decision

1. Build **one deployable NestJS application** (`apps/core`) composed of bounded-context packages under `modules/*`. It runs from one image with two entrypoints: `core-api` (HTTP) and `core-worker` (Temporal workers, outbox relay, consumers).
2. Each module uses **hexagonal layering**: `domain` (pure) → `application` (use cases, permissions) → `infrastructure` (DB, adapters) → `api` (controllers). Its public surface is `contracts/` only.
3. Each module **owns a Postgres schema**. No module reads or writes another module's tables. Cross-module FKs are allowed only towards `platform` and `masterdata`.
4. Cross-module interaction:
   - **Synchronous, in-process** through published ports when the change must be atomic with the caller. The main case is ledger postings: `InventoryPostingPort`, `FinancePostingPort`. Port commands carry idempotency keys and have compensating commands (reversal), so they can become sagas if a module is extracted.
   - **Asynchronous** through domain events (ADR-0007) for everything else.
5. Boundaries are enforced in CI with dependency-cruiser and ESLint boundary rules.
6. Python services (AI, ML, optimiser) are separate deployables from the start, because the language and runtime differ. They talk to core only through the public API or Temporal activities.

## Consequences

- One transaction can span Procurement → Inventory → Finance, which gives perpetual inventory with no drift.
- Simple deployment for on-prem and SMB.
- The team must stay disciplined about boundaries. CI tooling makes that mandatory.
- Scaling is coarse-grained: API and worker pools scale independently, but modules do not scale separately. That is acceptable until load tests say otherwise.

## Alternatives considered

- **Microservices from day one**: rejected. It needs distributed transactions for postings and brings heavy ops for on-prem.
- **Unstructured monolith (Odoo/ERPNext style)**: rejected. Models become entangled and customisation fragile, which are the problems we are trying to beat.
