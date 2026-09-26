import { newId } from '@manuling/kernel';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type CloudEvent,
  KafkaEventPublisher,
  KafkaEventSubscriber,
  buildEnvelope,
} from '../src/index.js';

/**
 * Runs against a real broker when KAFKA_TEST_BROKERS is set (dev stack: localhost:9092;
 * CI: the Kafka service container). Skipped otherwise.
 */
const brokers = process.env['KAFKA_TEST_BROKERS']?.split(',').filter(Boolean) ?? [];
const suite = brokers.length > 0 ? describe : describe.skip;

suite('Kafka adapter (real broker)', () => {
  const runId = newId().slice(-12);
  const context = `kt${runId.replace(/-/g, '')}`;
  const type = `${context}.ThingHappened.v1`;
  const topic = `manuling.${context}.events.v1`;
  const options = {
    brokers,
    clientId: 'manuling-test',
    autoCreateTopics: true,
    topicPartitions: 3,
  };
  const publisher = new KafkaEventPublisher(options);
  const subscriber = new KafkaEventSubscriber(options);

  afterAll(async () => {
    await subscriber.close();
    await publisher.close();
  });

  const event = (tenant: string, aggregate: string, n: number): CloudEvent =>
    buildEnvelope(
      { type, aggregateType: 'Thing', aggregateId: aggregate, data: { n } },
      {
        correlationId: 'kafka-test',
        source: 'system',
        locale: 'en-IN',
        timezone: 'UTC',
        companyIds: [],
        tenantId: tenant,
        actor: { type: 'system', id: 'test' },
      },
      new Date(),
    );

  it('auto-creates the topic, publishes durably and delivers in order per key', async () => {
    const tenant = newId();
    const aggregate = newId();
    const received: number[] = [];
    let done: () => void = () => undefined;
    const allReceived = new Promise<void>((r) => (done = r));

    await subscriber.subscribe(`manuling.test.${runId}`, [topic], (e) => {
      received.push((e.data as { n: number }).n);
      if (received.length === 20) done();
      return Promise.resolve();
    });
    for (let batch = 0; batch < 4; batch++) {
      await publisher.publish(
        Array.from({ length: 5 }, (_, i) => {
          const e = event(tenant, aggregate, batch * 5 + i);
          return { topic, key: `${tenant}:${aggregate}`, event: e };
        }),
      );
    }
    await Promise.race([
      allReceived,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 45_000)),
    ]);
    expect(received).toEqual(Array.from({ length: 20 }, (_, i) => i));
  }, 90_000);
});
