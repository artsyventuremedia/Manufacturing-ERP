import { type Clock, systemClock } from './clock.js';
import { ConcurrencyConflictError } from './errors.js';
import { newId } from './id.js';

/**
 * Domain event raised by an aggregate. The events package wraps it in a CloudEvents envelope
 * (with tenant, correlation and actor) when writing to the outbox (ADR-0007).
 */
export interface DomainEvent<TType extends string = string, TPayload = unknown> {
  readonly eventId: string;
  /** `{context}.{Aggregate}{PastTenseVerb}.v{n}`, e.g. `inventory.StockMoved.v1`. */
  readonly type: TType;
  readonly occurredAt: Date;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: TPayload;
}

const EVENT_TYPE = /^[a-z][a-z0-9]*\.[A-Z][A-Za-z0-9]*\.v\d+$/;

export abstract class AggregateRoot {
  protected abstract readonly aggregateType: string;
  private readonly pendingEvents: DomainEvent[] = [];

  protected constructor(
    readonly id: string,
    private currentVersion: number,
    protected readonly clock: Clock = systemClock,
  ) {}

  /** Version used for optimistic concurrency (ETag / If-Match). */
  get version(): number {
    return this.currentVersion;
  }

  /** Throws if the caller's expected version (from If-Match) is stale. */
  assertVersion(expected: number): void {
    if (expected !== this.currentVersion) {
      throw new ConcurrencyConflictError(
        this.aggregateType,
        this.id,
        expected,
        this.currentVersion,
      );
    }
  }

  protected raise<TPayload>(type: string, payload: TPayload): void {
    if (!EVENT_TYPE.test(type)) {
      throw new TypeError(`Event type "${type}" must match {context}.{Aggregate}{Verb}.v{n}`);
    }
    this.pendingEvents.push({
      eventId: newId(),
      type,
      occurredAt: this.clock.now(),
      aggregateType: this.aggregateType,
      aggregateId: this.id,
      payload,
    });
  }

  /** Returns and clears the events raised since the last call; the repository writes them to the outbox. */
  pullEvents(): DomainEvent[] {
    return this.pendingEvents.splice(0, this.pendingEvents.length);
  }

  /** Called by the repository after a successful write. */
  markPersisted(newVersion: number): void {
    this.currentVersion = newVersion;
  }
}
