import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

export interface EphemeralPostgres {
  /** Superuser connection string for the default `postgres` database. */
  readonly adminUrl: string;
  readonly port: number;
  /** Creates a fresh database and returns its superuser connection string. */
  createDatabase(name: string): Promise<string>;
  /** Connection string for `database` as `user`/`password`. */
  urlFor(database: string, user: string, password: string): string;
  stop(): Promise<void>;
}

const SUPERUSER = 'postgres';
const SUPERPASS = 'postgres';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('Could not allocate a port')));
      }
    });
  });
}

/**
 * Starts a real PostgreSQL server from embedded binaries (no Docker needed) in a temp dir.
 * If `MANULING_TEST_DATABASE_URL` is set (e.g. CI with a service container), that server is
 * used instead and `stop()` only drops the databases created here.
 */
export async function startEphemeralPostgres(): Promise<EphemeralPostgres> {
  const external = process.env['MANULING_TEST_DATABASE_URL'];
  if (external) return externalServer(external);

  const { server, port, dir } = await startWithRetry();

  const base = (db: string, user = SUPERUSER, pass = SUPERPASS): string =>
    `postgres://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@127.0.0.1:${port}/${db}`;

  return {
    adminUrl: base('postgres'),
    port,
    urlFor: (db, user, pass) => base(db, user, pass),
    async createDatabase(name) {
      await withClient(base('postgres'), (c) => c.query(`CREATE DATABASE "${safeIdent(name)}"`));
      return base(name);
    },
    async stop() {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const START_TIMEOUT_MS = 20_000;
const START_ATTEMPTS = 3;

/**
 * embedded-postgres waits indefinitely if the server never becomes ready (e.g. the port
 * picked by freePort() was grabbed by another process before Postgres bound it), so each
 * attempt is time-boxed and retried on a fresh port and data directory.
 */
async function startWithRetry(): Promise<{ server: EmbeddedPostgres; port: number; dir: string }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++) {
    const port = await freePort();
    const dir = mkdtempSync(join(tmpdir(), 'manuling-pg-'));
    const server = new EmbeddedPostgres({
      databaseDir: dir,
      user: SUPERUSER,
      password: SUPERPASS,
      port,
      persistent: false,
      onLog: () => undefined,
      onError: () => undefined,
    });
    try {
      await withTimeout(
        (async () => {
          await server.initialise();
          await server.start();
        })(),
        START_TIMEOUT_MS,
      );
      return { server, port, dir };
    } catch (err) {
      lastError = err;
      // stop() can wait forever on a half-started server; never let cleanup block a retry.
      await withTimeout(server.stop(), 5_000).catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  }
  throw new Error(`Embedded PostgreSQL failed to start after ${START_ATTEMPTS} attempts`, {
    cause: lastError,
  });
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function externalServer(adminUrl: string): EphemeralPostgres {
  const created: string[] = [];
  const url = new URL(adminUrl);
  const withDb = (db: string, user?: string, pass?: string): string => {
    const u = new URL(adminUrl);
    u.pathname = `/${db}`;
    if (user !== undefined) u.username = encodeURIComponent(user);
    if (pass !== undefined) u.password = encodeURIComponent(pass);
    return u.toString();
  };
  return {
    adminUrl,
    port: Number(url.port || 5432),
    urlFor: (db, user, pass) => withDb(db, user, pass),
    async createDatabase(name) {
      await withClient(adminUrl, (c) => c.query(`CREATE DATABASE "${safeIdent(name)}"`));
      created.push(name);
      return withDb(name);
    },
    async stop() {
      for (const name of created) {
        await withClient(adminUrl, (c) =>
          c.query(`DROP DATABASE IF EXISTS "${safeIdent(name)}" WITH (FORCE)`),
        );
      }
    },
  };
}

export async function withClient<T>(
  url: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function safeIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`Unsafe identifier "${name}"`);
  return name;
}
