import { type RegisteredPermission } from '@manuling/authz';
import { PLATFORM_PERMISSIONS as P } from './permissions.js';

/**
 * Built-in roles seeded into every workspace (plan decision D2). Their permissions are
 * computed from the live permission registry, so they pick up new modules automatically.
 * They are read-only for tenants; clone one to customise it.
 */
export interface SystemRoleTemplate {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly includes: (permission: RegisteredPermission) => boolean;
}

const ORG_READ = new Set<string>([P.companyRead, P.plantRead, P.fiscalYearRead]);
/** Viewer reads everything except the audit trail, whose before/after values bypass field policies. */
const readOnly = (p: RegisteredPermission) => p.action === 'read' && p.code !== P.auditRead;
const moduleRole =
  (...modules: string[]) =>
  (p: RegisteredPermission) =>
    ORG_READ.has(p.code) || modules.includes(p.module);

export const SYSTEM_ROLES: readonly SystemRoleTemplate[] = [
  {
    code: 'owner',
    name: 'Owner',
    description: 'Full access including subscription and billing',
    includes: () => true,
  },
  {
    code: 'administrator',
    name: 'Administrator',
    description: 'Full access except subscription and billing',
    includes: (p) => p.code !== P.subscriptionManage,
  },
  {
    code: 'finance',
    name: 'Finance',
    description: 'Accounting, tax, banking',
    includes: moduleRole('finance', 'loc_in'),
  },
  {
    code: 'sales',
    name: 'Sales',
    description: 'Quotations, orders, invoicing',
    includes: moduleRole('sales'),
  },
  {
    code: 'purchase',
    name: 'Purchase',
    description: 'Requisitions, RFQs, purchase orders',
    includes: moduleRole('procurement'),
  },
  {
    code: 'stores',
    name: 'Stores',
    description: 'Receipts, issues, transfers, counts',
    includes: moduleRole('inventory'),
  },
  {
    code: 'production',
    name: 'Production',
    description: 'BOMs, routings, work orders',
    includes: moduleRole('engineering', 'production'),
  },
  {
    code: 'quality',
    name: 'Quality',
    description: 'Inspections, NCRs, CAPA',
    includes: moduleRole('quality'),
  },
  {
    code: 'viewer',
    name: 'Viewer',
    description: 'Read-only access to everything',
    includes: readOnly,
  },
];

export const OWNER_ROLE_CODE = 'owner';

export function systemRoleTemplate(code: string): SystemRoleTemplate | undefined {
  return SYSTEM_ROLES.find((r) => r.code === code);
}

export function templatePermissions(
  template: SystemRoleTemplate,
  all: readonly RegisteredPermission[],
): Set<string> {
  return new Set(all.filter((p) => template.includes(p)).map((p) => p.code));
}

/** Seeded segregation-of-duties rules (plan decision D3). Codes refer to Phase 1 permissions. */
export const SYSTEM_SOD_RULES = [
  {
    code: 'supplier_create_vs_payment_approve',
    name: 'Create supplier vs approve payment',
    a: 'procurement.supplier.create',
    b: 'finance.payment.approve',
  },
  {
    code: 'po_create_vs_po_approve',
    name: 'Create purchase order vs approve it',
    a: 'procurement.purchase_order.create',
    b: 'procurement.purchase_order.approve',
  },
  {
    code: 'journal_post_vs_journal_approve',
    name: 'Post journal vs approve it',
    a: 'finance.journal.post',
    b: 'finance.journal.approve',
  },
] as const;

/** Enterprise blocks conflicts; Starter/Growth warn (plan decision D3). */
export function defaultSodSeverity(edition: string): 'warn' | 'block' {
  return edition === 'enterprise' ? 'block' : 'warn';
}
