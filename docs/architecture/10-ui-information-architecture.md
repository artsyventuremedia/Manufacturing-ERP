# 10 — UI Information Architecture

Status: **Draft for approval** · 2026-09-27 · Answers brief v2 deliverable 14 (and §58, §89) · Stack: ADR-0003 (Next.js, shadcn/ui, TanStack, AG Grid, ECharts, i18next) · Built in step 0.12 (design system and app shell)

---

## 1. Experiences

One web app and one mobile app, with **role-based experiences** instead of separate products. What a user sees is driven by their permissions, their home-screen configuration and the device.

| Experience     | Who                                                                   | Device                                 | Character                                                                                            |
| -------------- | --------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Desk**       | Office users: buyers, sales, accountants, planners, admins            | Web (desktop first, responsive)        | Dense tables, keyboard-first, command palette, saved views, split view (list + record)               |
| **Shop floor** | Operators, supervisors                                                | Tablet or low-cost Android, kiosk mode | Large touch targets, icons first, one task per screen, minimal typing, voice, offline, Kannada/Hindi |
| **Field**      | Stores, maintenance technicians, quality inspectors, drivers          | Mobile app                             | Scan-first (barcode/QR), offline queue, camera, location where needed                                |
| **Command**    | Plant head, CFO, COO, CEO                                             | Web and mobile                         | KPIs, control tower, alerts, drill-down, approvals, copilot                                          |
| **Portal**     | Customers, suppliers, employees                                       | Web (mobile friendly)                  | Their own records only, simple language                                                              |
| **Admin**      | Workspace admins; Manuling super-admins (control plane, separate app) | Web                                    | Configuration: users, roles, fields, workflows, notifications, integrations, packs                   |

## 2. Global navigation (Desk)

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ [Company ▾] [Plant ▾]   Search or ask Copilot (⌘K)        🔔  ✓ Approvals  ⚙ │
├───────────┬──────────────────────────────────────────────────────────────┤
│ Home      │                                                              │
│ Sales     │   Workspace (list · record · board · calendar · Gantt)       │
│ Purchase  │                                                              │
│ Inventory │                                                              │
│ Production│                                                              │
│ Planning  │                                                              │
│ Quality   │                                                              │
│ Maintenance│                                                             │
│ Finance   │                                                              │
│ HR        │                                                              │
│ Reports   │                                                              │
│ Settings  │                                                              │
└───────────┴──────────────────────────────────────────────────────────────┘
```

- Modules the tenant has not bought, or the user cannot access, do not appear (entitlements plus permissions).
- **Company and plant switchers** set the scope for lists and new records; the API still enforces scope.
- **Command palette (⌘K)** does navigation, record search, actions ("new PO") and copilot questions.
- **Notifications** (step 0.10) and **Approvals** (step 0.8 inbox ☑) are always one click away.

## 3. Screen patterns (every module uses the same ones)

| Pattern            | Used for                               | Rules                                                                                                                                                      |
| ------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List               | Every entity                           | Server-side paging, filters (incl. custom fields `ext.*` ☑), saved views, column layout from metadata (layouts ☑), bulk actions, CSV export                |
| Record             | Every document                         | Header with status and next actions; tabs; custom fields rendered from metadata; activity timeline (audit ☑ + comments); attachments (DMS); approval panel |
| Document lifecycle | Transactions                           | Draft → Submitted → Approved → Posted → Cancelled/Reversed; buttons shown only if the state machine and permissions allow                                  |
| Board / Kanban     | CRM pipeline, work orders, maintenance | Drag changes state through the same API                                                                                                                    |
| Gantt              | Scheduling, projects                   | Phase 3 component decision (ADR-0003)                                                                                                                      |
| Dashboard          | Command, module homes                  | Tiles from the KPI engine; every figure drills down to the list that makes it up                                                                           |
| Wizard             | Onboarding, imports, go-live           | Resumable; server-side state                                                                                                                               |

## 4. Screen list by module (Phase 0–1)

| Area                | Screens                                                                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shell (0.12)        | Sign-in (Keycloak), workspace picker, home, command palette, notifications inbox, approvals inbox, profile and preferences (language, time zone, phone, notification channels)                                                                   |
| Settings (0.12)     | Companies, plants, fiscal years, users and invitations, roles and grants, field policies, SoD rules, numbering series, workflows (designer + dry run), custom fields, custom objects, layouts, notification templates, audit trail, entitlements |
| Master data (P1)    | Items (with revisions, UoM conversions, HSN), parties (customer/supplier roles, GSTIN), warehouses and bins, price lists, tax codes, payment terms                                                                                               |
| Sales (P1)          | Quotations, sales orders, deliveries, invoices (e-invoice status), returns, customer statement                                                                                                                                                   |
| Purchase (P1)       | Requisitions, RFQs and comparison, purchase orders, goods receipts, purchase invoices (3-way match), supplier statement                                                                                                                          |
| Inventory (P1)      | Stock overview (by item, lot, bin), movements, transfers, adjustments, physical count, lot/serial trace                                                                                                                                          |
| Production (P1)     | BOMs, routings (basic), work orders, material issue, confirmation; shop-floor terminal (basic)                                                                                                                                                   |
| Finance (P1)        | Chart of accounts, journals, AR/AP, payments and receipts, bank reconciliation, GST returns, TDS, trial balance, P&L, balance sheet                                                                                                              |
| Implementation (P1) | Import wizard (template → upload → validate → preview → commit/rollback), Tally migration, go-live checklist                                                                                                                                     |

## 5. State definitions (every screen handles all of these)

Loading (skeletons, never spinners for whole pages) · empty (explains what to do next, with a primary action) · partial (some data failed; show what loaded and why the rest did not) · error (RFC 9457 message in the user's language, correlation id for support) · offline (mobile: queued actions with their sync state) · read-only (no permission or locked state, and says why) · conflict (409/412: show what changed and offer to reload or merge).

## 6. Design system (built in 0.12)

Tokens (colour, spacing, type, radius, elevation) with light and dark themes; WCAG 2.2 AA contrast; Indic-script typography (Noto Sans Kannada/Devanagari) tested at every size; components wrapping shadcn/ui; number, date and currency formatting through one i18n layer (Indian digit grouping 1,00,000 by default for en-IN); every string an i18n key (en, kn, hi); icons from one set (Lucide). Brand guidelines are open question Q14.

## 7. Per-module UX delivery (brief §89)

Before each module's UI is built, its phase plan includes: user journeys, information architecture, wireframes, screen list, state definitions and the permission matrix for its screens. This is added to the PRD §16 per-module order as part of "UI screens".
