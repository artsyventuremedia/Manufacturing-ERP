export interface SodRule {
  readonly id: string;
  readonly code: string;
  readonly permissionA: string;
  readonly permissionB: string;
  readonly severity: 'warn' | 'block';
}

export interface SodConflict {
  readonly ruleId: string;
  readonly code: string;
  readonly severity: 'warn' | 'block';
  readonly permissions: readonly [string, string];
}

/** Rules violated by a combined permission set (segregation of duties, PRD §12). */
export function findSodConflicts(
  permissions: ReadonlySet<string>,
  rules: readonly SodRule[],
): SodConflict[] {
  return rules
    .filter((r) => permissions.has(r.permissionA) && permissions.has(r.permissionB))
    .map((r) => ({
      ruleId: r.id,
      code: r.code,
      severity: r.severity,
      permissions: [r.permissionA, r.permissionB],
    }));
}
