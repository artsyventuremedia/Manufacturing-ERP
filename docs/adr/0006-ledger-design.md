# ADR-0006: Append-only double-entry ledgers for inventory and GL

- Status: Accepted (2026-09-25)
- Date: 2026-09-24

## Context

PRD §8 and §10 require perpetual inventory, append-only ledgers, corrections by reversal only, full traceability and multi-GAAP readiness. Incumbent SMB tools (Tally, many ERPNext setups) let users edit posted vouchers. That breaks audit trails and causes stock-to-GL mismatches, and auditors dislike it.

## Decision

### Two ledgers, one transaction

1. **Stock ledger** (`inventory.stock_ledger_entry`): one row per quantity movement per item × location × lot/serial × stock status × ownership, with signed `qty_base` and `value_base`.
2. **General ledger** (`finance.journal_entry` + `journal_line`): balanced double entry, with base-currency debit/credit and transaction-currency amounts, plus dimensions (cost centre, profit centre, plant, item, party, project).
3. Any business event that moves stock with a value (GRN, issue, receipt, delivery, transfer between valued locations, adjustment, revaluation) writes **both** ledgers in the **same DB transaction**, through `InventoryPostingPort` → `FinancePostingPort`. Each stock ledger entry references its `journal_entry_id`.

### Immutability

4. Ledger tables are INSERT-only: `UPDATE`/`DELETE` are revoked from `app_rw`, and a trigger raises on any attempt as defence in depth.
5. **Corrections are reversals.** Cancelling a posted document creates mirror entries with `reverses_entry_id`. The reversal posts in the current open period unless the user has "post to prior open period" permission. Original documents move to `Reversed`.
6. **Period control:** periods are `open | soft_closed | closed`. Soft-closed periods allow only permitted roles, such as adjusting entries. Closed periods reject all postings (domain check + trigger).
7. **Balance check:** a deferred constraint trigger verifies that debits equal credits per journal entry at commit.

### Balances and valuation

8. `inventory.stock_balance` and `finance.gl_balance` are **projections maintained synchronously** in the posting transaction with row-level locks, so they are always exact. A nightly reconciliation job re-derives them from the ledgers and raises an alert on any difference.
9. **Valuation:** it is configured per item/plant. FIFO uses `valuation_layer` rows that are consumed on issue. Moving average keeps a running cost in the balance. Standard cost posts price differences to a variance account. Consumption cost is resolved at posting time, so there are no retroactive re-costing edits. Late-arriving costs (landed cost, price differences after GRN) post as **revaluation entries**.
10. **Account determination** comes from a configurable `posting_rule` table (event key × item category × plant × …→ account), seeded by industry templates. There are no hard-coded accounts.
11. **Multi-GAAP (Phase 2+):** `journal_line.ledger_book` (for example `IND_AS`, `IFRS`, `TAX`). The leading book is posted by default. Books that differ (depreciation, provisions) get separate adjusting entries.
12. **Tamper evidence (regulated tenants):** a hash chain per tenant across journal entries and stock ledger entries (`prev_hash`, `hash`), anchored daily to an external timestamp.
13. **Partitioning:** ledger tables are range-partitioned by `posting_date` (monthly) with pg_partman. Indexes lead with `(tenant_id, …)`.

### Negative stock and concurrency

14. Negative stock is disallowed by default and configurable per company/warehouse, for example for backflush timing in SMB plants. Balance rows are locked in a deterministic order (item, location, lot) to avoid deadlocks.

## Consequences

- Stock and GL cannot diverge. Every number traces back to a source document and user.
- Users cannot "fix" a typo by editing a posted document. The UI must make reverse-and-repost a one-click action.
- Posting throughput is limited by row locks on hot items. We mitigate with short transactions and batched backflush, and we measure it in load tests.

## Alternatives considered

- Event-sourcing the whole domain: rejected as too complex for reporting and team onboarding. We get the useful parts (immutable ledgers, events) without it.
- Asynchronous GL posting from stock events: rejected because it breaks the real-time perpetual inventory requirement and causes reconciliation work.
