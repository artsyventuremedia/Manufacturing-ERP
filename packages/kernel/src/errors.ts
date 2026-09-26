/**
 * Framework-free error hierarchy. `code` is stable and machine-readable; it doubles as the
 * i18n key suffix (`errors.<code>`) for user-facing messages. The HTTP layer maps `category`
 * to status codes and RFC 9457 problem details.
 */
export type ErrorCategory =
  | 'validation'
  | 'not_found'
  | 'conflict'
  | 'forbidden'
  | 'unauthenticated'
  | 'business_rule'
  | 'invariant'
  | 'unavailable';

export type ErrorParams = Readonly<Record<string, unknown>>;

export class DomainError extends Error {
  constructor(
    readonly category: ErrorCategory,
    readonly code: string,
    message: string,
    readonly params: ErrorParams = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export interface FieldError {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export class ValidationError extends DomainError {
  constructor(
    code: string,
    message: string,
    params: ErrorParams = {},
    readonly fieldErrors: readonly FieldError[] = [],
  ) {
    super('validation', code, message, params);
  }
}

export class NotFoundError extends DomainError {
  constructor(entity: string, id: string) {
    super('not_found', 'kernel.not_found', `${entity} ${id} not found`, { entity, id });
  }
}

export class ConflictError extends DomainError {
  constructor(code: string, message: string, params: ErrorParams = {}) {
    super('conflict', code, message, params);
  }
}

/** Optimistic concurrency failure (PRD §10). */
export class ConcurrencyConflictError extends ConflictError {
  constructor(entity: string, id: string, expectedVersion: number, actualVersion?: number) {
    super(
      'kernel.concurrency_conflict',
      `${entity} ${id} was modified by someone else (expected version ${expectedVersion})`,
      { entity, id, expectedVersion, actualVersion },
    );
  }
}

export class ForbiddenError extends DomainError {
  constructor(code = 'kernel.forbidden', message = 'Not permitted', params: ErrorParams = {}) {
    super('forbidden', code, message, params);
  }
}

export class UnauthenticatedError extends DomainError {
  constructor(
    message = 'Authentication required',
    code = 'kernel.unauthenticated',
    options?: { cause?: unknown },
  ) {
    super('unauthenticated', code, message, {}, options);
  }
}

/** A business rule rejected the command (e.g. "period is closed", "credit limit exceeded"). */
export class BusinessRuleViolation extends DomainError {
  constructor(code: string, message: string, params: ErrorParams = {}) {
    super('business_rule', code, message, params);
  }
}

/** A programming error or broken invariant; never caused by user input. */
export class InvariantViolation extends DomainError {
  constructor(code: string, message: string, params: ErrorParams = {}) {
    super('invariant', code, message, params);
  }
}

export class ServiceUnavailableError extends DomainError {
  constructor(
    code: string,
    message: string,
    params: ErrorParams = {},
    options?: { cause?: unknown },
  ) {
    super('unavailable', code, message, params, options);
  }
}
