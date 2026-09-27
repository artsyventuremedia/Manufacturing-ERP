# Localisation (country packs)

Country-specific tax and statutory logic lives here, never in `modules/*` (ADR-0011):

- `core/`: the Country Pack SPI (tax determination, document compliance hooks, party registration validation, statutory reports, numbering constraints, print fields).
- `in/`: the India pack (GST, e-invoice via IRIS IRP through the GST Compliance Gateway, e-way bill, TDS/TCS, ITC-04, MSME 43B(h)).

Both packs arrive in Phase 1. The dependency rules already forbid core modules from importing a pack directly.
