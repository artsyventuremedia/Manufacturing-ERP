import { Migrator, foundationMigrations } from '@manuling/db';
import { OidcTokenVerifier, platformMigrations } from '@manuling/platform/module';
import {
  type EphemeralPostgres,
  type TestIdp,
  createTestIdp,
  startEphemeralPostgres,
  withClient,
} from '@manuling/testing';
import { type ModuleMetadata } from '@nestjs/common';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { type LightMyRequestResponse } from 'fastify';
import { createApiApp } from '../src/bootstrap.js';
import { type AppConfig, loadConfig } from '../src/config/config.js';

export interface Harness {
  readonly server: EphemeralPostgres;
  /** Login for the outbox relay role (reads every tenant's outbox). */
  readonly relayUrl: string;
  readonly adminUrl: string;
  readonly idp: TestIdp;
  readonly config: AppConfig;
  readonly app: NestFastifyApplication;
  call(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT',
    url: string,
    o?: CallOptions,
  ): Promise<LightMyRequestResponse>;
  /** Runs SQL as the owner role (fixtures that deliberately bypass the API). */
  sql<T extends Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  stop(): Promise<void>;
}

export interface CallOptions {
  readonly sub?: string;
  readonly tenant?: string;
  readonly token?: string;
  readonly claims?: Record<string, unknown>;
  readonly headers?: Record<string, string>;
  readonly payload?: unknown;
}

/** Real Postgres + migrations + app with an in-memory OIDC issuer. */
export async function startHarness(
  database: string,
  extra: Pick<ModuleMetadata, 'imports'> = {},
): Promise<Harness> {
  const server = await startEphemeralPostgres();
  const adminUrl = await server.createDatabase(database);
  await withClient(adminUrl, async (c) => {
    await new Migrator(c).migrate([foundationMigrations, platformMigrations]);
    await c.query(`CREATE ROLE mnl_app LOGIN PASSWORD 'app' IN ROLE app_rw`).catch(() => undefined);
    await c
      .query(`CREATE ROLE mnl_relay LOGIN PASSWORD 'relay' IN ROLE outbox_relay`)
      .catch(() => undefined);
  });
  const idp = await createTestIdp();
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: process.env['TEST_LOG_LEVEL'] ?? 'silent',
    DATABASE_URL: server.urlFor(database, 'mnl_app', 'app'),
    OIDC_ISSUER: idp.issuer,
    OIDC_AUDIENCE: idp.audience,
  });
  const app = await createApiApp(config, {
    ...extra,
    tokenVerifier: new OidcTokenVerifier({
      issuer: idp.issuer,
      audience: idp.audience,
      keys: idp.keys,
    }),
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  return {
    server,
    relayUrl: server.urlFor(database, 'mnl_relay', 'relay'),
    adminUrl,
    idp,
    config,
    app,
    async call(method, url, o = {}) {
      const headers: Record<string, string> = { ...o.headers };
      const token =
        o.token ??
        (o.sub ? await idp.token(o.sub, o.claims ? { claims: o.claims } : {}) : undefined);
      if (token) headers['authorization'] = `Bearer ${token}`;
      if (o.tenant) headers['x-tenant'] = o.tenant;
      return app.inject({
        method,
        url,
        headers,
        ...(o.payload === undefined ? {} : { payload: o.payload as object }),
      });
    },
    async sql<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
      return withClient(adminUrl, async (c) => (await c.query(text, params)).rows as T[]);
    },
    async stop() {
      await app.close();
      await server.stop();
    },
  };
}

export const tenantInput = (slug: string, sub: string, code: string) => ({
  slug,
  name: `${slug} works`,
  edition: 'starter' as const,
  defaultLocale: 'en-IN',
  defaultTimezone: 'Asia/Kolkata',
  company: { code, legalName: `${slug} Pvt. Ltd.`, baseCurrency: 'INR', countryCode: 'IN' },
  plant: { code: 'P1', name: 'Main plant', regionCode: 'IN-KA', timezone: 'Asia/Kolkata' },
  firstFiscalYear: 2026,
  admin: { idpSubject: sub, email: `admin@${slug}.test`, displayName: `${slug} admin` },
});
