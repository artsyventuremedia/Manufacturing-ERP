import { UnitOfWork } from '@manuling/db';
import { ConcurrencyConflictError, LocalDate, NotFoundError } from '@manuling/kernel';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import { type Company } from '../domain/company.js';
import { type FiscalYear } from '../domain/fiscal-year.js';
import { type Plant } from '../domain/plant.js';
import { companyTable, fiscalYearTable, plantTable } from './schema.js';
import { insertStamp, updateStamp } from './stamp.js';

export interface Timestamps {
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
export type CompanyRecord = Company & Timestamps;
export type PlantRecord = Plant & Timestamps;
export type FiscalYearRecord = FiscalYear & Timestamps;

/**
 * Company, plant and fiscal-year persistence. All queries run in the caller's UnitOfWork,
 * so RLS scopes them to the current tenant. Updates are optimistic: `WHERE version = expected`.
 */
@Injectable()
export class OrganisationRepository {
  constructor(private readonly uow: UnitOfWork) {}

  private get db() {
    return this.uow.current().db;
  }

  // ----- companies ---------------------------------------------------------

  async insertCompany(company: Company): Promise<CompanyRecord> {
    const [row] = await this.db
      .insert(companyTable)
      .values({ ...company, ...insertStamp() })
      .returning();
    return toCompany(row!);
  }

  async findCompany(id: string): Promise<CompanyRecord | undefined> {
    const [row] = await this.db.select().from(companyTable).where(eq(companyTable.id, id));
    return row ? toCompany(row) : undefined;
  }

  async getCompany(id: string): Promise<CompanyRecord> {
    const company = await this.findCompany(id);
    if (!company) throw new NotFoundError('Company', id);
    return company;
  }

  /** Keyset page ordered by (code, id). */
  async listCompanies(
    visibleIds: readonly string[],
    limit: number,
    after?: readonly [string, string],
  ): Promise<CompanyRecord[]> {
    if (visibleIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(companyTable)
      .where(
        and(
          inArray(companyTable.id, [...visibleIds]),
          after
            ? or(
                gt(companyTable.code, after[0]),
                and(eq(companyTable.code, after[0]), gt(companyTable.id, after[1])),
              )
            : undefined,
        ),
      )
      .orderBy(asc(companyTable.code), asc(companyTable.id))
      .limit(limit + 1);
    return rows.map(toCompany);
  }

  async updateCompany(company: Company, expectedVersion: number): Promise<CompanyRecord> {
    const [row] = await this.db
      .update(companyTable)
      .set({
        legalName: company.legalName,
        status: company.status,
        fiscalYearStartMonth: company.fiscalYearStartMonth,
        version: sql`${companyTable.version} + 1`,
        ...updateStamp(),
      })
      .where(and(eq(companyTable.id, company.id), eq(companyTable.version, expectedVersion)))
      .returning();
    if (!row)
      throw await this.staleOrMissing('Company', company.id, expectedVersion, () =>
        this.findCompany(company.id),
      );
    return toCompany(row);
  }

  // ----- plants --------------------------------------------------------------

  async insertPlant(plant: Plant): Promise<PlantRecord> {
    const [row] = await this.db
      .insert(plantTable)
      .values({ ...plant, ...insertStamp() })
      .returning();
    return toPlant(row!);
  }

  async findPlant(id: string): Promise<PlantRecord | undefined> {
    const [row] = await this.db.select().from(plantTable).where(eq(plantTable.id, id));
    return row ? toPlant(row) : undefined;
  }

  async getPlant(id: string): Promise<PlantRecord> {
    const plant = await this.findPlant(id);
    if (!plant) throw new NotFoundError('Plant', id);
    return plant;
  }

  async listPlants(companyId: string): Promise<PlantRecord[]> {
    const rows = await this.db
      .select()
      .from(plantTable)
      .where(eq(plantTable.companyId, companyId))
      .orderBy(asc(plantTable.code));
    return rows.map(toPlant);
  }

  async updatePlant(plant: Plant, expectedVersion: number): Promise<PlantRecord> {
    const [row] = await this.db
      .update(plantTable)
      .set({
        name: plant.name,
        regionCode: plant.regionCode,
        timezone: plant.timezone,
        status: plant.status,
        version: sql`${plantTable.version} + 1`,
        ...updateStamp(),
      })
      .where(and(eq(plantTable.id, plant.id), eq(plantTable.version, expectedVersion)))
      .returning();
    if (!row)
      throw await this.staleOrMissing('Plant', plant.id, expectedVersion, () =>
        this.findPlant(plant.id),
      );
    return toPlant(row);
  }

  // ----- fiscal years -----------------------------------------------------------

  async insertFiscalYear(fy: FiscalYear): Promise<FiscalYearRecord> {
    const [row] = await this.db
      .insert(fiscalYearTable)
      .values({
        ...fy,
        startDate: fy.startDate.toString(),
        endDate: fy.endDate.toString(),
        ...insertStamp(),
      })
      .returning();
    return toFiscalYear(row!);
  }

  async listFiscalYears(companyId: string): Promise<FiscalYearRecord[]> {
    const rows = await this.db
      .select()
      .from(fiscalYearTable)
      .where(eq(fiscalYearTable.companyId, companyId))
      .orderBy(asc(fiscalYearTable.startDate));
    return rows.map(toFiscalYear);
  }

  async hasFiscalYears(companyId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: fiscalYearTable.id })
      .from(fiscalYearTable)
      .where(eq(fiscalYearTable.companyId, companyId))
      .limit(1);
    return rows.length > 0;
  }

  private async staleOrMissing(
    entity: string,
    id: string,
    expectedVersion: number,
    find: () => Promise<{ version: number } | undefined>,
  ): Promise<Error> {
    const current = await find();
    return current
      ? new ConcurrencyConflictError(entity, id, expectedVersion, current.version)
      : new NotFoundError(entity, id);
  }
}

function toCompany(row: typeof companyTable.$inferSelect): CompanyRecord {
  return {
    id: row.id,
    code: row.code,
    legalName: row.legalName,
    baseCurrency: row.baseCurrency,
    countryCode: row.countryCode,
    fiscalYearStartMonth: row.fiscalYearStartMonth,
    status: row.status,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toPlant(row: typeof plantTable.$inferSelect): PlantRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    code: row.code,
    name: row.name,
    regionCode: row.regionCode,
    timezone: row.timezone,
    status: row.status,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toFiscalYear(row: typeof fiscalYearTable.$inferSelect): FiscalYearRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    code: row.code,
    startDate: LocalDate.parse(row.startDate),
    endDate: LocalDate.parse(row.endDate),
    status: row.status,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
