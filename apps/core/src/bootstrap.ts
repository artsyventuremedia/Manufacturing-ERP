import 'reflect-metadata';
import { type IncomingMessage } from 'node:http';
import { correlationIdFor, registerRequestContext } from '@manuling/http';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { AppModule, type AppModuleExtras } from './app.module.js';
import { type AppConfig } from './config/config.js';

/**
 * Builds the core-api application (shared by main.api.ts and the integration tests).
 * Fastify's request id is the correlation id; it is also stored on the raw request so
 * pino-http logs the same id.
 */
export async function createApiApp(
  config: AppConfig,
  extra: AppModuleExtras = {},
): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    trustProxy: true,
    bodyLimit: config.http.bodyLimitBytes,
    requestIdHeader: false,
    genReqId: (raw: IncomingMessage) => {
      const id = correlationIdFor(raw);
      (raw as IncomingMessage & { id?: string }).id = id;
      return id;
    },
  });
  registerRequestContext(adapter.getInstance(), config.i18n);

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(config, extra),
    adapter,
    {
      bufferLogs: true,
      // Throw startup errors to the caller instead of aborting the process.
      abortOnError: false,
    },
  );
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  return app;
}
