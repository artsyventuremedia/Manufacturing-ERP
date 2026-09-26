import { Public } from '@manuling/http';
import { ServiceUnavailableError } from '@manuling/kernel';
import { Controller, Get, Header, Inject } from '@nestjs/common';
import type pg from 'pg';
import { PG_POOL } from '../database/database.module.js';

const READINESS_TIMEOUT_MS = 2_000;

export interface HealthResponse {
  readonly status: 'ok';
  readonly checks?: Readonly<Record<string, 'ok'>>;
}

/**
 * Kubernetes probes. Unauthenticated by design and tenant-agnostic, so they use the pool
 * directly instead of a UnitOfWork.
 */
@Public()
@Controller('health')
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /** Liveness: the process is up and the event loop responds. */
  @Get('live')
  @Header('cache-control', 'no-store')
  live(): HealthResponse {
    return { status: 'ok' };
  }

  /** Readiness: dependencies needed to serve traffic are reachable. */
  @Get('ready')
  @Header('cache-control', 'no-store')
  async ready(): Promise<HealthResponse> {
    try {
      await withTimeout(this.pool.query('SELECT 1'), READINESS_TIMEOUT_MS);
    } catch (err) {
      throw new ServiceUnavailableError(
        'health.database_unavailable',
        'Database is not reachable',
        {},
        { cause: err },
      );
    }
    return { status: 'ok', checks: { database: 'ok' } };
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
