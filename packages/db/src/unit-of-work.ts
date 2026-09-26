import { AsyncLocalStorage } from 'node:async_hooks';
import { InvariantViolation, type RequestContext, RequestContexts, isId } from '@manuling/kernel';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { isRetryableTransactionError, mapDatabaseError } from './errors.js';

export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

export interface TransactionOptions {
  readonly isolation?: IsolationLevel;
  readonly readOnly?: boolean;
  /** Retries on serialization failure/deadlock. Defaults to 3 for serializable, else 0. */
  readonly maxRetries?: number;
}

export interface DbTransaction {
  readonly db: NodePgDatabase;
  readonly client: pg.PoolClient;
  readonly isolation: IsolationLevel;
  readonly readOnly: boolean;
}

export interface UnitOfWorkOptions {
  /** Per-transaction statement timeout; protects the pooled cell from runaway queries. */
  readonly statementTimeoutMs?: number;
  /**
   * Separate pool for {@link UnitOfWork.runIndependent}. An independent transaction is
   * usually opened while the caller still holds a connection; drawing both from one pool
   * deadlocks under load once every connection is held by a caller waiting for a second.
   */
  readonly independentPool?: pg.Pool;
}

/**
 * The only way application code reaches the database (ADR-0004 §2).
 *
 * Each call opens one transaction and applies the ambient {@link RequestContext} with
 * `set_config(..., true)` (transaction-local, so it is safe behind PgBouncer in transaction
 * mode). RLS policies read `app.tenant_id`; without a tenant every tenant table is empty
 * and unwritable, i.e. the system fails closed (ADR-0005).
 *
 * Nested `run` calls join the outer transaction, so ledger postings across modules commit
 * or roll back together (ADR-0006).
 */
export class UnitOfWork {
  private readonly storage = new AsyncLocalStorage<DbTransaction>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly options: UnitOfWorkOptions = {},
  ) {}

  /** The active transaction; repositories call this and never open connections themselves. */
  current(): DbTransaction {
    const tx = this.storage.getStore();
    if (!tx) {
      throw new InvariantViolation(
        'db.no_transaction',
        'Database access outside a UnitOfWork; wrap the use case in uow.run()',
      );
    }
    return tx;
  }

  inTransaction(): boolean {
    return this.storage.getStore() !== undefined;
  }

  async run<T>(
    fn: (tx: DbTransaction) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    const existing = this.storage.getStore();
    if (existing) return this.join(existing, fn, options);
    return this.runNew(fn, options);
  }

  /**
   * Runs `fn` in a new transaction on its own connection even when a transaction is already
   * active, and commits it independently (e.g. gap-tolerant number allocation, denial
   * auditing). Use sparingly: its effects survive a rollback of the caller.
   */
  runIndependent<T>(
    fn: (tx: DbTransaction) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    const pool = this.options.independentPool ?? this.pool;
    return this.storage.exit(() => this.runNew(fn, options, pool));
  }

  private async runNew<T>(
    fn: (tx: DbTransaction) => Promise<T>,
    options: TransactionOptions,
    pool: pg.Pool = this.pool,
  ): Promise<T> {
    const context = RequestContexts.require();
    const isolation = options.isolation ?? 'read committed';
    const maxRetries = options.maxRetries ?? (isolation === 'serializable' ? 3 : 0);

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.runOnce(pool, context, fn, isolation, options.readOnly ?? false);
      } catch (err) {
        if (attempt < maxRetries && isRetryableTransactionError(err)) continue;
        throw mapDatabaseError(err);
      }
    }
  }

  private join<T>(
    existing: DbTransaction,
    fn: (tx: DbTransaction) => Promise<T>,
    options: TransactionOptions,
  ): Promise<T> {
    if (options.isolation && options.isolation !== existing.isolation) {
      throw new InvariantViolation(
        'db.nested_isolation_mismatch',
        `Nested unit of work requested ${options.isolation} inside ${existing.isolation}`,
      );
    }
    if (existing.readOnly && options.readOnly === false) {
      throw new InvariantViolation(
        'db.nested_write_in_read_only',
        'Nested unit of work requested writes inside a read-only transaction',
      );
    }
    return fn(existing);
  }

  private async runOnce<T>(
    pool: pg.Pool,
    context: RequestContext,
    fn: (tx: DbTransaction) => Promise<T>,
    isolation: IsolationLevel,
    readOnly: boolean,
  ): Promise<T> {
    const settings = sessionSettings(context, this.options.statementTimeoutMs ?? 15_000);
    const client = await pool.connect();
    let discardConnection = false;
    try {
      await client.query(
        `BEGIN ISOLATION LEVEL ${isolation.toUpperCase()}${readOnly ? ' READ ONLY' : ''}`,
      );
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true),
                set_config('app.user_id', $2, true),
                set_config('app.actor_type', $3, true),
                set_config('app.actor_id', $4, true),
                set_config('app.company_ids', $5, true),
                set_config('app.correlation_id', $6, true),
                set_config('app.source', $7, true),
                set_config('statement_timeout', $8, true)`,
        settings,
      );
      const tx: DbTransaction = { db: drizzle(client), client, isolation, readOnly };
      const result = await this.storage.run(tx, () => fn(tx));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discardConnection = true;
      }
      throw err;
    } finally {
      client.release(discardConnection);
    }
  }
}

function sessionSettings(context: RequestContext, statementTimeoutMs: number): string[] {
  const tenantId = context.tenantId ?? '';
  if (tenantId !== '' && !isId(tenantId)) {
    throw new InvariantViolation(
      'db.invalid_tenant_context',
      'tenantId in request context is not a UUID',
    );
  }
  const actor = context.actor;
  const userId = actor ? (actor.type === 'user' ? actor.id : (actor.onBehalfOf ?? '')) : '';
  if (userId !== '' && !isId(userId)) {
    throw new InvariantViolation(
      'db.invalid_user_context',
      'userId in request context is not a UUID',
    );
  }
  for (const companyId of context.companyIds) {
    if (!isId(companyId)) {
      throw new InvariantViolation('db.invalid_company_context', 'companyIds must be UUIDs');
    }
  }
  return [
    tenantId,
    userId,
    actor?.type ?? '',
    actor?.id ?? '',
    context.companyIds.join(','),
    context.correlationId,
    context.source,
    String(statementTimeoutMs),
  ];
}
