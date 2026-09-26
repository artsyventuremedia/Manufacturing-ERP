import {
  ConflictError,
  ForbiddenError,
  InvariantViolation,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from '@manuling/kernel';
import { describe, expect, it } from 'vitest';
import { findPgError, isRetryableTransactionError, mapDatabaseError } from './errors.js';

const pgError = (code: string, message = 'x') =>
  Object.assign(new Error(message), { code, table: 't', schema: 's' });
/** Mimics DrizzleQueryError, which carries the driver error as `cause`. */
const wrapped = (cause: unknown) => Object.assign(new Error('Failed query: ...'), { cause });

describe('mapDatabaseError', () => {
  it.each([
    ['23505', ConflictError, 'db.unique_violation'],
    ['23503', ValidationError, 'db.reference_invalid'],
    ['23502', ValidationError, 'db.constraint_violation'],
    ['23514', ValidationError, 'db.constraint_violation'],
    ['23P01', ConflictError, 'db.overlap_violation'],
    ['40001', ConflictError, 'db.transaction_conflict'],
    ['40P01', ConflictError, 'db.transaction_conflict'],
    ['57014', ServiceUnavailableError, 'db.statement_timeout'],
    ['25006', InvariantViolation, 'db.read_only_transaction'],
    ['MN001', InvariantViolation, 'db.append_only'],
  ])('maps SQLSTATE %s (also when wrapped)', (code, type, mapped) => {
    for (const err of [pgError(code), wrapped(pgError(code))]) {
      const result = mapDatabaseError(err);
      expect(result).toBeInstanceOf(type);
      expect(result).toMatchObject({ code: mapped, params: { table: 't', schema: 's' } });
    }
  });

  it('distinguishes RLS violations from missing privileges', () => {
    expect(
      mapDatabaseError(pgError('42501', 'new row violates row-level security policy')),
    ).toMatchObject({
      code: 'db.tenant_isolation_violation',
    });
    expect(mapDatabaseError(pgError('42501', 'permission denied for table x'))).toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('passes through domain errors, unknown SQLSTATEs and non-database errors', () => {
    const domain = new NotFoundError('Item', '1');
    expect(mapDatabaseError(domain)).toBe(domain);
    const unknown = pgError('22012');
    expect(mapDatabaseError(unknown)).toBe(unknown);
    const plain = new Error('plain');
    expect(mapDatabaseError(plain)).toBe(plain);
  });

  it('finds pg errors through cause chains and flags retryable ones', () => {
    expect(findPgError(wrapped(wrapped(pgError('40001'))))?.code).toBe('40001');
    expect(findPgError({ code: 'TOO_LONG_CODE', message: 'x' })).toBeUndefined();
    expect(isRetryableTransactionError(wrapped(pgError('40P01')))).toBe(true);
    expect(isRetryableTransactionError(pgError('23505'))).toBe(false);
    expect(isRetryableTransactionError(null)).toBe(false);
  });
});
