import { type UnitOfWork } from '@manuling/db';
import { type RequestContext, RequestContexts, newId } from '@manuling/kernel';
import { sql } from 'drizzle-orm';
import { type EventSubscriber } from './bus.js';
import { type CloudEvent, topicFor } from './envelope.js';

/** A named reaction to events. Its database effects commit together with the inbox row. */
export interface EventConsumer {
  /** Stable name; also the consumer-group suffix and inbox key. */
  readonly name: string;
  readonly eventTypes: readonly string[];
  handle(event: CloudEvent): Promise<void>;
}

export type DispatchOutcome = 'processed' | 'duplicate' | 'ignored' | 'dead_lettered';

export interface ConsumerRunnerOptions {
  readonly maxAttempts?: number;
  readonly backoffMs?: (attempt: number) => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ConsumerLogger {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

const NAME = /^[a-z][a-z0-9_.-]{1,99}$/;

/**
 * Runs consumers with at-least-once delivery and exactly-once database effects
 * (ADR-0007 §6): each event is handled inside the event's tenant context, in one
 * transaction with an insert into `platform.inbox`. A redelivery finds the inbox row and
 * is skipped. After `maxAttempts` failures the event goes to `platform.dead_letter`.
 */
export class ConsumerRunner {
  private readonly maxAttempts: number;
  private readonly backoffMs: (attempt: number) => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly subscriber: EventSubscriber,
    options: ConsumerRunnerOptions = {},
    private readonly logger: ConsumerLogger = { warn: () => undefined, error: () => undefined },
  ) {
    this.maxAttempts = options.maxAttempts ?? 5;
    this.backoffMs = options.backoffMs ?? ((n) => Math.min(30_000, 200 * 2 ** (n - 1)));
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async start(consumers: readonly EventConsumer[]): Promise<void> {
    for (const consumer of consumers) {
      if (!NAME.test(consumer.name))
        throw new TypeError(`Invalid consumer name "${consumer.name}"`);
      const topics = [...new Set(consumer.eventTypes.map(topicFor))];
      await this.subscriber.subscribe(`manuling.${consumer.name}`, topics, async (event) => {
        await this.dispatch(consumer, event);
      });
    }
  }

  async dispatch(consumer: EventConsumer, event: CloudEvent): Promise<DispatchOutcome> {
    if (!consumer.eventTypes.includes(event.type)) return 'ignored';
    const context: RequestContext = {
      correlationId: event.correlationid,
      source: 'system',
      locale: 'en-IN',
      timezone: 'UTC',
      companyIds: [],
      tenantId: event.tenantid,
      actor: {
        type: 'system',
        id: `consumer:${consumer.name}`,
        ...(event.actor.type === 'user' ? { onBehalfOf: event.actor.id } : {}),
      },
    };

    for (let attempt = 1; ; attempt++) {
      try {
        return await RequestContexts.run(context, () =>
          this.uow.run(async ({ db }) => {
            const inserted = await db.execute(sql`
              INSERT INTO platform.inbox (tenant_id, consumer, event_id)
              VALUES (${event.tenantid}, ${consumer.name}, ${event.id})
              ON CONFLICT DO NOTHING RETURNING 1`);
            if ((inserted.rowCount ?? 0) === 0) return 'duplicate' as const;
            await consumer.handle(event);
            return 'processed' as const;
          }),
        );
      } catch (err) {
        if (attempt >= this.maxAttempts) {
          await this.deadLetter(context, consumer, event, err, attempt);
          return 'dead_lettered';
        }
        this.logger.warn(
          { err, consumer: consumer.name, eventId: event.id, attempt },
          'consumer failed; retrying',
        );
        await this.sleep(this.backoffMs(attempt));
      }
    }
  }

  private async deadLetter(
    context: RequestContext,
    consumer: EventConsumer,
    event: CloudEvent,
    err: unknown,
    attempts: number,
  ): Promise<void> {
    this.logger.error(
      { err, consumer: consumer.name, eventId: event.id, attempts },
      'event dead-lettered',
    );
    await RequestContexts.run(context, () =>
      this.uow.run(({ db }) =>
        db.execute(sql`
          INSERT INTO platform.dead_letter (id, tenant_id, consumer, event_id, event_type, envelope, error, attempts)
          VALUES (${newId()}, ${event.tenantid}, ${consumer.name}, ${event.id}, ${event.type}, ${JSON.stringify(event)}::jsonb,
                  ${String(err instanceof Error ? err.message : err).slice(0, 4000)}, ${attempts})
          ON CONFLICT (tenant_id, consumer, event_id) DO NOTHING`),
      ),
    );
  }
}
