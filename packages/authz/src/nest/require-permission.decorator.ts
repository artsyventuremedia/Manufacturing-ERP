import { SetMetadata } from '@nestjs/common';

export const REQUIRED_PERMISSION_KEY = 'manuling:requiredPermission';

/**
 * Declares the permission a route needs. The guard checks the caller holds it in at least
 * one scope; use cases then check the specific company/plant/attributes via AccessControl.
 * Every non-public route must carry this decorator or the application refuses to boot.
 */
export const RequirePermission = (code: string): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_PERMISSION_KEY, code);

export const ANY_MEMBER_KEY = 'manuling:anyMember';

/**
 * Route open to any authenticated member of the workspace, with no specific permission
 * (e.g. the caller's own profile). Use sparingly; data endpoints need @RequirePermission.
 */
export const AnyMember = (): MethodDecorator & ClassDecorator => SetMetadata(ANY_MEMBER_KEY, true);
