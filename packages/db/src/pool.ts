import pg from 'pg';

export interface PoolConfig {
  readonly connectionString: string;
  readonly max?: number;
  readonly applicationName?: string;
  readonly idleTimeoutMs?: number;
  readonly connectionTimeoutMs?: number;
  /** Called when an idle connection fails (server restart, failover, admin termination). */
  readonly onIdleError?: (err: Error) => void;
}

/**
 * Creates a pg pool. NUMERIC and BIGINT are left as strings by the driver (never parsed to
 * JS numbers), which is exactly what Money/Quantity expect (ADR-0008).
 *
 * An idle connection that dies (e.g. `57P01` on server shutdown or failover) makes the pool
 * emit `error`; without a listener that crashes the process. pg already discards the broken
 * client, so the listener only reports it.
 */
export function createPool(config: PoolConfig): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max ?? 10,
    application_name: config.applicationName ?? 'manuling',
    idleTimeoutMillis: config.idleTimeoutMs ?? 30_000,
    connectionTimeoutMillis: config.connectionTimeoutMs ?? 5_000,
  });
  pool.on('error', (err) => config.onIdleError?.(err));
  return pool;
}
