# ADR-0010: Durable workflows and approvals on Temporal

- Status: Accepted (2026-09-25)
- Date: 2026-09-24

## Context

We need (a) long-running system processes: MRP runs, period close, e-invoice submission with retries, imports, integrations and backfills; and (b) tenant-configurable **approval workflows** with conditions, parallel steps, SLAs, escalation and delegation (PRD §5.1). Both must survive restarts, be visible to operators, and run on-prem.

## Decision

1. **Temporal** (self-hosted, MIT) is the durable execution engine for all long-running processes. Its persistence is Postgres, so no Cassandra is needed on-prem. In SaaS it gets its own Postgres DB per cell.
2. Workers live in `core-worker` (TypeScript SDK). Python services register activities for ML and optimisation on their own task queues.
3. **Approval engine = our DSL + a generic Temporal interpreter workflow.**
   - Tenants design approval flows in a no-code designer. The JSON DSL (steps, approver resolution rules, conditions, parallel/any-of, SLA, escalation, reminders) is stored and versioned in `platform.workflow_definition/version`.
   - Submitting a document starts one `ApprovalWorkflow` instance pinned to the definition version current at submit time.
   - Human decisions arrive as Temporal **signals** from the approval API. SLA timers and escalations are Temporal timers.
   - The authoritative approval state is mirrored to `platform.workflow_instance` / `approval_task` in Postgres for inbox queries, reporting and audit. Temporal is not queried for inboxes.
4. Workflow code follows Temporal determinism rules and uses versioning (patching) for changes. Activities are idempotent, using the same keys as API commands.
5. **Tenant fairness:** task queues per workload class (approvals, integrations, heavy-compute) and per-tenant concurrency limits.
6. **Visibility:** Temporal UI for operators, and a tenant-safe "background jobs" screen in the product.
7. Short fire-and-forget jobs (sending one email) are also Temporal activities, so we don't need a second job system (BullMQ is not used).

## Consequences

- One mechanism for retries, timers and long-running state, with strong observability.
- Temporal adds services (frontend, history, matching, worker) and needs expertise. The on-prem footprint is about 1–2 GB of RAM.
- The AI-assisted workflow designer (PRD §5.1 "upgrade") produces DSL JSON, which is safe because it is data, not code.

## Alternatives considered

- Camunda 8 / Zeebe (BPMN): strong for BPM, but newer versions have licence restrictions for production use, and BPMN is heavier than tenants need.
- Custom state machine + cron + BullMQ: weak durability and visibility, and we would rebuild Temporal badly.
- Inngest / Restate: promising but younger. Revisit if Temporal operations become a burden.
