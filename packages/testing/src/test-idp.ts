import { type JWTVerifyGetKey, SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';

export interface TestIdp {
  readonly issuer: string;
  readonly audience: string;
  /** Key set to pass to OidcTokenVerifier({ keys }). */
  readonly keys: JWTVerifyGetKey;
  /** Signs an access token for `subject`; override claims or lifetime to build bad tokens. */
  token(subject: string, options?: TokenOptions): Promise<string>;
}

export interface TokenOptions {
  readonly audience?: string;
  readonly issuer?: string;
  readonly expiresInSeconds?: number;
  readonly claims?: Record<string, unknown>;
  /** Sign with a key the verifier does not know. */
  readonly foreignKey?: boolean;
}

/** In-memory OIDC issuer (RS256) standing in for Keycloak in tests. */
export async function createTestIdp(
  issuer = 'https://idp.test/realms/manuling',
  audience = 'manuling-api',
): Promise<TestIdp> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const foreign = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const keys = createLocalJWKSet({ keys: [jwk] });

  return {
    issuer,
    audience,
    keys,
    async token(subject, options = {}) {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ ...options.claims })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setSubject(subject)
        .setIssuer(options.issuer ?? issuer)
        .setAudience(options.audience ?? audience)
        .setIssuedAt(now - 5)
        .setExpirationTime(now + (options.expiresInSeconds ?? 300))
        .sign(options.foreignKey ? foreign.privateKey : privateKey);
    },
  };
}
