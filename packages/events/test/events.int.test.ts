import { Migrator, UnitOfWork, createPool, foundationMigrations } from '@manuling/db';
import { type RequestContext, RequestContexts, newId } from '@manuling/kernel';
import { type EphemeralPostgres, startEphemeralPostgres } from '@manuling/testing';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type CloudEvent,
  ConsumerRunner,
  type EventConsumer,
  EventOutbox,
  InMemoryEventBus,
  OutboxRelay,
} from '../src/index.js';

const A = newId();
const B = newId();
const USER = newId();
const ctx = (tenantId: string): RequestContext => ({
  correlationId: `corr-${tenantId.slice(-4)}`,
  source: 'api',
  locale: 'en-IN',
  timezone: 'Asia/Kolkata',
  companyIds: [],
  tenantId,
  actor: { type: 'user', id: USER },
});

let server: EphemeralPostgres;
let admin: pg.Client;
let appPool: pg.Pool;
let relayPool: pg.Pool;
let uow: UnitOfWork;
let outbox: EventOutbox;

const inTenant = <T>(tenantId: string, fn: () => Promise<T>) =>
  RequestContexts.run(ctx(tenantId), () => uow.run(fn));
const companyCreated = (id: string, code: string) => ({
  type: 'platform.CompanyCreated.v1',
  aggregateType: 'Company',
  aggregateId: id,
  data: { id, code },
});

beforeAll(async () => {
  server = await startEphemeralPostgres();
  const url = await server.createDatabase('manuling_events_test');
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await new Migrator(admin).migrate([foundationMigrations]);
  await admin.query(`CREATE ROLE mnl_app LOGIN PASSWORD 'app' IN ROLE app_rw`);
  await admin.query(`CREATE ROLE mnl_relay LOGIN PASSWORD 'relay' IN ROLE outbox_relay`);
  appPool = createPool({
    connectionString: server.urlFor('manuling_events_test', 'mnl_app', 'app'),
  });
  relayPool = createPool({
    connectionString: server.urlFor('manuling_events_test', 'mnl_relay', 'relay'),
  });
  uow = new UnitOfWork(appPool);
  outbox = new EventOutbox(uow);
});

afterAll(async () => {
  await appPool?.end();
  await relayPool?.end();
  await admin?.end();
  await server?.stop();
});

beforeEach(async () => {
  await admin.query('TRUNCATE platform.outbox, platform.inbox, platform.dead_letter');
});

describe('EventOutbox', () => {
  it('writes CloudEvents in the caller transaction, and nothing on rollback', async () => {
    const id = newId();
    const [envelope] = await inTenant(A, () => outbox.append(companyCreated(id, 'MPC')));
    expect(envelope).toMatchObject({
      specversion: '1.0',
      type: 'platform.CompanyCreated.v1',
      source: 'manuling/platform',
      subject: `Company/${id}`,
      tenantid: A,
      correlationid: ctx(A).correlationId,
      actor: { type: 'user', id: USER },
      data: { id, code: 'MPC' },
    });

    await expect(
      inTenant(A, async () => {
        await outbox.append(companyCreated(newId(), 'LOST'));
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    const rows = await admin.query('SELECT topic, partition_key, event_type FROM platform.outbox');
    expect(rows.rows).toEqual([
      {
        topic: 'manuling.platform.events.v1',
        partition_key: `${A}:${id}`,
        event_type: 'platform.CompanyCreated.v1',
      },
    ]);
  });

  it('keeps the app role inside its tenant while the relay role sees all tenants', async () => {
    await inTenant(A, () => outbox.append(companyCreated(newId(), 'A1')));
    await inTenant(B, () => outbox.append(companyCreated(newId(), 'B1')));
    const seenByB = await inTenant(
      B,
      async () => (await uow.current().db.execute(sql`SELECT tenant_id FROM platform.outbox`)).rows,
    );
    expect(seenByB).toEqual([{ tenant_id: B }]);
    await expect(
      inTenant(B, () => uow.current().db.execute(sql`UPDATE platform.outbox SET attempts = 9`)),
    ).rejects.toMatchObject({
      code: 'db.privilege_denied',
    });
    const seenByRelay = await relayPool.query('SELECT count(*)::int AS n FROM platform.outbox');
    expect(seenByRelay.rows[0]).toEqual({ n: 2 });
  });
});

describe('OutboxRelay', () => {
  it('publishes due rows in order with tenant:aggregate keys and marks them', async () => {
    const ids = [newId(), newId(), newId()];
    for (const [i, id] of ids.entries())
      await inTenant(A, () => outbox.append(companyCreated(id, `C${i}`)));
    const bus = new InMemoryEventBus();
    const relay = new OutboxRelay(relayPool, bus, { batchSize: 2 });
    expect(await relay.acquireLeadership()).toBe(true);

    expect(await relay.runOnce()).toEqual({ published: 2, failed: false });
    expect(await relay.runOnce()).toEqual({ published: 1, failed: false });
    expect(await relay.runOnce()).toEqual({ published: 0, failed: false });
    expect(bus.published.map((m) => (m.event.data as { id: string }).id)).toEqual(ids);
    expect(bus.published[0]!.key).toBe(`${A}:${ids[0]}`);
    const pending = await admin.query(
      'SELECT count(*)::int AS n FROM platform.outbox WHERE published_at IS NULL',
    );
    expect(pending.rows[0]).toEqual({ n: 0 });
    await relay.stop();
  });

  it('retries after a broker failure with backoff and records the error', async () => {
    await inTenant(A, () => outbox.append(companyCreated(newId(), 'RETRY')));
    const bus = new InMemoryEventBus();
    bus.failNextPublishes(1);
    const relay = new OutboxRelay(relayPool, bus, { maxBackoffMs: 1 });
    await relay.acquireLeadership();

    expect(await relay.runOnce()).toEqual({ published: 0, failed: true });
    const failed = await admin.query('SELECT attempts, last_error FROM platform.outbox');
    expect(failed.rows[0]).toEqual({ attempts: 1, last_error: 'simulated broker outage' });

    await new Promise((r) => setTimeout(r, 20));
    expect(await relay.runOnce()).toEqual({ published: 1, failed: false });
    const done = await admin.query(
      'SELECT published_at IS NOT NULL AS published, last_error FROM platform.outbox',
    );
    expect(done.rows[0]).toEqual({ published: true, last_error: null });
    await relay.stop();
  });

  it('elects a single leader; a standby takes over after the leader stops', async () => {
    const first = new OutboxRelay(relayPool, new InMemoryEventBus(), { lockKey: 991 });
    const second = new OutboxRelay(relayPool, new InMemoryEventBus(), { lockKey: 991 });
    expect(await first.acquireLeadership()).toBe(true);
    expect(await second.acquireLeadership()).toBe(false);
    await first.stop();
    expect(await second.acquireLeadership()).toBe(true);
    await second.stop();
  });

  it('runs continuously and drains new events', async () => {
    const bus = new InMemoryEventBus();
    const relay = new OutboxRelay(relayPool, bus, { pollIntervalMs: 10 });
    relay.start();
    await inTenant(B, () => outbox.append(companyCreated(newId(), 'LIVE')));
    for (let i = 0; i < 100 && bus.published.length === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    await relay.stop();
    expect(bus.published).toHaveLength(1);
  });

  it('prunes published rows past retention', async () => {
    await inTenant(A, () => outbox.append(companyCreated(newId(), 'OLD')));
    await admin.query(`UPDATE platform.outbox SET published_at = now() - interval '8 days'`);
    const relay = new OutboxRelay(relayPool, new InMemoryEventBus());
    expect(await relay.prune()).toBe(1);
  });
});

describe('ConsumerRunner', () => {
  const makeEvent = async (): Promise<CloudEvent> => {
    const [event] = await inTenant(A, () => outbox.append(companyCreated(newId(), 'EVT')));
    return event!;
  };

  it('processes an event once even when delivered twice, in the event tenant context', async () => {
    const seen: { tenant: string | undefined; onBehalfOf: string | undefined }[] = [];
    const consumer: EventConsumer = {
      name: 'test.projector',
      eventTypes: ['platform.CompanyCreated.v1'],
      handle: () => {
        const c = RequestContexts.requireTenant();
        seen.push({ tenant: c.tenantId, onBehalfOf: c.actor.onBehalfOf });
        return Promise.resolve();
      },
    };
    const runner = new ConsumerRunner(uow, new InMemoryEventBus());
    const event = await makeEvent();
    expect(await runner.dispatch(consumer, event)).toBe('processed');
    expect(await runner.dispatch(consumer, event)).toBe('duplicate');
    expect(await runner.dispatch(consumer, { ...event, type: 'platform.PlantCreated.v1' })).toBe(
      'ignored',
    );
    expect(seen).toEqual([{ tenant: A, onBehalfOf: USER }]);
  });

  it('rolls back the inbox row with a failed handler, retries, then dead-letters', async () => {
    let calls = 0;
    const flaky: EventConsumer = {
      name: 'test.flaky',
      eventTypes: ['platform.CompanyCreated.v1'],
      handle: () => (++calls < 3 ? Promise.reject(new Error(`boom ${calls}`)) : Promise.resolve()),
    };
    const runner = new ConsumerRunner(uow, new InMemoryEventBus(), {
      maxAttempts: 5,
      sleep: () => Promise.resolve(),
    });
    expect(await runner.dispatch(flaky, await makeEvent())).toBe('processed');
    expect(calls).toBe(3);

    const broken: EventConsumer = {
      ...flaky,
      name: 'test.broken',
      handle: () => Promise.reject(new Error('always')),
    };
    const event = await makeEvent();
    expect(await runner.dispatch(broken, event)).toBe('dead_lettered');
    const dead = await admin.query(
      'SELECT consumer, event_id, error, attempts FROM platform.dead_letter',
    );
    expect(dead.rows).toEqual([
      { consumer: 'test.broken', event_id: event.id, error: 'always', attempts: 5 },
    ]);
    const inbox = await admin.query(
      `SELECT count(*)::int AS n FROM platform.inbox WHERE consumer = 'test.broken'`,
    );
    expect(inbox.rows[0]).toEqual({ n: 0 });
  });

  it('subscribes consumers to their topics end to end through the relay', async () => {
    const bus = new InMemoryEventBus();
    const received: string[] = [];
    const runner = new ConsumerRunner(uow, bus);
    await runner.start([
      {
        name: 'test.e2e',
        eventTypes: ['platform.CompanyCreated.v1'],
        handle: (e) => {
          received.push((e.data as { code: string }).code);
          return Promise.resolve();
        },
      },
    ]);
    await inTenant(A, () => outbox.append(companyCreated(newId(), 'E2E')));
    const relay = new OutboxRelay(relayPool, bus);
    await relay.acquireLeadership();
    await relay.runOnce();
    await relay.stop();
    expect(received).toEqual(['E2E']);
  });
});
