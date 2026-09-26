import {
  type EventHandler,
  type EventMessage,
  type EventPublisher,
  type EventSubscriber,
} from './bus.js';

/**
 * In-process event bus for tests and Docker-less development. Delivers each published
 * message to every subscribed group sequentially, preserving publish order. Not durable.
 */
export class InMemoryEventBus implements EventPublisher, EventSubscriber {
  readonly published: EventMessage[] = [];
  private readonly groups = new Map<string, { topics: Set<string>; handler: EventHandler }>();
  private failNext = 0;

  publish(messages: readonly EventMessage[]): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      return Promise.reject(new Error('simulated broker outage'));
    }
    this.published.push(...messages);
    return this.deliver(messages);
  }

  subscribe(group: string, topics: readonly string[], handler: EventHandler): Promise<void> {
    this.groups.set(group, { topics: new Set(topics), handler });
    return Promise.resolve();
  }

  /** Test hook: make the next `count` publish calls fail. */
  failNextPublishes(count: number): void {
    this.failNext = count;
  }

  close(): Promise<void> {
    this.groups.clear();
    return Promise.resolve();
  }

  private async deliver(messages: readonly EventMessage[]): Promise<void> {
    for (const message of messages) {
      for (const { topics, handler } of this.groups.values()) {
        if (topics.has(message.topic)) await handler(message.event);
      }
    }
  }
}
