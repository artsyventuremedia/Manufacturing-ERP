import {
  type DomainError,
  type ErrorCategory,
  type FieldError,
  ValidationError,
} from '@manuling/kernel';

/** RFC 9457 problem details, extended with Manuling fields used by clients and i18n. */
export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly instance?: string;
  /** Stable machine code; UI translates `errors.<code>` with `params`. */
  readonly code: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly errors?: readonly FieldError[];
  readonly correlationId?: string;
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

const CATEGORY_STATUS: Record<ErrorCategory, number> = {
  validation: 422,
  business_rule: 422,
  not_found: 404,
  conflict: 409,
  forbidden: 403,
  unauthenticated: 401,
  invariant: 500,
  unavailable: 503,
};

/** Codes whose HTTP status is more specific than their category. */
const CODE_STATUS: Readonly<Record<string, number>> = {
  'kernel.concurrency_conflict': 412,
  'http.if_match_required': 428,
  'http.malformed_json': 400,
  'http.tenant_required': 400,
  'http.tenant_ambiguous': 400,
  'http.idempotency_in_progress': 409,
};

const TITLES: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  412: 'Precondition Failed',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

export function titleFor(status: number): string {
  return TITLES[status] ?? (status >= 500 ? 'Server Error' : 'Client Error');
}

export function problemType(code: string): string {
  return `urn:manuling:problem:${code}`;
}

export function statusForDomainError(error: DomainError): number {
  return CODE_STATUS[error.code] ?? CATEGORY_STATUS[error.category];
}

/**
 * Converts a DomainError into problem details. Internal errors (5xx from invariants) never
 * leak their message or params to clients; the correlation id links them to logs.
 */
export function domainErrorToProblem(
  error: DomainError,
  meta: { instance?: string; correlationId?: string } = {},
): ProblemDetails {
  const status = statusForDomainError(error);
  const internal = status >= 500 && error.category === 'invariant';
  return {
    type: problemType(internal ? 'internal_error' : error.code),
    title: titleFor(status),
    status,
    code: internal ? 'internal_error' : error.code,
    ...(internal ? {} : { detail: error.message }),
    ...(!internal && Object.keys(error.params).length > 0 ? { params: error.params } : {}),
    ...(error instanceof ValidationError && error.fieldErrors.length > 0
      ? { errors: error.fieldErrors }
      : {}),
    ...(meta.instance !== undefined ? { instance: meta.instance } : {}),
    ...(meta.correlationId !== undefined ? { correlationId: meta.correlationId } : {}),
  };
}

export function genericProblem(
  status: number,
  code: string,
  meta: { detail?: string; instance?: string; correlationId?: string } = {},
): ProblemDetails {
  return {
    type: problemType(code),
    title: titleFor(status),
    status,
    code,
    ...(meta.detail !== undefined ? { detail: meta.detail } : {}),
    ...(meta.instance !== undefined ? { instance: meta.instance } : {}),
    ...(meta.correlationId !== undefined ? { correlationId: meta.correlationId } : {}),
  };
}
