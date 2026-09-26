# 03 — Core ERD: Phase 0 and Phase 1

Status: **Draft for approval** · Last updated: 2026-09-24

---

## 0. Conventions that apply to every table

| Convention              | Rule                                                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Schema per module       | `platform.*`, `masterdata.*`, `finance.*`, `sales.*`, `procurement.*`, `inventory.*`, `engineering.*`, `production.*`, `loc_in.*` (India pack), `ai.*`, `integration.*`, `ext.*` (extensions)                                        |
| Primary key             | `id uuid` (UUIDv7, time-ordered, generated in the app)                                                                                                                                                                               |
| Tenancy                 | `tenant_id uuid not null` on every tenant-owned table, with an RLS policy (ADR-0005). Unique constraint on `(tenant_id, id)`. **Foreign keys are composite `(tenant_id, x_id)`**, so a row can never point at another tenant's row   |
| Company scope           | `company_id` on every transactional table. `plant_id` where relevant                                                                                                                                                                 |
| Cross-module FKs        | Allowed **only** towards `platform` and `masterdata` (upstream, stable). Otherwise references across modules are by id, validated in the application, with no DB constraint. This keeps modules extractable (ADR-0002)               |
| Standard columns        | `created_at timestamptz`, `created_by uuid`, `updated_at`, `updated_by`, `version int` (optimistic lock), `source text` (ui/api/import/agent/integration)                                                                            |
| Transactional documents | `status` enum following Draft → Submitted → Approved → Posted → Cancelled/Reversed. `doc_no` from a numbering series. `posting_date date`, `document_date date`. No hard deletes (DB role lacks DELETE; soft-delete only for drafts) |
| Money                   | `NUMERIC(20,6)` plus a `currency char(3)` column. Document header stores `fx_rate NUMERIC(18,9)` and base-currency amounts                                                                                                           |
| Quantity                | `NUMERIC(20,6)` plus `uom_id`. Lines also store `base_qty` in the item's base UoM                                                                                                                                                    |
| Extensions              | `ext jsonb not null default '{}'`, validated against `platform.custom_field_def` with a GIN index                                                                                                                                    |
| Ledgers                 | `inventory.stock_ledger_entry`, `finance.journal_line` and `platform.audit_log` are **INSERT-only** (UPDATE/DELETE revoked plus a trigger guard)                                                                                     |

The diagrams show key columns only. Full DDL comes with each module's migration.

---

## 1. Platform (Phase 0)

```mermaid
erDiagram
  TENANT ||--o{ COMPANY : has
  TENANT ||--o{ APP_USER : has
  TENANT ||--o{ TENANT_ENTITLEMENT : licensed_for
  COMPANY ||--o{ PLANT : has
  COMPANY ||--o{ FISCAL_YEAR : uses
  PLANT ||--o{ DEPARTMENT : has
  APP_USER ||--o{ USER_ROLE : assigned
  ROLE ||--o{ USER_ROLE : granted_via
  ROLE ||--o{ ROLE_PERMISSION : includes
  PERMISSION ||--o{ ROLE_PERMISSION : in
  USER_ROLE }o--o| COMPANY : scoped_to
  USER_ROLE }o--o| PLANT : scoped_to
  ROLE ||--o{ FIELD_POLICY : restricts
  SOD_RULE }o--o{ PERMISSION : conflicts
  NUMBERING_SERIES ||--o{ NUMBERING_COUNTER : per_fy_plant
  WORKFLOW_DEFINITION ||--o{ WORKFLOW_VERSION : versions
  WORKFLOW_VERSION ||--o{ WORKFLOW_INSTANCE : runs
  WORKFLOW_INSTANCE ||--o{ APPROVAL_TASK : creates
  APP_USER ||--o{ APPROVAL_TASK : assignee
  APP_USER ||--o{ DELEGATION : delegates
  CUSTOM_OBJECT_DEF ||--o{ CUSTOM_FIELD_DEF : fields
  CUSTOM_OBJECT_DEF ||--o{ CUSTOM_RECORD : instances
  APP_USER ||--o{ NOTIFICATION : receives
  DOCUMENT ||--o{ DOCUMENT_VERSION : versions
  DOCUMENT ||--o{ DOCUMENT_LINK : attached_to_any_record

  TENANT {
    uuid id PK
    text slug UK
    text name
    text edition "starter|growth|enterprise"
    text cell_id "pooled or dedicated cell"
    text data_region
    text status
    text default_locale
    text default_timezone
  }
  COMPANY {
    uuid id PK
    uuid tenant_id FK
    text legal_name
    char3 base_currency
    text country_code
    text gstin "via loc_in extension"
    text pan
    uuid fiscal_calendar_id
  }
  PLANT {
    uuid id PK
    uuid tenant_id FK
    uuid company_id FK
    text code
    text name
    text state_code "GST place of supply"
    uuid address_id
  }
  FISCAL_YEAR {
    uuid id PK
    uuid company_id FK
    text code "2026-27"
    date start_date
    date end_date
    text status
  }
  APP_USER {
    uuid id PK
    uuid tenant_id FK
    text idp_subject UK "Keycloak sub"
    text email
    text display_name
    text locale
    text timezone
    uuid employee_id "HR, P2"
    text user_type "internal|portal|agent"
  }
  ROLE {
    uuid id PK
    uuid tenant_id "null = system role"
    text code
    jsonb name_i18n
  }
  PERMISSION {
    text code PK "inventory.goods_receipt.post"
    text module
    text feature_key "entitlement gate"
  }
  USER_ROLE {
    uuid id PK
    uuid user_id FK
    uuid role_id FK
    uuid company_id "nullable scope"
    uuid plant_id "nullable scope"
    jsonb conditions "ABAC e.g. amount_lte"
    date valid_from
    date valid_to
  }
  FIELD_POLICY {
    uuid id PK
    uuid role_id FK
    text entity
    text field
    text access "hidden|read|write"
  }
  SOD_RULE {
    uuid id PK
    text code
    text permission_a
    text permission_b
    text severity
  }
  NUMBERING_SERIES {
    uuid id PK
    uuid company_id FK
    text doc_type
    text pattern "INV/{PLANT}/{FY}/{#####}"
    bool gapless "true for GST invoices"
  }
  NUMBERING_COUNTER {
    uuid series_id FK
    uuid plant_id
    uuid fiscal_year_id
    bigint next_value
  }
  WORKFLOW_DEFINITION {
    uuid id PK
    text entity_type
    text trigger "on_submit etc"
  }
  WORKFLOW_VERSION {
    uuid id PK
    int version
    jsonb definition "DSL: steps, conditions, SLA, escalation"
    text status
  }
  WORKFLOW_INSTANCE {
    uuid id PK
    text entity_type
    uuid entity_id
    text temporal_workflow_id
    text status
  }
  APPROVAL_TASK {
    uuid id PK
    uuid instance_id FK
    uuid assignee_id
    timestamptz due_at
    text decision
    text comment
    timestamptz decided_at
  }
  DELEGATION {
    uuid id PK
    uuid from_user_id
    uuid to_user_id
    date valid_from
    date valid_to
  }
  CUSTOM_OBJECT_DEF {
    uuid id PK
    text api_name
    bool is_core "true = extends a core entity"
  }
  CUSTOM_FIELD_DEF {
    uuid id PK
    uuid object_def_id FK
    text api_name
    text data_type
    jsonb validation
    jsonb label_i18n
  }
  CUSTOM_RECORD {
    uuid id PK
    uuid object_def_id FK
    jsonb data
  }
  TENANT_ENTITLEMENT {
    uuid tenant_id FK
    text feature_key
    int limit_value
    date valid_to
  }
  NOTIFICATION {
    uuid id PK
    uuid user_id FK
    text channel
    text template_key
    jsonb payload
    text status
  }
  DOCUMENT {
    uuid id PK
    text title
    text classification
    uuid retention_policy_id
  }
  DOCUMENT_VERSION {
    uuid id PK
    uuid document_id FK
    int version
    text object_key "S3 key"
    text sha256
    text ocr_text
  }
  DOCUMENT_LINK {
    uuid document_id FK
    text entity_type
    uuid entity_id
  }
```

Plus these infrastructure tables (not drawn):

- `platform.audit_log`: id, tenant_id, entity_type, entity_id, action, before jsonb, after jsonb, actor_type, actor_id, on_behalf_of, source, correlation_id, ip, at, prev_hash, hash.
- `platform.outbox`: id (= event id), tenant_id, aggregate_type, aggregate_id, event_type, payload jsonb, created_at, published_at.
- `platform.inbox`: consumer, event_id (PK pair), processed_at.
- `platform.idempotency_key`: tenant_id, key, request_hash, response, expires_at.

The **control plane** (tenant registry, cells, subscriptions, meters) has its own database and does not appear here.

---

## 2. Master Data (Phase 1)

```mermaid
erDiagram
  UOM_CLASS ||--o{ UOM : groups
  UOM ||--o{ UOM_CONVERSION : from
  ITEM_CATEGORY ||--o{ ITEM : classifies
  ITEM ||--o{ ITEM_UOM : alt_uoms
  ITEM ||--o{ ITEM_REVISION : revisions
  ITEM ||--o{ ITEM_PLANT : plant_settings
  PARTY ||--o{ PARTY_ROLE : plays
  PARTY ||--o{ PARTY_ADDRESS : has
  PARTY ||--o{ CONTACT : has
  PARTY ||--o{ PARTY_BANK_ACCOUNT : pays_to
  PARTY ||--o{ PARTY_TAX_REG : registered

  ITEM {
    uuid id PK
    text code UK
    jsonb name_i18n
    text item_type "raw|semi|finished|consumable|service|tool|spare"
    uuid base_uom_id FK
    uuid category_id FK
    text tracking "none|lot|serial"
    int shelf_life_days
    text hsn_sac "loc_in"
    text valuation_method "fifo|moving_avg|standard"
    text procurement_type "make|buy|both|subcontract"
    bool is_blocked
    jsonb attributes
    vector embedding "pgvector, similarity search"
  }
  ITEM_PLANT {
    uuid item_id FK
    uuid plant_id FK
    numeric reorder_point
    numeric safety_stock
    numeric min_order_qty
    int lead_time_days
    uuid default_warehouse_id
  }
  ITEM_REVISION {
    uuid id PK
    uuid item_id FK
    text revision
    date effective_from
    text status
  }
  UOM {
    uuid id PK
    text code "KG, NOS, MTR"
    text uqc "GST unit quantity code"
    int precision
  }
  UOM_CONVERSION {
    uuid from_uom_id
    uuid to_uom_id
    uuid item_id "nullable = global"
    numeric factor
  }
  PARTY {
    uuid id PK
    text code UK
    text legal_name
    text party_type "company|individual"
    text pan
    text msme_category "micro|small|medium|null"
    text udyam_no
    text status
  }
  PARTY_ROLE {
    uuid party_id FK
    text role "customer|supplier|transporter|job_worker"
    uuid company_id
    uuid payment_terms_id
    uuid receivable_or_payable_account_id
    numeric credit_limit
    uuid price_list_id
  }
  PARTY_TAX_REG {
    uuid party_id FK
    text country_code
    text reg_type "GSTIN"
    text reg_no
    text state_code
    text status "verified|unverified"
    timestamptz verified_at
  }
  PARTY_ADDRESS {
    uuid id PK
    uuid party_id FK
    text purpose "billing|shipping"
    text state_code
    text pincode
  }
```

---

## 3. Inventory (Phase 1)

```mermaid
erDiagram
  PLANT ||--o{ WAREHOUSE : has
  WAREHOUSE ||--o{ LOCATION : contains
  ITEM ||--o{ LOT : batches
  ITEM ||--o{ SERIAL : units
  LOT ||--o{ SERIAL : groups
  STOCK_LEDGER_ENTRY }o--|| ITEM : moves
  STOCK_LEDGER_ENTRY }o--|| LOCATION : at
  STOCK_LEDGER_ENTRY }o--o| LOT : lot
  STOCK_LEDGER_ENTRY }o--o| SERIAL : serial
  STOCK_LEDGER_ENTRY ||--o| STOCK_LEDGER_ENTRY : reverses
  STOCK_BALANCE }o--|| ITEM : of
  VALUATION_LAYER }o--|| STOCK_LEDGER_ENTRY : created_by
  GENEALOGY_LINK }o--|| LOT : parent_child

  WAREHOUSE {
    uuid id PK
    uuid plant_id FK
    text code
    text wh_type "stores|wip|fg|qc|rejected|jobwork|consignment|transit"
    bool bin_managed
  }
  LOCATION {
    uuid id PK
    uuid warehouse_id FK
    text code "A-01-03"
    uuid parent_id "zone > aisle > bin"
    text barcode
  }
  LOT {
    uuid id PK
    uuid item_id FK
    text lot_no
    date mfg_date
    date expiry_date
    uuid supplier_party_id
    text supplier_lot_no
    jsonb attributes "potency etc"
  }
  SERIAL {
    uuid id PK
    uuid item_id FK
    text serial_no
    uuid lot_id
    text status
  }
  STOCK_LEDGER_ENTRY {
    uuid id PK
    uuid company_id
    uuid plant_id
    uuid item_id
    uuid location_id
    uuid lot_id
    uuid serial_id
    text stock_status "unrestricted|qc_hold|blocked|rejected"
    text owner "own|consignment|customer_owned|at_job_worker"
    numeric qty_base "signed"
    numeric value_base "signed, base currency"
    text movement_type "GR_PO, GI_WO, GR_WO, GI_SO, TRANSFER, ADJ, ..."
    text source_doc_type
    uuid source_doc_id
    uuid source_line_id
    uuid journal_entry_id
    uuid reverses_entry_id
    date posting_date
    timestamptz posted_at
  }
  STOCK_BALANCE {
    uuid item_id
    uuid location_id
    uuid lot_id
    uuid serial_id
    text stock_status
    text owner
    numeric qty_base
    numeric value_base
    numeric reserved_qty
  }
  VALUATION_LAYER {
    uuid id PK
    uuid item_id
    uuid plant_id
    numeric qty_remaining
    numeric unit_cost
    uuid entry_id FK
  }
  GENEALOGY_LINK {
    uuid parent_lot_or_serial
    uuid child_lot_or_serial
    uuid work_order_id
    numeric qty
  }
```

`STOCK_BALANCE` is a **derived, lock-protected projection**. It is updated in the same transaction as each ledger insert (`SELECT … FOR UPDATE`) so negative-stock checks and ATP are exact. A nightly job re-derives balances from the ledger and alerts on any drift.

---

## 4. Finance and tax (Phase 1)

```mermaid
erDiagram
  COMPANY ||--o{ GL_ACCOUNT : chart
  GL_ACCOUNT ||--o{ GL_ACCOUNT : parent
  FISCAL_YEAR ||--o{ FISCAL_PERIOD : periods
  JOURNAL_ENTRY ||--|{ JOURNAL_LINE : lines
  JOURNAL_LINE }o--|| GL_ACCOUNT : account
  JOURNAL_LINE }o--o| COST_CENTRE : dim
  JOURNAL_LINE }o--o| PARTY : subledger
  JOURNAL_ENTRY ||--o| JOURNAL_ENTRY : reverses
  POSTING_RULE }o--|| GL_ACCOUNT : determines
  OPEN_ITEM }o--|| JOURNAL_LINE : from
  PAYMENT ||--o{ PAYMENT_ALLOCATION : allocates
  PAYMENT_ALLOCATION }o--|| OPEN_ITEM : settles
  BANK_ACCOUNT ||--o{ BANK_TRANSACTION : statement
  BANK_TRANSACTION ||--o{ RECON_MATCH : matched
  TAX_CODE ||--o{ TAX_RATE : rates
  TAX_LINE }o--|| TAX_CODE : uses

  GL_ACCOUNT {
    uuid id PK
    uuid company_id
    text code
    jsonb name_i18n
    text account_type "asset|liability|equity|income|expense"
    text subtype "bank|ar|ap|inventory|grir|tax|..."
    bool is_group
    bool is_control "subledger only"
  }
  FISCAL_PERIOD {
    uuid id PK
    uuid fiscal_year_id
    int period_no
    date start_date
    date end_date
    text status "open|soft_closed|closed"
  }
  JOURNAL_ENTRY {
    uuid id PK
    uuid company_id
    text doc_no
    text journal_type "GRN, SINV, PINV, PAY, JV, ..."
    date posting_date
    uuid period_id
    text source_doc_type
    uuid source_doc_id
    char3 currency
    numeric fx_rate
    uuid reverses_entry_id
    text status "posted|reversed"
  }
  JOURNAL_LINE {
    uuid id PK
    uuid journal_entry_id FK
    uuid account_id
    numeric debit_base
    numeric credit_base
    numeric amount_txn "signed"
    uuid party_id
    uuid cost_centre_id
    uuid profit_centre_id
    uuid plant_id
    uuid item_id
    jsonb dimensions
  }
  POSTING_RULE {
    uuid id PK
    uuid company_id
    text event_key "GR_PO.inventory"
    jsonb match "item_category, plant, ..."
    uuid account_id
  }
  OPEN_ITEM {
    uuid id PK
    uuid party_id
    text side "ar|ap"
    numeric amount_open
    date due_date
    text msme_flag "43B(h)"
  }
  PAYMENT {
    uuid id PK
    text direction "in|out"
    uuid party_id
    uuid bank_account_id
    numeric amount
    text mode "neft|rtgs|upi|cheque|cash"
    text utr
  }
  BANK_TRANSACTION {
    uuid id PK
    uuid bank_account_id
    date value_date
    numeric amount
    text narration
    text reference
    text match_status
  }
  TAX_CODE {
    uuid id PK
    text country_code
    text code "GST18, IGST18, RCM..."
    text tax_type
  }
  TAX_LINE {
    uuid id PK
    text source_doc_type
    uuid source_line_id
    uuid tax_code_id
    text component "CGST|SGST|IGST|CESS|TDS|TCS"
    numeric taxable_base
    numeric rate
    numeric amount
    bool reverse_charge
  }
```

**Balance enforcement:** a deferred constraint trigger checks `SUM(debit_base) = SUM(credit_base)` per `journal_entry_id` at commit. Posting into a closed period is rejected in the domain layer and again by a trigger. `gl_balance` (account × period × dimensions) is a lock-protected projection, the same pattern as `stock_balance`.

**India pack tables** (`loc_in.*`): `e_invoice` (IRN, ack no/date, signed QR, status, request/response log), `e_way_bill` (EWB no, validity, vehicle, part-B updates), `gstr2b_line` + `itc_match`, `tds_section`, `tds_deduction`, `itc04_record`, `msme_payment_tracker`, `gateway_provider_config` (per GSTIN × capability → provider, with the secret held in Vault), `gateway_call_log`. They reference core documents by `(source_doc_type, source_doc_id)`, and core has no knowledge of them (ADR-0011).

---

## 5. Sales and procurement (Phase 1)

```mermaid
erDiagram
  PRICE_LIST ||--o{ PRICE_LIST_ITEM : prices
  QUOTATION ||--|{ QUOTATION_LINE : lines
  QUOTATION ||--o| SALES_ORDER : converts_to
  SALES_ORDER ||--|{ SALES_ORDER_LINE : lines
  SALES_ORDER_LINE ||--o{ SO_SCHEDULE_LINE : schedule
  SALES_ORDER ||--o{ DELIVERY : fulfilled_by
  DELIVERY ||--|{ DELIVERY_LINE : lines
  DELIVERY ||--o{ SALES_INVOICE : billed_by
  SALES_INVOICE ||--|{ SALES_INVOICE_LINE : lines
  SALES_RETURN ||--|{ SALES_RETURN_LINE : lines

  PURCHASE_REQUISITION ||--|{ PR_LINE : lines
  RFQ ||--|{ RFQ_LINE : lines
  RFQ ||--o{ SUPPLIER_QUOTATION : responses
  PR_LINE }o--o| PO_LINE : sourced_into
  PURCHASE_ORDER ||--|{ PO_LINE : lines
  PO_LINE ||--o{ PO_SCHEDULE_LINE : schedule
  PURCHASE_ORDER ||--o{ GOODS_RECEIPT : received_by
  GOODS_RECEIPT ||--|{ GRN_LINE : lines
  GRN_LINE }o--|| PO_LINE : against
  PURCHASE_INVOICE ||--|{ PINV_LINE : lines
  PINV_LINE }o--o| GRN_LINE : matched_3way
  JOBWORK_CHALLAN ||--|{ JOBWORK_CHALLAN_LINE : lines

  SALES_ORDER {
    uuid id PK
    uuid company_id
    uuid plant_id
    text doc_no
    uuid customer_party_id
    uuid bill_to_address_id
    uuid ship_to_address_id
    text place_of_supply
    char3 currency
    numeric fx_rate
    text order_type "standard|blanket|scheduled|jobwork_in"
    text customer_po_no
    numeric total_base
    text status
    int version
  }
  SALES_ORDER_LINE {
    uuid id PK
    uuid item_id
    uuid item_revision_id
    numeric qty
    uuid uom_id
    numeric base_qty
    numeric unit_price
    numeric discount_pct
    date promised_date
    numeric delivered_qty
    numeric invoiced_qty
  }
  SALES_INVOICE {
    uuid id PK
    text doc_no "gapless series"
    date invoice_date
    uuid customer_party_id
    text supply_type "B2B|B2C|EXP|SEZ"
    numeric taxable_total
    numeric tax_total
    numeric grand_total
    uuid journal_entry_id
    text status
  }
  PURCHASE_ORDER {
    uuid id PK
    text doc_no
    uuid supplier_party_id
    uuid plant_id
    text po_type "standard|blanket|rate_contract|subcontract|import"
    char3 currency
    numeric total_base
    text status
    int version
  }
  PO_LINE {
    uuid id PK
    uuid item_id
    numeric qty
    numeric unit_price
    numeric received_qty
    numeric invoiced_qty
    numeric tolerance_pct
    bool inspection_required
  }
  GOODS_RECEIPT {
    uuid id PK
    text doc_no
    uuid supplier_party_id
    text supplier_challan_no
    text vehicle_no
    text eway_bill_no
    date receipt_date
    text status
  }
  GRN_LINE {
    uuid id PK
    uuid po_line_id
    uuid item_id
    numeric received_qty
    numeric accepted_qty
    numeric rejected_qty
    uuid lot_id
    uuid location_id
    text stock_status "qc_hold on receipt if required"
  }
  PURCHASE_INVOICE {
    uuid id PK
    text supplier_invoice_no
    date supplier_invoice_date
    numeric grand_total
    text match_status
    uuid source_document_id "AI-extracted PDF"
  }
```

---

## 6. Engineering and production (Phase 1, basic)

```mermaid
erDiagram
  ITEM ||--o{ BOM : has
  BOM ||--|{ BOM_LINE : components
  BOM_LINE }o--|| ITEM : component
  ITEM ||--o{ ROUTING : has
  ROUTING ||--|{ ROUTING_OPERATION : steps
  ROUTING_OPERATION }o--|| WORK_CENTRE : at
  WORK_CENTRE }o--|| PLANT : in
  WORK_ORDER }o--|| BOM : exploded_from
  WORK_ORDER }o--|| ROUTING : follows
  WORK_ORDER ||--|{ WO_COMPONENT : requires
  WORK_ORDER ||--|{ WO_OPERATION : operations
  WORK_ORDER ||--o{ MATERIAL_ISSUE : consumes
  WORK_ORDER ||--o{ PRODUCTION_CONFIRMATION : outputs

  BOM {
    uuid id PK
    uuid item_id
    uuid item_revision_id
    text bom_usage "engineering|manufacturing|service"
    numeric base_qty
    date effective_from
    date effective_to
    text status "draft|released|obsolete"
  }
  BOM_LINE {
    uuid id PK
    uuid component_item_id
    numeric qty_per
    uuid uom_id
    numeric scrap_pct
    text line_type "normal|phantom|by_product|co_product"
    text issue_method "manual|backflush"
    int alt_group
  }
  WORK_CENTRE {
    uuid id PK
    text code
    text wc_type "machine|line|labour|subcontract"
    numeric capacity_per_day_hrs
    numeric cost_rate_per_hr
  }
  ROUTING_OPERATION {
    uuid id PK
    int seq
    uuid work_centre_id
    numeric setup_min
    numeric run_min_per_unit
    bool inspection_point
  }
  WORK_ORDER {
    uuid id PK
    text doc_no
    uuid plant_id
    uuid item_id
    numeric planned_qty
    numeric completed_qty
    numeric scrap_qty
    date planned_start
    date planned_end
    text order_type "mts|mto|rework|jobwork_in"
    uuid sales_order_line_id "MTO pegging"
    text status "draft|released|in_progress|completed|closed"
  }
  PRODUCTION_CONFIRMATION {
    uuid id PK
    uuid work_order_id
    uuid wo_operation_id
    numeric good_qty
    numeric scrap_qty
    uuid scrap_reason_id
    uuid output_lot_id
    numeric labour_min
    numeric machine_min
    uuid operator_user_id
    bool is_final
  }
```

---

## 7. AI and integration (Phase 1 foundation)

| Table                              | Key columns                                                                                                                                                                                                                                | Purpose                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `ai.action_log`                    | id, tenant_id, actor (agent/copilot), on_behalf_of_user_id, session_id, tool, input jsonb, reasoning_summary, output jsonb, affected_entities, status (proposed/approved/executed/reversed), approved_by, reversal_of, model, tokens, cost | PRD §6.3 guardrails: every AI action logged, reversible, labelled |
| `ai.model_policy`                  | tenant_id, use_case, provider, model, allow_external, redaction_level                                                                                                                                                                      | Per-tenant model choice                                           |
| `ai.embedding`                     | tenant_id, source_type, source_id, chunk_no, content_hash, vector, acl_hash                                                                                                                                                                | RAG and similarity search with permission filtering               |
| `integration.import_job`           | id, kind (excel/tally), mapping_profile_id, status, stats, error_file_key                                                                                                                                                                  | AI-assisted migration                                             |
| `integration.webhook_subscription` | event_types, url, secret_ref, status                                                                                                                                                                                                       | Outbound webhooks                                                 |
| `integration.tally_mapping`        | company_id, entity_type, manuling_id, tally_name, tally_guid                                                                                                                                                                               | Tally migration and export mapping (ADR-0012)                     |
| `integration.tally_export`         | company_id, voucher_source_id, batch_id, status (pending/sent/accepted/rejected), tally_remote_id, error                                                                                                                                   | Idempotent one-way export log                                     |
