import { Migrator, foundationMigrations } from '@manuling/db';
import { platformMigrations } from '@manuling/platform/module';
import pg from 'pg';
import { z } from 'zod';

/**
 * Applies database migrations as the owner/migration role (ADR-0004). Run before each
 * deploy (Kubernetes Job / Helm hook) and by `pnpm --filter @manuling/core migrate` locally.
 *
 * DATABASE_ADMIN_URL  owner connection string (required)
 * APP_DB_USER         optional existing login role to add to app_rw after migrating
 * RELAY_DB_USER       optional existing login role to add to outbox_relay (core-worker relay)
 */
const env = z
  .object({
    DATABASE_ADMIN_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL'),
    APP_DB_USER: z
      .string()
      .regex(/^[a-z_][a-z0-9_]{0,62}$/)
      .optional(),
    RELAY_DB_USER: z
      .string()
      .regex(/^[a-z_][a-z0-9_]{0,62}$/)
      .optional(),
  })
  .safeParse(process.env);
if (!env.success) {
  process.stderr.write(
    `Invalid migration configuration: ${env.error.issues.map((i) => i.path.join('.')).join(', ')}\n`,
  );
  process.exit(1);
}

// Module migration sets are appended here in dependency order as modules are built.
const migrationSets = [foundationMigrations, platformMigrations];

const client = new pg.Client({
  connectionString: env.data.DATABASE_ADMIN_URL,
  application_name: 'manuling-migrate',
});
await client.connect();
try {
  const result = await new Migrator(client, {
    info: (m) => process.stdout.write(`${m}\n`),
  }).migrate(migrationSets);
  process.stdout.write(
    `migrations: ${result.applied.length} applied, ${result.alreadyApplied} already applied\n`,
  );
  if (env.data.APP_DB_USER) {
    await client.query(`GRANT app_rw TO "${env.data.APP_DB_USER}"`);
    process.stdout.write(`granted app_rw to ${env.data.APP_DB_USER}\n`);
  }
  if (env.data.RELAY_DB_USER) {
    if (env.data.RELAY_DB_USER === env.data.APP_DB_USER) {
      throw new Error('RELAY_DB_USER must differ from APP_DB_USER (the relay sees all tenants)');
    }
    await client.query(`GRANT outbox_relay TO "${env.data.RELAY_DB_USER}"`);
    process.stdout.write(`granted outbox_relay to ${env.data.RELAY_DB_USER}\n`);
  }
} finally {
  await client.end();
}
