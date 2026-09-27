# Plan: Phase 0 step 0.9 (custom fields and custom objects)

Status: done · 2026-09-27 (see docs/STATUS.md) · PRD §2.4 ("configure, don't customise"), §5.1 (no-code fields, objects, forms, list views)

## Outcome

A workspace admin adds fields to built-in records (company, plant, and later items, parties and so on) and defines entirely new record types. Neither touches the database schema or needs a release. Custom data is validated, access-controlled, audited, evented, filterable and exportable, just like core data.

## Decisions

| #   | Decision                                                                                                                                                                                                                                                                                        | Why                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Custom field values live in each record's `ext` JSON column (already on every core table); custom object records live in one generic `custom_record` table with a `data` JSON column. GIN indexes serve filters.                                                                                | No runtime DDL (the app role cannot run DDL, by design), upgrade-safe, and consistent across pooled and dedicated cells (ADR-0005) |
| C2  | Every write is validated against active field definitions: unknown keys are rejected, types are checked strictly, `required` is enforced, defaults are applied. Decimals are strings with a declared scale (ADR-0008); references must point to a record of the target type in the same tenant. | Bad data never enters `ext`; errors carry JSON paths for the form UI                                                               |
| C3  | Supported types: text, long_text, integer, decimal, boolean, date, datetime, select, multi_select, email, url, phone, reference. A field's type cannot change after creation, but it can be archived (its values are kept and hidden).                                                          | Type changes would silently corrupt stored values                                                                                  |
| C4  | Field-level security covers custom fields as `ext.<field>`, both in field policies and in response redaction and write checks.                                                                                                                                                                  | Hiding a custom "cost" field must work like hiding a core one (ADR-0014 §7)                                                        |
| C5  | Extensible core entities come from a code registry (`platform.company`, `platform.plant` now; modules add theirs). Custom objects are addressed as `custom.<api_name>`.                                                                                                                         | Only entities that validate and redact `ext` can be extended                                                                       |
| C6  | Custom object records use generic permissions `platform.custom_record.read` and `platform.custom_record.write`; `platform.customization.manage` covers definitions and layouts. Per-object permissions come later (tracked).                                                                    | Tenant-defined objects cannot register process-wide permission codes; generic permissions keep ADR-0014's boot-time guarantee      |
| C7  | Form and list layouts are stored as validated metadata per entity (sections with ordered fields, list columns) for the UI (step 0.12).                                                                                                                                                          | The UI renders from metadata, including custom fields, without code                                                                |
| C8  | Exports: CSV of custom object records with columns labelled in the caller's locale, honouring field policies and filters.                                                                                                                                                                       | PRD §5.1 bulk export                                                                                                               |

## API

- Fields: `GET /v1/platform/custom-fields?entity=`, `POST /v1/platform/custom-fields`, `PATCH /v1/platform/custom-fields/{id}` (labels, help, required, options add, archive).
- Objects: `GET|POST /v1/platform/custom-objects`, `PATCH /v1/platform/custom-objects/{id}`.
- Records: `GET|POST /v1/platform/custom-objects/{apiName}/records` (filters `data.<field>=v`, `data.<field>[gte|lte]=v`), `GET|PATCH /…/records/{id}` (If-Match), `POST /…/records/{id}/archive`, `GET /…/records/export.csv`.
- Core entities: `ext` in company and plant responses and requests (PATCH merges; `null` clears); company list filters on `ext.<field>`.
- Layouts: `GET|PUT /v1/platform/layouts/{entity}/{kind}` (`form` | `list`).

## Tests

- **Unit:** field definition validation, value validation and coercion per type, filter parsing.
- **Integration:** fields on companies (create/update with `ext`, errors with paths, required, defaults, merge/clear, filters); field-policy hiding and locking of `ext.*`; custom object lifecycle, records CRUD, filters and paging, CSV export; reference checks (cross-tenant rejected); type lock; archive; events and audit; tenant isolation.
