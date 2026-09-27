# 05 — Brief v2: Gap Analysis and Deliverables Index

Status: **Draft for approval** · 2026-09-27

On 2026-09-27 the product owner supplied an expanded 100-section brief ("brief v2", saved as [BRIEF-v2.md](../BRIEF-v2.md)) for the same product. It asks for 24 architecture deliverables before Phase 1, and for approval before implementing. This document maps each deliverable to where it is answered, and records what was added. The brief's own rule (§93) is followed: existing, tested work is kept and extended, not rewritten.

The product name placeholder in brief v2 is **Manuling** (answered earlier, Q1).

## 1. Deliverables index

| #   | Deliverable (brief v2 "First task") | Where                                                                                          | Before brief v2                       | Added now                                                                                                        |
| --- | ----------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | Product architecture                | [06](06-product-and-module-map.md) §1                                                          | Partly (PRD §2, §8)                   | Five product layers (Core, Manufacturing, Industry Packs, AI, Integration) with dependency rules                 |
| 2   | Complete module map                 | [06](06-product-and-module-map.md) §2                                                          | 22 contexts ([02](02-context-map.md)) | Every brief v2 area mapped to a context, edition and phase; new contexts Commercial and Customer Success         |
| 3   | Domain boundaries                   | [02](02-context-map.md) §1–§2                                                                  | ☑ approved                            | —                                                                                                                |
| 4   | System architecture                 | [01](01-system-architecture.md)                                                                | ☑ approved                            | —                                                                                                                |
| 5   | Database architecture               | [03](03-erd-phase0-1.md), ADR-0004/0005/0006/0008, [11](11-data-and-api-architecture.md) §1–§3 | ERD and ADRs ☑                        | Store-by-store workload separation, design rules incl. soft-delete stance, backup/DR targets and restore testing |
| 6   | API architecture                    | [11](11-data-and-api-architecture.md) §4                                                       | Built in code, not written up         | Conventions table; API keys, webhooks, SSE/WebSocket, rate limits, developer portal plan                         |
| 7   | Event architecture                  | ADR-0007, [02](02-context-map.md) §3–§4, `docs/events/`                                        | ☑ built and approved                  | —                                                                                                                |
| 8   | AI architecture                     | [07](07-ai-architecture.md)                                                                    | PRD §6 only                           | Copilot pipeline, tool registry, agents, RAG, document intelligence, ML pipelines, governance controls           |
| 9   | Security architecture               | [08](08-security-architecture.md)                                                              | Spread over ADRs                      | One controls matrix with built/planned state, trust boundaries, STRIDE summary, financial controls               |
| 10  | Multi-tenancy architecture          | ADR-0005, ADR-0013                                                                             | ☑ built                               | Tenant-aware cache/search/storage/analytics rules in [08](08-security-architecture.md) §3                        |
| 11  | Role/permission architecture        | ADR-0014, [09](09-roles-and-process-maps.md) §1–§2                                             | ☑ built                               | Planned role templates (operator, supervisor, planner, executive, portals)                                       |
| 12  | Complete user-role matrix           | [09](09-roles-and-process-maps.md) §3                                                          | Missing                               | Persona × module matrix                                                                                          |
| 13  | Manufacturing process map           | [09](09-roles-and-process-maps.md) §4, [02](02-context-map.md) §4                              | Golden scenario only                  | Seven end-to-end process maps                                                                                    |
| 14  | UI information architecture         | [10](10-ui-information-architecture.md)                                                        | Missing (PRD §7 requirements only)    | Experiences, navigation, screen patterns, screen list, state definitions, design-system rules                    |
| 15  | Development roadmap                 | [06](06-product-and-module-map.md) §5                                                          | PRD §17                               | Brief v2 phases 0–9 mapped onto PRD phases 0–4                                                                   |
| 16  | Dependency graph                    | [06](06-product-and-module-map.md) §3                                                          | Implicit                              | Explicit graph and its consequences                                                                              |
| 17  | MVP definition                      | [06](06-product-and-module-map.md) §4                                                          | PRD §14 Starter                       | Exact MVP scope and exit criteria                                                                                |
| 18  | Enterprise version                  | [06](06-product-and-module-map.md) §4                                                          | PRD §14                               | Five editions reconciled with brief v2 tiers                                                                     |
| 19  | Future advanced version             | [06](06-product-and-module-map.md) §4                                                          | PRD §17 Phase 4                       | Written out                                                                                                      |
| 20  | Technology stack                    | ADR-0003                                                                                       | ☑ accepted                            | Brief v2 stack matches; deviations (search, analytics, object storage) already justified there                   |
| 21  | Repository structure                | [04](04-monorepo-and-scaffolding.md)                                                           | ☑ built                               | Mapping below (§3)                                                                                               |
| 22  | Testing strategy                    | [12](12-testing-strategy.md)                                                                   | Practised, not written                | Full matrix incl. manufacturing, financial, AI, load and security tests                                          |
| 23  | Deployment architecture             | [01](01-system-architecture.md) §5                                                             | ☑ approved                            | Backup/DR in [11](11-data-and-api-architecture.md) §3                                                            |
| 24  | Risks and bottlenecks               | [13](13-risks-and-bottlenecks.md)                                                              | Scattered                             | Risk register, bottlenecks, and 11 conflicts with proposed alternatives                                          |

## 2. What is actually built today (brief v2: "do not claim anything is implemented unless it exists")

Built, tested and on GitHub with green CI: Phase 0 steps 0.1–0.9, which cover the repo and CI, kernel (money, quantity, ids, errors), HTTP conventions, identity and tenancy with RLS, authorisation (RBAC, ABAC, field policies, SoD), audit with an optional hash chain, transactional outbox with Kafka and consumers, numbering series, the approval engine on Temporal, and custom fields, objects and layouts. There is **no UI yet** (step 0.12) and **no business module yet** (Phase 1). Step 0.10 (notifications) was paused part-way when brief v2 arrived: its plan, migration and domain code exist but are not committed. Details: [STATUS.md](../STATUS.md).

## 3. Repository structure (brief v2 §85)

Brief v2 suggests `apps/ services/ packages/ shared/ database/ infrastructure/ docs/ tests/ scripts/`. The approved structure ([04](04-monorepo-and-scaffolding.md)) covers the same needs with names that match its architecture; renaming would churn every import for no gain:

| Brief v2           | Manuling                                                                                              | Why it differs                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| apps/              | `apps/` (core, later web, mobile, portal)                                                             | Same                                                                     |
| services/          | `services/` (Python: ai-gateway, agent-runtime, ml, optimizer; Phase 1+)                              | Same, created when the first one is built                                |
| packages/, shared/ | `packages/` (kernel, db, http, authz, events, testing, later ui, i18n)                                | One place for shared code; a second "shared" folder would blur ownership |
| (domain modules)   | `modules/` (platform now; one per bounded context)                                                    | Makes bounded contexts first-class and boundary-checked                  |
| database/          | Migrations live with their owner: `packages/db/migrations`, `modules/*/migrations`                    | A context owns its schema (modular-monolith rule)                        |
| infrastructure/    | `infra/` (docker, keycloak, postgres; later helm, terraform)                                          | Same                                                                     |
| tests/             | Tests next to code (`*.test.ts`, `*.int.test.ts`); cross-module E2E in `apps/*/test` and later `e2e/` | Co-location keeps tests maintained                                       |
| scripts/           | CLIs in `apps/core/src/cli` (provision, seed, export schemas)                                         | Typed and tested with the app                                            |
| —                  | `localisation/` (country packs)                                                                       | ADR-0011                                                                 |

## 4. Decisions needed from the product owner

1. **Approve** documents 05–13 (or send changes).
2. **Conflicts** in [13](13-risks-and-bottlenecks.md) §3: accept the proposed alternatives, especially C1 (finance stays in the MVP) and C2 (keep PRD phase numbering).
3. **Q21, the demo company:** "Artsy Manufacturing Pvt Ltd / Mysuru Plant / Industrial Pump" (brief v2) or "Mysuru Precision Components Pvt. Ltd." (PRD)?
4. **Q22, the editions:** five tiers (Free trial, Starter, Professional, Enterprise, Enterprise Plus) replace the PRD's three?
5. After approval: resume step 0.10 (notifications), then 0.11–0.15, then open Phase 1 with the phase prompt.
