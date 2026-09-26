import { AsyncLocalStorage } from 'node:async_hooks';
import { InvariantViolation, UnauthenticatedError } from './errors.js';

export type ActorType = 'user' | 'agent' | 'system' | 'integration';
/** Where a change originated; stored on every audit record (PRD §10). */
export type RequestSource = 'ui' | 'api' | 'import' | 'agent' | 'integration' | 'system';

export interface Actor {
  readonly type: ActorType;
  readonly id: string;
  /** For agents and integrations acting on behalf of a user (ADR-0009 §6). */
  readonly onBehalfOf?: string;
}

/**
 * Ambient per-request/per-job context. Carried through async calls with AsyncLocalStorage
 * and applied to every DB transaction as `SET LOCAL app.*` (ADR-0004, ADR-0005).
 */
export interface RequestContext {
  readonly correlationId: string;
  readonly source: RequestSource;
  readonly locale: string;
  readonly timezone: string;
  readonly tenantId?: string;
  readonly actor?: Actor;
  /** Companies the actor may act in; empty means none. */
  readonly companyIds: readonly string[];
  /** Caller IP as seen by the API (after trusted proxies); recorded in the audit log. */
  readonly clientIp?: string;
}

export interface TenantRequestContext extends RequestContext {
  readonly tenantId: string;
  readonly actor: Actor;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const RequestContexts = {
  run<T>(context: RequestContext, fn: () => T): T {
    return storage.run(Object.freeze({ ...context }), fn);
  },

  current(): RequestContext | undefined {
    return storage.getStore();
  },

  require(): RequestContext {
    const ctx = storage.getStore();
    if (!ctx) {
      throw new InvariantViolation(
        'kernel.context.missing',
        'No request context; wrap the call in RequestContexts.run()',
      );
    }
    return ctx;
  },

  /** Context with an authenticated tenant and actor, or UnauthenticatedError. */
  requireTenant(): TenantRequestContext {
    const ctx = RequestContexts.require();
    if (!ctx.tenantId || !ctx.actor) throw new UnauthenticatedError();
    return ctx as TenantRequestContext;
  },
};
