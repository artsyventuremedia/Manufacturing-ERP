import {
  AccessControl,
  type SodConflict,
  findSodConflicts,
  isActive,
  permissionRegistry,
  type RegisteredPermission,
} from '@manuling/authz';
import { UnitOfWork } from '@manuling/db';
import {
  ConflictError,
  ForbiddenError,
  LocalDate,
  NotFoundError,
  RequestContexts,
  ValidationError,
} from '@manuling/kernel';
import { Injectable } from '@nestjs/common';
import { AccessLoader } from '../authorisation/access-loader.js';
import { PLATFORM_PERMISSIONS as P } from '../authorisation/permissions.js';
import { OWNER_ROLE_CODE } from '../authorisation/role-templates.js';
import { type UserChanges, changeUser, inviteUser } from '../domain/app-user.js';
import {
  type Role,
  assertEditable,
  assertOwnerRemains,
  changeRole,
  createAssignment,
  createCustomRole,
  parsePermissions,
} from '../domain/role.js';
import {
  type AssignmentRecord,
  AuthorisationRepository,
  type FieldPolicyRow,
  type RoleRecord,
  type SodRuleRecord,
} from '../infrastructure/authorisation.repository.js';
import { type AppUserRecord, IdentityRepository } from '../infrastructure/identity.repository.js';
import { ChangeLog } from './change-log.js';
import { assignmentSnapshot, roleSnapshot, userSnapshot } from './snapshots.js';

export type RoleWithPermissions = RoleRecord & { readonly permissions: readonly string[] };
export type UserWithAssignments = AppUserRecord & {
  readonly assignments: readonly AssignmentRecord[];
};

export interface AssignmentInput {
  readonly roleId: string;
  readonly companyId?: string | null | undefined;
  readonly plantId?: string | null | undefined;
  readonly conditions?: unknown;
  readonly validFrom?: string | null | undefined;
  readonly validTo?: string | null | undefined;
}

export interface SodViolation {
  readonly userId: string;
  readonly email: string;
  readonly conflicts: readonly SodConflict[];
}

const FIELD_ENTITY = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9]*$/;

/**
 * Roles, users, assignments, field policies and SoD (step 0.5).
 * Anti-escalation: nobody can create or assign a role with permissions they do not hold
 * themselves in the target scope. Every change is audited and published as a platform.* event.
 */
@Injectable()
export class AuthorisationService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repo: AuthorisationRepository,
    private readonly identity: IdentityRepository,
    private readonly accessLoader: AccessLoader,
    private readonly changes: ChangeLog,
  ) {}

  listPermissions(): RegisteredPermission[] {
    return permissionRegistry.all();
  }

  // ----- roles ---------------------------------------------------------------------

  listRoles(): Promise<RoleWithPermissions[]> {
    return this.uow.run(
      async () => {
        const roles = await this.repo.listRoles();
        const perms = await this.accessLoader.permissionsFor(roles);
        return roles.map((r) => withPermissions(r, perms.get(r.id)));
      },
      { readOnly: true },
    );
  }

  getRole(id: string): Promise<RoleWithPermissions> {
    return this.uow.run(() => this.roleWithPermissions(id), { readOnly: true });
  }

  createRole(input: {
    code: string;
    name: string;
    description?: string | undefined;
    permissions: readonly string[];
  }): Promise<RoleWithPermissions> {
    AccessControl.assert(P.roleManage);
    const role = createCustomRole(input);
    const permissions = parsePermissions(input.permissions, (c) => permissionRegistry.has(c));
    assertHoldsAll(permissions, {});
    return this.uow.run(async () => {
      const saved = await this.repo.insertRole(role);
      await this.repo.replacePermissions(saved.id, permissions);
      await this.recordRole('create', undefined, saved, permissions);
      return withPermissions(saved, new Set(permissions));
    });
  }

  updateRole(
    id: string,
    expectedVersion: number,
    changes: {
      name?: string | undefined;
      description?: string | null | undefined;
      status?: 'active' | 'archived' | undefined;
      permissions?: readonly string[] | undefined;
    },
  ): Promise<RoleWithPermissions> {
    AccessControl.assert(P.roleManage);
    return this.uow.run(async () => {
      const before = await this.roleWithPermissions(id);
      const saved = await this.repo.updateRole(changeRole(before, changes), expectedVersion);
      if (changes.permissions !== undefined) {
        const permissions = parsePermissions(changes.permissions, (c) => permissionRegistry.has(c));
        assertHoldsAll(permissions, {});
        await this.repo.replacePermissions(id, permissions);
      }
      const after = await this.roleWithPermissions(saved.id);
      await this.recordRole('update', before, after, after.permissions);
      return after;
    });
  }

  /** Copies a role (typically a built-in one) into an editable custom role. */
  cloneRole(id: string, input: { code: string; name: string }): Promise<RoleWithPermissions> {
    AccessControl.assert(P.roleManage);
    return this.uow.run(async () => {
      const source = await this.roleWithPermissions(id);
      assertHoldsAll(source.permissions, {});
      const role = createCustomRole({ ...input, description: `Copy of ${source.name}` });
      const saved = await this.repo.insertRole(role);
      await this.repo.replacePermissions(saved.id, source.permissions);
      const policies = await this.repo.fieldPolicies([id]);
      await this.repo.replaceFieldPolicies(
        saved.id,
        policies.map(({ entity, field, access }) => ({ entity, field, access })),
      );
      await this.recordRole('clone', undefined, saved, source.permissions, id);
      return withPermissions(saved, new Set(source.permissions));
    });
  }

  getFieldPolicies(roleId: string): Promise<FieldPolicyRow[]> {
    return this.uow.run(
      async () => {
        await this.repo.getRole(roleId);
        return this.repo.fieldPolicies([roleId]);
      },
      { readOnly: true },
    );
  }

  replaceFieldPolicies(
    roleId: string,
    policies: readonly Omit<FieldPolicyRow, 'roleId'>[],
  ): Promise<FieldPolicyRow[]> {
    AccessControl.assert(P.roleManage);
    for (const [i, p] of policies.entries()) {
      if (!FIELD_ENTITY.test(p.entity) || !FIELD_NAME.test(p.field)) {
        throw new ValidationError(
          'platform.field_policy.invalid',
          'Invalid entity or field name',
          {},
          [
            {
              path: `policies.${i}`,
              code: 'platform.field_policy.invalid',
              message: 'Use entity "module.entity" and a camelCase field',
            },
          ],
        );
      }
    }
    const unique = new Map(policies.map((p) => [`${p.entity}.${p.field}`, p]));
    return this.uow.run(async () => {
      assertEditable(await this.repo.getRole(roleId));
      const before = await this.repo.fieldPolicies([roleId]);
      await this.repo.replaceFieldPolicies(roleId, [...unique.values()]);
      const after = await this.repo.fieldPolicies([roleId]);
      const plain = (rows: FieldPolicyRow[]) =>
        rows.map(({ entity, field, access }) => ({ entity, field, access }));
      await this.changes.record({
        entityType: 'platform.role_field_policy',
        entityId: roleId,
        action: 'replace',
        before: { policies: plain(before) },
        after: { policies: plain(after) },
        event: {
          type: 'platform.RoleFieldPoliciesReplaced.v1',
          aggregateType: 'Role',
          data: { roleId, policies: plain(after) },
        },
      });
      return after;
    });
  }

  // ----- users -------------------------------------------------------------------------

  listUsers(limit: number, after?: readonly [string, string]): Promise<AppUserRecord[]> {
    return this.uow.run(() => this.identity.listUsers(limit, after), { readOnly: true });
  }

  getUser(id: string): Promise<UserWithAssignments> {
    return this.uow.run(
      async () => {
        const user = await this.identity.getUser(id);
        return { ...user, assignments: await this.repo.assignmentsForUser(id, true) };
      },
      { readOnly: true },
    );
  }

  /** Invites a user (plan D1) with initial role assignments, all in one transaction. */
  inviteUser(
    input: { email: string; displayName: string; assignments: readonly AssignmentInput[] },
    now: Date = new Date(),
  ): Promise<{ user: UserWithAssignments; warnings: SodConflict[] }> {
    AccessControl.assert(P.userInvite);
    const invited = inviteUser(input, now);
    return this.uow.run(async () => {
      const user = await this.identity.insertUser(invited);
      const snapshot = userSnapshot(user);
      await this.changes.record({
        entityType: 'platform.user',
        entityId: user.id,
        action: 'invite',
        after: snapshot,
        event: { type: 'platform.UserInvited.v1', aggregateType: 'User', data: snapshot },
      });
      const warnings: SodConflict[] = [];
      for (const a of input.assignments) warnings.push(...(await this.assign(user.id, a)).warnings);
      return {
        user: { ...user, assignments: await this.repo.assignmentsForUser(user.id, true) },
        warnings,
      };
    });
  }

  updateUser(id: string, expectedVersion: number, changes: UserChanges): Promise<AppUserRecord> {
    AccessControl.assert(P.userUpdate);
    const { actor, timezone } = RequestContexts.requireTenant();
    return this.uow.run(async () => {
      const current = await this.identity.getUser(id);
      const next = changeUser(current, changes, actor.id);
      if (current.status === 'active' && next.status === 'disabled') {
        assertOwnerRemains(await this.repo.countOwners(today(timezone), { userId: id }));
      }
      const saved = await this.identity.updateUser(next, expectedVersion);
      const after = userSnapshot(saved);
      await this.changes.record({
        entityType: 'platform.user',
        entityId: id,
        action: 'update',
        before: userSnapshot(current),
        after,
        event: { type: 'platform.UserChanged.v1', aggregateType: 'User', data: after },
      });
      return saved;
    });
  }

  // ----- assignments ----------------------------------------------------------------------

  assignRole(
    userId: string,
    input: AssignmentInput,
  ): Promise<{ assignment: AssignmentRecord; warnings: SodConflict[] }> {
    return this.uow.run(async () => {
      await this.identity.getUser(userId);
      return this.assign(userId, input);
    });
  }

  revokeAssignment(id: string): Promise<AssignmentRecord> {
    const { timezone } = RequestContexts.requireTenant();
    return this.uow.run(async () => {
      const assignment = await this.repo.findAssignment(id);
      if (!assignment || assignment.status !== 'active')
        throw new NotFoundError('RoleAssignment', id);
      AccessControl.assert(P.roleAssign, scopeOf(assignment));
      if (assignment.roleCode === OWNER_ROLE_CODE) {
        assertOwnerRemains(await this.repo.countOwners(today(timezone), { assignmentId: id }));
      }
      await this.repo.revokeAssignment(id);
      const revoked = (await this.repo.findAssignment(id))!;
      const { conditions: _c, ...data } = assignmentSnapshot(revoked);
      await this.changes.record({
        entityType: 'platform.user_role',
        entityId: id,
        action: 'revoke',
        before: assignmentSnapshot(assignment),
        after: assignmentSnapshot(revoked),
        event: { type: 'platform.UserRoleRevoked.v1', aggregateType: 'UserRole', data },
      });
      return revoked;
    });
  }

  // ----- segregation of duties ----------------------------------------------------------------

  listSodRules(): Promise<SodRuleRecord[]> {
    return this.uow.run(() => this.repo.listSodRules(), { readOnly: true });
  }

  updateSodRule(
    id: string,
    expectedVersion: number,
    changes: {
      severity?: 'warn' | 'block' | undefined;
      status?: 'active' | 'disabled' | undefined;
    },
  ): Promise<SodRuleRecord> {
    AccessControl.assert(P.sodManage);
    return this.uow.run(async () => {
      const rule = await this.repo.getSodRule(id);
      const saved = await this.repo.updateSodRule(
        {
          ...rule,
          severity: changes.severity ?? rule.severity,
          status: changes.status ?? rule.status,
        },
        expectedVersion,
      );
      const snap = (r: SodRuleRecord) => ({
        id: r.id,
        code: r.code,
        severity: r.severity,
        status: r.status,
      });
      await this.changes.record({
        entityType: 'platform.sod_rule',
        entityId: id,
        action: 'update',
        before: snap(rule),
        after: snap(saved),
        event: { type: 'platform.SodRuleChanged.v1', aggregateType: 'SodRule', data: snap(saved) },
      });
      return saved;
    });
  }

  /** Active users whose combined, currently valid permissions violate an active rule. */
  sodViolations(): Promise<SodViolation[]> {
    const { timezone } = RequestContexts.requireTenant();
    return this.uow.run(
      async () => {
        const rules = await this.repo.listSodRules(true);
        const violations: SodViolation[] = [];
        for (const user of await this.identity.listActiveUsers()) {
          const perms = await this.userPermissions(user.id, today(timezone));
          const conflicts = findSodConflicts(perms, rules);
          if (conflicts.length > 0)
            violations.push({ userId: user.id, email: user.email, conflicts });
        }
        return violations;
      },
      { readOnly: true },
    );
  }

  // ----- internals ---------------------------------------------------------------------------

  private async assign(
    userId: string,
    input: AssignmentInput,
  ): Promise<{ assignment: AssignmentRecord; warnings: SodConflict[] }> {
    const { timezone } = RequestContexts.requireTenant();
    const assignment = createAssignment({ userId, ...input });
    const scope = scopeOf(assignment);
    AccessControl.assert(P.roleAssign, scope);

    const role = await this.repo.findRole(assignment.roleId);
    if (!role || role.status !== 'active') throw new NotFoundError('Role', assignment.roleId);
    const rolePerms =
      (await this.accessLoader.permissionsFor([role])).get(role.id) ?? new Set<string>();
    assertHoldsAll([...rolePerms], scope);

    const combined = new Set([
      ...(await this.userPermissions(userId, today(timezone))),
      ...rolePerms,
    ]);
    const conflicts = findSodConflicts(combined, await this.repo.listSodRules(true));
    const blocking = conflicts.filter((c) => c.severity === 'block');
    if (blocking.length > 0) {
      throw new ConflictError(
        'authz.sod_conflict',
        'This assignment would combine conflicting duties',
        { conflicts: blocking },
      );
    }
    await this.repo.insertAssignment(assignment);
    const saved = (await this.repo.findAssignment(assignment.id))!;
    const snapshot = assignmentSnapshot(saved);
    const { conditions: _c, ...data } = snapshot;
    await this.changes.record({
      entityType: 'platform.user_role',
      entityId: saved.id,
      action: 'assign',
      after: { ...snapshot, sodWarnings: conflicts.map((c) => c.code) },
      event: { type: 'platform.UserRoleAssigned.v1', aggregateType: 'UserRole', data },
    });
    return { assignment: saved, warnings: conflicts };
  }

  private async recordRole(
    action: 'create' | 'update' | 'clone',
    before: RoleWithPermissions | undefined,
    after: Role,
    permissions: Iterable<string>,
    clonedFrom?: string,
  ): Promise<void> {
    const snapshot = roleSnapshot(after, permissions);
    await this.changes.record({
      entityType: 'platform.role',
      entityId: after.id,
      action,
      before: before ? roleSnapshot(before, before.permissions) : undefined,
      after: clonedFrom ? { ...snapshot, clonedFrom } : snapshot,
      event: {
        type: action === 'update' ? 'platform.RoleChanged.v1' : 'platform.RoleCreated.v1',
        aggregateType: 'Role',
        data: snapshot,
      },
    });
  }

  private async userPermissions(userId: string, day: LocalDate): Promise<Set<string>> {
    const assignments = (await this.repo.assignmentsForUser(userId)).filter((a) =>
      isActive(a, day),
    );
    const roles: Role[] = [];
    for (const id of new Set(assignments.map((a) => a.roleId))) {
      const role = await this.repo.findRole(id);
      if (role) roles.push(role);
    }
    const byRole = await this.accessLoader.permissionsFor(roles);
    return new Set(roles.flatMap((r) => [...(byRole.get(r.id) ?? [])]));
  }

  private async roleWithPermissions(id: string): Promise<RoleWithPermissions> {
    const role = await this.repo.getRole(id);
    return withPermissions(role, (await this.accessLoader.permissionsFor([role])).get(role.id));
  }
}

function withPermissions(
  role: RoleRecord,
  permissions: ReadonlySet<string> | undefined,
): RoleWithPermissions {
  return { ...role, permissions: [...(permissions ?? [])].sort() };
}

function scopeOf(a: { companyId: string | null; plantId: string | null }): {
  companyId?: string;
  plantId?: string;
} {
  return {
    ...(a.companyId ? { companyId: a.companyId } : {}),
    ...(a.plantId ? { plantId: a.plantId } : {}),
  };
}

/** Anti-escalation: the caller must already hold every permission in the target scope. */
function assertHoldsAll(
  permissions: Iterable<string>,
  scope: { companyId?: string; plantId?: string },
): void {
  const missing = [...permissions].filter((p) => !AccessControl.can(p, scope));
  if (missing.length > 0) {
    throw new ForbiddenError(
      'authz.escalation_denied',
      'You cannot grant permissions you do not hold yourself',
      { missing },
    );
  }
}

function today(timezone: string): LocalDate {
  return LocalDate.fromInstant(new Date(), timezone);
}
