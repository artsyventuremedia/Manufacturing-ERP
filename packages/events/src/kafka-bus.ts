import { KafkaJS } from '@confluentinc/kafka-javascript';
import { type CloudEvent } from './envelope.js';
import {
  type EventHandler,
  type EventMessage,
  type EventPublisher,
  type EventSubscriber,
} from './bus.js';

export interface KafkaOptions {
  readonly brokers: readonly string[];
  readonly clientId: string;
}

/**
 * Kafka adapter on Confluent's librdkafka client (KafkaJS-compatible API). Idempotent
 * producer with acks=all, so a resolved publish is durable and not duplicated by retries.
 * NOTE: not exercised against a live broker in this repository's local test run (no
 * Docker); CI and the dev stack cover it.
 */
export class KafkaEventPublisher implements EventPublisher {
  private readonly producer: KafkaJS.Producer;
  private connected: Promise<void> | undefined;

  constructor(options: KafkaOptions) {
    const kafka = new KafkaJS.Kafka({
      kafkaJS: { brokers: [...options.brokers], clientId: options.clientId },
    });
    this.producer = kafka.producer({ kafkaJS: { idempotent: true, acks: -1 } });
  }

  async publish(messages: readonly EventMessage[]): Promise<void> {
    this.connected ??= this.producer.connect();
    await this.connected;
    const byTopic = new Map<
      string,
      { key: string; value: string; headers: Record<string, string> }[]
    >();
    for (const m of messages) {
      const list = byTopic.get(m.topic) ?? [];
      list.push({
        key: m.key,
        value: JSON.stringify(m.event),
        headers: { ce_type: m.event.type, ce_id: m.event.id, ce_tenantid: m.event.tenantid },
      });
      byTopic.set(m.topic, list);
    }
    await this.producer.sendBatch({
      topicMessages: [...byTopic].map(([topic, msgs]) => ({ topic, messages: msgs })),
    });
  }

  async close(): Promise<void> {
    if (this.connected) await this.producer.disconnect();
  }
}

export class KafkaEventSubscriber implements EventSubscriber {
  private readonly consumers: KafkaJS.Consumer[] = [];

  constructor(private readonly options: KafkaOptions) {}

  async subscribe(group: string, topics: readonly string[], handler: EventHandler): Promise<void> {
    const kafka = new KafkaJS.Kafka({
      kafkaJS: { brokers: [...this.options.brokers], clientId: this.options.clientId },
    });
    const consumer = kafka.consumer({
      kafkaJS: { groupId: group, fromBeginning: true, autoCommit: false },
    });
    await consumer.connect();
    await consumer.subscribe({ topics: [...topics] });
    this.consumers.push(consumer);
    await consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        if (message.value) await handler(JSON.parse(message.value.toString()) as CloudEvent);
        // Commit only after the handler (and its inbox write) succeeded: at-least-once.
        await consumer.commitOffsets([
          { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
        ]);
      },
    });
  }

  async close(): Promise<void> {
    await Promise.all(this.consumers.map((c) => c.disconnect()));
  }
}
