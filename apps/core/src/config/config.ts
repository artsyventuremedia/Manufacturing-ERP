import { z } from 'zod';

const logLevel = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  /** Connection string for a login role that is a member of app_rw (never the owner). */
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).default(15_000),
  LOG_LEVEL: logLevel.default('info'),
  LOG_PRETTY: z.stringbool().default(false),
  SUPPORTED_LOCALES: z.string().default('en-IN,kn-IN,hi-IN'),
  DEFAULT_LOCALE: z.string().default('en-IN'),
  DEFAULT_TIMEZONE: z.string().default('Asia/Kolkata'),
  /** OIDC issuer (Keycloak realm URL); must equal the tokens' `iss`. */
  OIDC_ISSUER: z.url({ protocol: /^https?$/ }),
  OIDC_AUDIENCE: z.string().min(1).default('manuling-api'),
  /** e.g. manuling.in → tenants at {slug}.manuling.in. Optional: X-Tenant header always works. */
  TENANT_BASE_DOMAIN: z
    .string()
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)
    .optional(),
  /** `kafka` in real deployments; `memory` only for tests and Docker-less development. */
  EVENT_BUS: z.enum(['kafka', 'memory']).default('memory'),
  /** Comma-separated host:port list; required when EVENT_BUS=kafka. */
  KAFKA_BROKERS: z.string().optional(),
  /** Create missing topics on first use. Default: on outside production (topics are infra-managed there). */
  KAFKA_AUTO_CREATE_TOPICS: z.stringbool().optional(),
  KAFKA_TOPIC_PARTITIONS: z.coerce.number().int().min(1).max(1000).default(6),
  KAFKA_REPLICATION_FACTOR: z.coerce.number().int().min(1).max(10).default(1),
  /** Temporal frontend (host:port) and namespace for durable workflows (ADR-0010). */
  TEMPORAL_ADDRESS: z.string().min(3).default('localhost:7233'),
  TEMPORAL_NAMESPACE: z.string().min(1).default('default'),
  /** Worker only: login role that is a member of outbox_relay (reads all tenants' outbox). */
  DATABASE_RELAY_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL')
    .optional(),
  BODY_LIMIT_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(50 * 1024 * 1024)
    .default(1024 * 1024),
});

export interface AppConfig {
  readonly env: 'development' | 'test' | 'production';
  readonly http: { readonly host: string; readonly port: number; readonly bodyLimitBytes: number };
  readonly database: {
    readonly url: string;
    readonly poolMax: number;
    readonly statementTimeoutMs: number;
  };
  readonly auth: {
    readonly issuer: string;
    readonly audience: string;
    readonly tenantBaseDomain: string | undefined;
  };
  readonly events: {
    readonly bus: 'kafka' | 'memory';
    readonly kafkaBrokers: readonly string[];
    readonly kafkaAutoCreateTopics: boolean;
    readonly kafkaTopicPartitions: number;
    readonly kafkaReplicationFactor: number;
    readonly relayDatabaseUrl: string | undefined;
  };
  readonly temporal: { readonly address: string; readonly namespace: string };
  readonly log: { readonly level: z.infer<typeof logLevel>; readonly pretty: boolean };
  readonly i18n: {
    readonly supportedLocales: readonly string[];
    readonly defaultLocale: string;
    readonly defaultTimezone: string;
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');

/**
 * Validates environment variables once at startup. Fails fast with the offending variable
 * names only; values are never printed because they may contain secrets.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }
  const e = parsed.data;
  const supportedLocales = e.SUPPORTED_LOCALES.split(',')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!supportedLocales.includes(e.DEFAULT_LOCALE)) {
    throw new Error('Invalid configuration: DEFAULT_LOCALE must be one of SUPPORTED_LOCALES');
  }
  if (!isValidTimeZone(e.DEFAULT_TIMEZONE)) {
    throw new Error('Invalid configuration: DEFAULT_TIMEZONE is not a valid IANA time zone');
  }
  const kafkaBrokers = (e.KAFKA_BROKERS ?? '')
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean);
  if (e.EVENT_BUS === 'kafka' && kafkaBrokers.length === 0) {
    throw new Error('Invalid configuration: KAFKA_BROKERS is required when EVENT_BUS=kafka');
  }
  if (e.EVENT_BUS === 'memory' && e.NODE_ENV === 'production') {
    throw new Error(
      'Invalid configuration: EVENT_BUS=memory is not durable; use kafka in production',
    );
  }
  return {
    env: e.NODE_ENV,
    http: { host: e.HOST, port: e.PORT, bodyLimitBytes: e.BODY_LIMIT_BYTES },
    database: {
      url: e.DATABASE_URL,
      poolMax: e.DATABASE_POOL_MAX,
      statementTimeoutMs: e.DATABASE_STATEMENT_TIMEOUT_MS,
    },
    auth: {
      issuer: e.OIDC_ISSUER,
      audience: e.OIDC_AUDIENCE,
      tenantBaseDomain: e.TENANT_BASE_DOMAIN,
    },
    events: {
      bus: e.EVENT_BUS,
      kafkaBrokers,
      kafkaAutoCreateTopics: e.KAFKA_AUTO_CREATE_TOPICS ?? e.NODE_ENV !== 'production',
      kafkaTopicPartitions: e.KAFKA_TOPIC_PARTITIONS,
      kafkaReplicationFactor: e.KAFKA_REPLICATION_FACTOR,
      relayDatabaseUrl: e.DATABASE_RELAY_URL,
    },
    temporal: { address: e.TEMPORAL_ADDRESS, namespace: e.TEMPORAL_NAMESPACE },
    log: { level: e.LOG_LEVEL, pretty: e.LOG_PRETTY },
    i18n: {
      supportedLocales,
      defaultLocale: e.DEFAULT_LOCALE,
      defaultTimezone: e.DEFAULT_TIMEZONE,
    },
  };
}

/** Accepts any IANA zone the runtime knows, including aliases such as Asia/Kolkata. */
function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
