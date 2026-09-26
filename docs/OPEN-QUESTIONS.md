# Open Questions (awaiting product owner)

**Answered:** Q1, Q4, Q6 (2026-09-24), Q7 (2026-09-25). Every other question still uses its default until you say otherwise.

Each question lists the **default assumption** I will use if you reply "defaults OK". Numbers are referenced from other docs, for example ADR-0003 → Q12.

## Product and go-to-market

| #   | Question                                                                                                                            | Default assumption                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Q1  | ~~Product name~~                                                                                                                    | ✅ **Answered: Manuling** (`@manuling/*`)                                                          |
| Q2  | What is the **pilot customer's industry**? Is there a named pilot, and what do they use today (Tally, spreadsheets, another ERP)?   | Auto components / precision machining (matches the demo company), currently on Tally Prime + Excel |
| Q3  | What is the target date for the **first pilot go-live**, and who is building (you + an AI builder, or a team, and how many people)? | Small team with Claude Code. Phase 0 in about 6–8 weeks, Phase 1 in about 4 months                 |
| Q4  | ~~SaaS or on-prem for the first pilot?~~                                                                                            | ✅ **Answered: SaaS** (India region)                                                               |
| Q5  | Which **cloud provider** for SaaS: AWS (Mumbai/Hyderabad), Azure (Pune/Chennai) or GCP (Mumbai/Delhi)? Any credits?                 | AWS ap-south-1 / ap-south-2                                                                        |
| Q16 | What are the **year-1 scale assumptions** (tenants, users per tenant, transactions per day)?                                        | ≤ 200 tenants, ≤ 100 users each, one pooled cell                                                   |

## Integrations and compliance

| #   | Question                                                                                                                                                                                 | Default assumption                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q6  | ~~Which GSP/ASP?~~                                                                                                                                                                       | ✅ **Answered: IRIS IRP + a provider-agnostic GST Compliance Gateway** (ADR-0011 §5)                                                                                    |
| Q7  | ~~Tally: one-time migration or ongoing co-existence?~~                                                                                                                                   | ⏳ **Recommended: one-time migration + one-way export bridge (Manuling → Tally), no two-way sync** (ADR-0012). Awaiting your confirmation                               |
| Q8  | Which **WhatsApp Business provider**: Meta Cloud API direct, Gupshup, Interakt or another?                                                                                               | Meta Cloud API behind a provider adapter                                                                                                                                |
| Q9  | **LLM policy**: may tenant data be sent to external LLM APIs (with redaction), or do pilots need an India-hosted or self-hosted model?                                                   | External API (Claude) with PII redaction, and a self-hosted fallback slot in the gateway                                                                                |
| Q18 | Is **multi-GAAP** (Ind AS + IFRS/US GAAP books) needed in Phase 1?                                                                                                                       | No. A single Ind AS book in P1, with the ledger schema ready for more books                                                                                             |
| Q20 | For IRIS: which IRIS products are contracted? Is it IRIS IRP for e-invoice only, or also IRIS for standalone e-way bills, GSTR returns and GSTIN lookup? Do we have sandbox credentials? | IRIS IRP handles e-invoice + EWB-with-IRN. Standalone EWB, returns and lookup go through adapters behind the same gateway, with the provider chosen when we contract it |
| Q19 | Which Phase 1 **sales scope**: exports and SEZ invoices, and multi-currency sales and purchase?                                                                                          | Yes, both are included in P1 (common for Mysuru/Bengaluru auto-component exporters)                                                                                     |

## Technology choices needing sign-off

| #   | Question                                                                                                                                                               | Default assumption                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Q10 | **Mobile offline sync**: may we use PowerSync (self-hostable open edition, commercial support), or must it be fully in-house?                                          | Spike PowerSync vs a custom sync in Phase 1, then decide by ADR      |
| Q12 | **On-prem object storage**: SeaweedFS (Apache 2.0) vs Garage (AGPL) vs a customer-provided NAS/S3. Do you have legal counsel to review OSS licences for the installer? | SeaweedFS. Legal review before GA                                    |
| Q13 | What is the **budget for commercial UI components** (AG Grid Enterprise at about USD 1k per developer, Bryntum/DHTMLX Gantt)?                                          | AG Grid Community now. Decide on Enterprise and Gantt before Phase 3 |
| Q17 | **Source control**: GitHub org name, and may I `git init` here? Is GitHub Actions OK for CI?                                                                           | Yes to both. The repo is private under an Artsy Technologies org     |

## UX and content

| #   | Question                                                                                                                                             | Default assumption                                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Q11 | Who provides and reviews **Kannada and Hindi translations** and manufacturing terminology?                                                           | Machine-translated first drafts, reviewed by a native-speaking domain person before each release. Glossary kept in `packages/i18n/glossary` |
| Q14 | Are there existing **brand guidelines** (logo, colours, typography)?                                                                                 | A neutral design system with tokens, so branding can be applied later                                                                       |
| Q15 | For the **Starter edition**, should lot/serial tracking and basic production orders be included (the PRD says yes), or held back as a Growth upsell? | Included, as the PRD says                                                                                                                   |
