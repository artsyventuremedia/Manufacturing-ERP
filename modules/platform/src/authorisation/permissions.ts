import { type PermissionDefinition, permissionRegistry } from '@manuling/authz';

const core = 'core';

/** Permissions owned by the Platform context. */
export const PLATFORM_PERMISSIONS = {
  companyRead: 'platform.company.read',
  companyCreate: 'platform.company.create',
  companyUpdate: 'platform.company.update',
  plantRead: 'platform.plant.read',
  plantCreate: 'platform.plant.create',
  plantUpdate: 'platform.plant.update',
  fiscalYearRead: 'platform.fiscal_year.read',
  fiscalYearCreate: 'platform.fiscal_year.create',
  userRead: 'platform.user.read',
  userInvite: 'platform.user.invite',
  userUpdate: 'platform.user.update',
  roleRead: 'platform.role.read',
  roleManage: 'platform.role.manage',
  roleAssign: 'platform.role.assign',
  sodRead: 'platform.sod_rule.read',
  sodManage: 'platform.sod_rule.manage',
  subscriptionManage: 'platform.subscription.manage',
  auditRead: 'platform.audit.read',
  numberingRead: 'platform.numbering.read',
  numberingManage: 'platform.numbering.manage',
  auditManage: 'platform.audit.manage',
} as const;

const definitions: PermissionDefinition[] = [
  {
    code: PLATFORM_PERMISSIONS.numberingRead,
    description: 'View document numbering series',
    featureKey: core,
  },
  {
    code: PLATFORM_PERMISSIONS.numberingManage,
    description: 'Create and change document numbering series',
    featureKey: core,
  },
  { code: PLATFORM_PERMISSIONS.companyRead, description: 'View companies', featureKey: core },
  { code: PLATFORM_PERMISSIONS.companyCreate, description: 'Create companies', featureKey: core },
  { code: PLATFORM_PERMISSIONS.companyUpdate, description: 'Edit companies', featureKey: core },
  { code: PLATFORM_PERMISSIONS.plantRead, description: 'View plants', featureKey: core },
  { code: PLATFORM_PERMISSIONS.plantCreate, description: 'Create plants', featureKey: core },
  { code: PLATFORM_PERMISSIONS.plantUpdate, description: 'Edit plants', featureKey: core },
  { code: PLATFORM_PERMISSIONS.fiscalYearRead, description: 'View fiscal years', featureKey: core },
  {
    code: PLATFORM_PERMISSIONS.fiscalYearCreate,
    description: 'Open fiscal years',
    featureKey: core,
  },
  { code: PLATFORM_PERMISSIONS.userRead, description: 'View users', featureKey: core },
  { code: PLATFORM_PERMISSIONS.userInvite, description: 'Invite users', featureKey: core },
  {
    code: PLATFORM_PERMISSIONS.userUpdate,
    description: 'Enable, disable and edit users',
    featureKey: core,
  },
  {
    code: PLATFORM_PERMISSIONS.roleRead,
    description: 'View roles, permissions and field policies',
    featureKey: core,
  },
  {
    code: PLATFORM_PERMISSIONS.roleManage,
    description: 'Create and edit custom roles and field policies',
    featureKey: core,
  },
  {
    code: PLATFORM_PERMISSIONS.roleAssign,
    description: 'Assign and revoke roles',
    featureKey: core,
  },
  {
    code: PLATFORM_PERMISSIONS.sodRead,
    description: 'View segregation-of-duties rules and violations',
    featureKey: core,
  },
  {
    code: PLATFORM_PERMISSIONS.sodManage,
    description: 'Change segregation-of-duties rules',
    featureKey: core,
  },
  {
    code: PLATFORM_PERMISSIONS.subscriptionManage,
    description: 'Manage subscription, billing and licences',
    featureKey: core,
  },
  {
    code: PLATFORM_PERMISSIONS.auditRead,
    description: 'View the audit trail and verify its hash chain',
    featureKey: core,
  },
  {
    code: PLATFORM_PERMISSIONS.auditManage,
    description: 'Enable tamper-evident hash chaining of the audit trail',
    featureKey: core,
  },
];

permissionRegistry.register(definitions);
