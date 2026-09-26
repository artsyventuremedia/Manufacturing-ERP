import { type AccessSnapshot } from '@manuling/authz';

/** The authenticated caller, resolved per request by the authentication guard. */
export interface Principal {
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly userId: string;
  readonly locale: string | null;
  readonly timezone: string;
  readonly access: AccessSnapshot;
  /** Companies the user can see (from role scopes). */
  readonly companyIds: readonly string[];
}
