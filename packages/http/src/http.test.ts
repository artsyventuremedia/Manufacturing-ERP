import {
  ConcurrencyConflictError,
  InvariantViolation,
  NotFoundError,
  ValidationError,
} from '@manuling/kernel';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { formatEtag, parseIfMatch } from './etag.js';
import { decodeCursor, encodeCursor, pageQuerySchema, toPage } from './pagination.js';
import { fastifyClientErrorStatus } from './problem-details.filter.js';
import { domainErrorToProblem, genericProblem } from './problem-details.js';
import { negotiateLocale } from './request-context.js';
import { ZodPipe, parseWith } from './zod.js';

describe('ETag / If-Match', () => {
  it('round-trips versions', () => {
    expect(formatEtag(7)).toBe('"v7"');
    expect(parseIfMatch('"v7"')).toBe(7);
    expect(parseIfMatch(['W/"v12"'])).toBe(12);
  });

  it('requires a well-formed header', () => {
    expect(() => parseIfMatch(undefined)).toThrow(
      expect.objectContaining({ code: 'http.if_match_required' }),
    );
    expect(() => parseIfMatch('*')).toThrow(
      expect.objectContaining({ code: 'http.if_match_invalid' }),
    );
  });
});

describe('pagination', () => {
  it('encodes opaque keyset cursors and validates them', () => {
    const cursor = encodeCursor(['2026-04-01', 'abc']);
    expect(decodeCursor(cursor, 2)).toEqual(['2026-04-01', 'abc']);
    expect(() => decodeCursor(cursor, 3)).toThrow(ValidationError);
    expect(() => decodeCursor('%%%', 1)).toThrow(ValidationError);
    expect(() => decodeCursor(encodeCursor([]).replace('W10', 'e30'), 0)).toThrow(ValidationError);
  });

  it('builds pages from limit + 1 rows', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const page = toPage(rows, 2, (r) => [r.id]);
    expect(page.items).toHaveLength(2);
    expect(decodeCursor(page.nextCursor!, 1)).toEqual(['b']);
    expect(toPage(rows, 3, (r) => [r.id]).nextCursor).toBeUndefined();
  });

  it('bounds page size', () => {
    expect(pageQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(pageQuerySchema.parse({ limit: '10' }).limit).toBe(10);
    expect(pageQuerySchema.safeParse({ limit: '500' }).success).toBe(false);
  });
});

describe('problem details', () => {
  it('maps categories and special codes to statuses', () => {
    expect(domainErrorToProblem(new NotFoundError('Item', 'x')).status).toBe(404);
    expect(domainErrorToProblem(new ConcurrencyConflictError('Item', 'x', 1, 2)).status).toBe(412);
    const invalid = domainErrorToProblem(
      new ValidationError('x.bad', 'bad', {}, [{ path: 'qty', code: 'c', message: 'm' }]),
      { instance: '/v1/items', correlationId: 'corr-1234' },
    );
    expect(invalid).toMatchObject({
      status: 422,
      code: 'x.bad',
      type: 'urn:manuling:problem:x.bad',
      errors: [{ path: 'qty' }],
      instance: '/v1/items',
      correlationId: 'corr-1234',
    });
  });

  it('hides internal error details', () => {
    const p = domainErrorToProblem(
      new InvariantViolation('secret.code', 'secret message', { sql: 'x' }),
    );
    expect(p).toEqual({
      type: 'urn:manuling:problem:internal_error',
      title: 'Internal Server Error',
      status: 500,
      code: 'internal_error',
    });
    expect(genericProblem(503, 'x').title).toBe('Service Unavailable');
  });

  it('recognises Fastify client errors only', () => {
    expect(
      fastifyClientErrorStatus({ code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE', statusCode: 415 }),
    ).toBe(415);
    expect(fastifyClientErrorStatus({ code: 'FST_X', statusCode: 500 })).toBeUndefined();
    expect(fastifyClientErrorStatus(new Error('x'))).toBeUndefined();
    expect(fastifyClientErrorStatus(null)).toBeUndefined();
  });
});

describe('locale negotiation', () => {
  const options = {
    supportedLocales: ['en-IN', 'kn-IN', 'hi-IN'],
    defaultLocale: 'en-IN',
    defaultTimezone: 'Asia/Kolkata',
  };

  it('matches exact tags, then languages, honouring q-values', () => {
    expect(negotiateLocale('kn-IN,en;q=0.8', options)).toBe('kn-IN');
    expect(negotiateLocale('hi', options)).toBe('hi-IN');
    expect(negotiateLocale('fr-FR;q=0.9, kn;q=0.5', options)).toBe('kn-IN');
    expect(negotiateLocale('de, fr', options)).toBe('en-IN');
    expect(negotiateLocale(undefined, options)).toBe('en-IN');
    expect(negotiateLocale('kn;q=0', options)).toBe('en-IN');
  });
});

describe('zod validation', () => {
  const schema = z.object({
    qty: z.string().regex(/^\d+(\.\d+)?$/),
    items: z.array(z.string()).min(1),
  });

  it('returns parsed data or field errors', () => {
    expect(parseWith(schema, { qty: '1.5', items: ['a'] })).toEqual({ qty: '1.5', items: ['a'] });
    try {
      new ZodPipe(schema).transform({ qty: 'x', items: [] });
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).fieldErrors.map((e) => e.path).sort()).toEqual([
        'items',
        'qty',
      ]);
    }
    expect(() => parseWith(z.string(), 1)).toThrow(
      expect.objectContaining({ fieldErrors: [expect.objectContaining({ path: '$' })] }),
    );
  });
});
