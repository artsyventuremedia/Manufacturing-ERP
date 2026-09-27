# Brief v2: Manufacturing Operating System (as received 2026-09-27)

Supplied by the product owner (Artsy Technologies). The content is kept as received; long one-item-per-line lists are condensed into comma-separated lines. Where this brief and the approved architecture differ, see [architecture/13](architecture/13-risks-and-bottlenecks.md) §3. The answers to its "First task" are indexed in [architecture/05](architecture/05-brief-v2-gap-analysis.md).

**Role:** Principal Enterprise Software Architect, Manufacturing Domain Architect, ERP Product Strategist, AI Architect, Cybersecurity Architect, UX Architect, DevOps Engineer, QA Architect and CTO-level engineering lead. Design, architect, develop, test, secure, document and prepare for production a next-generation Manufacturing ERP platform.

**Project name:** [PRODUCT NAME] → Manuling (Q1) · **Company:** Artsy Technologies

**Vision:** A globally scalable Manufacturing Operating System that goes significantly beyond traditional ERP products. It combines ERP, MRP, MRP II, MES, WMS, QMS, SCM, CRM, PLM, APS, CMMS/EAM, HCM, finance, procurement, inventory, production planning, maintenance, BI, workflow automation, document management, IoT, AI/ML, digital twin, supplier management, customer portal, employee portal and management intelligence. The goal is not to clone existing ERP software. It must be modern, modular, AI-native, API-first, real-time and multi-tenant, and serve:

- company types: small manufacturers, SMEs, mid-market, large enterprises, multi-plant organisations, contract manufacturers and OEMs;
- manufacturing types: discrete, process, batch, make-to-stock, make-to-order, engineer-to-order, configure-to-order, assemble-to-order, job shops, continuous and hybrid.

## 1. Product principles

The platform is:

- AI-native, real-time, cloud-native, API-first and mobile-first;
- multi-tenant, multi-company, multi-plant and multi-location;
- multi-currency, multi-language and multi-tax-jurisdiction;
- event-driven, configurable and extensible;
- secure to enterprise grade, offline-capable where required, highly observable, audit-ready, and manufacturing-first.

Do not hard-code business processes that should be configurable; everything possible should be configurable through administration screens.

## 2. Core architecture

Logical layers, top to bottom: frontend → API gateway → identity and access management → business services → workflow engine → event bus → domain services → operational databases → analytics / data warehouse → AI/ML layer.

Use domain-driven design, with bounded contexts: Identity, Organization, Finance, Sales, Procurement, Inventory, Manufacturing, Quality, Maintenance, Warehouse, Supply Chain, Projects, HR, CRM, PLM, Documents, IoT, Analytics, AI, Notifications, Workflow. The architecture must support a modular-monolith deployment and later microservice decomposition, without unnecessarily creating hundreds of microservices, and with clear domain boundaries.

## 3. Multi-tenancy

Hierarchy: Tenant → Companies, Plants, Warehouses, Locations, Departments, Teams, Users.

Implement:

- tenant isolation and row-level security;
- RBAC, ABAC and permission inheritance;
- data partitioning;
- tenant-aware caching, search, storage, analytics and audit logs.

No tenant may ever access another tenant's data. Create automated tenant-isolation tests.

## 4. Organization management

Organization, company, business unit, division, plant, factory, warehouse, store, department, cost centre, profit centre, work centre, production line, machine, workstation, location, bin, zone. Support organisational hierarchies.

## 5. Master data management

Centralised master data:

- products and items: products, SKUs, items, raw materials, components, subassemblies, finished goods, consumables, services, spare parts, tools, assets;
- parties and people: customers, suppliers, employees;
- resources: machines, operations, work centres, warehouses, locations;
- reference data: units of measure, tax codes, currencies, payment terms, Incoterms;
- quality and reasons: quality parameters, defect codes, reason codes;
- engineering: BOMs, routings, specifications.

Implement versioning, approval, effective dates, change history, duplicate detection, data validation, import/export, bulk operations and API access.

## 6. Product lifecycle management

A complete PLM system:

- products: creation, versions, attributes, lifecycle states;
- BOMs: engineering, manufacturing and service BOMs; BOM comparison and revision;
- engineering change: ECR, ECO and ECN;
- documents: attachments, CAD file attachments, technical specifications;
- control: approval workflows, revision control, digital signatures;
- analysis: impact analysis, where-used analysis;
- components: substitution, alternate components, obsolete components.

Lifecycle states: Draft, Review, Approved, Released, Superseded, Obsolete.

## 7. BOM engine

BOM types:

- structure: single-level, multi-level, phantom;
- variants: configurable, variant;
- components: optional, alternate, batch-specific, serial-specific;
- outputs and losses: co-products, by-products, scrap, yield.

BOM explosion calculates material requirements, cost, quantity, lead time, scrap, yield and availability.

## 8. Routing engine

Each routing operation defines:

- operation sequence, work centre, machine and labour;
- times: setup, run, queue, move and inspection;
- requirements: tools and skills;
- energy consumption, machine constraints and quality checkpoints.

Support alternate routings and routing versioning.

## 9. Sales & CRM

Features: lead, opportunity, account and contact management, quotation, sales order, contract, customer pricing, discounts, credit limits, customer complaints, customer portal and sales forecasting.

AI features:

- scoring and forecasting: lead scoring, opportunity scoring, sales forecasting, quote probability;
- risk: customer risk detection, churn prediction;
- assistance: next-best-action, automated follow-ups, AI-generated proposals and emails, an AI sales assistant.

## 10. Configure-price-quote

Support:

- product and variant configuration, with a rules engine;
- pricing and discount engines, with margin calculation;
- customer-specific, volume and contract pricing;
- tax calculation, quotation generation and approval workflow.

AI assists configuration and quotation.

## 11. Procurement

Complete source-to-pay:

- supplier lifecycle: discovery, onboarding, qualification;
- sourcing: RFQ, RFI, RFP, quotation comparison;
- purchasing: purchase requisition, purchase order, blanket PO, contract purchasing;
- receipt and payment: goods receipt, invoice matching, payment workflow;
- supplier management: scorecard, risk, performance.

Three-way matching: PO → GRN → invoice.

AI: supplier risk scoring, price anomaly detection, procurement recommendations, demand-based purchasing, supplier recommendation, negotiation intelligence.

## 12. Inventory management

Stock types: raw material, WIP, finished goods, consumables, spare parts, tools.

Features:

- structure and tracking: multi-location, batch, serial and lot tracking, expiry;
- valuation and picking methods: FEFO, FIFO, LIFO;
- movements: transfers, reservations, adjustments;
- counting: cycle counting, physical inventory;
- stock status: quarantine, blocked, available;
- replenishment: safety stock, reorder points, min/max.

Real-time inventory visibility is mandatory.

## 13. Advanced warehouse management

WMS features:

- flow: inbound, putaway, storage, picking, packing, dispatch, cross docking;
- picking methods: wave, batch and zone picking, pick paths;
- identification: barcode, QR, RFID;
- yard and dock: bin, dock, yard and truck management;
- shipping: ASN, load planning.

A mobile warehouse app with handheld scanner support is required.

## 14. Demand planning

Inputs: historical sales, orders, seasonality, promotions, market trends, customer forecasts, inventory, lead times, production capacity. AI models generate a demand forecast, forecast confidence, demand anomalies and forecast scenarios.

## 15. Material requirement planning

MRP considers demand, BOM, inventory, open POs, open production orders, lead times, safety stock, minimum order quantity, lot size, supplier constraints, capacity and calendars. Output: purchase, production and transfer recommendations, plus exception alerts.

## 16. Advanced production planning

Build: MPS, MRP, CRP, finite capacity planning, production scheduling and dispatching. Support MTS, MTO, ETO, ATO and CTO.

The scheduling engine considers:

- capacity: machines, labour, tools;
- materials: material availability;
- calendars: shift calendars, maintenance downtime;
- sequencing: changeover time, priority, due dates, setup optimisation.

## 17. MES

A real-time MES:

- orders and execution: production orders, job cards, work instructions, digital work instructions, operator login;
- reporting: production, downtime and scrap reporting, rework, production confirmation;
- tracking: machine status, WIP, labour, material consumption;
- records: electronic batch records, traceability.

Machine states: Running, Idle, Setup, Blocked, Breakdown, Maintenance, Offline. Provide real-time shop-floor dashboards.

## 18. Shop floor control

Operators see:

- work: current job, next job, instructions, quality checks;
- resources: material and tools required, machine status;
- progress: target quantity, produced quantity, rejected quantity, downtime, shift target.

Operators can start, pause and complete a job; report scrap and downtime; request material and maintenance; and raise a quality issue. The interface must be extremely simple.

## 19. IoT / machine connectivity

Protocols: MQTT, OPC-UA, Modbus, REST, WebSocket.

Data collected:

- process: temperature, pressure, vibration, speed;
- electrical: energy, current, voltage;
- production: machine state, cycle time, production count.

Device management covers devices, gateways, sensors, machines and data streams.

## 20. OEE

Real-time availability, performance, quality and OEE, at machine, line, plant, shift, product and operator level. Loss types: availability, performance, quality, setup, breakdown, material shortage, idle time.

## 21. Quality management

Enterprise QMS:

- inspection by stage: incoming QC, in-process QC, final inspection;
- quality by party: supplier quality, customer quality;
- planning: quality plans, inspection plans, sampling plans, inspection characteristics, control plan;
- problem solving: non-conformance, CAPA (corrective and preventive action), 8D, root cause analysis;
- analysis: SPC, FMEA.

Support Six Sigma, Lean, ISO workflows and audit management.

## 22. Quality inspection engine

Inspection types:

- by data: attribute and variable inspection;
- by coverage: sampling, 100% inspection;
- capture: automatic and manual measurement;
- evaluation: pass/fail, tolerance limits, specification limits.

Failed material is quarantined automatically.

## 23. Maintenance / EAM / CMMS

Full asset management:

- assets: registry, hierarchy, machine history, asset lifecycle;
- maintenance types: preventive, predictive, corrective, breakdown;
- execution: work orders, schedules, checklists, technician management;
- resources and cost: spare parts, maintenance costs.

AI: failure prediction, maintenance recommendation, remaining useful life, anomaly detection.

## 24. Spare parts management

Track spare-part inventory, critical spares, machine compatibility, min/max stock, consumption, replacement history, supplier and lead time. Recommend replenishment automatically.

## 25. Finance & accounting

A complete finance system:

- ledgers: general ledger, accounts payable, accounts receivable;
- cash and bank: cash management, bank reconciliation;
- assets: fixed assets, depreciation;
- planning and cost: cost accounting, budgeting;
- documents: tax, invoices, credit notes, debit notes, payments, receipts, expenses.

Manufacturing costing: standard, actual and estimated cost; material, labour and machine cost; overhead; variance.

## 26. Costing engine

Product cost = material + labour + machine + energy + overhead + scrap + logistics + other costs. Provide actual vs standard cost, and cost, production, material, labour and overhead variances.

## 27. HR & workforce

Manufacturing-focused HR:

- people and time: employee, attendance, shift, roster, leave;
- pay: payroll integration;
- capability: skills, certifications, training, competency, machine authorisation.

Track employee → skill → machine → operation.

## 28. Shift management

Shift templates, shift calendars, breaks, overtime, and holiday, machine and employee calendars. Production planning must consider these calendars automatically.

## 29. Supply chain management

The end-to-end chain: supplier → procurement → inbound → warehouse → production → outbound → customer. Track lead time, transit time, supplier reliability, demand, supply, inventory and logistics. Create a supply-chain control tower.

## 30. Logistics management

Support:

- planning: shipment planning, route planning;
- fleet and carriers: vehicle management, carrier management;
- execution: dispatch, tracking, proof of delivery;
- cost and paperwork: freight costing, transport documents.

Integrate external logistics APIs.

## 31–33. Portals

Each portal gives secure access to the user's own records:

- **Customer portal:** orders, quotes, invoices, payments, shipments, documents, production status, quality documents, support tickets, complaints, service requests.
- **Supplier portal:** RFQs, purchase orders, schedules, ASN, delivery status, invoices, quality results, documents, performance scorecards.
- **Employee portal:** attendance, tasks, shift, production targets, training, documents, leave, requests, notifications.

## 34. Service management

Service requests, tickets, warranty, installation, AMC, field service, technician assignment, service contracts, service parts, service history.

## 35. Project management

For ETO and project manufacturing:

- planning: projects, tasks, milestones, resources;
- money: budget, cost, billing, project profitability;
- linked operations: BOM, procurement, production.

## 36. Document management

A central document system:

- documents with versioning, relationships and templates;
- control: approval, access control, digital signatures, expiry.

AI extraction from PDFs, invoices, POs, drawings, specifications, certificates and inspection reports.

## 37. Workflow engine

A visual workflow builder with conditional branching.

Triggers:

- record events: record created, record updated;
- time: date/time;
- conditions: threshold reached, machine event, quality failure, inventory shortage, payment overdue.

Actions:

- decisions: approve, reject;
- messages: notify, send email, send WhatsApp;
- create records: task, PO, production order;
- other: call API, update record, run AI agent.

## 38. Notification engine

Channels: in-app, email, SMS, WhatsApp, push, voice. Support immediate and scheduled notifications, escalations, reminders, digests and alert rules.

## 39. AI copilot

Users can ask questions such as:

- "What is causing today's production loss?", "Which machines are at risk?", "Why is inventory increasing?", "Which suppliers are underperforming?"
- "Show delayed production orders.", "Why is order XYZ delayed?", "Explain today's OEE.", "Which products have declining margins?", "Summarize today's factory performance."
- "Generate a purchase plan.", "Create a production schedule."

The AI must use authorised enterprise data and tools, not just generate text: natural language → intent → permission check → tool execution → result → explanation.

## 40. AI agents

Specialised agents: sales, procurement, inventory, planning, production, quality, maintenance, finance, HR, customer service, supply chain and management.

Agents operate under permissions, approval rules, budget limits, audit logs and human-in-the-loop controls. No high-impact action executes automatically without configurable authorisation.

## 41. Predictive analytics

ML pipelines:

- demand and supply: demand forecasting, inventory optimisation, lead-time prediction, supplier risk;
- operations: machine failure, maintenance prediction, quality prediction, production delay;
- commercial and finance: customer churn, cash-flow forecasting.

Every prediction shows the prediction, confidence, input factors, timestamp and model version.

## 42. Digital twin

A digital representation of factory, plant, production lines, machines, warehouse, inventory, orders and production status. Visualise the current, historical and future planned state.

## 43. Simulation engine

Users can simulate questions such as:

- "What if machine X goes down?" or "What if supplier delivery is delayed?"
- "What if demand increases 20%?" or "What if material cost increases?"
- "What if we add another machine?" or "What if we change shift timings?"

Results show the impact on capacity, cost, delivery, inventory and profitability.

## 44. Business intelligence

Dashboards: executive, plant, production, sales, finance, procurement, inventory, quality, maintenance, supply chain, HR. Support real-time dashboards, drill-down, filters, cross-filtering, saved and scheduled reports, and exports.

## 45. KPI engine

KPIs:

- financial: revenue, gross margin, net margin, cost variance, quality cost;
- production: production volume, OEE, yield, scrap, rework, downtime;
- delivery: OTIF, supplier OTIF, forecast accuracy;
- inventory and working capital: inventory turnover, inventory days, DPO, DSO, cash conversion cycle;
- utilisation: capacity, machine and labour utilisation.

Allow custom KPIs.

## 46. Executive control tower

Shows revenue, orders, production, capacity, inventory, cash, quality, maintenance, supply chain, customer issues, supplier issues and critical alerts. Automatically identifies critical problems, emerging risks, bottlenecks, cost leakage, revenue opportunities and operational anomalies.

## 47. Mobile application

Apps for executives, managers, sales, warehouse, production operators, maintenance technicians, quality inspectors and drivers. Support Android and iOS, offline mode, push notifications, barcode and QR scanning, camera, voice commands, and location where appropriate.

## 48. Voice interface

Example commands:

- "Show today's production." · "Show stock of item ABC." · "Why is line 2 delayed?"
- "Start production order 1024." · "Report 5 defective units." · "Create a maintenance request."

Voice must respect permissions.

## 49. Search

Global search across customers, suppliers, products, orders, invoices, machines, employees, documents, production orders, quality records and maintenance records. Supports natural-language search.

## 50. AI document intelligence

Extract data from invoices, POs, delivery challans, GRNs, quality certificates, technical documents, contracts and drawings. Map the extracted fields into ERP records, with human verification available.

## 51. Security

- Identity: OAuth2, OIDC, JWT, MFA, SSO.
- Access: RBAC, ABAC, session management, device management, IP restrictions.
- Data protection: encryption at rest and in transit, secrets management.
- API: API security, rate limiting, WAF compatibility.
- Monitoring: audit logging, security alerts.

Follow OWASP, zero-trust principles, a secure SDLC and least privilege.

## 52. Audit system

Every critical operation is auditable, recording who, what, when, where, before, after, reason, approval and source. Audit logs are immutable or protected against unauthorised modification.

## 53. API platform

REST, webhook, WebSocket and event APIs; API keys and OAuth; a developer portal; API documentation; rate limits. Use OpenAPI.

## 54. Integrations

Connectors for:

- finance: accounting systems, payment gateways, banks, tax systems, government systems;
- commerce: CRM, e-commerce, marketplaces, shipping providers;
- communication: email, WhatsApp, SMS;
- engineering and operations: CAD/PLM, IoT, HR systems;
- data: cloud storage, BI.

Build an integration framework rather than hard-coding each integration.

## 55. Marketplace / app ecosystem

A future platform where third parties build apps, plugins, connectors, reports, AI agents, industry modules and workflows. Provide developer APIs and an SDK strategy.

## 56. Manufacturing types

Configurable industry templates:

- engineered products: automotive, aerospace, electronics, engineering, machinery, precision manufacturing, defence manufacturing;
- regulated and process: pharmaceutical, medical devices, food, chemicals, plastics;
- consumer and textile: textile, garments, furniture, FMCG, consumer goods;
- materials and energy: construction materials, renewable energy.

Do not create separate software per industry; create configurable industry packs.

## 57. Configuration engine

Administrators configure fields, forms, tables, workflows, approvals, statuses, roles, permissions, notifications, dashboards, reports, business rules, pricing, taxes, sequences and documents. Prefer a metadata-driven architecture.

## 58. UX requirements

Minimal clicks, fast navigation, a command centre, global search, keyboard shortcuts, responsive design, dark and light modes, accessible UI and role-based dashboards.

Distinct experiences for operator, supervisor, manager, plant head, CFO, COO, CEO and admin. Do not overwhelm operators with enterprise-level complexity.

## 59. Performance

Targets: fast page loads, real-time updates, horizontal scalability, background job processing, caching, database indexing, queue processing, lazy loading, pagination and bulk operations. Define measurable SLA/SLO targets. Load test at 100, 1,000, 10,000 and 100,000+ concurrent users where architecturally applicable.

## 60. Data architecture

Define the transactional database, analytics database, object storage, search index, cache, message broker, and data warehouse/lakehouse strategy. Clearly separate OLTP and analytical workloads.

## 61. Observability

Logs, metrics, distributed tracing, error tracking, health checks, and performance, audit and infrastructure monitoring. Create operational dashboards.

## 62. DevOps

Environments: local development, development, testing, staging and production. A CI/CD pipeline that automates build, lint, unit tests, integration tests, security tests, migration tests, deployment and rollback. Use infrastructure-as-code.

## 63. Testing

Test types:

- code and API: unit, integration, API, E2E;
- non-functional: security, performance, load;
- platform rules: tenant isolation, RBAC, workflow;
- domain calculations: manufacturing, financial;
- AI evaluation.

Target high coverage for business-critical modules.

## 64. Data validation

Every transaction validates permissions, master data, business rules, financial rules, inventory availability, manufacturing constraints and workflow status. Never silently corrupt data.

## 65. Backup & disaster recovery

Automated backups, point-in-time recovery, backup encryption, replication, disaster recovery and restore testing. Define RPO and RTO.

## 66. Localisation

Regions: India, US, EU, UK, Middle East, Southeast Asia. Support different taxes, currencies, languages, date and number formats, accounting rules and compliance requirements.

## 67. India-first features

Architecture for GST, GST invoicing, e-invoice, e-way bill, TDS, TCS, HSN/SAC, Indian accounting requirements, UPI/payment integration and Indian payroll integrations. Compliance is configurable and versioned.

## 68. Reporting

A report builder with dimensions, measures, filters, grouping, sorting and calculated fields. Report areas: operational, financial, manufacturing, quality, inventory, sales, procurement, management.

## 69. Alert & risk engine

Automatically detect:

- inventory: low inventory, excess inventory;
- operations: delayed orders, production bottlenecks, machine failure, quality deterioration, capacity shortages;
- supply: supplier delays;
- finance: margin decline, cash-flow problems;
- integrity: unusual transactions, fraud indicators.

Severity levels: Information, Warning, Critical.

## 70. Rule engine

Configurable business rules, for example:

- IF inventory < safety stock THEN generate a replenishment recommendation.
- IF quality failure rate > threshold THEN create a CAPA.
- IF machine vibration > threshold THEN generate a maintenance alert.
- IF PO amount > approval limit THEN require management approval.

## 71. Approval engine

Configurable multi-level approvals for purchases, discounts, quotations, credit, payments, engineering changes, quality release and production deviations. Supports sequential, parallel, conditional and delegated approval.

## 72. Financial controls

Prevent unauthorised payments, duplicate invoices, duplicate vendors, unauthorised discounts and fraudulent transactions. Provide segregation of duties.

## 73. Analytics data model

A unified business semantic layer over customer, supplier, product, order, inventory, machine, employee, production, quality and finance, so AI and BI query one consistent model.

## 74. AI governance

- Registries and versions: model registry, prompt/version management.
- Oversight: AI audit logs, usage tracking, cost tracking.
- Quality: model evaluation, hallucination controls, fallback models.
- Data: data access controls, PII controls.
- Human approval.

AI must never bypass ERP permissions.

## 75. Commercial model

Tiers: free trial, Starter, Professional, Enterprise, Enterprise Plus. Pricing dimensions: users, plants, modules, transactions, AI usage, storage, API usage. Implement feature flags and entitlement management.

## 76. Billing

SaaS billing:

- catalogue: subscription, plan, add-ons;
- charging: usage, invoice, payment;
- lifecycle: trial, renewal, upgrade, downgrade, proration, cancellation.

## 77. Admin control center

A super admin manages:

- customers: tenants, users, support;
- commercial: plans, modules, features, subscriptions;
- usage: usage, AI usage, API usage;
- operations: system health, security, integrations.

## 78. Customer success

Onboarding, implementation checklist, training, support tickets, knowledge base, product tours, usage analytics, health score.

## 79. Implementation engine

An implementation module covering:

- setup: tenant setup, company setup;
- data loads: master data import, opening balances, BOM, inventory, supplier, customer and user imports;
- configuration: roles, workflows, integrations;
- validation and launch: testing, UAT, go-live checklist.

## 80. Data import

Excel/CSV import with template, validation, preview, error reporting, duplicate detection and rollback. Large imports run asynchronously.

## 81. AI-powered implementation

Customers upload Excel, CSV, PDF or existing ERP exports. The AI identifies customers, suppliers, products, BOMs, inventory and transactions, and assists migration. Never overwrite production data without approval.

## 82. Migration engine

Migration tools for legacy ERPs: SAP, Oracle, Microsoft Dynamics, Tally, Zoho, Odoo, Busy, custom ERPs and Excel. Do not claim direct compatibility unless an actual connector exists. Create mapping tools.

## 83. Product architecture

Core Platform + Manufacturing Platform + Industry Packs + AI Platform + Integration Platform. Modules can be enabled independently.

## 84. Tech stack

Recommend and justify a modern enterprise stack:

- frontend: React / Next.js / TypeScript;
- backend: one of NestJS, Spring Boot, .NET or Go;
- data: PostgreSQL, Redis, OpenSearch or Elasticsearch, S3-compatible storage, ClickHouse or a warehouse;
- messaging: Kafka, Redpanda or RabbitMQ;
- AI/ML: Python services with PyTorch, scikit-learn or other suitable models;
- infrastructure: Docker; Kubernetes when scale justifies it; AWS, Azure or GCP.

Select the minimum architecture that gives enterprise reliability; do not use every technology blindly.

## 85. Repository structure

A clean monorepo with apps/, services/, packages/, shared/, database/, infrastructure/, docs/, tests/, scripts/. Document architectural decisions.

## 86. Database design

A complete ERD: tables, relationships, indexes, constraints, enums, audit fields, tenant keys, soft-delete strategy, versioning and history tables. Every table has id, tenant_id where applicable, and created_at, updated_at, created_by, updated_by where appropriate.

## 87. API design

Specify APIs before implementation. For each domain, define:

- endpoints, request and response schemas;
- validation, authorisation and errors;
- pagination, filtering and sorting;
- idempotency.

Use consistent conventions.

## 88. Error handling

Standard errors contain a code, message, details, correlation ID and timestamp. Never expose secrets or stack traces to end users.

## 89. UX delivery

Before coding each major module, create the user journey, information architecture, wireframes, screen list, state definitions and permission matrix.

## 90. Development methodology

Work in phases, never everything at once:

- **Phase 0:** discovery, architecture, domain model, UX system, security model.
- **Phase 1:** identity, tenant, organisation, master data, RBAC, audit, core platform.
- **Phase 2:** CRM, sales, CPQ, procurement, inventory.
- **Phase 3:** BOM, routing, MRP, planning, production.
- **Phase 4:** MES, WMS, quality, maintenance, IoT.
- **Phase 5:** finance, costing, supply chain, logistics, HR.
- **Phase 6:** PLM, service, projects, portals.
- **Phase 7:** BI, control tower, AI copilot, AI agents, predictive analytics.
- **Phase 8:** digital twin, simulation, advanced optimisation.
- **Phase 9:** marketplace, developer platform, industry packs.

## 91. Development rule

Each phase follows these steps:

1. Analyse requirements, identify dependencies.
2. Design the architecture, database, APIs and UI.
3. Implement the backend, frontend, permissions and audit.
4. Test: unit and integration tests, security validation, performance tests.
5. Fix issues and document.

A feature is complete only when UI, API, database, business logic, validation, permissions, audit, error handling, tests and documentation all exist, never merely because a UI exists.

## 92. No mock functionality

No fake APIs, AI responses, reports, dashboards, payments, notifications, integrations or production calculations. If an integration is unavailable, create an adapter interface and a sandbox implementation, clearly marked as sandbox, and never present it as production-ready.

## 93. AI coding agent rules

Inspect the existing repository first: its architecture, modules, database, APIs, components, authentication and tests. Do not rewrite working components unnecessarily, and maintain backward compatibility.

## 94. Code quality

Code is readable, typed, modular, testable, secure and documented. Avoid:

- structure problems: duplicate logic, god classes, god components, dead code;
- hard-coding: business rules, tenant IDs, credentials;
- temporary production hacks.

## 95. Final deliverables

1. Documentation: PRD, domain architecture, system architecture, ERD, API specification.
2. Access and workflow: RBAC matrix, permission matrix, workflow architecture.
3. Design: UI/UX architecture, design system.
4. Application code: database migrations, backend, frontend, mobile apps.
5. Intelligence and connectivity: AI layer, ML pipelines, IoT architecture, integration framework, reporting engine.
6. Delivery tooling: testing framework, CI/CD, infrastructure-as-code.
7. Guides: security, deployment, admin, user, API, developer and migration documentation.
8. Disaster recovery plan.

## 96. Definition of done

The platform is complete only when business processes work end to end as one connected flow. Example:

- Order to supply: customer order → ATP check → production planning → MRP → purchase requirement → procurement → goods receipt → inventory.
- Make and ship: production → quality inspection → finished goods → warehouse → shipment.
- Bill and close: invoice → payment → accounting → customer notification → analytics.

## 97. Demo scenario

A complete demo company: Artsy Manufacturing Pvt Ltd, Mysuru Plant, product Industrial Pump. The demo includes:

- customer, sales order;
- BOM, routing, machine, operator;
- inventory, MRP;
- supplier, purchase order, GRN;
- production order, quality inspection, finished goods;
- shipment, invoice, payment.

Demonstrate the full lifecycle (see Q21).

## 98. Management demo

The CEO asks "What is happening in the factory today?" The answer uses real data on production, OEE, orders, delays, inventory, quality, maintenance, cash, supplier risk and customer risk, and every metric can be drilled into.

## 99. Competitive differentiation

Differentiate through:

- AI: AI-native workflows, natural-language ERP, AI agents;
- prediction and planning: predictive maintenance, predictive quality, intelligent planning, simulation, digital twin;
- operations: real-time manufacturing, a unified ERP + MES + WMS + QMS + SCM, a real-time control tower, voice operations, IoT integration;
- configurability: configurable workflows, no-code customisation;
- ecosystem: an API ecosystem, industry packs;
- enterprise-grade security.

## 100. Final CTO requirement

Build a 10+ year platform. Optimise for scalability, maintainability, security, extensibility, interoperability, data integrity, AI readiness, global deployment, enterprise adoption and long-term product economics.

Before each major decision, explain why, trade-offs, alternatives, risks, and scalability, security and cost impact. Never hide architectural problems; where a requested feature conflicts with good architecture, identify the conflict and propose a better architecture.

## First task

Before implementing, produce 24 deliverables:

1. Product architecture: product architecture, module map, domain boundaries.
2. Technical architecture: system, database, API, event, AI, security and multi-tenancy architecture.
3. Access: role/permission architecture, user-role matrix.
4. Process and UI: manufacturing process map, UI information architecture.
5. Planning: roadmap, dependency graph.
6. Scope: MVP, enterprise version, future advanced version.
7. Engineering: technology stack, repository structure, testing strategy, deployment architecture.
8. Risks and architectural bottlenecks.

Then wait for approval before implementing Phase 1. Do not skip dependencies or claim anything is implemented that does not exist in the repository.
