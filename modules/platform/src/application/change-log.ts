import { AuditTrail } from '@manuling/db';
import { EventOutbox } from '@manuling/events';
import { Injectable } from '@nestjs/common';
import {
  PLATFORM_EVENTS,
  type PlatformEventData,
  type PlatformEventType,
} from '../contracts/events.js';

export interface Change<T extends PlatformEventType> {
  readonly entityType: string;
  readonly entityId: string;
  readonly action: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly event?: {
    readonly type: T;
    readonly aggregateType: string;
    readonly data: PlatformEventData<T>;
  };
}

/**
 * Records a change in the current transaction: an audit row (PRD §10) and, optionally,
 * a domain event in the outbox (ADR-0007). Event data is validated against the published
 * contract, so consumers never receive a malformed payload.
 */
@Injectable()
export class ChangeLog {
  constructor(
    private readonly audit: AuditTrail,
    private readonly outbox: EventOutbox,
  ) {}

  async record<T extends PlatformEventType>(change: Change<T>): Promise<void> {
    await this.audit.record({
      entityType: change.entityType,
      entityId: change.entityId,
      action: change.action,
      before: change.before,
      after: change.after,
    });
    if (change.event) {
      const data = PLATFORM_EVENTS[change.event.type].parse(change.event.data);
      await this.outbox.append({
        type: change.event.type,
        aggregateType: change.event.aggregateType,
        aggregateId: change.entityId,
        data,
      });
    }
  }
}
