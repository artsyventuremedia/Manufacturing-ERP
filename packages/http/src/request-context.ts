import { type RequestContext, RequestContexts, newId } from '@manuling/kernel';
import type { FastifyInstance, FastifyRequest, RawRequestDefaultExpression } from 'fastify';

export const CORRELATION_HEADER = 'x-correlation-id';
/** Set by Manuling's own web/mobile clients so audit records show `ui` rather than `api`. */
export const CLIENT_HEADER = 'x-manuling-client';

export interface RequestContextOptions {
  readonly supportedLocales: readonly string[];
  readonly defaultLocale: string;
  readonly defaultTimezone: string;
}

const CORRELATION_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Fastify `genReqId`: reuse a well-formed inbound correlation id (from the gateway or a
 * calling service) or mint a UUIDv7. Fastify's request id then doubles as correlation id,
 * so every log line and problem response carries it.
 */
export function correlationIdFor(raw: RawRequestDefaultExpression): string {
  const header = raw.headers[CORRELATION_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  return value !== undefined && CORRELATION_PATTERN.test(value) ? value : newId();
}

/** Picks the best supported locale from Accept-Language, matching on language when needed. */
export function negotiateLocale(
  acceptLanguage: string | undefined,
  options: RequestContextOptions,
): string {
  if (!acceptLanguage) return options.defaultLocale;
  const ranked = acceptLanguage
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const weight = q ? Number(q.slice(2)) : 1;
      return { tag: tag.toLowerCase(), weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((l) => l.tag !== '' && l.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);

  const supported = options.supportedLocales.map((l) => ({ locale: l, lower: l.toLowerCase() }));
  for (const { tag } of ranked) {
    const exact = supported.find((s) => s.lower === tag);
    if (exact) return exact.locale;
    const language = tag.split('-')[0];
    const byLanguage = supported.find((s) => s.lower.split('-')[0] === language);
    if (byLanguage) return byLanguage.locale;
  }
  return options.defaultLocale;
}

export function baseContextFor(
  request: FastifyRequest,
  options: RequestContextOptions,
): RequestContext {
  return {
    correlationId: request.id,
    source:
      request.headers[CLIENT_HEADER] === 'web' || request.headers[CLIENT_HEADER] === 'mobile'
        ? 'ui'
        : 'api',
    locale: negotiateLocale(request.headers['accept-language'], options),
    // Tenant/user time zone replaces this once identity is resolved (step 0.4).
    timezone: options.defaultTimezone,
    companyIds: [],
    clientIp: request.ip,
  };
}

/**
 * Runs the rest of each request (hooks, guards, handler) inside a {@link RequestContexts}
 * scope and echoes the correlation id. Tenant and actor are added by the authentication
 * layer (step 0.4), which re-scopes the context once the token is verified.
 */
export function registerRequestContext(app: FastifyInstance, options: RequestContextOptions): void {
  app.addHook('onRequest', (request, reply, done) => {
    void reply.header(CORRELATION_HEADER, request.id);
    RequestContexts.run(baseContextFor(request, options), done);
  });
}
