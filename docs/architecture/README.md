# Architecture

| Doc                                                                   | Contents                                                                                                                                                        |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [01 — System architecture](01-system-architecture.md)                 | Drivers, C4 context and container views, request/event lifecycle, SaaS / private cloud / on-prem / edge deployment views, cross-cutting concerns, phase mapping |
| [02 — Context map](02-context-map.md)                                 | Bounded contexts, context map, sync vs async rule, domain event catalogue, golden-scenario trace                                                                |
| [03 — ERD (Phase 0–1)](03-erd-phase0-1.md)                            | Table conventions, ERDs for Platform, Master Data, Inventory, Finance/Tax, Sales/Procurement, Engineering/Production, AI                                        |
| [04 — Monorepo and scaffolding](04-monorepo-and-scaffolding.md)       | Folder structure, module layout, enforced boundaries, Phase 0 step plan                                                                                         |
| [05 — Brief v2 gap analysis](05-brief-v2-gap-analysis.md)             | Index of the 24 brief v2 deliverables, what existed vs what was added, repository mapping, decisions needed                                                     |
| [06 — Product and module map](06-product-and-module-map.md)           | Product layers, complete module map, dependency graph, editions, MVP / enterprise / future definitions, reconciled roadmap                                      |
| [07 — AI architecture](07-ai-architecture.md)                         | Copilot pipeline, tool registry, agents, RAG, document intelligence, ML pipelines, AI governance                                                                |
| [08 — Security architecture](08-security-architecture.md)             | Trust boundaries, controls matrix with built/planned state, STRIDE summary, financial controls                                                                  |
| [09 — Roles and process maps](09-roles-and-process-maps.md)           | Role templates, persona × module matrix, seven end-to-end manufacturing process maps                                                                            |
| [10 — UI information architecture](10-ui-information-architecture.md) | Experiences by role, navigation, screen patterns, screen list, state definitions, design-system rules                                                           |
| [11 — Data and API architecture](11-data-and-api-architecture.md)     | Stores and workload separation, database rules, backup/DR, API conventions and additions, SLOs and load tests                                                   |
| [12 — Testing strategy](12-testing-strategy.md)                       | Test matrix (unit to AI evaluation), rules                                                                                                                      |
| [13 — Risks and bottlenecks](13-risks-and-bottlenecks.md)             | Risk register, architectural bottlenecks, conflicts between brief v2 and the architecture                                                                       |

Decisions: [`/docs/adr`](../adr/README.md) · Open questions: [`/docs/OPEN-QUESTIONS.md`](../OPEN-QUESTIONS.md)
