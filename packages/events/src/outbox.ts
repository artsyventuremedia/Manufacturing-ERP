import { type UnitOfWork } from '@manuling/db';
import { type Clock, RequestContexts, systemClock } from '@manuling/kernel';
import { sql } from 'drizzle-orm';
import {
  type CloudEvent,
  type NewEvent,
  buildEnvelope,
  partitionKey,
  topicFor,
} from './envelope.js';

/**
 * Transactional outbox writer (ADR-0007 §1): events are inserted in the caller's
 * UnitOfWork, so they are published if and only if the state change commits.
 */
export class EventOutbox {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock = systemClock,
  ) {}

  async append(...events: NewEvent[]): Promise<CloudEvent[]> {
    const { db } = this.uow.current();
    const ctx = RequestContexts.requireTenant();
    const now = this.clock.now();
    const envelopes: CloudEvent[] = [];
    for (const event of events) {
      const envelope = buildEnvelope(event, ctx, now);
      await db.execute(sql`
        INSERT INTO platform.outbox (id, tenant_id, topic, event_type, aggregate_type, aggregate_id, partition_key, envelope)
        VALUES (${envelope.id}, ${ctx.tenantId}, ${topicFor(event.type)}, ${event.type}, ${event.aggregateType},
                ${event.aggregateId}, ${partitionKey(ctx.tenantId, event.aggregateId)}, ${JSON.stringify(envelope)}::jsonb)`);
      envelopes.push(envelope);
    }
    return envelopes;
  }
}
