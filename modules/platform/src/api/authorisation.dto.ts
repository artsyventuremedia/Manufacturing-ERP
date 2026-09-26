import { type SodConflict } from '@manuling/authz';
import { type OpenAPIRegistry, z } from '@manuling/http';
import {
  type RoleWithPermissions,
  type SodViolation,
  type UserWithAssignments,
} from '../application/authorisation.service.js';
import {
  type AssignmentRecord,
  type FieldPolicyRow,
  type SodRuleRecord,
} from '../infrastructure/authorisation.repository.js';
import { type AppUserRecord } from '../infrastructure/identity.repository.js';

// ----- requests ------------------------------------------------------------------

const permissionCode = z.string().max(100);
const isoDate = z.iso.date();

export const createRoleBody = z
  .object({
    code: z.string().max(40),
    name: z.string().max(100),
    description: z.string().max(500).optional(),
    permissions: z.array(permissionCode).max(500),
  })
  .strict();

export const updateRoleBody = z
  .object({
    name: z.string().max(100).optional(),
    description: z.string().max(500).nullable().optional(),
    status: z.enum(['active', 'archived']).optional(),
    permissions: z.array(permissionCode).max(500).optional(),
  })
  .strict();

export const cloneRoleBody = z
  .object({ code: z.string().max(40), name: z.string().max(100) })
  .strict();

export const assignmentBody = z
  .object({
    roleId: z.uuid(),
    companyId: z.uuid().nullable().optional(),
    plantId: z.uuid().nullable().optional(),
    conditions: z.array(z.record(z.string(), z.unknown())).max(10).optional(),
    validFrom: isoDate.nullable().optional(),
    validTo: isoDate.nullable().optional(),
  })
  .strict();

export const inviteUserBody = z
  .object({
    email: z.string().max(254),
    displayName: z.string().max(200),
    assignments: z.array(assignmentBody).max(20).default([]),
  })
  .strict();

export const updateUserBody = z
  .object({
    displayName: z.string().max(200).optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .strict();

export const fieldPoliciesBody = z
  .object({
    policies: z
      .array(
        z
          .object({
            entity: z.string().max(80),
            field: z.string().max(80),
            access: z.enum(['hidden', 'read']),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();

export const updateSodRuleBody = z
  .object({
    severity: z.enum(['warn', 'block']).optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .strict();

// ----- responses -------------------------------------------------------------------

const conflictSchema = z.object({
  ruleId: z.uuid(),
  code: z.string(),
  severity: z.enum(['warn', 'block']),
  permissions: z.array(z.string()),
});

export const permissionResponse = z.object({
  code: z.string(),
  module: z.string(),
  entity: z.string(),
  action: z.string(),
  description: z.string(),
});

export const roleResponse = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isSystem: z.boolean(),
  status: z.enum(['active', 'archived']),
  permissions: z.array(z.string()),
  version: z.number().int(),
});

export const assignmentResponse = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  roleId: z.uuid(),
  roleCode: z.string(),
  companyId: z.uuid().nullable(),
  plantId: z.uuid().nullable(),
  conditions: z.array(z.record(z.string(), z.unknown())),
  validFrom: isoDate.nullable(),
  validTo: isoDate.nullable(),
  status: z.enum(['active', 'revoked']),
});

export const userResponse = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  status: z.enum(['invited', 'active', 'disabled']),
  invitationExpiresAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  assignments: z.array(assignmentResponse).optional(),
});

export const fieldPolicyResponse = z.object({
  entity: z.string(),
  field: z.string(),
  access: z.enum(['hidden', 'read']),
});

export const sodRuleResponse = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  permissionA: z.string(),
  permissionB: z.string(),
  severity: z.enum(['warn', 'block']),
  isSystem: z.boolean(),
  status: z.enum(['active', 'disabled']),
  version: z.number().int(),
});

export type RoleResponse = z.infer<typeof roleResponse>;
export type AssignmentResponse = z.infer<typeof assignmentResponse>;
export type UserResponse = z.infer<typeof userResponse>;
export type SodRuleResponse = z.infer<typeof sodRuleResponse>;

export function toRoleResponse(r: RoleWithPermissions): RoleResponse {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    isSystem: r.isSystem,
    status: r.status,
    permissions: [...r.permissions],
    version: r.version,
  };
}

export function toAssignmentResponse(a: AssignmentRecord): AssignmentResponse {
  return {
    id: a.id,
    userId: a.userId,
    roleId: a.roleId,
    roleCode: a.roleCode,
    companyId: a.companyId,
    plantId: a.plantId,
    conditions: a.conditions.map((c) => ({ ...c })),
    validFrom: a.validFrom?.toString() ?? null,
    validTo: a.validTo?.toString() ?? null,
    status: a.status,
  };
}

export function toUserResponse(u: AppUserRecord | UserWithAssignments): UserResponse {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    status: u.status,
    invitationExpiresAt: u.invitationExpiresAt?.toISOString() ?? null,
    version: u.version,
    ...('assignments' in u ? { assignments: u.assignments.map(toAssignmentResponse) } : {}),
  };
}

export function toFieldPolicies(
  rows: readonly FieldPolicyRow[],
): z.infer<typeof fieldPolicyResponse>[] {
  return rows.map(({ entity, field, access }) => ({ entity, field, access }));
}

export function toSodRuleResponse(r: SodRuleRecord): SodRuleResponse {
  return { ...r };
}

export function toConflicts(c: readonly SodConflict[]): z.infer<typeof conflictSchema>[] {
  return c.map((x) => ({
    ruleId: x.ruleId,
    code: x.code,
    severity: x.severity,
    permissions: [...x.permissions],
  }));
}

export function toViolations(v: readonly SodViolation[]) {
  return v.map((x) => ({ userId: x.userId, email: x.email, conflicts: toConflicts(x.conflicts) }));
}

// ----- OpenAPI ---------------------------------------------------------------------

export function registerAuthorisationOpenApi(registry: OpenAPIRegistry): void {
  const problem = {
    'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetails' } },
  };
  const denied = {
    403: {
      description: 'Missing permission, or escalation / SoD / last-owner rule',
      content: problem,
    },
  };
  const json = (schema: z.ZodType) => ({ 'application/json': { schema } });
  const security = [{ bearer: [] }];
  const tags = ['Access control'];
  const id = z.object({ id: z.uuid() });
  const ifMatch = z.object({ 'If-Match': z.string() });
  const Role = registry.register('Role', roleResponse);
  const User = registry.register('User', userResponse);
  const Assignment = registry.register('RoleAssignment', assignmentResponse);
  const SodRule = registry.register('SodRule', sodRuleResponse);
  const Conflict = registry.register('SodConflict', conflictSchema);
  const items = (s: z.ZodType) => json(z.object({ items: z.array(s) }));

  const path = (
    method: 'get' | 'post' | 'patch' | 'put',
    p: string,
    summary: string,
    extra: object,
  ) =>
    registry.registerPath({
      method,
      path: p,
      tags,
      security,
      summary,
      responses: { 200: { description: 'OK' }, ...denied },
      ...extra,
    });

  path('get', '/v1/platform/permissions', 'Permission catalogue', {
    responses: { 200: { description: 'OK', content: items(permissionResponse) }, ...denied },
  });
  path('get', '/v1/platform/roles', 'List roles', {
    responses: { 200: { description: 'OK', content: items(Role) }, ...denied },
  });
  path('post', '/v1/platform/roles', 'Create a custom role', {
    request: { body: { content: json(createRoleBody) } },
    responses: { 201: { description: 'Created', content: json(Role) }, ...denied },
  });
  path('get', '/v1/platform/roles/{id}', 'Get a role', {
    request: { params: id },
    responses: { 200: { description: 'OK', content: json(Role) }, ...denied },
  });
  path('patch', '/v1/platform/roles/{id}', 'Update a custom role', {
    request: { params: id, headers: ifMatch, body: { content: json(updateRoleBody) } },
    responses: { 200: { description: 'OK', content: json(Role) }, ...denied },
  });
  path('post', '/v1/platform/roles/{id}/clone', 'Clone a role into an editable custom role', {
    request: { params: id, body: { content: json(cloneRoleBody) } },
    responses: { 201: { description: 'Created', content: json(Role) }, ...denied },
  });
  path('get', '/v1/platform/roles/{id}/field-policies', 'Field policies of a role', {
    request: { params: id },
    responses: { 200: { description: 'OK', content: items(fieldPolicyResponse) }, ...denied },
  });
  path('put', '/v1/platform/roles/{id}/field-policies', 'Replace field policies of a custom role', {
    request: { params: id, body: { content: json(fieldPoliciesBody) } },
    responses: { 200: { description: 'OK', content: items(fieldPolicyResponse) }, ...denied },
  });
  path('get', '/v1/platform/users', 'List users', {
    responses: {
      200: {
        description: 'OK',
        content: json(z.object({ items: z.array(User), nextCursor: z.string().optional() })),
      },
      ...denied,
    },
  });
  path('post', '/v1/platform/users/invitations', 'Invite a user with initial roles', {
    request: { body: { content: json(inviteUserBody) } },
    responses: {
      201: {
        description: 'Invited',
        content: json(z.object({ user: User, warnings: z.array(Conflict) })),
      },
      ...denied,
    },
  });
  path('get', '/v1/platform/users/{id}', 'Get a user with role assignments', {
    request: { params: id },
    responses: { 200: { description: 'OK', content: json(User) }, ...denied },
  });
  path('patch', '/v1/platform/users/{id}', 'Enable/disable or rename a user', {
    request: { params: id, headers: ifMatch, body: { content: json(updateUserBody) } },
    responses: { 200: { description: 'OK', content: json(User) }, ...denied },
  });
  path('post', '/v1/platform/users/{id}/role-assignments', 'Assign a role', {
    request: { params: id, body: { content: json(assignmentBody) } },
    responses: {
      201: {
        description: 'Assigned (warnings list SoD conflicts that only warn)',
        content: json(z.object({ assignment: Assignment, warnings: z.array(Conflict) })),
      },
      409: { description: 'Blocked by a SoD rule', content: problem },
      ...denied,
    },
  });
  path('post', '/v1/platform/role-assignments/{id}/revoke', 'Revoke a role assignment', {
    request: { params: id },
    responses: { 200: { description: 'Revoked', content: json(Assignment) }, ...denied },
  });
  path('get', '/v1/platform/sod-rules', 'Segregation-of-duties rules', {
    responses: { 200: { description: 'OK', content: items(SodRule) }, ...denied },
  });
  path('patch', '/v1/platform/sod-rules/{id}', 'Change severity or disable a SoD rule', {
    request: { params: id, headers: ifMatch, body: { content: json(updateSodRuleBody) } },
    responses: { 200: { description: 'OK', content: json(SodRule) }, ...denied },
  });
  path('get', '/v1/platform/sod-violations', 'Users currently violating SoD rules', {
    responses: { 200: { description: 'OK' }, ...denied },
  });
}
