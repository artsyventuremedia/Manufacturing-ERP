import { type Condition, PERMISSION_PATTERN } from '@manuling/authz/core';
import { BusinessRuleViolation, LocalDate, ValidationError, newId } from '@manuling/kernel';
import { parseName } from './validation.js';

export interface Role {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly isSystem: boolean;
  readonly status: 'active' | 'archived';
  readonly version: number;
}

const ROLE_CODE = /^[a-z][a-z0-9_]{1,39}$/;

export function parseRoleCode(value: string): string {
  const v = value.trim().toLowerCase();
  if (!ROLE_CODE.test(v))
    throw fieldError(
      'code',
      'platform.role.code_invalid',
      'Use 2–40 lowercase letters, digits or "_"',
    );
  return v;
}

/**
 * Validates a permission set against the permissions this build knows, so a typo cannot
 * silently grant nothing (or a future permission nobody reviewed).
 */
export function parsePermissions(
  values: readonly string[],
  known: (code: string) => boolean,
): string[] {
  const unique = [...new Set(values)];
  const unknown = unique.filter((p) => !PERMISSION_PATTERN.test(p) || !known(p));
  if (unknown.length > 0) {
    throw new ValidationError(
      'platform.role.permission_unknown',
      `Unknown permissions: ${unknown.join(', ')}`,
      { unknown },
      [
        {
          path: 'permissions',
          code: 'platform.role.permission_unknown',
          message: unknown.join(', '),
        },
      ],
    );
  }
  return unique.sort();
}

export function createCustomRole(input: {
  code: string;
  name: string;
  description?: string | undefined;
}): Role {
  return {
    id: newId(),
    code: parseRoleCode(input.code),
    name: parseName(input.name, 'name', 100),
    description: input.description?.trim() || null,
    isSystem: false,
    status: 'active',
    version: 1,
  };
}

export function assertEditable(role: Role): void {
  if (role.isSystem) {
    throw new BusinessRuleViolation(
      'authz.system_role_read_only',
      'Built-in roles are read-only; clone the role to customise it',
    );
  }
}

export function changeRole(
  role: Role,
  changes: {
    name?: string | undefined;
    description?: string | null | undefined;
    status?: 'active' | 'archived' | undefined;
  },
): Role {
  assertEditable(role);
  return {
    ...role,
    name: changes.name === undefined ? role.name : parseName(changes.name, 'name', 100),
    description:
      changes.description === undefined ? role.description : changes.description?.trim() || null,
    status: changes.status ?? role.status,
  };
}

// ----- assignments -----------------------------------------------------------------

export interface RoleAssignment {
  readonly id: string;
  readonly userId: string;
  readonly roleId: string;
  readonly companyId: string | null;
  readonly plantId: string | null;
  readonly conditions: readonly Condition[];
  readonly validFrom: LocalDate | null;
  readonly validTo: LocalDate | null;
  readonly status: 'active' | 'revoked';
  readonly version: number;
}

const COMPARE_OPS = new Set(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']);
const ATTR = /^[a-zA-Z][a-zA-Z0-9]{0,63}$/;

/** Validates conditions supplied as untyped JSON into the structured Condition type. */
export function parseConditions(raw: unknown): Condition[] {
  if (!Array.isArray(raw) || raw.length > 10) {
    throw fieldError(
      'conditions',
      'platform.assignment.conditions_invalid',
      'Conditions must be a list of up to 10 rules',
    );
  }
  return raw.map((c, i): Condition => {
    const path = `conditions.${i}`;
    if (typeof c !== 'object' || c === null)
      throw fieldError(path, 'platform.assignment.condition_invalid', 'Invalid condition');
    const { attr, op, value } = c as Record<string, unknown>;
    if (op === 'own') return { op: 'own' };
    if (typeof attr !== 'string' || !ATTR.test(attr))
      throw fieldError(
        `${path}.attr`,
        'platform.assignment.condition_invalid',
        'Invalid attribute name',
      );
    if (op === 'in') {
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        !value.every((v) => typeof v === 'string')
      ) {
        throw fieldError(
          `${path}.value`,
          'platform.assignment.condition_invalid',
          '"in" needs a non-empty list of strings',
        );
      }
      return { attr, op: 'in', value: value };
    }
    if (typeof op !== 'string' || !COMPARE_OPS.has(op) || typeof value !== 'string') {
      throw fieldError(
        path,
        'platform.assignment.condition_invalid',
        'Use op eq|ne|lt|lte|gt|gte with a string value, "in" or "own"',
      );
    }
    return { attr, op: op as 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte', value };
  });
}

export function createAssignment(input: {
  userId: string;
  roleId: string;
  companyId?: string | null | undefined;
  plantId?: string | null | undefined;
  conditions?: unknown;
  validFrom?: string | null | undefined;
  validTo?: string | null | undefined;
}): RoleAssignment {
  const validFrom = input.validFrom ? LocalDate.parse(input.validFrom) : null;
  const validTo = input.validTo ? LocalDate.parse(input.validTo) : null;
  if (validFrom && validTo && validTo.compare(validFrom) < 0) {
    throw fieldError(
      'validTo',
      'platform.assignment.validity_invalid',
      'validTo must not be before validFrom',
    );
  }
  if (input.plantId && !input.companyId) {
    throw fieldError(
      'companyId',
      'platform.assignment.scope_invalid',
      'A plant-scoped assignment needs its company',
    );
  }
  return {
    id: newId(),
    userId: input.userId,
    roleId: input.roleId,
    companyId: input.companyId ?? null,
    plantId: input.plantId ?? null,
    conditions: input.conditions === undefined ? [] : parseConditions(input.conditions),
    validFrom,
    validTo,
    status: 'active',
    version: 1,
  };
}

/**
 * The workspace must always keep an active user with a tenant-wide, unconditional Owner
 * assignment, or nobody could administer it again.
 */
export function assertOwnerRemains(remainingOwners: number): void {
  if (remainingOwners < 1) {
    throw new BusinessRuleViolation(
      'authz.last_owner',
      'The workspace must keep at least one active Owner',
    );
  }
}

function fieldError(path: string, code: string, message: string): ValidationError {
  return new ValidationError(code, message, { field: path }, [{ path, code, message }]);
}
