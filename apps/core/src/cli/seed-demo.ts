import { parseArgs } from 'node:util';
import { ConflictError } from '@manuling/kernel';
import { cliArgs, currentFiscalYearStart, provisionTenant } from './provisioning.js';

/**
 * Seeds the demo workspace "Mysuru Precision Components Pvt. Ltd." (PRD §17) with slug
 * `mysuru-precision`. Safe to re-run: an existing workspace is left untouched.
 *   pnpm --filter @manuling/core seed:demo -- --admin-sub <keycloak-sub-of-demo-admin>
 */
const { values } = parseArgs({
  args: cliArgs(),
  options: {
    'admin-sub': { type: 'string' },
    'admin-email': { type: 'string', default: 'admin@mysuruprecision.example' },
  },
  strict: true,
});
if (!values['admin-sub']) {
  process.stderr.write('Missing --admin-sub (the Keycloak user id of the demo administrator)\n');
  process.exit(2);
}

try {
  const result = await provisionTenant({
    slug: 'mysuru-precision',
    name: 'Mysuru Precision Components',
    edition: 'growth',
    defaultLocale: 'en-IN',
    defaultTimezone: 'Asia/Kolkata',
    company: {
      code: 'MPC',
      legalName: 'Mysuru Precision Components Pvt. Ltd.',
      baseCurrency: 'INR',
      countryCode: 'IN',
    },
    plant: {
      code: 'MYS1',
      name: 'Hebbal Industrial Area, Mysuru',
      regionCode: 'IN-KA',
      timezone: 'Asia/Kolkata',
    },
    firstFiscalYear: currentFiscalYearStart(4, 'Asia/Kolkata'),
    admin: {
      idpSubject: values['admin-sub'],
      email: values['admin-email'],
      displayName: 'Demo Administrator',
    },
  });
  process.stdout.write(`Demo workspace created: ${JSON.stringify(result)}\n`);
} catch (err) {
  if (err instanceof ConflictError && err.code === 'db.unique_violation') {
    process.stdout.write('Demo workspace "mysuru-precision" already exists; nothing to do.\n');
  } else {
    throw err;
  }
}
