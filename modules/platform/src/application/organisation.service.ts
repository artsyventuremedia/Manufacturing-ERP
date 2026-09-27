import { AccessControl } from '@manuling/authz';
import { UnitOfWork } from '@manuling/db';
import { NotFoundError, RequestContexts } from '@manuling/kernel';
import { Injectable } from '@nestjs/common';
import { PLATFORM_PERMISSIONS as P } from '../authorisation/permissions.js';
import {
  type CompanyChanges,
  type NewCompany,
  changeCompany,
  createCompany,
} from '../domain/company.js';
import { createFiscalYear } from '../domain/fiscal-year.js';
import { type NewPlant, type PlantChanges, changePlant, createPlant } from '../domain/plant.js';
import {
  type CompanyRecord,
  type FiscalYearRecord,
  OrganisationRepository,
  type PlantRecord,
} from '../infrastructure/organisation.repository.js';
import { ChangeLog } from './change-log.js';
import { CustomisationService } from './customisation.service.js';
import { ExtensionService } from './extensions.js';
import { type ExtValues } from '../domain/custom-fields.js';
import { filterSql } from '../infrastructure/customisation.repository.js';
import { companySnapshot, fiscalYearSnapshot, plantSnapshot } from './snapshots.js';

const COMPANY = 'platform.company';
const PLANT = 'platform.plant';

/**
 * Use cases for the organisation structure (company → plant) and fiscal calendars.
 * Companies outside the caller's role scopes are reported as not found; visible
 * resources without the needed permission give 403. Every write records an audit row
 * and a platform.* event in the same transaction.
 */
@Injectable()
export class OrganisationService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repo: OrganisationRepository,
    private readonly changes: ChangeLog,
    private readonly extensions: ExtensionService,
  ) {}

  listCompanies(
    limit: number,
    after?: readonly [string, string],
    query: Readonly<Record<string, unknown>> = {},
  ): Promise<CompanyRecord[]> {
    const { companyIds } = RequestContexts.requireTenant();
    return this.uow.run(
      async () => {
        const filters = await this.extensions.filters(COMPANY, query, 'ext');
        CustomisationService.assertFilterable(COMPANY, filters);
        const rows = await this.repo.listCompanies(
          companyIds,
          limit,
          after,
          filterSql('ext', filters),
        );
        return this.present(
          COMPANY,
          rows.filter((c) => AccessControl.can(P.companyRead, { companyId: c.id })),
        );
      },
      { readOnly: true },
    );
  }

  getCompany(id: string): Promise<CompanyRecord> {
    return this.uow.run(
      async () =>
        (await this.present(COMPANY, [await this.readableCompany(id, P.companyRead)]))[0]!,
      { readOnly: true },
    );
  }

  createCompany(input: NewCompany & { ext?: unknown }): Promise<CompanyRecord> {
    AccessControl.assert(P.companyCreate);
    const company = createCompany(input);
    return this.uow.run(async () => {
      const ext = await this.extensions.prepare(COMPANY, input.ext ?? {}, undefined);
      const saved = await this.repo.insertCompany({ ...company, ext });
      const after = companySnapshot(saved);
      await this.changes.record({
        entityType: 'platform.company',
        entityId: saved.id,
        action: 'create',
        after,
        event: { type: 'platform.CompanyCreated.v1', aggregateType: 'Company', data: after },
      });
      return (await this.present(COMPANY, [saved]))[0]!;
    });
  }

  updateCompany(
    id: string,
    expectedVersion: number,
    changes: CompanyChanges & { ext?: unknown },
  ): Promise<CompanyRecord> {
    return this.uow.run(async () => {
      const current = await this.readableCompany(id, P.companyUpdate);
      const hasFiscalYears = await this.repo.hasFiscalYears(id);
      const ext = await this.extensions.prepare(COMPANY, changes.ext, current.ext as ExtValues);
      const saved = await this.repo.updateCompany(
        { ...changeCompany(current, changes, hasFiscalYears), ext },
        expectedVersion,
      );
      const after = companySnapshot(saved);
      await this.changes.record({
        entityType: 'platform.company',
        entityId: id,
        action: 'update',
        before: companySnapshot(current),
        after,
        event: { type: 'platform.CompanyChanged.v1', aggregateType: 'Company', data: after },
      });
      return (await this.present(COMPANY, [saved]))[0]!;
    });
  }

  listPlants(companyId: string): Promise<PlantRecord[]> {
    return this.uow.run(
      async () => {
        this.assertVisible(companyId);
        const plants = await this.repo.listPlants(companyId);
        return this.present(
          PLANT,
          plants.filter((p) => AccessControl.can(P.plantRead, { companyId, plantId: p.id })),
        );
      },
      { readOnly: true },
    );
  }

  getPlant(id: string): Promise<PlantRecord> {
    return this.uow.run(
      async () => (await this.present(PLANT, [await this.readablePlant(id, P.plantRead)]))[0]!,
      { readOnly: true },
    );
  }

  createPlant(companyId: string, input: NewPlant & { ext?: unknown }): Promise<PlantRecord> {
    return this.uow.run(async () => {
      const company = await this.readableCompany(companyId, P.plantCreate);
      const ext = await this.extensions.prepare(PLANT, input.ext ?? {}, undefined);
      const saved = await this.repo.insertPlant({ ...createPlant(company, input), ext });
      const after = plantSnapshot(saved);
      await this.changes.record({
        entityType: 'platform.plant',
        entityId: saved.id,
        action: 'create',
        after,
        event: { type: 'platform.PlantCreated.v1', aggregateType: 'Plant', data: after },
      });
      return (await this.present(PLANT, [saved]))[0]!;
    });
  }

  updatePlant(
    id: string,
    expectedVersion: number,
    changes: PlantChanges & { ext?: unknown },
  ): Promise<PlantRecord> {
    return this.uow.run(async () => {
      const plant = await this.readablePlant(id, P.plantUpdate);
      const company = await this.repo.findCompany(plant.companyId);
      if (!company) throw new NotFoundError('Company', plant.companyId);
      const ext = await this.extensions.prepare(PLANT, changes.ext, plant.ext as ExtValues);
      const saved = await this.repo.updatePlant(
        { ...changePlant(plant, company.countryCode, changes), ext },
        expectedVersion,
      );
      const after = plantSnapshot(saved);
      await this.changes.record({
        entityType: 'platform.plant',
        entityId: id,
        action: 'update',
        before: plantSnapshot(plant),
        after,
        event: { type: 'platform.PlantChanged.v1', aggregateType: 'Plant', data: after },
      });
      return (await this.present(PLANT, [saved]))[0]!;
    });
  }

  listFiscalYears(companyId: string): Promise<FiscalYearRecord[]> {
    return this.uow.run(
      async () => {
        await this.readableCompany(companyId, P.fiscalYearRead);
        return this.repo.listFiscalYears(companyId);
      },
      { readOnly: true },
    );
  }

  createFiscalYear(companyId: string, startYear: number): Promise<FiscalYearRecord> {
    return this.uow.run(async () => {
      const company = await this.readableCompany(companyId, P.fiscalYearCreate);
      const existing = await this.repo.listFiscalYears(companyId);
      const saved = await this.repo.insertFiscalYear(
        createFiscalYear(company, startYear, existing),
      );
      const after = fiscalYearSnapshot(saved);
      await this.changes.record({
        entityType: 'platform.fiscal_year',
        entityId: saved.id,
        action: 'create',
        after,
        event: { type: 'platform.FiscalYearOpened.v1', aggregateType: 'FiscalYear', data: after },
      });
      return saved;
    });
  }

  /** Hides archived and policy-hidden custom fields (plan C4). */
  private async present<T extends { ext: Readonly<Record<string, unknown>> }>(
    entity: string,
    rows: T[],
  ): Promise<T[]> {
    if (rows.length === 0) return rows;
    const defs = await this.extensions.defs(entity);
    return rows.map((r) => ({
      ...r,
      ext: this.extensions.present(entity, r.ext as ExtValues, defs),
    }));
  }

  private assertVisible(companyId: string): void {
    if (!RequestContexts.requireTenant().companyIds.includes(companyId))
      throw new NotFoundError('Company', companyId);
  }

  private async readableCompany(id: string, permission: string): Promise<CompanyRecord> {
    this.assertVisible(id);
    const company = await this.repo.getCompany(id);
    AccessControl.assert(permission, { companyId: id });
    return company;
  }

  /** Plants the caller cannot even read are reported as not found. */
  private async readablePlant(id: string, permission: string): Promise<PlantRecord> {
    const plant = await this.repo.getPlant(id);
    const scope = { companyId: plant.companyId, plantId: plant.id };
    if (
      !RequestContexts.requireTenant().companyIds.includes(plant.companyId) ||
      !AccessControl.can(P.plantRead, scope)
    ) {
      throw new NotFoundError('Plant', id);
    }
    AccessControl.assert(permission, scope);
    return plant;
  }
}
