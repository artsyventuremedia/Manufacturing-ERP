import { type Condition } from '@manuling/authz';
import { UnitOfWork } from '@manuling/db';
import { ConcurrencyConflictError, LocalDate, NotFoundError, newId } from '@manuling/kernel';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { type Role, type RoleAssignment } from '../domain/role.js';
import {
  appUserTable,
  companyTable,
  fieldPolicyTable,
  rolePermissionTable,
  roleTable,
  sodRuleTable,
  userRoleTable,
} from './schema.js';
import { insertStamp, updateStamp } from './stamp.js';

export type RoleRecord = Role & { readonly createdAt: Date; readonly updatedAt: Date };
export type AssignmentRecord = RoleAssignment & {
  readonly roleCode: string;
  readonly createdAt: Date;
};

export interface FieldPolicyRow {
  readonly roleId: string;
  readonly entity: string;
  readonly field: string;
  readonly access: 'hidden' | 'read';
}

export interface SodRuleRecord {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly permissionA: string;
  readonly permissionB: string;
  readonly severity: 'warn' | 'block';
  readonly isSystem: boolean;
  readonly status: 'active' | 'disabled';
  readonly version: number;
}

/** Roles, assignments, field policies and SoD rules; tenant-scoped through the UnitOfWork. */
@Injectable()
export class AuthorisationRepository {
  constructor(private readonly uow: UnitOfWork) {}

  private get db() {
    return this.uow.current().db;
  }

  // ----- roles ---------------------------------------------------------------------

  async insertRole(role: Role): Promise<RoleRecord> {
    const [row] = await this.db
      .insert(roleTable)
      .values({ ...role, ...insertStamp() })
      .returning();
    return toRole(row!);
  }

  async findRole(id: string): Promise<RoleRecord | undefined> {
    const [row] = await this.db.select().from(roleTable).where(eq(roleTable.id, id));
    return row ? toRole(row) : undefined;
  }

  async getRole(id: string): Promise<RoleRecord> {
    const role = await this.findRole(id);
    if (!role) throw new NotFoundError('Role', id);
    return role;
  }

  async findRoleByCode(code: string): Promise<RoleRecord | undefined> {
    const [row] = await this.db.select().from(roleTable).where(eq(roleTable.code, code));
    return row ? toRole(row) : undefined;
  }

  async listRoles(): Promise<RoleRecord[]> {
    const rows = await this.db
      .select()
      .from(roleTable)
      .orderBy(asc(roleTable.isSystem), asc(roleTable.name));
    return rows
      .map(toRole)
      .sort((a, b) => Number(b.isSystem) - Number(a.isSystem) || a.name.localeCompare(b.name));
  }

  async updateRole(role: Role, expectedVersion: number): Promise<RoleRecord> {
    const [row] = await this.db
      .update(roleTable)
      .set({
        name: role.name,
        description: role.description,
        status: role.status,
        version: sql`${roleTable.version} + 1`,
        ...updateStamp(),
      })
      .where(and(eq(roleTable.id, role.id), eq(roleTable.version, expectedVersion)))
      .returning();
    if (!row) {
      const current = await this.findRole(role.id);
      throw current
        ? new ConcurrencyConflictError('Role', role.id, expectedVersion, current.version)
        : new NotFoundError('Role', role.id);
    }
    return toRole(row);
  }

  async storedPermissions(roleIds: readonly string[]): Promise<Map<string, Set<string>>> {
    const result = new Map<string, Set<string>>();
    if (roleIds.length === 0) return result;
    const rows = await this.db
      .select({ roleId: rolePermissionTable.roleId, permission: rolePermissionTable.permission })
      .from(rolePermissionTable)
      .where(inArray(rolePermissionTable.roleId, [...roleIds]));
    for (const r of rows) {
      if (!result.has(r.roleId)) result.set(r.roleId, new Set());
      result.get(r.roleId)!.add(r.permission);
    }
    return result;
  }

  async replacePermissions(roleId: string, permissions: readonly string[]): Promise<void> {
    await this.db.delete(rolePermissionTable).where(eq(rolePermissionTable.roleId, roleId));
    if (permissions.length === 0) return;
    const { tenantId, createdBy } = insertStamp();
    await this.db
      .insert(rolePermissionTable)
      .values(permissions.map((permission) => ({ tenantId, roleId, permission, createdBy })));
  }

  // ----- assignments -----------------------------------------------------------------

  async insertAssignment(a: RoleAssignment): Promise<void> {
    await this.db.insert(userRoleTable).values({
      id: a.id,
      userId: a.userId,
      roleId: a.roleId,
      companyId: a.companyId,
      plantId: a.plantId,
      conditions: [...a.conditions],
      validFrom: a.validFrom?.toString() ?? null,
      validTo: a.validTo?.toString() ?? null,
      status: a.status,
      version: a.version,
      ...insertStamp(),
    });
  }

  /** Assignments of a user joined with their role; only active assignments of active roles unless `all`. */
  async assignmentsForUser(userId: string, all = false): Promise<AssignmentRecord[]> {
    const rows = await this.db
      .select({ a: userRoleTable, roleCode: roleTable.code })
      .from(userRoleTable)
      .innerJoin(roleTable, eq(roleTable.id, userRoleTable.roleId))
      .where(
        all
          ? eq(userRoleTable.userId, userId)
          : and(
              eq(userRoleTable.userId, userId),
              eq(userRoleTable.status, 'active'),
              eq(roleTable.status, 'active'),
            ),
      )
      .orderBy(asc(userRoleTable.createdAt));
    return rows.map((r) => toAssignment(r.a, r.roleCode));
  }

  async findAssignment(id: string): Promise<AssignmentRecord | undefined> {
    const [row] = await this.db
      .select({ a: userRoleTable, roleCode: roleTable.code })
      .from(userRoleTable)
      .innerJoin(roleTable, eq(roleTable.id, userRoleTable.roleId))
      .where(eq(userRoleTable.id, id));
    return row ? toAssignment(row.a, row.roleCode) : undefined;
  }

  async revokeAssignment(id: string): Promise<void> {
    await this.db
      .update(userRoleTable)
      .set({ status: 'revoked', version: sql`${userRoleTable.version} + 1`, ...updateStamp() })
      .where(and(eq(userRoleTable.id, id), eq(userRoleTable.status, 'active')));
  }

  /**
   * Active users holding an unconditional, tenant-wide, currently valid Owner assignment,
   * optionally ignoring one assignment or one user (to test a pending change).
   */
  async countOwners(
    today: LocalDate,
    exclude: { assignmentId?: string; userId?: string } = {},
  ): Promise<number> {
    const d = today.toString();
    const res = await this.db
      .select({ n: sql<string>`count(DISTINCT ${userRoleTable.userId})` })
      .from(userRoleTable)
      .innerJoin(roleTable, eq(roleTable.id, userRoleTable.roleId))
      .innerJoin(appUserTable, eq(appUserTable.id, userRoleTable.userId))
      .where(
        and(
          eq(roleTable.code, 'owner'),
          eq(roleTable.isSystem, true),
          eq(userRoleTable.status, 'active'),
          sql`${userRoleTable.companyId} IS NULL`,
          sql`${userRoleTable.conditions} = '[]'::jsonb`,
          sql`(${userRoleTable.validFrom} IS NULL OR ${userRoleTable.validFrom} <= ${d}::date)`,
          sql`(${userRoleTable.validTo} IS NULL OR ${userRoleTable.validTo} >= ${d}::date)`,
          eq(appUserTable.status, 'active'),
          exclude.assignmentId ? ne(userRoleTable.id, exclude.assignmentId) : undefined,
          exclude.userId ? ne(userRoleTable.userId, exclude.userId) : undefined,
        ),
      );
    return Number(res[0]?.n ?? 0);
  }

  // ----- field policies ----------------------------------------------------------------

  async fieldPolicies(roleIds: readonly string[]): Promise<FieldPolicyRow[]> {
    if (roleIds.length === 0) return [];
    return this.db
      .select({
        roleId: fieldPolicyTable.roleId,
        entity: fieldPolicyTable.entity,
        field: fieldPolicyTable.field,
        access: fieldPolicyTable.access,
      })
      .from(fieldPolicyTable)
      .where(inArray(fieldPolicyTable.roleId, [...roleIds]))
      .orderBy(asc(fieldPolicyTable.entity), asc(fieldPolicyTable.field));
  }

  async replaceFieldPolicies(
    roleId: string,
    policies: readonly Omit<FieldPolicyRow, 'roleId'>[],
  ): Promise<void> {
    await this.db.delete(fieldPolicyTable).where(eq(fieldPolicyTable.roleId, roleId));
    if (policies.length === 0) return;
    const { tenantId, createdBy } = insertStamp();
    await this.db
      .insert(fieldPolicyTable)
      .values(policies.map((p) => ({ id: newId(), tenantId, roleId, createdBy, ...p })));
  }

  // ----- segregation of duties ------------------------------------------------------------

  async insertSodRule(rule: Omit<SodRuleRecord, 'version'>): Promise<void> {
    await this.db.insert(sodRuleTable).values({ ...rule, ...insertStamp() });
  }

  async listSodRules(activeOnly = false): Promise<SodRuleRecord[]> {
    const rows = await this.db
      .select()
      .from(sodRuleTable)
      .where(activeOnly ? eq(sodRuleTable.status, 'active') : undefined)
      .orderBy(asc(sodRuleTable.code));
    return rows.map(toSodRule);
  }

  async getSodRule(id: string): Promise<SodRuleRecord> {
    const [row] = await this.db.select().from(sodRuleTable).where(eq(sodRuleTable.id, id));
    if (!row) throw new NotFoundError('SodRule', id);
    return toSodRule(row);
  }

  async updateSodRule(rule: SodRuleRecord, expectedVersion: number): Promise<SodRuleRecord> {
    const [row] = await this.db
      .update(sodRuleTable)
      .set({
        severity: rule.severity,
        status: rule.status,
        version: sql`${sodRuleTable.version} + 1`,
        ...updateStamp(),
      })
      .where(and(eq(sodRuleTable.id, rule.id), eq(sodRuleTable.version, expectedVersion)))
      .returning();
    if (!row) throw new ConcurrencyConflictError('SodRule', rule.id, expectedVersion);
    return toSodRule(row);
  }

  // ----- companies (visibility) ---------------------------------------------------------

  async allCompanyIds(): Promise<string[]> {
    const rows = await this.db.select({ id: companyTable.id }).from(companyTable);
    return rows.map((r) => r.id);
  }
}

function toRole(row: typeof roleTable.$inferSelect): RoleRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    isSystem: row.isSystem,
    status: row.status,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toAssignment(row: typeof userRoleTable.$inferSelect, roleCode: string): AssignmentRecord {
  return {
    id: row.id,
    userId: row.userId,
    roleId: row.roleId,
    roleCode,
    companyId: row.companyId,
    plantId: row.plantId,
    // Validated by parseConditions before insert; stored JSON is trusted structurally.
    conditions: row.conditions as Condition[],
    validFrom: row.validFrom ? LocalDate.parse(row.validFrom) : null,
    validTo: row.validTo ? LocalDate.parse(row.validTo) : null,
    status: row.status,
    version: row.version,
    createdAt: row.createdAt,
  };
}

function toSodRule(row: typeof sodRuleTable.$inferSelect): SodRuleRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    permissionA: row.permissionA,
    permissionB: row.permissionB,
    severity: row.severity,
    isSystem: row.isSystem,
    status: row.status,
    version: row.version,
  };
}
