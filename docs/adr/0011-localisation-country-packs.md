# ADR-0011: Localisation as country-pack plugins

- Status: Accepted (2026-09-25)
- Date: 2026-09-24

## Context

India compliance (GST, e-invoice, e-way bill, TDS/TCS, ITC-04, MSME 43B(h), payroll statutory rules) is launch-critical. The PRD also requires that other countries' tax regimes can be added **without touching core code** (PRD §5.2, §2.8).

## Decision

1. Define a **Country Pack SPI** in `localisation/core`, with extension points:
   - `TaxDeterminationService`: given a document context (seller/buyer registrations, place of supply, item tax class, supply type), return tax lines. The GST pack handles CGST+SGST vs IGST, cess, RCM, SEZ/export and composition.
   - `DocumentComplianceHooks`: `beforeSubmit`, `afterPost` and `onCancel` per document type. Examples: IRN generation, EWB creation, blocking cancellation after 24 h without a credit note.
   - `PartyRegistrationValidator`: GSTIN/PAN/Udyam format checks and online verification.
   - `StatutoryReportProvider`: GSTR-1 / 3B data, GSTR-2B reconciliation, TDS returns, ITC-04.
   - `NumberingConstraints`: for example GST invoice numbers ≤ 16 characters, unique per FY, gapless.
   - `PrintFieldProvider`: legal fields on print formats, such as a QR code or HSN summary.
   - `PayrollStatutoryRules` (Phase 2): PF, ESI, PT, LWF and gratuity as a configurable rule set.
2. A pack is activated per **company** (not per tenant), so a tenant can have an Indian company and a UAE company.
3. Pack data lives in its own schema (`loc_in.*`) and references core documents by `(doc_type, doc_id)`. Core modules call the SPI and never import a pack directly.
4. Rates and rule tables (GST rates by HSN, TDS sections, PT slabs) are **versioned data with effective dates**, updatable without a release.
5. **GST Compliance Gateway** (product-owner decision, 2026-09-24). All government-facing calls go through one provider-agnostic gateway inside the India pack, never from core modules directly.
   - **Capability ports**, each routed independently per company: `EInvoicePort` (generate/cancel IRN, get by IRN, signed QR), `EWayBillPort` (generate, including from IRN; Part-B/vehicle update; extend; cancel), `GstReturnPort` (GSTR-1 upload, GSTR-2B download, 3B data), `TaxpayerLookupPort` (GSTIN search/verification).
   - **First adapter: IRIS IRP** for e-invoicing, plus e-way bill generation along with the IRN. Standalone e-way bills (for example job-work challans and stock transfers without an invoice), returns and GSTIN lookup are routed to whichever provider the tenant has contracted. Their adapters are built against the same ports, and which IRIS product covers them is Q20.
   - **Canonical model:** the gateway takes a Manuling-internal `EInvoiceDocument` and maps it to the NIC/IRP e-invoice JSON schema (INV-01) in one place. Adapters only handle transport, auth and provider-specific error codes. Adding a second IRP means writing a new adapter with no mapping changes.
   - **Credentials** are per company GSTIN (IRP API user/password, client id/secret) and stored in Vault, never in the DB. Auth tokens are cached per GSTIN until they expire.
   - **Reliability:** every submission runs as a Temporal workflow with an idempotency key of doc type + doc id + attempt purpose. Retries use backoff and treat duplicate-IRN responses as success, fetching the existing IRN. Circuit breakers work per provider, and a secondary IRP can serve as **failover** (config only). Rate limits apply per GSTIN.
   - **Audit:** each request and response is stored (secrets redacted) in `loc_in.gateway_call_log` with latency and status. Signed IRN and QR payloads are kept as immutable records.
   - **Sandbox mode per tenant** points at the provider's sandbox, used by the go-live wizard and by training mode.
   - Supports the 30-day IRN reporting window and the 24-hour cancellation limit through alerts, and blocks invoice cancellation after an IRN is issued, suggesting a credit note instead.

## Consequences

- The India pack is first-class but isolated. Adding a VAT country means writing a new pack.
- Core modules must stay tax-agnostic. Code review rejects GST-specific logic in `modules/*`.
