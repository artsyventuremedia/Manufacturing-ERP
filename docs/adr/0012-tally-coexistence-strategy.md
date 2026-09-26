# ADR-0012: Tally strategy: one-time migration + one-way export bridge (no two-way sync)

- Status: Accepted (2026-09-25)
- Date: 2026-09-24

## Context

Most target customers (Mysuru/Bengaluru SMB manufacturers) keep their books in Tally Prime, usually maintained by an external CA firm. Adoption risk comes less from the owner than from the **accountant**, who files GST and TDS and closes the books in Tally, and who will resist a switch in the middle of a year. The options were:

| Option                                   | Description                                                                                                                                                           |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. One-time migration only               | Import masters, opening balances and open documents; Tally is retired on go-live                                                                                      |
| B. **Migration + one-way export bridge** | As A, plus Manuling exports posted vouchers into Tally so the accountant can keep working in Tally for a transition period, or permanently in "operations-first" mode |
| C. Two-way sync                          | Both systems accept entries and changes are reconciled continuously                                                                                                   |

Why two-way sync (C) fails for us:

- **Two sources of truth.** Tally allows editing and deleting posted vouchers. Our ledgers are append-only (ADR-0006). A Tally edit could not be mirrored except as a reversal, so the systems would drift and need endless reconciliation.
- **GST double-reporting risk.** If both systems can raise invoices, e-invoice/IRN ownership and GSTR-1 data become ambiguous. That is a compliance liability for our customer.
- **Weak integration surface.** Tally's integration runs as XML over HTTP on a Windows desktop (port 9000) or through TDL. It has no stable change feed, no reliable IDs across edits, and the machine is often switched off. A two-way sync needs an always-on connector on the customer's PC, which is fragile on SaaS.
- It would absorb engineering effort for months and still frustrate customers.

## Decision

**Adopt option B.**

1. **One-time migration (Phase 1, go-live wizard):**
   - Import from Tally (XML export, or a direct pull from Tally Prime over its XML/HTTP interface through a small connector). The import covers the ledger/group chart → CoA mapping, parties (with GSTIN/PAN), stock items/groups/units, godowns → warehouses, opening balances (trial balance as at the cut-over date), outstanding bills (AR/AP open items with due dates, for 43B(h) tracking), opening stock with value and batches, and open sales/purchase orders.
   - **AI-assisted mapping:** the implementation agent proposes group → account-type and godown → warehouse mappings, spots duplicate parties, and flags invalid GSTINs. A human confirms. Output includes a validation report: the migrated trial balance must match Tally's to the paisa before go-live.
   - The recommended cut-over is the start of a month (ideally a quarter or 1 April), so GST returns for a period come from one system.
2. **One-way export bridge (Manuling → Tally)**, configurable per company:
   - **Transition mode** (default for 1–3 months or until the first year-end): posted Manuling vouchers (sales, purchase, receipts, payments, journals, credit/debit notes) are exported as Tally-importable XML, with a detail level set per voucher type (full item detail or a ledger-level summary).
   - **Operations-first mode** (permanent option): for customers whose CA insists on Tally, Manuling runs operations (orders, inventory, production, quality, e-invoice) and the books stay in Tally. Finance-only screens in Manuling are hidden. **Manuling is still the only system that issues e-invoices**, and Tally receives the IRN, so GST ownership stays unambiguous.
   - Delivery methods: (a) a downloadable XML batch from a daily/weekly export screen (works everywhere, no install); (b) an optional **Manuling Tally Bridge**, a small signed Windows agent that pulls pending batches over HTTPS and pushes them into Tally on `localhost:9000`, reporting success or failure per voucher.
   - Export is **idempotent**: each voucher carries its Manuling id in the Tally narration/remote-id, re-exports update rather than duplicate, and reversals export as reversing vouchers. An export log shows what is pending, sent, accepted or rejected.
   - **Nothing flows back from Tally.** Adjustments the CA makes in Tally (depreciation, provisions, year-end entries) stay in Tally. In operations-first mode this is expected. In transition mode the CA posts them in Manuling instead, and the UI provides a "CA adjustments" journal template.
3. **Mapping is data, not code:** a per-company `tally_mapping` table (Manuling account/party/item/tax ledger ↔ Tally ledger/stock item names) is seeded by the migration and editable in the UI.
4. The bridge lives in `modules/integration/tally` and consumes `finance.JournalPosted` / `sales.SalesInvoicePosted` events, so Tally is just another downstream consumer and core modules have no knowledge of it.

## Consequences

- The accountant keeps using Tally, and the owner gets live operations and inventory from day one. This removes the largest adoption blocker.
- Manuling stays the single source of truth for everything it posts. There is no conflict resolution to build.
- In operations-first mode, P&L and balance sheet in Manuling are "operational" views (no CA adjustments). Dashboards must label this clearly.
- Scope: migration in Phase 1 (go-live wizard) and XML batch export in Phase 1. The Windows Bridge agent comes late in Phase 1 or early in Phase 2.

## Alternatives considered

- A only: cleanest, but it loses deals where the CA refuses to switch mid-year.
- C (two-way sync): rejected for the reasons above.
