import { AsyncLocalStorage } from 'node:async_hooks';
import { ForbiddenError, InvariantViolation, type LocalDate } from '@manuling/kernel';
import { type Condition, type ResourceAttributes, evaluateConditions } from './conditions.js';

/** One role assignment with the permissions it confers. */
export interface Grant {
  readonly roleId: string;
  readonly permissions: ReadonlySet<string>;
  /** null = tenant-wide. */
  readonly companyId: string | null;
  /** null = whole company (or tenant). */
  readonly plantId: string | null;
  readonly conditions: readonly Condition[];
  readonly validFrom: LocalDate | null;
  readonly validTo: LocalDate | null;
}

export type FieldAccess = 'hidden' | 'read' | 'write';

export interface AccessSnapshot {
  readonly userId: string;
  /** Business date in the user's zone, for assignment validity. */
  readonly today: LocalDate;
  readonly grants: readonly Grant[];
  /** entity → field → effective access (most permissive across the user's roles). */
  readonly fieldAccess: ReadonlyMap<string, ReadonlyMap<string, FieldAccess>>;
}

/** What is being accessed. Omitted company/plant = a tenant-level resource. */
export interface ResourceRef {
  readonly companyId?: string;
  readonly plantId?: string;
  readonly attributes?: ResourceAttributes;
}

export function isActive(grant: Pick<Grant, 'validFrom' | 'validTo'>, today: LocalDate): boolean {
  return (
    (grant.validFrom === null || grant.validFrom.compare(today) <= 0) &&
    (grant.validTo === null || today.compare(grant.validTo) <= 0)
  );
}

/**
 * A grant covers a resource when its scope contains the resource's scope:
 * tenant-wide ⊇ company ⊇ plant. Tenant-level resources need a tenant-wide grant.
 */
export function scopeCovers(grant: Grant, resource: ResourceRef): boolean {
  if (grant.companyId === null) return true;
  if (resource.companyId !== grant.companyId) return false;
  return grant.plantId === null || resource.plantId === grant.plantId;
}

export function isGranted(
  snapshot: AccessSnapshot,
  permission: string,
  resource: ResourceRef = {},
): boolean {
  return snapshot.grants.some(
    (g) =>
      g.permissions.has(permission) &&
      isActive(g, snapshot.today) &&
      scopeCovers(g, resource) &&
      evaluateConditions(g.conditions, resource.attributes ?? {}, snapshot.userId),
  );
}

/** Whether the permission is held anywhere (any scope, ignoring conditions): the route-level check. */
export function holdsAnywhere(snapshot: AccessSnapshot, permission: string): boolean {
  return snapshot.grants.some((g) => g.permissions.has(permission) && isActive(g, snapshot.today));
}

export function permissionsAnywhere(snapshot: AccessSnapshot): string[] {
  const all = new Set<string>();
  for (const g of snapshot.grants)
    if (isActive(g, snapshot.today)) for (const p of g.permissions) all.add(p);
  return [...all].sort();
}

/** Company ids visible to the user, or 'all' when any active grant is tenant-wide. */
export function visibleCompanies(snapshot: AccessSnapshot): 'all' | string[] {
  const active = snapshot.grants.filter((g) => isActive(g, snapshot.today));
  if (active.some((g) => g.companyId === null)) return 'all';
  return [...new Set(active.map((g) => g.companyId!))];
}

const storage = new AsyncLocalStorage<AccessSnapshot>();

/** Ambient access snapshot for the current request, set next to the RequestContext. */
export const AccessContexts = {
  run<T>(snapshot: AccessSnapshot, fn: () => T): T {
    return storage.run(snapshot, fn);
  },
  current(): AccessSnapshot | undefined {
    return storage.getStore();
  },
  require(): AccessSnapshot {
    const s = storage.getStore();
    if (!s)
      throw new InvariantViolation(
        'authz.no_access_context',
        'No access context for this operation',
      );
    return s;
  },
};

/** Use-case-level checks against the ambient access snapshot. */
export const AccessControl = {
  can(permission: string, resource?: ResourceRef): boolean {
    return isGranted(AccessContexts.require(), permission, resource);
  },

  assert(permission: string, resource?: ResourceRef): void {
    if (!isGranted(AccessContexts.require(), permission, resource)) {
      throw new ForbiddenError('authz.permission_denied', 'You do not have permission to do this', {
        permission,
      });
    }
  },

  /** Effective access to a field; unlisted fields are writable. */
  fieldAccess(entity: string, field: string): FieldAccess {
    return AccessContexts.current()?.fieldAccess.get(entity)?.get(field) ?? 'write';
  },

  /** Removes hidden fields from a response object. */
  redact<T extends object>(entity: string, value: T): Partial<T> {
    const policies = AccessContexts.current()?.fieldAccess.get(entity);
    if (!policies) return value;
    const copy = { ...value } as Record<string, unknown>;
    for (const [field, access] of policies) if (access === 'hidden') delete copy[field];
    return copy as Partial<T>;
  },

  /** Rejects changes to fields the caller may not write. */
  assertWritable(entity: string, changes: object): void {
    const policies = AccessContexts.current()?.fieldAccess.get(entity);
    if (!policies) return;
    for (const field of Object.keys(changes)) {
      const access = policies.get(field) ?? 'write';
      if (access !== 'write') {
        throw new ForbiddenError('authz.field_read_only', `You cannot change "${field}"`, {
          entity,
          field,
        });
      }
    }
  },
};

/**
 * Most permissive access per field across roles: a field is hidden only if every role that
 * has policies for the entity hides it (roles with no policy for a field grant write).
 */
export function mergeFieldPolicies(
  roleIds: readonly string[],
  policies: readonly { roleId: string; entity: string; field: string; access: 'hidden' | 'read' }[],
): Map<string, Map<string, FieldAccess>> {
  const rank: Record<FieldAccess, number> = { hidden: 0, read: 1, write: 2 };
  const result = new Map<string, Map<string, FieldAccess>>();
  const fields = new Map<string, Set<string>>();
  for (const p of policies) {
    if (!fields.has(p.entity)) fields.set(p.entity, new Set());
    fields.get(p.entity)!.add(p.field);
  }
  for (const [entity, names] of fields) {
    const perField = new Map<string, FieldAccess>();
    for (const field of names) {
      let best: FieldAccess = 'hidden';
      for (const roleId of roleIds) {
        const own = policies.find(
          (p) => p.roleId === roleId && p.entity === entity && p.field === field,
        );
        const access: FieldAccess = own ? own.access : 'write';
        if (rank[access] > rank[best]) best = access;
      }
      if (best !== 'write') perField.set(field, best);
    }
    if (perField.size > 0) result.set(entity, perField);
  }
  return result;
}
