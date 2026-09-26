# 01 — System Architecture

Status: **Draft for approval** · Owner: Architecture · Last updated: 2026-09-24

This document describes the target architecture of Manuling across all phases. It shows what exists in Phase 0/1 and what gets added later. Decisions referenced as `ADR-NNNN` live in [`/docs/adr`](../adr/README.md).

---

## 1. Architectural drivers

| Driver                                           | Source          | Architectural consequence                                                                                                                                                                 |
| ------------------------------------------------ | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One data model, zero re-entry                    | PRD §2.1        | A single transactional PostgreSQL store per tenant cell. Modules own their tables but share one database and one transaction boundary where they need to (for example stock + GL posting) |
| Real-time, event-driven                          | PRD §2.2, §8    | Transactional outbox → Kafka. Every state change emits a versioned domain event                                                                                                           |
| SaaS + private cloud + on-prem from one codebase | PRD §0, §8      | Everything runs in containers and uses only portable dependencies (Postgres, Kafka API, S3 API, OIDC, Temporal). No cloud-proprietary service sits in the critical path                   |
| SMB price point                                  | PRD §0, §14     | Pooled multi-tenancy with RLS. The whole platform runs on one VM (about 32 GB) for on-prem Starter customers                                                                              |
| Enterprise isolation                             | PRD §8, §12     | "Cells": the same stack deployed as pooled cells or dedicated single-tenant cells                                                                                                         |
| Shop-floor offline                               | PRD §2.6, §5.17 | Offline-first mobile with local SQLite + sync. Per-plant edge agent with store-and-forward                                                                                                |
| Correct accounting and traceability              | PRD §10         | Append-only double-entry ledgers (inventory and GL) posted in the same DB transaction (ADR-0006)                                                                                          |
| AI-native with guardrails                        | PRD §6          | An AI gateway and agent runtime that call the ERP **only through the public API as the invoking user**, and that logs every action                                                        |
| Configure, don't customise                       | PRD §2.4, §8    | Metadata-driven custom fields/objects, workflow DSL, sandboxed scripting. Extensions never touch core tables                                                                              |

---

## 2. System context (C4 level 1)

```mermaid
flowchart LR
  subgraph People
    OWN[Owner / CEO]
    OFF[Office users<br/>accounts, sales, purchase, stores]
    OPR[Shop-floor operators<br/>tablets and kiosks]
    TECH[Maintenance and<br/>field technicians]
    EXT[Customers, suppliers,<br/>dealers, job workers]
    ADM[Tenant admin /<br/>implementation partner]
  end

  SYS(("Manuling<br/>AI-native Manufacturing ERP"))

  subgraph Government["India government systems"]
    GSP[GSP / ASP<br/>GSTN returns]
    IRP[e-Invoice IRP<br/>IRIS IRP first]
    EWB[e-Way Bill portal]
    VER[GSTIN / Udyam<br/>verification]
  end

  subgraph ThirdParty["Third-party services"]
    BANK[Banks and payment<br/>gateways / UPI]
    WA[WhatsApp Business API,<br/>SMS, email]
    LLM[LLM providers<br/>or self-hosted models]
    EDI[EDI VANs /<br/>OEM customer portals]
    LOG[Logistics and<br/>courier APIs]
    TALLY[Tally Prime /<br/>Excel / legacy ERPs]
    BI[Power BI / Tableau]
  end

  subgraph Plant["Plant floor"]
    PLC[PLCs, CNCs, sensors,<br/>energy meters, weighbridges]
    DEV[Barcode/RFID scanners,<br/>label printers, biometrics]
  end

  OWN & OFF & ADM -->|Web app| SYS
  OPR & TECH -->|Mobile / kiosk, offline-first| SYS
  EXT -->|Portals and WhatsApp flows| SYS
  SYS <-->|Returns, IRN, EWB| GSP & IRP & EWB & VER
  SYS <--> BANK & WA & EDI & LOG
  SYS -->|Prompts, redacted| LLM
  TALLY -->|Import / sync| SYS
  SYS -->|Connectors| BI
  PLC -->|OPC UA / Modbus / MQTT via edge agent| SYS
  DEV --> SYS
```

---

## 3. Container view (C4 level 2)

```mermaid
flowchart TB
  subgraph Clients
    WEB[Web app<br/>Next.js · React · TS]
    MOB[Mobile apps<br/>Expo React Native · SQLite]
    PORTAL[Portals<br/>same Next.js app, portal routes]
  end

  subgraph Edge["Per-plant edge (Phase 3)"]
    EAGENT[Edge agent<br/>OPC UA / Modbus / S7 / MQTT drivers]
    EBUF[(Local buffer<br/>SQLite / NATS leaf)]
    EMQ[MQTT broker<br/>Mosquitto / EMQX]
    EAGENT --- EBUF
    EAGENT --- EMQ
  end

  GW[API gateway / ingress<br/>Envoy or Traefik · TLS · rate limits · WAF]
  IDP[Keycloak<br/>OIDC · SAML · MFA · Organizations]

  subgraph Core["Core platform (modular monolith, one image)"]
    API[core-api<br/>NestJS · REST OpenAPI 3.1 · webhooks]
    WRK[core-worker<br/>Temporal workers · outbox relay ·<br/>event consumers · schedulers]
  end

  subgraph PyServices["Python services"]
    AIGW[ai-gateway<br/>FastAPI · LLM routing · redaction ·<br/>cost metering · prompt logs]
    AGENT[agent-runtime<br/>copilot and agents · tool calls via core-api]
    ML[ml-service<br/>forecasting · anomaly · predictions]
    OPT[optimizer<br/>OR-Tools · APS · MRP heavy lifting]
  end

  subgraph Data["Data plane"]
    PG[(PostgreSQL 16<br/>RLS · pgvector · pg_trgm)]
    TS[(TimescaleDB<br/>machine and energy series · Phase 3)]
    KAFKA[[Kafka API broker<br/>domain events]]
    TEMP[Temporal server]
    REDIS[(Redis<br/>cache · rate limits · sessions)]
    OBJ[(S3-compatible object store<br/>documents · attachments · exports)]
    OLAP[(Analytics store<br/>ClickHouse or Postgres replica · Phase 1+)]
  end

  subgraph Integrations["Integration adapters (in core-worker)"]
    INDIA[localisation-in · GST Compliance Gateway<br/>IRIS IRP · EWB · returns · GSTIN]
    COMMS[comms<br/>WhatsApp · SMS · email · push]
    BANKA[bank feeds · payment gateways]
  end

  OBS[Observability<br/>OTel collector → Prometheus · Loki · Tempo · Grafana · Sentry]

  WEB & PORTAL & MOB --> GW
  GW --> API
  GW --> AGENT
  WEB & MOB & PORTAL -.OIDC.-> IDP
  API -.token validation.-> IDP

  API --> PG
  API --> REDIS
  API --> OBJ
  API -->|start workflows| TEMP
  WRK --> PG
  WRK --> TEMP
  WRK -->|publish outbox| KAFKA
  KAFKA -->|consume| WRK
  KAFKA --> ML
  KAFKA -->|CDC / sink| OLAP
  WRK --> INDIA & COMMS & BANKA

  AGENT --> AIGW
  AGENT -->|tool calls as the invoking user| API
  AIGW --> PG
  ML --> PG
  OPT <-->|jobs via Temporal activities| WRK

  EAGENT -->|MQTT over TLS, store-and-forward| GW
  GW -->|telemetry ingest| WRK
  WRK --> TS

  API & WRK & AIGW & AGENT & ML & OPT -.-> OBS
```

### Container responsibilities

| Container         | Tech                                                | Responsibility                                                                                                                                                                                       | Scales by             |
| ----------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **core-api**      | NestJS on Node 22 LTS                               | All synchronous commands and queries for every bounded context. Validates, authorises and writes to Postgres with the outbox in the same transaction                                                 | Horizontal, stateless |
| **core-worker**   | Same codebase, different entrypoint                 | Temporal workflow/activity workers, outbox relay, Kafka consumers (projections, notifications, search indexing), integration adapters, scheduled jobs                                                | Horizontal per queue  |
| **web**           | Next.js (App Router) as a client-rendered app shell | Office UI, portals, command palette, copilot panel. Server components only for the shell and i18n bootstrap; data comes from core-api via TanStack Query                                             | Horizontal/CDN        |
| **mobile**        | Expo React Native                                   | Stores, approvals and (later) operator, technician and ESS apps. Offline-first with SQLite and a sync protocol (ADR pending, Q10)                                                                    | n/a                   |
| **ai-gateway**    | FastAPI                                             | Provider-agnostic LLM access, per-tenant model policy, PII redaction, prompt/response logs, token metering                                                                                           | Horizontal            |
| **agent-runtime** | FastAPI + an agent framework                        | Copilot sessions and background agents. **Has no DB write access to ERP data**: every action goes through core-api with a delegated user token, so permissions, validation and audit apply unchanged | Horizontal            |
| **ml-service**    | FastAPI, scikit-learn / statsforecast / LightGBM    | Training and serving forecasting, anomaly and prediction models. Returns confidence and drivers with every prediction                                                                                | Horizontal + batch    |
| **optimizer**     | Python, OR-Tools CP-SAT                             | Finite-capacity scheduling, what-if, sequencing                                                                                                                                                      | Job-based             |
| **edge-agent**    | Go or Rust (ADR in Phase 3)                         | Protocol drivers, local buffering (≥72 h), edge rules, store-and-forward                                                                                                                             | Per plant             |

**Why core-api and core-worker are one codebase:** both import the same domain modules. One Docker image with two entrypoints keeps the modular monolith deployable as a single unit and lets us scale workers separately (ADR-0002).

---

## 4. Request and event lifecycle

This is how a typical write (posting a Goods Receipt) flows through the system and shows the key invariants.

```mermaid
sequenceDiagram
  autonumber
  participant U as User (web)
  participant API as core-api
  participant PG as PostgreSQL
  participant R as Outbox relay
  participant K as Kafka
  participant C as Consumers

  U->>API: POST /v1/procurement/goods-receipts/{id}:post  (If-Match: version)
  API->>API: AuthN (JWT) → TenantContext → AuthZ (RBAC+ABAC) → validate
  API->>PG: BEGIN, then SET LOCAL app.tenant_id and app.user_id
  API->>PG: update GRN status (version check)
  API->>PG: insert stock_ledger_entry rows (status = QC_HOLD)
  API->>PG: insert journal_entry + lines (Inventory Dr / GR-IR Cr)
  API->>PG: upsert stock_balance (row lock)
  API->>PG: insert audit_log + outbox(GoodsReceiptPosted, StockMoved, JournalPosted)
  API->>PG: COMMIT
  API-->>U: 200 + new version
  R->>PG: SELECT … FOR UPDATE SKIP LOCKED from outbox
  R->>K: publish CloudEvents (key = tenant_id:aggregate_id)
  C->>K: consume
  C->>C: Quality creates inspection lot · Analytics projection · notify buyer · search index
```

Invariants:

1. Ledger postings that must balance happen **synchronously in one DB transaction** (in-process calls across modules through their published application interfaces). Only reactions that can tolerate lag go through Kafka.
2. Consumers are idempotent (the `event_id` goes into a per-consumer `inbox` table).
3. Kafka ordering is per aggregate (the partition key includes the aggregate id).

---

## 5. Deployment views

### 5.1 Multi-tenant SaaS (default)

```mermaid
flowchart TB
  subgraph Global["Global control plane"]
    CP[Control plane<br/>tenant registry · provisioning · licensing ·<br/>billing metering · cell router]
    CPDB[(Control plane DB)]
    CP --- CPDB
  end

  DNS[DNS + CDN + WAF<br/>tenant.product.com] --> ROUTER[Cell router<br/>tenant → cell lookup]

  subgraph IN["Region: India (Mumbai / Hyderabad) — data residency"]
    subgraph CellP1["Pooled cell P1 (Starter/Growth, ~500–2,000 tenants)"]
      K8S1[Kubernetes namespace<br/>core-api · core-worker · ai · ml · web]
      PG1[(Postgres HA<br/>primary + sync replica + PITR)]
      KF1[[Kafka 3 brokers]]
      T1[Temporal]
    end
    subgraph CellD1["Dedicated cell D1 (Enterprise tenant)"]
      K8S2[Same Helm chart,<br/>single tenant]
      PG2[(Dedicated Postgres)]
    end
    SHARED[Shared regional services<br/>Keycloak HA · object storage · observability]
  end

  subgraph ROW["Region: EU / US (later)"]
    CellP2[Pooled cell P2]
  end

  ROUTER --> CellP1 & CellD1 & CellP2
  CP -.provisions / upgrades.-> CellP1 & CellD1 & CellP2
```

- A **cell** is one complete stack deployed from one Helm chart. Pooled cells use RLS; dedicated cells run the same code with one tenant (ADR-0005).
- Blue/green or canary rollouts happen per cell through Argo CD. Migrations follow expand/contract, so they are backward compatible (PRD §13).
- Backups: continuous WAL archiving (pgBackRest) to object storage in another zone, giving RPO ≤ 15 min. A standby cluster can be restored within 4 h (RTO).

### 5.2 Private cloud (customer's AWS/Azure/GCP account)

The same Helm chart and Terraform modules deploy a dedicated cell into the customer's account. The customer can choose managed Postgres (RDS/Azure Flexible/Cloud SQL) and managed Kafka. The control plane connects outbound only, for licence and update checks.

### 5.3 On-premise (SMB and regulated customers)

```mermaid
flowchart LR
  subgraph Site["Customer site"]
    subgraph Server["Single server (16 vCPU / 32–64 GB) — k3s or Docker Compose"]
      A[core-api + core-worker]
      W[web]
      KC[Keycloak]
      P[(Postgres + TimescaleDB)]
      KA[[Kafka single-node KRaft]]
      TE[Temporal]
      O[(S3-compatible store)]
      AI[ai-gateway<br/>→ cloud LLM or local model]
    end
    TAB[Tablets / PCs on LAN]
    EDGEBOX[Edge agent box<br/>per plant]
  end
  UPD[Vendor update and licence server]

  TAB --> W & A
  EDGEBOX --> A
  Server -. outbound HTTPS only, optional .-> UPD
```

- Installer: a signed bundle (Helm chart + images) plus an `installer` CLI that runs preflight checks, generates secrets, sets up backups to a NAS or S3, and upgrades in place.
- Air-gapped mode: offline licence file, images from a local registry, and optional self-hosted LLM (open-weights model on a GPU box) through the same ai-gateway.

### 5.4 Edge (per plant, Phase 3)

The edge agent runs on an industrial PC or ARM box under Docker/k3s. It reads PLCs (OPC UA, Modbus, S7, EtherNet/IP) and retrofit sensors, publishes to a local MQTT broker, buffers at least 72 h locally, and forwards over mTLS to the cloud or on-prem ingestion endpoint. It also caches the operator-terminal data it needs, so the shop floor keeps running on the LAN during WAN outages.

---

## 6. Cross-cutting concerns

| Concern                          | Approach                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Identity**                     | Keycloak with a single realm plus Keycloak Organizations for tenants. Per-tenant IdP brokering (Azure AD, Google, SAML) for enterprise SSO. MFA policies per tenant. Short-lived access tokens (5 min) with refresh rotation (ADR-0009)                                                                                                                     |
| **Authorisation**                | In-app policy engine: roles → permissions (`inventory.goods_receipt.post`), scoped by company/plant/warehouse, plus ABAC conditions (amount limits, own-records) and field-level masks. Segregation-of-duties rules are checked at role assignment and at action time. Every endpoint declares its permission, and a lint rule fails CI when one is missing |
| **Tenant isolation**             | Postgres RLS on every tenant table (ADR-0005). Composite `(tenant_id, id)` foreign keys prevent cross-tenant references. CI runs an isolation test suite that attempts cross-tenant reads and writes on every table                                                                                                                                         |
| **Audit**                        | Row-level audit written by the application layer in the same transaction (who, what, before, after, source, correlation id). A hash chain per tenant provides tamper evidence for regulated tenants                                                                                                                                                         |
| **Money and quantity**           | `NUMERIC(20,6)` in the DB; `Money`/`Quantity` value objects on decimal.js in TS. JSON transports them as strings. Precision is configured per currency and per UoM (ADR-0008)                                                                                                                                                                               |
| **Time**                         | `timestamptz` in UTC everywhere. Business dates (posting date, document date) are `date` with an explicit fiscal calendar                                                                                                                                                                                                                                   |
| **i18n**                         | i18next keys for all UI text. ICU message format. Locale-aware number formatting (lakh/crore grouping for en-IN). Print templates render Indic scripts with embedded Noto fonts                                                                                                                                                                             |
| **Localisation (tax/statutory)** | A country pack plugin interface: tax determination, document requirements, e-invoicing, statutory reports. India is the first pack (ADR-0011)                                                                                                                                                                                                               |
| **API conventions**              | REST `/v1/{context}/{resource}`, cursor pagination, `If-Match`/ETag optimistic concurrency, `Idempotency-Key` on POSTs, RFC 9457 problem+json errors, state transitions as `POST …/{id}:submit` style actions                                                                                                                                               |
| **Observability**                | OpenTelemetry traces, metrics and logs. `tenant_id`, `user_id` and `correlation_id` on every span and log line. Per-tenant SLO dashboards                                                                                                                                                                                                                   |
| **Feature flags and licensing**  | Entitlements come from the control plane (edition, modules, seats, plants, meters). They are cached in core-api and enforced by guards on routes, UI slots and background jobs. Separate operational feature flags (OpenFeature API; Unleash or flagd backend)                                                                                              |
| **Extensibility**                | Custom fields as a `jsonb` extension column validated against metadata, custom objects in a generic, indexed store, sandboxed scripts (a V8 isolate with a CPU/memory budget) triggered by events and hooks, UI extension slots, and outbound webhooks. Extensions get their own schema and never write core tables directly                                |
| **Security**                     | OWASP ASVS L2, secrets in Vault (or the cloud KMS), TLS 1.3 by default, a CSP on the web app, SAST/DAST/SCA and container scanning in CI, signed images (cosign)                                                                                                                                                                                            |

---

## 7. Phase mapping

| Container / capability                                                                                    | P0      | P1      | P2         | P3                      | P4     |
| --------------------------------------------------------------------------------------------------------- | ------- | ------- | ---------- | ----------------------- | ------ |
| core-api, core-worker, web shell, Keycloak, Postgres, Kafka, Temporal, Redis, object store, observability | ●       |         |            |                         |        |
| Control plane (tenants, licensing, cell routing)                                                          | ● basic |         |            |                         | ● full |
| Mobile (stores, approvals)                                                                                |         | ●       | ● portals  | ● operator / technician |        |
| ai-gateway + copilot foundation (NL search, doc extraction)                                               |         | ●       |            |                         |        |
| Analytics store and dashboards                                                                            |         | ● basic | ● advanced |                         |        |
| ml-service (forecasting, anomaly)                                                                         |         |         | ●          |                         | ● full |
| optimizer (APS)                                                                                           |         |         |            | ●                       |        |
| Edge agent, TimescaleDB, digital twin                                                                     |         |         |            | ●                       | ● twin |
| agent-runtime (autonomous agents)                                                                         |         |         |            |                         | ●      |
