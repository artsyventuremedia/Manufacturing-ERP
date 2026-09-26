import { parseArgs } from 'node:util';
import { DomainError } from '@manuling/kernel';
import { currentFiscalYearStart, provisionTenant } from './provisioning.js';

/**
 * Operator CLI: create a workspace with its first company, plant, fiscal year and admin.
 *   pnpm --filter @manuling/core provision-tenant -- --slug acme --name "Acme" \
 *     --company-code ACME --company-name "Acme Pvt. Ltd." --plant-code P1 --plant-name "Main" \
 *     --admin-sub <keycloak-sub> --admin-email owner@acme.in --admin-name "Owner"
 */
const { values } = parseArgs({
  options: {
    slug: { type: 'string' },
    name: { type: 'string' },
    edition: { type: 'string', default: 'starter' },
    locale: { type: 'string', default: 'en-IN' },
    timezone: { type: 'string', default: 'Asia/Kolkata' },
    'company-code': { type: 'string' },
    'company-name': { type: 'string' },
    currency: { type: 'string', default: 'INR' },
    country: { type: 'string', default: 'IN' },
    'plant-code': { type: 'string' },
    'plant-name': { type: 'string' },
    'plant-region': { type: 'string' },
    'fy-start-year': { type: 'string' },
    'admin-sub': { type: 'string' },
    'admin-email': { type: 'string' },
    'admin-name': { type: 'string' },
  },
  strict: true,
});

const required = [
  'slug',
  'name',
  'company-code',
  'company-name',
  'plant-code',
  'plant-name',
  'admin-sub',
  'admin-email',
  'admin-name',
] as const;
const missing = required.filter((k) => !values[k]);
if (missing.length > 0) {
  process.stderr.write(`Missing required options: ${missing.map((m) => `--${m}`).join(', ')}\n`);
  process.exit(2);
}
const edition = values.edition;
if (edition !== 'starter' && edition !== 'growth' && edition !== 'enterprise') {
  process.stderr.write('--edition must be starter, growth or enterprise\n');
  process.exit(2);
}

try {
  const result = await provisionTenant({
    slug: values.slug!,
    name: values.name!,
    edition,
    defaultLocale: values.locale,
    defaultTimezone: values.timezone,
    company: {
      code: values['company-code']!,
      legalName: values['company-name']!,
      baseCurrency: values.currency,
      countryCode: values.country,
    },
    plant: {
      code: values['plant-code']!,
      name: values['plant-name']!,
      regionCode: values['plant-region'],
      timezone: values.timezone,
    },
    firstFiscalYear: values['fy-start-year']
      ? Number(values['fy-start-year'])
      : currentFiscalYearStart(values.country.toUpperCase() === 'IN' ? 4 : 1, values.timezone),
    admin: {
      idpSubject: values['admin-sub']!,
      email: values['admin-email']!,
      displayName: values['admin-name']!,
    },
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (err) {
  if (err instanceof DomainError) {
    process.stderr.write(`Provisioning failed: ${err.code}: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}
