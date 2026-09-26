import { type Actor, type RequestContext, newId } from '@manuling/kernel';

/** CloudEvents 1.0 envelope with Manuling extensions (ADR-0007 §5). */
export interface CloudEvent<TData = unknown> {
  readonly specversion: '1.0';
  readonly id: string;
  /** `{context}.{Aggregate}{PastTenseVerb}.v{n}` */
  readonly type: string;
  readonly source: string;
  readonly subject: string;
  readonly time: string;
  readonly datacontenttype: 'application/json';
  readonly tenantid: string;
  readonly correlationid: string;
  readonly causationid?: string;
  readonly actor: Actor;
  readonly data: TData;
}

export interface NewEvent<TData = unknown> {
  readonly type: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly data: TData;
  /** Event that caused this one (set by consumers reacting to an event). */
  readonly causationId?: string;
}

const EVENT_TYPE = /^([a-z][a-z0-9_]*)\.[A-Z][A-Za-z0-9]*\.v\d+$/;

/** Bounded context from an event type: `platform.CompanyCreated.v1` → `platform`. */
export function contextOf(type: string): string {
  const match = EVENT_TYPE.exec(type);
  if (!match)
    throw new TypeError(`Event type "${type}" must match {context}.{Aggregate}{Verb}.v{n}`);
  return match[1]!;
}

/** One topic per bounded context and major version (ADR-0007 §4). */
export function topicFor(type: string): string {
  return `manuling.${contextOf(type)}.events.v1`;
}

/** Ordering key: all events of one aggregate land on one partition, in order. */
export function partitionKey(tenantId: string, aggregateId: string): string {
  return `${tenantId}:${aggregateId}`;
}

export function buildEnvelope<T>(
  event: NewEvent<T>,
  ctx: RequestContext & { tenantId: string; actor: Actor },
  now: Date,
): CloudEvent<T> {
  return {
    specversion: '1.0',
    id: newId(),
    type: event.type,
    source: `manuling/${contextOf(event.type)}`,
    subject: `${event.aggregateType}/${event.aggregateId}`,
    time: now.toISOString(),
    datacontenttype: 'application/json',
    tenantid: ctx.tenantId,
    correlationid: ctx.correlationId,
    ...(event.causationId ? { causationid: event.causationId } : {}),
    actor: ctx.actor,
    data: event.data,
  };
}
