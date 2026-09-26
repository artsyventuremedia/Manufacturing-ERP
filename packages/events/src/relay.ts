import type pg from 'pg';
import { type EventMessage, type EventPublisher } from './bus.js';
import { type CloudEvent } from './envelope.js';

export interface RelayOptions {
  readonly batchSize?: number;
  readonly pollIntervalMs?: number;
  readonly maxBackoffMs?: number;
  readonly retentionDays?: number;
  /** Advisory-lock key for leader election; one active relay per database. */
  readonly lockKey?: number;
}

export interface RelayLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface RelayBatchResult {
  readonly published: number;
  readonly failed: boolean;
}

const silent: RelayLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Outbox relay (ADR-0007 §2). Connects as a member of `outbox_relay`, the only role that
 * can see every tenant's outbox rows. Leader-elected with a session advisory lock, so
 * rows are published in `position` order by exactly one process; standbys wait.
 * A failed batch is retried with exponential backoff; the error is recorded on the rows.
 */
export class OutboxRelay {
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly retentionDays: number;
  private readonly lockKey: number;
  private leader: pg.PoolClient | undefined;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;
  private iterations = 0;

  constructor(
    private readonly pool: pg.Pool,
    private readonly publisher: EventPublisher,
    options: RelayOptions = {},
    private readonly logger: RelayLogger = silent,
  ) {
    this.batchSize = options.batchSize ?? 100;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.retentionDays = options.retentionDays ?? 7;
    this.lockKey = options.lockKey ?? 7_331_002;
  }

  /** Tries to become the leader; true if this instance may publish. */
  async acquireLeadership(): Promise<boolean> {
    if (this.leader) return true;
    const client = await this.pool.connect();
    const res = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [
      this.lockKey,
    ]);
    if (res.rows[0]?.ok) {
      this.leader = client;
      this.logger.info({ lockKey: this.lockKey }, 'outbox relay acquired leadership');
      return true;
    }
    client.release();
    return false;
  }

  /** Publishes one batch of due rows. Call only while leader. */
  async runOnce(): Promise<RelayBatchResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const due = await client.query<{
        id: string;
        topic: string;
        partition_key: string;
        envelope: CloudEvent;
        attempts: number;
      }>(
        `SELECT id, topic, partition_key, envelope, attempts FROM platform.outbox
          WHERE published_at IS NULL AND next_attempt_at <= now()
          ORDER BY position LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [this.batchSize],
      );
      if (due.rows.length === 0) {
        await client.query('COMMIT');
        return { published: 0, failed: false };
      }
      const ids = due.rows.map((r) => r.id);
      const messages: EventMessage[] = due.rows.map((r) => ({
        topic: r.topic,
        key: r.partition_key,
        event: r.envelope,
      }));
      try {
        await this.publisher.publish(messages);
      } catch (err) {
        const attempts = Math.max(...due.rows.map((r) => r.attempts)) + 1;
        const delayMs = Math.min(this.maxBackoffMs, 250 * 2 ** (attempts - 1));
        await client.query(
          `UPDATE platform.outbox SET attempts = attempts + 1, last_error = $2,
                  next_attempt_at = now() + make_interval(secs => $3::double precision / 1000)
            WHERE id = ANY($1::uuid[])`,
          [ids, String(err instanceof Error ? err.message : err).slice(0, 2000), delayMs],
        );
        await client.query('COMMIT');
        this.logger.warn(
          { err, count: ids.length, attempts, delayMs },
          'outbox publish failed; will retry',
        );
        return { published: 0, failed: true };
      }
      await client.query(
        'UPDATE platform.outbox SET published_at = now(), last_error = NULL WHERE id = ANY($1::uuid[])',
        [ids],
      );
      await client.query('COMMIT');
      return { published: ids.length, failed: false };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Deletes published rows past retention (replay beyond that comes from Kafka/archives). */
  async prune(): Promise<number> {
    const res = await this.pool.query(
      `DELETE FROM platform.outbox WHERE published_at < now() - make_interval(days => $1)`,
      [this.retentionDays],
    );
    return res.rowCount ?? 0;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
    if (this.leader) {
      await this.leader
        .query('SELECT pg_advisory_unlock($1)', [this.lockKey])
        .catch(() => undefined);
      this.leader.release();
      this.leader = undefined;
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.tick().finally(() => (this.running = undefined));
    }, delayMs);
  }

  private async tick(): Promise<void> {
    let next = this.pollIntervalMs;
    try {
      if (await this.acquireLeadership()) {
        const result = await this.runOnce();
        if (result.published === this.batchSize) next = 0; // drain backlog quickly
        if (++this.iterations % 1_000 === 0) await this.prune();
      }
    } catch (err) {
      this.logger.error({ err }, 'outbox relay iteration failed');
      if (this.leader) {
        this.leader.release(true);
        this.leader = undefined; // re-elect on the next tick
      }
    }
    this.schedule(next);
  }
}
