import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InvariantViolation } from '@manuling/kernel';
import type pg from 'pg';

/** A directory of `NNNN_snake_name.sql` files owned by one module/schema. */
export interface MigrationSet {
  readonly name: string;
  readonly directory: string;
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: number;
}

export interface MigrationLogger {
  info(message: string): void;
}

/** Foundation SQL shipped with this package; always applied first. */
export const foundationMigrations: MigrationSet = {
  name: 'foundation',
  directory: fileURLToPath(new URL('../migrations', import.meta.url)),
};

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const NO_TRANSACTION_MARKER = '-- migrate:no-transaction';
/** Arbitrary constant key for pg_advisory_lock so concurrent deploys migrate one at a time. */
const MIGRATION_LOCK_KEY = 7_331_001;

interface MigrationFile {
  readonly version: string;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

/**
 * Forward-only SQL migrator (ADR-0004 §3–4). Runs as the migration/owner role.
 * - Serialised with an advisory lock.
 * - Each file runs in its own transaction unless it starts with `-- migrate:no-transaction`
 *   (needed for CREATE INDEX CONCURRENTLY).
 * - Checksums of applied files are verified; editing an applied migration is an error.
 */
export class Migrator {
  constructor(
    private readonly client: pg.Client | pg.PoolClient,
    private readonly logger: MigrationLogger = { info: () => undefined },
  ) {}

  async migrate(sets: readonly MigrationSet[]): Promise<MigrationResult> {
    const names = new Set<string>();
    for (const set of sets) {
      if (names.has(set.name))
        throw new InvariantViolation(
          'db.migration_duplicate_set',
          `Duplicate migration set ${set.name}`,
        );
      names.add(set.name);
    }

    await this.client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await this.ensureMetaTable();
      const applied: string[] = [];
      let alreadyApplied = 0;
      for (const set of sets) {
        const files = await loadMigrationFiles(set.directory);
        const done = await this.appliedChecksums(set.name);
        for (const file of files) {
          const id = `${set.name}/${file.version}_${file.name}`;
          const existing = done.get(file.version);
          if (existing !== undefined) {
            if (existing !== file.checksum) {
              throw new InvariantViolation(
                'db.migration_checksum_mismatch',
                `Migration ${id} was modified after being applied; add a new migration instead`,
                { migration: id },
              );
            }
            alreadyApplied++;
            continue;
          }
          await this.apply(set.name, file);
          this.logger.info(`applied migration ${id}`);
          applied.push(id);
        }
      }
      return { applied, alreadyApplied };
    } finally {
      await this.client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  }

  private async ensureMetaTable(): Promise<void> {
    await this.client.query(`
      CREATE SCHEMA IF NOT EXISTS platform_meta;
      CREATE TABLE IF NOT EXISTS platform_meta.schema_migration (
        migration_set text        NOT NULL,
        version       text        NOT NULL,
        name          text        NOT NULL,
        checksum      text        NOT NULL,
        applied_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (migration_set, version)
      );`);
  }

  private async appliedChecksums(set: string): Promise<Map<string, string>> {
    const res = await this.client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM platform_meta.schema_migration WHERE migration_set = $1',
      [set],
    );
    return new Map(res.rows.map((r) => [r.version, r.checksum]));
  }

  private async apply(set: string, file: MigrationFile): Promise<void> {
    const record = (): Promise<unknown> =>
      this.client.query(
        'INSERT INTO platform_meta.schema_migration (migration_set, version, name, checksum) VALUES ($1, $2, $3, $4)',
        [set, file.version, file.name, file.checksum],
      );

    if (file.sql.trimStart().startsWith(NO_TRANSACTION_MARKER)) {
      await this.client.query(file.sql);
      await record();
      return;
    }
    await this.client.query('BEGIN');
    try {
      await this.client.query(file.sql);
      await record();
      await this.client.query('COMMIT');
    } catch (err) {
      await this.client.query('ROLLBACK');
      throw err;
    }
  }
}

async function loadMigrationFiles(directory: string): Promise<MigrationFile[]> {
  const entries = (await readdir(directory)).filter((f) => f.endsWith('.sql')).sort();
  const files: MigrationFile[] = [];
  const versions = new Set<string>();
  for (const entry of entries) {
    const match = FILE_PATTERN.exec(entry);
    if (!match) {
      throw new InvariantViolation(
        'db.migration_bad_name',
        `Migration file "${entry}" must match NNNN_snake_name.sql`,
      );
    }
    const [, version, name] = match as unknown as [string, string, string];
    if (versions.has(version)) {
      throw new InvariantViolation(
        'db.migration_duplicate_version',
        `Duplicate migration version ${version} in ${directory}`,
      );
    }
    versions.add(version);
    const sql = await readFile(join(directory, entry), 'utf8');
    files.push({ version, name, sql, checksum: createHash('sha256').update(sql).digest('hex') });
  }
  return files;
}
