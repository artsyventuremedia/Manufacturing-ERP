import {
  type AccessSnapshot,
  type Grant,
  isActive,
  mergeFieldPolicies,
  permissionRegistry,
  visibleCompanies,
} from '@manuling/authz';
import { LocalDate } from '@manuling/kernel';
import { Injectable } from '@nestjs/common';
import { type Role } from '../domain/role.js';
import { AuthorisationRepository } from '../infrastructure/authorisation.repository.js';
import { systemRoleTemplate, templatePermissions } from './role-templates.js';

/**
 * Builds a user's AccessSnapshot: active assignments → grants (system-role permissions
 * from templates, custom-role permissions from storage), merged field policies, and the
 * set of visible companies. Must run inside a tenant-scoped UnitOfWork.
 */
@Injectable()
export class AccessLoader {
  constructor(private readonly repo: AuthorisationRepository) {}

  async load(
    userId: string,
    timezone: string,
    now: Date = new Date(),
  ): Promise<{ access: AccessSnapshot; companyIds: string[] }> {
    const today = LocalDate.fromInstant(now, timezone);
    const assignments = await this.repo.assignmentsForUser(userId);
    const roleIds = [...new Set(assignments.map((a) => a.roleId))];
    const roles = new Map<string, Role>();
    for (const id of roleIds) {
      const role = await this.repo.findRole(id);
      if (role) roles.set(id, role);
    }
    const permissionsByRole = await this.permissionsFor([...roles.values()]);

    const grants: Grant[] = assignments.map((a) => ({
      roleId: a.roleId,
      permissions: permissionsByRole.get(a.roleId) ?? new Set<string>(),
      companyId: a.companyId,
      plantId: a.plantId,
      conditions: a.conditions,
      validFrom: a.validFrom,
      validTo: a.validTo,
    }));

    const activeRoleIds = [
      ...new Set(grants.filter((g) => isActive(g, today)).map((g) => g.roleId)),
    ];
    const fieldAccess = mergeFieldPolicies(
      activeRoleIds,
      await this.repo.fieldPolicies(activeRoleIds),
    );
    const access: AccessSnapshot = { userId, today, grants, fieldAccess };

    const visible = visibleCompanies(access);
    const companyIds = visible === 'all' ? await this.repo.allCompanyIds() : visible;
    return { access, companyIds };
  }

  /** Effective permissions of roles: templates for system roles, stored rows for custom ones. */
  async permissionsFor(roles: readonly Role[]): Promise<Map<string, Set<string>>> {
    const all = permissionRegistry.all();
    const stored = await this.repo.storedPermissions(
      roles.filter((r) => !r.isSystem).map((r) => r.id),
    );
    const result = new Map<string, Set<string>>();
    for (const role of roles) {
      if (role.isSystem) {
        const template = systemRoleTemplate(role.code);
        result.set(role.id, template ? templatePermissions(template, all) : new Set());
      } else {
        result.set(role.id, stored.get(role.id) ?? new Set());
      }
    }
    return result;
  }
}
