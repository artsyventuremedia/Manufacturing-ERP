import { ANY_MEMBER_KEY, REQUIRED_PERMISSION_KEY, permissionRegistry } from '@manuling/authz';
import { IS_PUBLIC_KEY } from '@manuling/http';
import { InvariantViolation } from '@manuling/kernel';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants.js';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';

export interface RouteAccessViolation {
  readonly route: string;
  readonly problem: 'no_access_rule' | 'unknown_permission';
  readonly permission?: string;
}

/**
 * Refuses to start the application if any HTTP route lacks an access rule (@Public,
 * @AnyMember or @RequirePermission) or names a permission that is not registered.
 * This makes "permission checks on every endpoint" (PRD §16.4) a hard guarantee.
 */
@Injectable()
export class RouteAccessCheck implements OnApplicationBootstrap {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onApplicationBootstrap(): void {
    const violations = this.findViolations();
    if (violations.length > 0) {
      const list = violations
        .map((v) => `${v.route} (${v.problem}${v.permission ? `: ${v.permission}` : ''})`)
        .join(', ');
      throw new InvariantViolation(
        'authz.routes_unprotected',
        `Routes without a valid access rule: ${list}`,
        { violations },
      );
    }
  }

  findViolations(): RouteAccessViolation[] {
    const violations: RouteAccessViolation[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const instance: unknown = wrapper.instance;
      const metatype: unknown = wrapper.metatype;
      if (!instance || typeof metatype !== 'function') continue;
      const prototype = Object.getPrototypeOf(instance) as object;
      for (const name of this.scanner.getAllMethodNames(prototype)) {
        const handler = (prototype as Record<string, unknown>)[name];
        if (
          typeof handler !== 'function' ||
          Reflect.getMetadata(METHOD_METADATA, handler) === undefined
        )
          continue;
        const targets = [handler, metatype];
        const route = `${metatype.name}.${name}`;
        if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) continue;
        if (this.reflector.getAllAndOverride<boolean>(ANY_MEMBER_KEY, targets)) continue;
        const permission = this.reflector.getAllAndOverride<string | undefined>(
          REQUIRED_PERMISSION_KEY,
          targets,
        );
        if (!permission) violations.push({ route, problem: 'no_access_rule' });
        else if (!permissionRegistry.has(permission))
          violations.push({ route, problem: 'unknown_permission', permission });
      }
    }
    return violations;
  }
}
