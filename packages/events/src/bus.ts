import { type CloudEvent } from './envelope.js';

export interface EventMessage {
  readonly topic: string;
  readonly key: string;
  readonly event: CloudEvent;
}

/** Publishes to the event log (Kafka in production). Must be durable when it resolves. */
export interface EventPublisher {
  publish(messages: readonly EventMessage[]): Promise<void>;
  close(): Promise<void>;
}

export type EventHandler = (event: CloudEvent) => Promise<void>;

/** Delivers events to a named consumer group, at least once. */
export interface EventSubscriber {
  subscribe(group: string, topics: readonly string[], handler: EventHandler): Promise<void>;
  close(): Promise<void>;
}

export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');
export const EVENT_SUBSCRIBER = Symbol('EVENT_SUBSCRIBER');
