import pg from 'pg';

export interface PoolConfig {
  readonly connectionString: string;
  readonly max?: number;
  readonly applicationName?: string;
  readonly idleTimeoutMs?: number;
  readonly connectionTimeoutMs?: number;
}

/**
 * Creates a pg pool. NUMERIC and BIGINT are left as strings by the driver (never parsed to
 * JS numbers), which is exactly what Money/Quantity expect (ADR-0008).
 */
export function createPool(config: PoolConfig): pg.Pool {
  return new pg.Pool({
    connectionString: config.connectionString,
    max: config.max ?? 10,
    application_name: config.applicationName ?? 'manuling',
    idleTimeoutMillis: config.idleTimeoutMs ?? 30_000,
    connectionTimeoutMillis: config.connectionTimeoutMs ?? 5_000,
  });
}
