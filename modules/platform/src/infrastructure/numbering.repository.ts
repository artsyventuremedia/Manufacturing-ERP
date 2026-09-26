import { UnitOfWork } from '@manuling/db';
import { ConcurrencyConflictError, NotFoundError } from '@manuling/kernel';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { type NumberingSeries } from '../domain/numbering.js';
import { numberingSeriesTable } from './schema.js';
import { insertStamp, updateStamp } from './stamp.js';

/** Stands in for "not applicable" counter keys (company scope, no reset). */
export const NIL_KEY = '00000000-0000-0000-0000-000000000000';

@Injectable()
export class NumberingRepository {
  constructor(private readonly uow: UnitOfWork) {}

  private get db() {
    return this.uow.current().db;
  }

  async insertSeries(series: NumberingSeries): Promise<NumberingSeries> {
    const [row] = await this.db
      .insert(numberingSeriesTable)
      .values({ ...series, ...insertStamp() })
      .returning();
    return toSeries(row!);
  }

  async findSeries(id: string): Promise<NumberingSeries | undefined> {
    const [row] = await this.db
      .select()
      .from(numberingSeriesTable)
      .where(eq(numberingSeriesTable.id, id));
    return row ? toSeries(row) : undefined;
  }

  async getSeries(id: string): Promise<NumberingSeries> {
    const series = await this.findSeries(id);
    if (!series) throw new NotFoundError('NumberingSeries', id);
    return series;
  }

  async listSeries(companyId: string): Promise<NumberingSeries[]> {
    const rows = await this.db
      .select()
      .from(numberingSeriesTable)
      .where(eq(numberingSeriesTable.companyId, companyId))
      .orderBy(asc(numberingSeriesTable.docType), asc(numberingSeriesTable.code));
    return rows.map(toSeries);
  }

  /** The active series for a document: by code if given, else the default for the type. */
  async resolveSeries(
    companyId: string,
    docType: string,
    code?: string,
  ): Promise<NumberingSeries | undefined> {
    const [row] = await this.db
      .select()
      .from(numberingSeriesTable)
      .where(
        and(
          eq(numberingSeriesTable.companyId, companyId),
          eq(numberingSeriesTable.docType, docType),
          eq(numberingSeriesTable.status, 'active'),
          code ? eq(numberingSeriesTable.code, code) : eq(numberingSeriesTable.isDefault, true),
        ),
      );
    return row ? toSeries(row) : undefined;
  }

  async updateSeries(series: NumberingSeries, expectedVersion: number): Promise<NumberingSeries> {
    const [row] = await this.db
      .update(numberingSeriesTable)
      .set({
        pattern: series.pattern,
        maxLength: series.maxLength,
        isDefault: series.isDefault,
        status: series.status,
        version: sql`${numberingSeriesTable.version} + 1`,
        ...updateStamp(),
      })
      .where(
        and(
          eq(numberingSeriesTable.id, series.id),
          eq(numberingSeriesTable.version, expectedVersion),
        ),
      )
      .returning();
    if (!row) {
      const current = await this.findSeries(series.id);
      throw current
        ? new ConcurrencyConflictError(
            'NumberingSeries',
            series.id,
            expectedVersion,
            current.version,
          )
        : new NotFoundError('NumberingSeries', series.id);
    }
    return toSeries(row);
  }

  /** Makes room for a new default: at most one default per company and document type. */
  async clearDefault(companyId: string, docType: string, exceptId: string): Promise<void> {
    await this.db
      .update(numberingSeriesTable)
      .set({
        isDefault: false,
        version: sql`${numberingSeriesTable.version} + 1`,
        ...updateStamp(),
      })
      .where(
        and(
          eq(numberingSeriesTable.companyId, companyId),
          eq(numberingSeriesTable.docType, docType),
          eq(numberingSeriesTable.isDefault, true),
          sql`${numberingSeriesTable.id} <> ${exceptId}`,
        ),
      );
  }

  async isInUse(seriesId: string): Promise<boolean> {
    const res = await this.db.execute(
      sql`SELECT 1 FROM platform.numbering_counter WHERE series_id = ${seriesId} LIMIT 1`,
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Allocates the next value with one atomic upsert. The counter row stays locked until the
   * surrounding transaction ends: concurrent allocations queue, and a rollback returns the value.
   */
  async allocate(
    seriesId: string,
    plantKey: string,
    fiscalYearKey: string,
    startValue: number,
  ): Promise<bigint> {
    const res = await this.db.execute<{ value: string }>(sql`
      INSERT INTO platform.numbering_counter (tenant_id, series_id, plant_key, fiscal_year_key, next_value)
      VALUES (platform.current_tenant_id(), ${seriesId}, ${plantKey}, ${fiscalYearKey}, ${startValue + 1})
      ON CONFLICT (tenant_id, series_id, plant_key, fiscal_year_key)
      DO UPDATE SET next_value = platform.numbering_counter.next_value + 1, updated_at = now()
      RETURNING next_value - 1 AS value`);
    return BigInt(res.rows[0]!.value);
  }

  /** The value `allocate` would return next, without allocating. */
  async peek(
    seriesId: string,
    plantKey: string,
    fiscalYearKey: string,
    startValue: number,
  ): Promise<bigint> {
    const res = await this.db.execute<{ next_value: string }>(sql`
      SELECT next_value FROM platform.numbering_counter
       WHERE series_id = ${seriesId} AND plant_key = ${plantKey} AND fiscal_year_key = ${fiscalYearKey}`);
    return res.rows[0] ? BigInt(res.rows[0].next_value) : BigInt(startValue);
  }
}

function toSeries(row: typeof numberingSeriesTable.$inferSelect): NumberingSeries {
  return {
    id: row.id,
    companyId: row.companyId,
    code: row.code,
    docType: row.docType,
    pattern: row.pattern,
    gapless: row.gapless,
    scope: row.scope,
    resetPolicy: row.resetPolicy,
    startValue: Number(row.startValue),
    maxLength: row.maxLength,
    isDefault: row.isDefault,
    status: row.status,
    version: row.version,
  };
}
