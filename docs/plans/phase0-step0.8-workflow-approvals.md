# Plan: Phase 0 step 0.8 (workflow and approval engine)

Status: done · 2026-09-26 (see docs/STATUS.md, ADR-0015) · Implements ADR-0010 (Temporal) and PRD §5.1 (approvals with delegation, escalation and SLAs)

## Outcome

Any module can put a document through a tenant-configured approval flow with one call:

```ts
approvals.submit({
  companyId,
  entityType: 'procurement.purchase_order',
  entityId,
  attributes: { amount: '750000.00', plantId },
  requesterId,
});
```

The flow then runs durably: reminders, SLA escalation and delegation keep working through restarts and deploys. The result comes back as an event, `platform.ApprovalCompleted.v1` (approved or rejected), which the module consumes to move the document forward.

## Key decisions

| #   | Decision                                                                                                                                                                                                                                                                               | Why                                                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | **Postgres is the source of truth for tasks and decisions; Temporal owns time and orchestration.** Approving writes the decision row in the API transaction, and the workflow then reads decisions through an activity.                                                                | Inboxes, reports and audit query plain tables (ADR-0010 §3). The UI shows the decision immediately; nothing depends on Temporal being reachable at click time. |
| W2  | **The outbox drives Temporal.** `submit` writes the instance and `ApprovalSubmitted` in one transaction; a core-worker consumer starts the workflow (the workflow id is the instance id, so starts are idempotent). Decisions and cancels reach the workflow the same way, as signals. | The API never blocks on or fails because of Temporal. Every hand-off is at-least-once plus idempotent (ADR-0007).                                              |
| W3  | **Approvers can be resolved by permission.** Besides named users and roles, a step can say "anyone who holds `procurement.purchase_order.approve` for this company/plant _and whose conditions accept this document_" (e.g. `amount ≤ 5,00,000`).                                      | Approval limits are configured once, as role conditions (step 0.5), instead of being duplicated in every flow.                                                 |
| W4  | **Separation of duties at decision time:** the requester can never approve their own request, and a user cannot decide two steps of the same instance unless the step allows it.                                                                                                       | PRD §12 and ADR-0014 §8 (the action-time SoD deferred to this step).                                                                                           |
| W5  | **The DSL is data**, versioned and immutable once published; each instance pins its version. Step conditions reuse the authz condition evaluator (Decimal, fail-closed).                                                                                                               | Safe to edit without affecting in-flight approvals, and AI-draftable (PRD §5.1 upgrade).                                                                       |
| W6  | **Timers are durable:** reminders, SLA escalation (to users, roles or permission holders) and optional auto-reject on timeout.                                                                                                                                                         | These are Temporal's strengths; a cron plus flags would lose state.                                                                                            |
| W7  | **Delegation:** a user delegates to another for a date range, optionally per document type. Delegates act "on behalf of", and the audit shows both.                                                                                                                                    | PRD §5.1.                                                                                                                                                      |

## DSL (v1)

```json
{
  "steps": [
    {
      "id": "plant_head",
      "name": { "en": "Plant head", "kn": "ಘಟಕ ಮುಖ್ಯಸ್ಥ" },
      "when": [{ "attr": "amount", "op": "gt", "value": "100000" }],
      "approvers": { "type": "permission", "permission": "procurement.purchase_order.approve" },
      "mode": "any",
      "slaHours": 24,
      "reminderHours": 8,
      "onTimeout": { "action": "escalate", "to": { "type": "role", "role": "administrator" } }
    },
    { "id": "finance", "approvers": { "type": "role", "role": "finance" }, "mode": { "quorum": 2 } }
  ]
}
```

- **Approver types:** `users`, `role` (scoped to the document's company or plant), `permission` (W3).
- **Modes:** `any`, `all`, `{ quorum: n }`.
- **Steps** run in order; a step whose `when` is false is skipped. Any rejection ends the flow as rejected.

## Data (platform migration 0004)

- `workflow_definition`: per company and document type.
- `workflow_version`: DSL JSON, version number, draft or published.
- `workflow_instance`: entity, attribute snapshot, requester, pinned version, status, current step.
- `approval_task`: instance, step, assignee, delegate, status, due date, decision, comment, escalation level.
- `delegation`: from, to, validity, document types.

All tables are tenant-scoped with RLS and composite foreign keys; everything is audited and evented (`ApprovalRequested`, `ApprovalTaskAssigned`, `ApprovalDecided`, `ApprovalEscalated`, `ApprovalCompleted`).

## APIs

- **Definitions:** list, create a draft version, validate (dry run against sample attributes: shows which steps apply and who would approve), publish.
- **Inbox:** `GET /v1/platform/approval-tasks?status=pending` (mine and delegated to me); `POST …/{id}/approve|reject` with a comment.
- **Instances:** get with timeline; cancel (requester).
- **Delegations:** create, list and end.
- **Permissions:** `platform.workflow.read|manage`, `platform.approval.decide`, `platform.delegation.manage`.
- **Port:** `APPROVAL_PORT.submit(...)` / `cancel(...)` for modules.

## Runtime

- Temporal TypeScript SDK 1.24. A worker in core-worker on task queue `approvals`; activities use UnitOfWork under the instance's tenant, with actor `system:approvals`.
- Config: `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`.
- Dev: Temporal from the Compose stack (now runnable via Colima). CI: Temporal's time-skipping test server.

## Tests

1. **Unit:** DSL validation, step applicability, quorum maths, approver resolution rules.
2. **Workflow tests** with Temporal's **time-skipping** environment and real Postgres activities: SLA escalation after 24 h, reminders and auto-reject, all running in seconds.
3. **Integration against a real Temporal server:**
   - submit → tasks → approve → `ApprovalCompleted(approved)`; rejection path;
   - quorum; requester cannot approve; delegate approves on behalf; cancel;
   - duplicate signals are harmless; Temporal down at submit is picked up later;
   - tenant isolation.
4. **Acceptance** (STATUS exit criterion): a purchase order over the threshold escalates after its SLA.

## Also in this step (verification now possible with Docker)

- Run the Compose dev stack end to end; fix image tags or configuration.
- Keycloak realm import plus a real login as `demo.admin` → `/v1/platform/me`.
- Opt-in Kafka adapter test against the real broker (`KAFKA_TEST_BROKERS`), plus a CI job that runs it with Docker services.
