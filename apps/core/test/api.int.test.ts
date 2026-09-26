import { foundationMigrations, Migrator } from '@manuling/db';
import { Public, ZodPipe } from '@manuling/http';
import { ConcurrencyConflictError, RequestContexts } from '@manuling/kernel';
import { platformMigrations } from '@manuling/platform/module';
import { type EphemeralPostgres, startEphemeralPostgres, withClient } from '@manuling/testing';
import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApiApp } from '../src/bootstrap.js';
import { type AppConfig, loadConfig } from '../src/config/config.js';

const echoSchema = z.object({ name: z.string().min(1), qty: z.string().regex(/^\d+$/) });

@Public()
@Controller('__test')
class ProbeController {
  @Get('context')
  context(): unknown {
    return RequestContexts.current();
  }

  @Get('context-async')
  async contextAsync(): Promise<unknown> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return RequestContexts.current();
  }

  @Get('conflict')
  conflict(): never {
    throw new ConcurrencyConflictError('Item', 'abc', 1, 2);
  }

  @Get('boom')
  boom(): never {
    throw new Error('secret internal detail');
  }

  @Post('echo')
  echo(@Body(new ZodPipe(echoSchema)) body: z.output<typeof echoSchema>): unknown {
    return body;
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

let server: EphemeralPostgres;
let app: NestFastifyApplication;
let config: AppConfig;

beforeAll(async () => {
  server = await startEphemeralPostgres();
  const adminUrl = await server.createDatabase('manuling_core_test');
  await withClient(adminUrl, async (client) => {
    await new Migrator(client).migrate([foundationMigrations, platformMigrations]);
    await client.query(`CREATE ROLE mnl_app LOGIN PASSWORD 'app' IN ROLE app_rw`);
  });
  config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: server.urlFor('manuling_core_test', 'mnl_app', 'app'),
    OIDC_ISSUER: 'https://idp.test/realms/manuling',
  });
  app = await createApiApp(config, { imports: [ProbeModule] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
  await server?.stop();
});

describe('health', () => {
  it('reports liveness and readiness', async () => {
    const live = await app.inject({ method: 'GET', url: '/health/live' });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: 'ok' });
    expect(live.headers['cache-control']).toBe('no-store');

    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ok', checks: { database: 'ok' } });
  });

  it('is not ready when the database is unreachable', async () => {
    const broken = await createApiApp({
      ...config,
      database: { ...config.database, url: 'postgres://nobody:x@127.0.0.1:1/none' },
    });
    await broken.init();
    try {
      const res = await broken.inject({ method: 'GET', url: '/health/ready' });
      expect(res.statusCode).toBe(503);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.json()).toMatchObject({ code: 'health.database_unavailable', status: 503 });
    } finally {
      await broken.close();
    }
  });
});

describe('request context', () => {
  it('propagates correlation id and negotiated locale into handlers, across awaits', async () => {
    for (const url of ['/__test/context', '/__test/context-async']) {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: {
          'x-correlation-id': 'gateway-trace-0001',
          'accept-language': 'kn,en;q=0.5',
          'x-manuling-client': 'web',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-correlation-id']).toBe('gateway-trace-0001');
      expect(res.json()).toMatchObject({
        correlationId: 'gateway-trace-0001',
        locale: 'kn-IN',
        source: 'ui',
        timezone: 'Asia/Kolkata',
        companyIds: [],
      });
    }
  });

  it('mints a UUIDv7 correlation id when none (or a malformed one) is sent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/__test/context',
      headers: { 'x-correlation-id': 'bad id!' },
    });
    const id = res.headers['x-correlation-id'] as string;
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(res.json()).toMatchObject({ correlationId: id, source: 'api', locale: 'en-IN' });
  });
});

describe('problem details (RFC 9457)', () => {
  it('returns 404 for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope?x=1' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ code: 'http.route_not_found', instance: '/nope' });
  });

  it('maps optimistic concurrency conflicts to 412', async () => {
    const res = await app.inject({ method: 'GET', url: '/__test/conflict' });
    expect(res.statusCode).toBe(412);
    expect(res.json()).toMatchObject({
      code: 'kernel.concurrency_conflict',
      params: { expectedVersion: 1 },
    });
  });

  it('returns 422 with field errors for invalid bodies', async () => {
    const ok = await app.inject({
      method: 'POST',
      url: '/__test/echo',
      payload: { name: 'bolt', qty: '5' },
    });
    expect(ok.statusCode).toBe(201);
    const res = await app.inject({
      method: 'POST',
      url: '/__test/echo',
      payload: { name: '', qty: '1.5' },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json<{ errors: { path: string }[] }>();
    expect(body.errors.map((e) => e.path).sort()).toEqual(['name', 'qty']);
  });

  it('returns 400 for malformed JSON and 415 for unsupported media types', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/__test/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"name":',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.headers['content-type']).toContain('application/problem+json');
    expect(bad.json()).toMatchObject({ code: 'http.malformed_request' });

    const xml = await app.inject({
      method: 'POST',
      url: '/__test/echo',
      headers: { 'content-type': 'application/xml' },
      payload: '<a/>',
    });
    expect(xml.statusCode).toBe(415);
    expect(xml.headers['content-type']).toContain('application/problem+json');
    expect(xml.json()).toMatchObject({ code: 'http.unsupported_media_type' });
  });

  it('hides internal error details but returns the correlation id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/__test/boom',
      headers: { 'x-correlation-id': 'trace-boom-01' },
    });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret internal detail');
    expect(res.json()).toMatchObject({ code: 'internal_error', correlationId: 'trace-boom-01' });
  });
});

describe('OpenAPI', () => {
  it('serves an OpenAPI 3.1 document with health paths and ProblemDetails', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json<{
      openapi: string;
      paths: Record<string, unknown>;
      components: { schemas: object };
    }>();
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/health/live', '/health/ready']),
    );
    expect(doc.components.schemas).toHaveProperty('ProblemDetails');
  });
});
