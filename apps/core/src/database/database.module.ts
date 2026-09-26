import { AuditTrail, UnitOfWork, createPool } from '@manuling/db';
import { EventOutbox } from '@manuling/events';
import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import type pg from 'pg';
import { APP_CONFIG, type AppConfig } from '../config/config.js';

export const PG_POOL = Symbol('PG_POOL');
/** Pool for UnitOfWork.runIndependent, so nested independent transactions cannot starve the main pool. */
export const PG_INDEPENDENT_POOL = Symbol('PG_INDEPENDENT_POOL');

@Injectable()
class PoolLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(PG_INDEPENDENT_POOL) private readonly independentPool: pg.Pool,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.pool.end(), this.independentPool.end()]);
  }
}

/**
 * Provides the application pool (app_rw member role), the UnitOfWork, and the audit trail
 * and outbox writers that join its transactions. Modules must use UnitOfWork; direct
 * PG_POOL access is reserved for infrastructure such as health checks.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        createPool({
          connectionString: config.database.url,
          max: config.database.poolMax,
          applicationName: 'manuling-core',
        }),
    },
    {
      provide: PG_INDEPENDENT_POOL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        createPool({
          connectionString: config.database.url,
          max: Math.max(2, Math.ceil(config.database.poolMax / 4)),
          applicationName: 'manuling-core-independent',
        }),
    },
    {
      provide: UnitOfWork,
      inject: [PG_POOL, PG_INDEPENDENT_POOL, APP_CONFIG],
      useFactory: (pool: pg.Pool, independentPool: pg.Pool, config: AppConfig) =>
        new UnitOfWork(pool, {
          statementTimeoutMs: config.database.statementTimeoutMs,
          independentPool,
        }),
    },
    {
      provide: AuditTrail,
      inject: [UnitOfWork],
      useFactory: (uow: UnitOfWork) => new AuditTrail(uow),
    },
    {
      provide: EventOutbox,
      inject: [UnitOfWork],
      useFactory: (uow: UnitOfWork) => new EventOutbox(uow),
    },
    PoolLifecycle,
  ],
  exports: [PG_POOL, UnitOfWork, AuditTrail, EventOutbox],
})
export class DatabaseModule {}
