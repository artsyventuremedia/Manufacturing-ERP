import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'manuling:isPublic';

/**
 * Marks a route as reachable without authentication (health probes, OpenAPI document).
 * Every other route is authenticated by the global guard.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
