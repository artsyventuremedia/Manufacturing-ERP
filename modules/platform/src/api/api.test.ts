import { createTestIdp } from '@manuling/testing';
import { describe, expect, it } from 'vitest';
import { OidcTokenVerifier } from '../infrastructure/oidc-token-verifier.js';
import { resolveTenantSlug, slugFromHost } from './tenant-resolver.js';

describe('tenant resolution', () => {
  it('reads the subdomain under the base domain only', () => {
    expect(slugFromHost('mysuru-precision.manuling.in:443', 'manuling.in')).toBe(
      'mysuru-precision',
    );
    expect(slugFromHost('a.b.manuling.in', 'manuling.in')).toBeUndefined();
    expect(slugFromHost('evil-manuling.in', 'manuling.in')).toBeUndefined();
    expect(slugFromHost('x.manuling.in', undefined)).toBeUndefined();
  });

  it('prefers agreement between header and host', () => {
    expect(resolveTenantSlug({ 'x-tenant': ' Alpha ' }, undefined)).toBe('alpha');
    expect(resolveTenantSlug({ host: 'alpha.manuling.in' }, 'manuling.in')).toBe('alpha');
    expect(
      resolveTenantSlug({ host: 'alpha.manuling.in', 'x-tenant': 'alpha' }, 'manuling.in'),
    ).toBe('alpha');
    expect(() =>
      resolveTenantSlug({ host: 'alpha.manuling.in', 'x-tenant': 'beta' }, 'manuling.in'),
    ).toThrow(expect.objectContaining({ code: 'http.tenant_ambiguous' }));
    expect(() => resolveTenantSlug({ host: 'localhost:3000' }, 'manuling.in')).toThrow(
      expect.objectContaining({ code: 'http.tenant_required' }),
    );
  });
});

describe('OidcTokenVerifier', () => {
  it('accepts valid tokens and rejects wrong audience, issuer, key or expiry', async () => {
    const idp = await createTestIdp();
    const verifier = new OidcTokenVerifier({
      issuer: idp.issuer,
      audience: idp.audience,
      keys: idp.keys,
      clockToleranceSeconds: 0,
    });

    const ok = await verifier.verify(await idp.token('user-1', { claims: { email: 'u@x.in' } }));
    expect(ok).toMatchObject({ subject: 'user-1', issuer: idp.issuer, email: 'u@x.in' });

    for (const bad of [
      await idp.token('u', { audience: 'account' }),
      await idp.token('u', { issuer: 'https://other/realms/x' }),
      await idp.token('u', { foreignKey: true }),
      await idp.token('u', { expiresInSeconds: -60 }),
      'not.a.jwt',
    ]) {
      await expect(verifier.verify(bad)).rejects.toMatchObject({ code: 'auth.invalid_token' });
    }
  });

  it('reports an unreachable identity provider distinctly and retries discovery later', async () => {
    const verifier = new OidcTokenVerifier({
      issuer: 'http://127.0.0.1:1/realms/x',
      audience: 'a',
    });
    await expect(verifier.verify('x.y.z')).rejects.toMatchObject({ code: 'auth.idp_unavailable' });
    await expect(verifier.verify('x.y.z')).rejects.toMatchObject({ code: 'auth.idp_unavailable' });
  });
});
