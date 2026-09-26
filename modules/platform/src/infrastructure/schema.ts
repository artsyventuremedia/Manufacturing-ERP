import {
  bigint,
  boolean,
  char,
  date,
  integer,
  jsonb,
  pgSchema,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/** Drizzle definitions mirroring migrations/0001_tenancy_identity.sql (the SQL is authoritative). */
const platform = pgSchema('platform');

const audit = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
  version: integer('version').notNull().default(1),
  source: text('source').notNull(),
};

export const tenantTable = platform.table('tenant', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  edition: text('edition').$type<'starter' | 'growth' | 'enterprise'>().notNull(),
  status: text('status').$type<'active' | 'suspended'>().notNull(),
  dataRegion: text('data_region').notNull(),
  defaultLocale: text('default_locale').notNull(),
  defaultTimezone: text('default_timezone').notNull(),
  ...audit,
});

export const tenantDirectoryTable = platform.table('tenant_directory', {
  slug: text('slug').primaryKey(),
  id: uuid('id').notNull(),
  status: text('status').$type<'active' | 'suspended'>().notNull(),
});

export const companyTable = platform.table('company', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  code: text('code').notNull(),
  legalName: text('legal_name').notNull(),
  baseCurrency: char('base_currency', { length: 3 }).notNull(),
  countryCode: char('country_code', { length: 2 }).notNull(),
  fiscalYearStartMonth: smallint('fiscal_year_start_month').notNull(),
  status: text('status').$type<'active' | 'inactive'>().notNull(),
  ext: jsonb('ext').$type<Record<string, unknown>>().notNull().default({}),
  ...audit,
});

export const plantTable = platform.table('plant', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  regionCode: text('region_code'),
  timezone: text('timezone').notNull(),
  status: text('status').$type<'active' | 'inactive'>().notNull(),
  ext: jsonb('ext').$type<Record<string, unknown>>().notNull().default({}),
  ...audit,
});

export const fiscalYearTable = platform.table('fiscal_year', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  code: text('code').notNull(),
  startDate: date('start_date', { mode: 'string' }).notNull(),
  endDate: date('end_date', { mode: 'string' }).notNull(),
  status: text('status').$type<'open' | 'closed'>().notNull(),
  ...audit,
});

export const appUserTable = platform.table('app_user', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  idpSubject: text('idp_subject'),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  locale: text('locale'),
  timezone: text('timezone'),
  userType: text('user_type').$type<'internal' | 'portal' | 'agent'>().notNull(),
  status: text('status').$type<'invited' | 'active' | 'disabled'>().notNull(),
  invitationExpiresAt: timestamp('invitation_expires_at', { withTimezone: true }),
  ...audit,
});

export const roleTable = platform.table('role', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  isSystem: boolean('is_system').notNull(),
  status: text('status').$type<'active' | 'archived'>().notNull(),
  ...audit,
});

export const rolePermissionTable = platform.table('role_permission', {
  tenantId: uuid('tenant_id').notNull(),
  roleId: uuid('role_id').notNull(),
  permission: text('permission').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
});

export const userRoleTable = platform.table('user_role', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  roleId: uuid('role_id').notNull(),
  companyId: uuid('company_id'),
  plantId: uuid('plant_id'),
  conditions: jsonb('conditions').$type<unknown[]>().notNull(),
  validFrom: date('valid_from', { mode: 'string' }),
  validTo: date('valid_to', { mode: 'string' }),
  status: text('status').$type<'active' | 'revoked'>().notNull(),
  ...audit,
});

export const fieldPolicyTable = platform.table('field_policy', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  roleId: uuid('role_id').notNull(),
  entity: text('entity').notNull(),
  field: text('field').notNull(),
  access: text('access').$type<'hidden' | 'read'>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
});

export const sodRuleTable = platform.table('sod_rule', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  permissionA: text('permission_a').notNull(),
  permissionB: text('permission_b').notNull(),
  severity: text('severity').$type<'warn' | 'block'>().notNull(),
  isSystem: boolean('is_system').notNull(),
  status: text('status').$type<'active' | 'disabled'>().notNull(),
  ...audit,
});

export const idempotencyKeyTable = platform.table('idempotency_key', {
  tenantId: uuid('tenant_id').notNull(),
  key: text('key').notNull(),
  requestHash: text('request_hash').notNull(),
  method: text('method').notNull(),
  path: text('path').notNull(),
  status: text('status').$type<'in_progress' | 'completed'>().notNull(),
  responseStatus: integer('response_status'),
  responseHeaders: jsonb('response_headers').$type<Record<string, string>>(),
  responseBody: jsonb('response_body'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const numberingSeriesTable = platform.table('numbering_series', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  code: text('code').notNull(),
  docType: text('doc_type').notNull(),
  pattern: text('pattern').notNull(),
  gapless: boolean('gapless').notNull(),
  scope: text('scope').$type<'company' | 'plant'>().notNull(),
  resetPolicy: text('reset_policy').$type<'fiscal_year' | 'never'>().notNull(),
  startValue: bigint('start_value', { mode: 'number' }).notNull(),
  maxLength: integer('max_length'),
  isDefault: boolean('is_default').notNull(),
  status: text('status').$type<'active' | 'inactive'>().notNull(),
  ...audit,
});
