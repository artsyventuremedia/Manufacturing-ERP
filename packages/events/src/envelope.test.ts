import { describe, expect, it } from 'vitest';
import { buildEnvelope, contextOf, partitionKey, topicFor } from './envelope.js';
import { InMemoryEventBus } from './memory-bus.js';

const ctx = {
  correlationId: 'c-1',
  source: 'api' as const,
  locale: 'en-IN',
  timezone: 'UTC',
  companyIds: [],
  tenantId: 't-1',
  actor: { type: 'user' as const, id: 'u-1' },
};

describe('envelope helpers', () => {
  it('derives context, topic and partition key', () => {
    expect(contextOf('inventory.StockMoved.v1')).toBe('inventory');
    expect(topicFor('platform.CompanyCreated.v2')).toBe('manuling.platform.events.v1');
    expect(partitionKey('t', 'a')).toBe('t:a');
    expect(() => topicFor('bad-type')).toThrow(TypeError);
  });

  it('builds CloudEvents with tenant, correlation, causation and actor', () => {
    const e = buildEnvelope(
      {
        type: 'sales.SalesOrderConfirmed.v1',
        aggregateType: 'SalesOrder',
        aggregateId: 'so1',
        data: { total: '10.00' },
        causationId: 'ev0',
      },
      ctx,
      new Date('2026-09-25T00:00:00Z'),
    );
    expect(e).toMatchObject({
      specversion: '1.0',
      source: 'manuling/sales',
      subject: 'SalesOrder/so1',
      time: '2026-09-25T00:00:00.000Z',
      tenantid: 't-1',
      correlationid: 'c-1',
      causationid: 'ev0',
      actor: { type: 'user', id: 'u-1' },
    });
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('InMemoryEventBus', () => {
  it('delivers in order to subscribed topics only, and can simulate outages', async () => {
    const bus = new InMemoryEventBus();
    const got: string[] = [];
    await bus.subscribe('g', ['t1'], (e) => {
      got.push(e.id);
      return Promise.resolve();
    });
    const event = (id: string) => ({
      ...buildEnvelope(
        { type: 'a.B.v1', aggregateType: 'B', aggregateId: 'x', data: {} },
        ctx,
        new Date(),
      ),
      id,
    });
    await bus.publish([
      { topic: 't1', key: 'k', event: event('1') },
      { topic: 't2', key: 'k', event: event('2') },
      { topic: 't1', key: 'k', event: event('3') },
    ]);
    expect(got).toEqual(['1', '3']);
    bus.failNextPublishes(1);
    await expect(bus.publish([])).rejects.toThrow('simulated broker outage');
    await bus.close();
  });
});
