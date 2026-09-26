import { DomainError } from '@manuling/kernel';
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { type Observable, catchError, from, mergeMap, throwError } from 'rxjs';
import { AuditService } from '../application/audit.service.js';

/**
 * Audits authorisation refusals raised inside use cases (permission, escalation, field-level)
 * for authenticated callers. Runs inside the request context, after the handler's
 * transaction rolled back, so the denial is written in its own transaction.
 */
@Injectable()
export class AccessDenialInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (!request.principal) return next.handle();
    return next.handle().pipe(
      catchError((err: unknown) => {
        if (
          !(err instanceof DomainError) ||
          err.category !== 'forbidden' ||
          !err.code.startsWith('authz.')
        ) {
          return throwError(() => err);
        }
        const route = `${request.method} ${request.routeOptions.url ?? request.url}`;
        return from(this.audit.recordDenial(err.code, err.params, route)).pipe(
          mergeMap(() => throwError(() => err)),
        );
      }),
    );
  }
}
