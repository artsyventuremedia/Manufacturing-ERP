import { ANY_MEMBER_KEY, REQUIRED_PERMISSION_KEY, holdsAnywhere } from '@manuling/authz';
import { IS_PUBLIC_KEY } from '@manuling/http';
import {
  ForbiddenError,
  InvariantViolation,
  RequestContexts,
  UnauthenticatedError,
} from '@manuling/kernel';
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AuditService } from '../application/audit.service.js';
import { Authenticator } from '../application/authenticator.js';
import { type Principal } from '../application/principal.js';
import { TOKEN_VERIFIER, type TokenVerifier } from '../application/token-verifier.js';
import { PLATFORM_OPTIONS, type PlatformOptions } from '../platform.options.js';
import { resolveTenantSlug } from './tenant-resolver.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

/**
 * Global guard. Every route is @Public(), @AnyMember() or @RequirePermission(...):
 * the caller must present a valid bearer token, belong to the target workspace and, for
 * permission routes, hold the permission in at least one scope. Use cases then check the
 * exact company/plant/attributes with AccessControl.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authenticator: Authenticator,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    @Inject(PLATFORM_OPTIONS) private readonly options: PlatformOptions,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const permission = this.reflector.getAllAndOverride<string | undefined>(
      REQUIRED_PERMISSION_KEY,
      targets,
    );
    const anyMember = this.reflector.getAllAndOverride<boolean>(ANY_MEMBER_KEY, targets);
    if (!permission && !anyMember) {
      // Unreachable when the boot-time check runs; kept as a fail-closed backstop.
      throw new InvariantViolation('authz.route_unprotected', 'Route declares no access rule');
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = bearerToken(request.headers.authorization);
    const slug = resolveTenantSlug(request.headers, this.options.tenantBaseDomain);
    const verified = await this.verifier.verify(token);
    const principal = await this.authenticator.authenticate(slug, verified);

    if (permission && !holdsAnywhere(principal.access, permission)) {
      const route = `${request.method} ${request.routeOptions.url ?? request.url}`;
      await RequestContexts.run(
        {
          ...RequestContexts.require(),
          tenantId: principal.tenantId,
          actor: { type: 'user', id: principal.userId },
        },
        () => this.audit.recordDenial('authz.permission_denied', { permission }, route),
      );
      throw new ForbiddenError('authz.permission_denied', 'You do not have permission to do this', {
        permission,
      });
    }
    request.principal = principal;
    return true;
  }
}

function bearerToken(header: string | undefined): string {
  const match = header ? /^Bearer\s+([A-Za-z0-9._~+/-]+=*)$/i.exec(header.trim()) : null;
  if (!match)
    throw new UnauthenticatedError('A bearer access token is required', 'auth.token_missing');
  return match[1]!;
}
