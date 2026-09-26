import { UnauthenticatedError } from '@manuling/kernel';
import { type JWTVerifyGetKey, createRemoteJWKSet, jwtVerify } from 'jose';
import { type TokenVerifier, type VerifiedToken } from '../application/token-verifier.js';

export interface OidcOptions {
  /** Issuer URL, e.g. https://auth.manuling.in/realms/manuling (must match `iss` exactly). */
  readonly issuer: string;
  /** Expected `aud` (Keycloak audience mapper adds it). */
  readonly audience: string;
  readonly clockToleranceSeconds?: number;
  /** Inject a key set (tests, air-gapped installs); otherwise discovered from the issuer. */
  readonly keys?: JWTVerifyGetKey;
}

const ALGORITHMS = ['RS256', 'PS256', 'ES256', 'EdDSA'];

/**
 * Verifies OIDC access tokens (JWT) against the issuer's JWKS, found through OpenID
 * discovery and cached with key rotation handled by `jose`.
 */
export class OidcTokenVerifier implements TokenVerifier {
  private keys: Promise<JWTVerifyGetKey> | undefined;

  constructor(private readonly options: OidcOptions) {
    if (options.keys) this.keys = Promise.resolve(options.keys);
  }

  async verify(token: string): Promise<VerifiedToken> {
    let keys: JWTVerifyGetKey;
    try {
      keys = await this.keySet();
    } catch (err) {
      this.keys = undefined; // retry discovery on the next request
      throw new UnauthenticatedError('Identity provider is unreachable', 'auth.idp_unavailable', {
        cause: err,
      });
    }
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        algorithms: ALGORITHMS,
        clockTolerance: this.options.clockToleranceSeconds ?? 30,
        requiredClaims: ['sub', 'exp', 'iat'],
      });
      return {
        subject: payload.sub!,
        issuer: payload.iss!,
        expiresAt: new Date(payload.exp! * 1000),
        ...(typeof payload['email'] === 'string' ? { email: payload['email'] } : {}),
        emailVerified: payload['email_verified'] === true,
      };
    } catch {
      throw new UnauthenticatedError(
        'The access token is invalid or expired',
        'auth.invalid_token',
      );
    }
  }

  private keySet(): Promise<JWTVerifyGetKey> {
    this.keys ??= this.discover();
    return this.keys;
  }

  private async discover(): Promise<JWTVerifyGetKey> {
    const url = `${this.options.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status}`);
    const doc = (await res.json()) as { jwks_uri?: unknown };
    if (typeof doc.jwks_uri !== 'string')
      throw new Error('OIDC discovery document has no jwks_uri');
    return createRemoteJWKSet(new URL(doc.jwks_uri), {
      cooldownDuration: 30_000,
      timeoutDuration: 5_000,
    });
  }
}
