# Plan: Phase 0 step 0.7 (numbering series)

Status: done · 2026-09-26 (see docs/STATUS.md) · PRD §5.1 ("document numbering series per company, plant and financial year"), ADR-0011 (numbering constraints)

## Design

1. **Series** (`platform.numbering_series`), per company:
   - code, document type (`module.document`, e.g. `sales.invoice`), pattern, gapless flag;
   - counter scope (company or plant), reset policy (per fiscal year or never), start value;
   - optional max length and a restricted character set; a default series per document type.
2. **Pattern tokens:**
   - `{FY}` = `2026-27`, `{FYS}` = `2627`;
   - `{YYYY}`, `{YY}`, `{MM}` from the document date;
   - `{COMPANY}`, `{PLANT}`;
   - `{#####}` = the counter, zero-padded to the number of `#`s.

   Literal text is limited to letters, digits, `/` and `-`, which is GST-safe. Example: `INV/{PLANT}/{FY}/{#####}` → `INV/MYS1/2026-27/00001`.

3. **Counters** (`platform.numbering_counter`) are keyed by series × plant × fiscal year and allocated with one atomic upsert:
   - **Gapless series** (GST invoices) allocate _inside_ the document's transaction. The counter row stays locked until commit, so a rollback returns the number and sequences never skip.
   - **Gap-tolerant series** allocate in a separate, immediately committed transaction, so hot documents don't serialise on one row. A rolled-back document leaves a gap but never a duplicate.
4. **Limits:** if a number would exceed `max_length` (GST: 16 characters, set by the India pack), allocation fails with `platform.numbering.too_long` instead of producing an invalid number.
5. **`NumberingPort`** (platform contracts) is the in-process API other modules call:

   ```
   next({ companyId, docType, documentDate, plantId?, seriesCode? }) → { number, sequence, seriesId }
   ```

   The fiscal year is resolved from the company's fiscal years; a date outside every fiscal year is rejected.

6. **Admin APIs:** list and create series, update them (pattern locked once used), and preview the next number without allocating. Permissions: `platform.numbering.read` and `platform.numbering.manage`. Series changes are audited and emit events.
7. **Tests:**
   - Unit: pattern parsing and rendering, and validation.
   - Integration: 1,000 concurrent gapless allocations produce exactly 1…1000; a rollback returns a gapless number; gap-tolerant series never duplicate; plant and fiscal-year counters are independent; a new fiscal year resets; the length limit is enforced; tenant isolation; API and permissions.
