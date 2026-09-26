# ADR-0015: Approval engine (Postgres truth, Temporal time, outbox hand-offs)

- Status: Accepted (2026-09-26)
- Date: 2026-09-26
- Refines: ADR-0010 (durable workflows and approvals on Temporal)

## Decision

1. **Postgres is the source of truth** for workflow definitions, instances, tasks and decisions. Users decide in an ordinary API transaction, so the inbox and timeline update immediately and never depend on Temporal being reachable.
2. **Temporal orchestrates**: step sequencing, SLA deadlines, reminders and escalation. Workflow code is deterministic and only calls idempotent activities, which lock the instance row and read or write through UnitOfWork under the instance's tenant.
3. **Every hand-off goes through the outbox.** `ApprovalSubmitted` starts the workflow (the workflow id is the instance id, so starts are idempotent), and `ApprovalTaskDecided` / `ApprovalCancelled` become signals. All approval events use the instance as their aggregate, so they stay ordered on one Kafka partition.
4. **Approvers are resolved by permission, role or named users.** For permission approvers, each candidate's own ABAC conditions (for example an amount limit) must accept the document, so approval limits live in one place: role assignments (ADR-0014).
5. **Separation of duties at decision time:** requesters are never assigned and cannot act, even as a delegate. One person cannot decide two steps of the same instance unless the step allows it.
6. **Flows are versioned JSON.** Published versions are immutable (DB trigger), and instances pin their version.
7. **Outcome:** modules learn the result from `platform.ApprovalCompleted.v1` (approved, rejected or cancelled, with a reason).

## Consequences

- Tests use Temporal's time-skipping server, so a 24-hour SLA escalation runs in milliseconds against real Postgres.
- Approver resolution loads each candidate's access snapshot, which is O(active users) per step. That is fine for SMB tenants; an index of permission holders can be added when larger tenants arrive.
