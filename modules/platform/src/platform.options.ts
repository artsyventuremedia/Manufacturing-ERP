import { type TokenVerifier } from './application/token-verifier.js';
import { type OidcOptions } from './infrastructure/oidc-token-verifier.js';

export interface PlatformOptions {
  readonly oidc: OidcOptions;
  /** Base domain for `{slug}.{baseDomain}` tenant hosts; header-only resolution if unset. */
  readonly tenantBaseDomain?: string | undefined;
  readonly supportedLocales: readonly string[];
  /** Replaces the OIDC verifier (tests, custom IdPs). */
  readonly tokenVerifier?: TokenVerifier | undefined;
}

export const PLATFORM_OPTIONS = Symbol('PLATFORM_OPTIONS');
