import {
  ConflictError,
  DomainError,
  ForbiddenError,
  InvariantViolation,
  ServiceUnavailableError,
  ValidationError,
} from '@manuling/kernel';

/** SQLSTATE values we react to. */
export const PgCode = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  notNullViolation: '23502',
  checkViolation: '23514',
  exclusionViolation: '23P01',
  serializationFailure: '40001',
  deadlockDetected: '40P01',
  insufficientPrivilege: '42501',
  queryCanceled: '57014',
  readOnlyTransaction: '25006',
  appendOnlyViolation: 'MN001',
} as const;

interface PgErrorLike {
  code: string;
  message: string;
  constraint?: string;
  table?: string;
  schema?: string;
}

export function isPgError(err: unknown): err is PgErrorLike {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { code?: unknown }).code === 'string' &&
    typeof (err as { message?: unknown }).message === 'string' &&
    (err as { code: string }).code.length === 5
  );
}

/**
 * Finds the underlying PostgreSQL error. Drizzle wraps driver errors in DrizzleQueryError
 * (with the pg error as `cause`), so walk the cause chain a few levels.
 */
export function findPgError(err: unknown): PgErrorLike | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth++) {
    if (isPgError(current)) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Serialization failures and deadlocks are safe to retry from the start of the transaction. */
export function isRetryableTransactionError(err: unknown): boolean {
  const code = findPgError(err)?.code;
  return code === PgCode.serializationFailure || code === PgCode.deadlockDetected;
}

/**
 * Translates driver errors into kernel errors so no raw SQL error text reaches API clients.
 * Unknown errors are returned unchanged and reported as 500 by the HTTP layer.
 */
export function mapDatabaseError(error: unknown): unknown {
  if (error instanceof DomainError) return error;
  const err = findPgError(error);
  if (!err) return error;
  const where = { schema: err.schema, table: err.table, constraint: err.constraint };

  switch (err.code) {
    case PgCode.uniqueViolation:
      return new ConflictError(
        'db.unique_violation',
        'A record with the same key already exists',
        where,
      );
    case PgCode.foreignKeyViolation:
      return new ValidationError(
        'db.reference_invalid',
        'A referenced record does not exist',
        where,
      );
    case PgCode.notNullViolation:
    case PgCode.checkViolation:
      return new ValidationError(
        'db.constraint_violation',
        'The data violates a database constraint',
        where,
      );
    case PgCode.exclusionViolation:
      return new ConflictError(
        'db.overlap_violation',
        'The record overlaps an existing one',
        where,
      );
    case PgCode.serializationFailure:
    case PgCode.deadlockDetected:
      return new ConflictError(
        'db.transaction_conflict',
        'Concurrent update detected; please retry',
        where,
      );
    case PgCode.insufficientPrivilege:
      return err.message.includes('row-level security')
        ? new ForbiddenError('db.tenant_isolation_violation', 'Cross-tenant write rejected', where)
        : new ForbiddenError('db.privilege_denied', 'Operation not permitted on this table', where);
    case PgCode.queryCanceled:
      return new ServiceUnavailableError(
        'db.statement_timeout',
        'The database operation timed out',
        where,
        {
          cause: err,
        },
      );
    case PgCode.readOnlyTransaction:
      return new InvariantViolation(
        'db.read_only_transaction',
        'Write attempted in a read-only transaction',
        where,
      );
    case PgCode.appendOnlyViolation:
      return new InvariantViolation(
        'db.append_only',
        'Ledger records are append-only; post a reversal',
        where,
      );
    default:
      return error;
  }
}
