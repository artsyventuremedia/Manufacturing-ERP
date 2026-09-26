import { RequestContexts } from '@manuling/kernel';
import type { Params } from 'nestjs-pino';
import { type AppConfig } from './config/config.js';

/** Structured JSON logs (pino) with correlation and tenant ids on every line; secrets redacted. */
export function loggerOptions(config: AppConfig): Params {
  return {
    pinoHttp: {
      level: config.log.level,
      ...(config.log.pretty
        ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
        : {}),
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-api-key"]',
          'res.headers["set-cookie"]',
        ],
        censor: '[redacted]',
      },
      customProps: () => {
        const ctx = RequestContexts.current();
        return ctx?.tenantId ? { tenantId: ctx.tenantId } : {};
      },
      // Fastify's middleware layer rewrites req.url relative to the mount path; match the original.
      autoLogging: {
        ignore: (req) => {
          const url = (req as { originalUrl?: string }).originalUrl ?? req.url ?? '';
          return url.startsWith('/health/');
        },
      },
      quietReqLogger: true,
    },
  };
}
