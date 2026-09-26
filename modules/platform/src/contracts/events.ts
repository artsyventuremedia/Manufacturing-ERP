import { z } from 'zod';

/**
 * Published language of the Platform context (ADR-0007 §5): event types and the JSON
 * shape of their `data`. Exported as JSON Schema to docs/events/ (CI checks it is current).
 * Within a major version (`.v1`) changes must be additive.
 */
const company = z.object({
  id: z.uuid(),
  code: z.string(),
  legalName: z.string(),
  baseCurrency: z.string(),
  countryCode: z.string(),
  fiscalYearStartMonth: z.number().int(),
  status: z.enum(['active', 'inactive']),
  version: z.number().int(),
});

const plant = z.object({
  id: z.uuid(),
  companyId: z.uuid(),
  code: z.string(),
  name: z.string(),
  regionCode: z.string().nullable(),
  timezone: z.string(),
  status: z.enum(['active', 'inactive']),
  version: z.number().int(),
});

const fiscalYear = z.object({
  id: z.uuid(),
  companyId: z.uuid(),
  code: z.string(),
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  status: z.enum(['open', 'closed']),
});

const user = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  status: z.enum(['invited', 'active', 'disabled']),
});

const role = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  isSystem: z.boolean(),
  status: z.enum(['active', 'archived']),
  permissions: z.array(z.string()),
});

const assignment = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  roleId: z.uuid(),
  roleCode: z.string(),
  companyId: z.uuid().nullable(),
  plantId: z.uuid().nullable(),
  validFrom: z.iso.date().nullable(),
  validTo: z.iso.date().nullable(),
  status: z.enum(['active', 'revoked']),
});

const numberingSeries = z.object({
  id: z.uuid(),
  companyId: z.uuid(),
  code: z.string(),
  docType: z.string(),
  pattern: z.string(),
  gapless: z.boolean(),
  scope: z.enum(['company', 'plant']),
  resetPolicy: z.enum(['fiscal_year', 'never']),
  maxLength: z.number().int().nullable(),
  isDefault: z.boolean(),
  status: z.enum(['active', 'inactive']),
});

const approvalRef = {
  instanceId: z.uuid(),
  entityType: z.string(),
  entityId: z.string(),
  companyId: z.uuid(),
};

const approvalTask = z.object({
  ...approvalRef,
  taskId: z.uuid(),
  stepId: z.string(),
  assigneeId: z.uuid(),
  dueAt: z.iso.datetime().nullable(),
  escalationLevel: z.number().int(),
});

export const PLATFORM_EVENTS = {
  'platform.TenantProvisioned.v1': z.object({
    tenantId: z.uuid(),
    slug: z.string(),
    edition: z.enum(['starter', 'growth', 'enterprise']),
    companyId: z.uuid(),
    plantId: z.uuid(),
    adminUserId: z.uuid(),
  }),
  'platform.CompanyCreated.v1': company,
  'platform.CompanyChanged.v1': company,
  'platform.PlantCreated.v1': plant,
  'platform.PlantChanged.v1': plant,
  'platform.FiscalYearOpened.v1': fiscalYear,
  'platform.UserInvited.v1': user,
  'platform.UserActivated.v1': user,
  'platform.UserChanged.v1': user,
  'platform.RoleCreated.v1': role,
  'platform.RoleChanged.v1': role,
  'platform.RoleFieldPoliciesReplaced.v1': z.object({
    roleId: z.uuid(),
    policies: z.array(
      z.object({ entity: z.string(), field: z.string(), access: z.enum(['hidden', 'read']) }),
    ),
  }),
  'platform.UserRoleAssigned.v1': assignment,
  'platform.UserRoleRevoked.v1': assignment,
  'platform.NumberingSeriesCreated.v1': numberingSeries,
  'platform.NumberingSeriesChanged.v1': numberingSeries,
  'platform.ApprovalSubmitted.v1': z.object({
    ...approvalRef,
    requesterId: z.uuid(),
    workflowVersionId: z.uuid(),
  }),
  'platform.ApprovalTaskAssigned.v1': approvalTask,
  'platform.ApprovalReminderDue.v1': approvalTask,
  'platform.ApprovalEscalated.v1': approvalTask,
  'platform.ApprovalTaskDecided.v1': z.object({
    ...approvalRef,
    taskId: z.uuid(),
    stepId: z.string(),
    decision: z.enum(['approved', 'rejected']),
    decidedBy: z.uuid(),
    onBehalfOf: z.uuid().nullable(),
  }),
  'platform.ApprovalCancelled.v1': z.object({ ...approvalRef, reason: z.string() }),
  'platform.ApprovalCompleted.v1': z.object({
    ...approvalRef,
    outcome: z.enum(['approved', 'rejected', 'cancelled']),
    reason: z.string().nullable(),
  }),
  'platform.WorkflowVersionPublished.v1': z.object({
    definitionId: z.uuid(),
    versionId: z.uuid(),
    companyId: z.uuid(),
    docType: z.string(),
    version: z.number().int(),
  }),
  'platform.SodRuleChanged.v1': z.object({
    id: z.uuid(),
    code: z.string(),
    severity: z.enum(['warn', 'block']),
    status: z.enum(['active', 'disabled']),
  }),
} as const;

export type PlatformEventType = keyof typeof PLATFORM_EVENTS;
export type PlatformEventData<T extends PlatformEventType> = z.infer<(typeof PLATFORM_EVENTS)[T]>;
