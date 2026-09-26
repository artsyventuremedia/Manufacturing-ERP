/** Claims we rely on from a verified access token. Tenancy never comes from claims. */
export interface VerifiedToken {
  readonly subject: string;
  readonly issuer: string;
  readonly expiresAt: Date;
  readonly email?: string;
  /** Only a verified email may bind an invitation (plan decision D1). */
  readonly emailVerified: boolean;
}

export interface TokenVerifier {
  /** Resolves with verified claims or rejects with UnauthenticatedError('auth.invalid_token'). */
  verify(token: string): Promise<VerifiedToken>;
}

export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');
