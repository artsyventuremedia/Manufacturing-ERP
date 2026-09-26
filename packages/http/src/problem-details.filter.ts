import { DomainError, RequestContexts } from '@manuling/kernel';
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  PROBLEM_CONTENT_TYPE,
  type ProblemDetails,
  domainErrorToProblem,
  genericProblem,
} from './problem-details.js';

/**
 * Global exception filter: every error leaves the API as RFC 9457 problem+json.
 * 5xx errors are logged with stack and correlation id; their details never reach clients.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ProblemDetails');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    const problem = this.toProblem(exception, request);
    if (problem.status >= 500) {
      this.logger.error(
        {
          err: exception,
          correlationId: problem.correlationId,
          tenantId: RequestContexts.current()?.tenantId,
        },
        'Request failed',
      );
    }
    if (problem.status === 401) {
      // RFC 6750 §3: tell clients how to authenticate.
      void reply.header(
        'www-authenticate',
        problem.code === 'auth.invalid_token' ? 'Bearer error="invalid_token"' : 'Bearer',
      );
    }
    void reply.status(problem.status).header('content-type', PROBLEM_CONTENT_TYPE).send(problem);
  }

  private toProblem(exception: unknown, request: FastifyRequest): ProblemDetails {
    const meta = { instance: request.url.split('?')[0] ?? request.url, correlationId: request.id };
    if (exception instanceof DomainError) return domainErrorToProblem(exception, meta);
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = HTTP_STATUS_CODES[status] ?? `http.status_${status}`;
      return genericProblem(status, code, {
        ...meta,
        ...(status < 500 ? { detail: exception.message } : {}),
      });
    }
    const fastifyStatus = fastifyClientErrorStatus(exception);
    if (fastifyStatus !== undefined) {
      return genericProblem(
        fastifyStatus,
        HTTP_STATUS_CODES[fastifyStatus] ?? `http.status_${fastifyStatus}`,
        {
          ...meta,
          detail: (exception as Error).message,
        },
      );
    }
    return genericProblem(500, 'internal_error', meta);
  }
}

/** Stable codes for transport-level errors raised by Nest or Fastify before our handlers run. */
const HTTP_STATUS_CODES: Readonly<Record<number, string>> = {
  400: 'http.malformed_request',
  404: 'http.route_not_found',
  405: 'http.method_not_allowed',
  413: 'http.payload_too_large',
  415: 'http.unsupported_media_type',
};

/** Fastify's own 4xx errors (bad JSON, unsupported media type, body too large). */
export function fastifyClientErrorStatus(exception: unknown): number | undefined {
  if (typeof exception !== 'object' || exception === null) return undefined;
  const { statusCode, code } = exception as { statusCode?: unknown; code?: unknown };
  return typeof code === 'string' &&
    code.startsWith('FST_') &&
    typeof statusCode === 'number' &&
    statusCode >= 400 &&
    statusCode < 500
    ? statusCode
    : undefined;
}
