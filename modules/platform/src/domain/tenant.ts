import { ValidationError, newId } from '@manuling/kernel';
import { parseLocale, parseName, parseSlug, parseTimezone } from './validation.js';

export type Edition = 'starter' | 'growth' | 'enterprise';
export type TenantStatus = 'active' | 'suspended';

export interface Tenant {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly edition: Edition;
  readonly status: TenantStatus;
  readonly defaultLocale: string;
  readonly defaultTimezone: string;
}

/** Slugs that would collide with platform hostnames (api.…, www.…) or cause confusion. */
const RESERVED_SLUGS = new Set([
  'api',
  'app',
  'www',
  'admin',
  'auth',
  'login',
  'status',
  'docs',
  'mail',
  'static',
]);

export function createTenant(
  input: {
    slug: string;
    name: string;
    edition: Edition;
    defaultLocale: string;
    defaultTimezone: string;
  },
  supportedLocales: readonly string[],
): Tenant {
  const slug = parseSlug(input.slug);
  if (RESERVED_SLUGS.has(slug)) {
    const message = `"${slug}" is reserved`;
    throw new ValidationError('platform.slug_reserved', message, { slug }, [
      { path: 'slug', code: 'platform.slug_reserved', message },
    ]);
  }
  return {
    id: newId(),
    slug,
    name: parseName(input.name, 'name'),
    edition: input.edition,
    status: 'active',
    defaultLocale: parseLocale(input.defaultLocale, supportedLocales, 'defaultLocale'),
    defaultTimezone: parseTimezone(input.defaultTimezone, 'defaultTimezone'),
  };
}
