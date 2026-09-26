import { AccessContexts } from '@manuling/authz';
import { type RequestContext, RequestContexts } from '@manuling/kernel';
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Observable } from 'rxjs';

/**
 * Runs the handler (and its pipes) inside a RequestContext with the authenticated tenant,
 * user and visible companies, plus the caller's AccessSnapshot, so UnitOfWork applies RLS
 * for that tenant (ADR-0005) and AccessControl can check permissions (ADR-0009).
 */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const principal = context.switchToHttp().getRequest<FastifyRequest>().principal;
    if (!principal) return next.handle();

    const base = RequestContexts.require();
    const enriched: RequestContext = {
      ...base,
      tenantId: principal.tenantId,
      actor: { type: 'user', id: principal.userId },
      locale: principal.locale ?? base.locale,
      timezone: principal.timezone,
      companyIds: principal.companyIds,
    };
    return new Observable((subscriber) => {
      const subscription = RequestContexts.run(enriched, () =>
        AccessContexts.run(principal.access, () => next.handle().subscribe(subscriber)),
      );
      return () => subscription.unsubscribe();
    });
  }
}
