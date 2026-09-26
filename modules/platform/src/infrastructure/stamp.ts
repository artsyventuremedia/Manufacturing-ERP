import { RequestContexts } from '@manuling/kernel';

/** Tenant, actor and source columns for inserts, taken from the ambient request context. */
export function insertStamp(): {
  tenantId: string;
  createdBy: string | null;
  updatedBy: string | null;
  source: string;
} {
  const ctx = RequestContexts.requireTenant();
  const userId = actingUserId();
  return { tenantId: ctx.tenantId, createdBy: userId, updatedBy: userId, source: ctx.source };
}

export function updateStamp(): { updatedBy: string | null; updatedAt: Date } {
  return { updatedBy: actingUserId(), updatedAt: new Date() };
}

function actingUserId(): string | null {
  const actor = RequestContexts.requireTenant().actor;
  return actor.type === 'user' ? actor.id : (actor.onBehalfOf ?? null);
}
