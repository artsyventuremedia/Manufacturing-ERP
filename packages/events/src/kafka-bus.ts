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
  /**
   * Create missing topics before first use (development, CI, small on-prem installs). In
   * managed clusters topics are provisioned by infrastructure and this stays off.
   */
  readonly autoCreateTopics?: boolean;
  /** Partitions for auto-created topics; ordering is per partition key (tenant:aggregate). */
  readonly topicPartitions?: number;
  /** Replication factor for auto-created topics (1 for a single dev broker, 3 in production). */
  readonly replicationFactor?: number;
}

function client(options: KafkaOptions): KafkaJS.Kafka {
  return new KafkaJS.Kafka({
    kafkaJS: {
      brokers: [...options.brokers],
      clientId: options.clientId,
      logLevel: KafkaJS.logLevel.WARN,
    },
  });
}

/** Creates the topics that do not exist yet; idempotent and safe to race. */
class TopicProvisioner {
  private readonly known = new Set<string>();

  constructor(
    private readonly kafka: KafkaJS.Kafka,
    private readonly options: KafkaOptions,
  ) {}

  async ensure(topics: Iterable<string>): Promise<void> {
    if (!this.options.autoCreateTopics) return;
    const wanted = [...new Set(topics)].filter((t) => !this.known.has(t));
    if (wanted.length === 0) return;
    const admin = this.kafka.admin();
    await admin.connect();
    try {
      const existing = new Set(await admin.listTopics());
      const missing = wanted.filter((t) => !existing.has(t));
      if (missing.length > 0) {
        try {
          await admin.createTopics({
            topics: missing.map((topic) => ({
              topic,
              numPartitions: this.options.topicPartitions ?? 6,
              replicationFactor: this.options.replicationFactor ?? 1,
            })),
          });
        } catch (err) {
          // Another process created it first.
          if (!/already exists/i.test(String((err as Error).message))) throw err;
        }
      }
      for (const t of wanted) this.known.add(t);
    } finally {
      await admin.disconnect();
    }
  }
}

/**
 * Kafka adapter on Confluent's librdkafka client (KafkaJS-compatible API). Idempotent
 * producer with acks=all, so a resolved publish is durable and not duplicated by retries.
 */
export class KafkaEventPublisher implements EventPublisher {
  private readonly producer: KafkaJS.Producer;
  private readonly topics: TopicProvisioner;
  private connected: Promise<void> | undefined;

  constructor(options: KafkaOptions) {
    const kafka = client(options);
    this.topics = new TopicProvisioner(kafka, options);
    this.producer = kafka.producer({ kafkaJS: { idempotent: true, acks: -1 } });
  }

  async publish(messages: readonly EventMessage[]): Promise<void> {
    if (messages.length === 0) return;
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
    await this.topics.ensure(byTopic.keys());
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
  private readonly kafka: KafkaJS.Kafka;
  private readonly topics: TopicProvisioner;

  constructor(options: KafkaOptions) {
    this.kafka = client(options);
    this.topics = new TopicProvisioner(this.kafka, options);
  }

  async subscribe(group: string, topics: readonly string[], handler: EventHandler): Promise<void> {
    await this.topics.ensure(topics);
    const consumer = this.kafka.consumer({
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
