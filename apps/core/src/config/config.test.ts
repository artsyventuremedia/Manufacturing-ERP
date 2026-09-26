import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = {
  DATABASE_URL: 'postgres://app:secret@db:5432/manuling',
  OIDC_ISSUER: 'http://localhost:8080/realms/manuling',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig(base);
    expect(config.http).toEqual({ host: '0.0.0.0', port: 3000, bodyLimitBytes: 1_048_576 });
    expect(config.i18n).toEqual({
      supportedLocales: ['en-IN', 'kn-IN', 'hi-IN'],
      defaultLocale: 'en-IN',
      defaultTimezone: 'Asia/Kolkata',
    });
    expect(config.log).toEqual({ level: 'info', pretty: false });
    expect(config.auth).toEqual({
      issuer: 'http://localhost:8080/realms/manuling',
      audience: 'manuling-api',
      tenantBaseDomain: undefined,
    });
  });

  it('fails fast without leaking secret values', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    try {
      loadConfig({ ...base, PORT: 'abc', DATABASE_URL: 'mysql://u:hunter2@x' });
    } catch (err) {
      expect((err as Error).message).not.toContain('hunter2');
      expect((err as Error).message).toMatch(/PORT/);
    }
  });

  it('validates locale and time zone consistency', () => {
    expect(() => loadConfig({ ...base, DEFAULT_LOCALE: 'fr-FR' })).toThrow(/DEFAULT_LOCALE/);
    expect(() => loadConfig({ ...base, DEFAULT_TIMEZONE: 'Mars/Olympus' })).toThrow(
      /DEFAULT_TIMEZONE/,
    );
    expect(loadConfig({ ...base, LOG_PRETTY: 'true' }).log.pretty).toBe(true);
  });
});
