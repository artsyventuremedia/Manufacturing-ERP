# ADR-0008: Money, quantity and identifier representation

- Status: Accepted (2026-09-25)
- Date: 2026-09-24

## Context

PRD §10 forbids floating point for money and quantity and requires configurable precision per currency and UoM. GST rounding rules (line vs invoice level, rounding to the rupee on invoice totals) must be exact. IDs must be globally unique across cells (for tenant mobility, ADR-0005) and index-friendly.

## Decision

1. **DB types:** money and quantity use `NUMERIC(20,6)`. Unit prices and rates use `NUMERIC(24,9)`. FX rates use `NUMERIC(18,9)`. Rounding to display or legal precision happens in the domain layer, never implicitly in the DB.
2. **TypeScript:** `Money { amount: Decimal, currency }` and `Quantity { value: Decimal, uom }` value objects in `@manuling/kernel`, built on `decimal.js`. Operations across currencies or UoMs without explicit conversion throw. JS `number` is banned for these fields (lint).
3. **Rounding policy** is an explicit object (`RoundingPolicy { scale, mode }`), resolved from currency, UoM and localisation rules. The India pack defines GST rounding: tax per line at 2 dp, then invoice total rounded to the rupee with a round-off line.
4. **Transport:** decimals are serialised as **strings** in JSON (`"1234.50"`) with the currency/UoM alongside. OpenAPI uses `type: string, format: decimal`.
5. **Python services** use `decimal.Decimal`.
6. **IDs:** UUIDv7 generated in the application (time-ordered, which suits B-tree indexes and is safe to merge across cells). Human-facing document numbers come from the numbering series and are never used as keys.
7. **Time:** `timestamptz` (UTC) for instants. `date` for business dates such as posting, document and due dates. Plant time zone is used to derive business dates from instants.

## Consequences

- Exact, reproducible arithmetic across API, UI, mobile and Python.
- Slightly more verbose code. The generated SDK hides the string ↔ Decimal conversion.
