import { integer, jsonb, numeric, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** NUMERIC(20,6); Drizzle returns these as strings, feed them to Money/Quantity (ADR-0008). */
export const moneyColumn = (name: string) => numeric(name, { precision: 20, scale: 6 });
export const quantityColumn = (name: string) => numeric(name, { precision: 20, scale: 6 });
/** NUMERIC(24,9) for unit prices and rates; NUMERIC(18,9) for FX rates. */
export const rateColumn = (name: string) => numeric(name, { precision: 24, scale: 9 });
export const fxRateColumn = (name: string) => numeric(name, { precision: 18, scale: 9 });

/**
 * Standard columns for every tenant-owned table (docs/architecture/03-erd-phase0-1.md §0).
 * The migration must also call `platform.enable_tenant_rls('<schema>.<table>')` and declare
 * `UNIQUE (tenant_id, id)` so other tables can use composite foreign keys.
 */
export function tenantScopedColumns() {
  return {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by'),
    version: integer('version').notNull().default(1),
    source: text('source').notNull(),
    ext: jsonb('ext').$type<Record<string, unknown>>().notNull().default({}),
  };
}
