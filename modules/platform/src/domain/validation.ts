import { ValidationError } from '@manuling/kernel';

const CODE = /^[A-Z0-9][A-Z0-9_-]{0,19}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const COUNTRY = /^[A-Z]{2}$/;
const REGION = /^[A-Z]{2}-[A-Z0-9]{1,3}$/;
const LOCALE = /^[a-z]{2,3}(-[A-Z]{2})?$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Short business code (company, plant): uppercase letters, digits, `_` and `-`. */
export function parseCode(value: string, field: string): string {
  const v = value.trim().toUpperCase();
  if (!CODE.test(v)) {
    throw invalid(field, 'platform.code_invalid', 'Use 1–20 letters, digits, "_" or "-"');
  }
  return v;
}

export function parseSlug(value: string): string {
  const v = value.trim().toLowerCase();
  if (!SLUG.test(v) || v.includes('--')) {
    throw invalid(
      'slug',
      'platform.slug_invalid',
      'Use 3–40 lowercase letters, digits or single hyphens',
    );
  }
  return v;
}

export function parseName(value: string, field: string, max = 200): string {
  const v = value.trim().replace(/\s+/g, ' ');
  if (v.length === 0 || v.length > max) {
    throw invalid(field, 'platform.name_invalid', `Must be 1–${max} characters`);
  }
  return v;
}

export function parseCountry(value: string): string {
  const v = value.trim().toUpperCase();
  if (!COUNTRY.test(v))
    throw invalid('countryCode', 'platform.country_invalid', 'Use an ISO 3166-1 alpha-2 code');
  return v;
}

/** ISO 3166-2 subdivision, e.g. IN-KA (Karnataka). Its country prefix must match. */
export function parseRegion(value: string, countryCode: string): string {
  const v = value.trim().toUpperCase();
  if (!REGION.test(v) || !v.startsWith(`${countryCode}-`)) {
    throw invalid(
      'regionCode',
      'platform.region_invalid',
      `Use an ISO 3166-2 code for ${countryCode}, e.g. ${countryCode}-KA`,
    );
  }
  return v;
}

export function parseTimezone(value: string, field = 'timezone'): string {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
  } catch {
    throw invalid(field, 'platform.timezone_invalid', 'Use an IANA time zone such as Asia/Kolkata');
  }
  return value;
}

export function parseLocale(value: string, supported: readonly string[], field = 'locale'): string {
  if (!LOCALE.test(value) || !supported.includes(value)) {
    throw invalid(
      field,
      'platform.locale_unsupported',
      `Supported locales: ${supported.join(', ')}`,
    );
  }
  return value;
}

export function parseEmail(value: string): string {
  const v = value.trim().toLowerCase();
  if (!EMAIL.test(v) || v.length > 254)
    throw invalid('email', 'platform.email_invalid', 'Invalid email address');
  return v;
}

export function parseMonth(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 12) {
    throw invalid(field, 'platform.month_invalid', 'Must be a month number 1–12');
  }
  return value;
}

function invalid(path: string, code: string, message: string): ValidationError {
  return new ValidationError(code, message, { field: path }, [{ path, code, message }]);
}
