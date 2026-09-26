import { InvariantViolation } from '@manuling/kernel';

/** `{module}.{entity}.{action}`, e.g. `platform.company.create` (ADR-0009 §8). */
export const PERMISSION_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

export interface PermissionDefinition {
  readonly code: string;
  readonly description: string;
  /** Entitlement feature this permission belongs to (edition gating, step 0.11). */
  readonly featureKey: string;
}

export interface RegisteredPermission extends PermissionDefinition {
  readonly module: string;
  readonly entity: string;
  readonly action: string;
}

/**
 * Catalogue of every permission the running build knows. Modules register theirs at load
 * time; role templates, the role editor and the boot-time route check read from here.
 */
export class PermissionRegistry {
  private readonly byCode = new Map<string, RegisteredPermission>();

  register(definitions: readonly PermissionDefinition[]): void {
    for (const def of definitions) {
      if (!PERMISSION_PATTERN.test(def.code)) {
        throw new InvariantViolation(
          'authz.permission_code_invalid',
          `Invalid permission code "${def.code}"`,
        );
      }
      const existing = this.byCode.get(def.code);
      if (existing) {
        if (existing.description === def.description && existing.featureKey === def.featureKey)
          continue;
        throw new InvariantViolation(
          'authz.permission_duplicate',
          `Permission "${def.code}" registered twice`,
        );
      }
      const [module, entity, action] = def.code.split('.') as [string, string, string];
      this.byCode.set(def.code, { ...def, module, entity, action });
    }
  }

  has(code: string): boolean {
    return this.byCode.has(code);
  }

  get(code: string): RegisteredPermission | undefined {
    return this.byCode.get(code);
  }

  all(): RegisteredPermission[] {
    return [...this.byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
  }
}

/** Process-wide registry used by modules and the platform authorisation services. */
export const permissionRegistry = new PermissionRegistry();
