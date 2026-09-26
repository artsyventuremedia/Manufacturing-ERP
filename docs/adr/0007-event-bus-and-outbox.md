# ADR-0007: Event bus — transactional outbox + Kafka API

- Status: Accepted (2026-09-25)
- Date: 2026-09-24

## Context

PRD §2.2 and §8 require an event-driven system: every state change emits events for planning, analytics, notifications, AI and external subscribers. Dual writes (DB commit, then publish) lose or invent events on failure. The broker must run everywhere from a single on-prem server to multi-region SaaS.

## Decision

1. **Transactional outbox:** domain events are inserted into `platform.outbox` in the **same transaction** as the state change.
2. **Relay** (in core-worker) polls the outbox with `SELECT … FOR UPDATE SKIP LOCKED`, publishes, and marks rows published. Rows are pruned after 7 days. Debezium CDC is an optional upgrade for high-volume cells; the interface stays the same.
3. **Broker: Apache Kafka (KRaft mode)** in every deployment: 3+ brokers in SaaS cells, a single node on-prem. The code talks only the Kafka protocol (KafkaJS / confluent-kafka), so Redpanda or a managed Kafka (MSK, Confluent, Aiven) are drop-in replacements.
4. **Topics:** one topic per bounded context (`erp.{context}.events.v1`). Partition key `tenant_id:aggregate_id`, which gives per-aggregate ordering. Separate topics for high-volume streams (IoT telemetry, Phase 3).
5. **Envelope:** CloudEvents 1.0 with extensions `tenantid`, `companyid`, `correlationid`, `causationid` and `actor`. Payload schemas are JSON Schema, versioned in `packages/contracts/events`, and CI checks compatibility (only additive changes within a major version).
6. **Delivery semantics:** at least once. Every consumer is **idempotent** through `platform.inbox (consumer, event_id)` recorded in the consumer's own transaction. Retries use exponential backoff, and poison messages go to a DLQ per consumer, shown in an admin UI.
7. **In-process vs broker:** see ADR-0002. Ledger-coupled work is synchronous and in-process. Events are only for reactions that can tolerate lag.
8. **External subscribers:** webhooks and the n8n/Zapier connectors consume through a webhook dispatcher that reads the same events, applies tenant filters, and signs payloads (HMAC).
9. **Replay:** Kafka retention is 7–30 days per topic, and the outbox archive goes to object storage, so projections (analytics, search, embeddings) can be rebuilt.

## Consequences

- No lost or phantom events. Consumers can be extracted into separate services without code changes on the producer side.
- Kafka adds about 1–2 GB of RAM on a single on-prem node. That is acceptable.
- Eventual consistency for read models: the UI shows "updating…" states where a projection is involved.

## Alternatives considered

- NATS JetStream: lighter, but a weaker Kafka Connect / CDC / lakehouse ecosystem. Kept as a candidate for the edge.
- Postgres-only queue (LISTEN/NOTIFY, pgmq): attractive for the smallest installs but does not scale to IoT volumes. It would mean two code paths.
- RabbitMQ: no log replay, and weaker partitioned ordering.
