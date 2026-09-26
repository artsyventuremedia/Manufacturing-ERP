import {
  type CallHandler,
  type ExecutionContext,
  HttpStatus,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type Observable, catchError, from, mergeMap, of, switchMap } from 'rxjs';
import { IdempotencyService } from '../application/idempotency.service.js';

const HEADER = 'idempotency-key';
/** Response headers worth replaying (clients use them to follow up on the created resource). */
const REPLAYED_HEADERS = ['etag', 'location'];

/** Applies Idempotency-Key semantics to authenticated POST requests that send the header. */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly service: IdempotencyService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const raw = request.headers[HEADER];
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (request.method !== 'POST' || header === undefined || !request.principal)
      return next.handle();

    const reply = http.getResponse<FastifyReply>();
    const key = IdempotencyService.validateKey(header);
    const path = request.url.split('?')[0] ?? request.url;
    const hash = IdempotencyService.fingerprint(request.method, path, request.body);
    const status =
      this.reflector.get<number | undefined>(HTTP_CODE_METADATA, context.getHandler()) ??
      HttpStatus.CREATED;

    return from(this.service.start(key, request.method, path, hash)).pipe(
      switchMap((start) => {
        if (start.kind === 'replay') {
          void reply.header('idempotent-replayed', 'true');
          for (const [name, value] of Object.entries(start.headers)) void reply.header(name, value);
          return of(start.body);
        }
        return next.handle().pipe(
          mergeMap(async (body: unknown) => {
            const headers: Record<string, string> = {};
            for (const name of REPLAYED_HEADERS) {
              const value = reply.getHeader(name);
              if (typeof value === 'string') headers[name] = value;
            }
            await this.service.complete(key, { status, headers, body });
            return body;
          }),
          catchError(async (err: unknown) => {
            await this.service.release(key);
            throw err;
          }),
        );
      }),
    );
  }
}
