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
import { companySnapshot, fiscalYearSnapshot, plantSnapshot } from './snapshots.js';

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
  ) {}

  listCompanies(limit: number, after?: readonly [string, string]): Promise<CompanyRecord[]> {
    const { companyIds } = RequestContexts.requireTenant();
    return this.uow.run(
      async () => {
        const rows = await this.repo.listCompanies(companyIds, limit, after);
        return rows.filter((c) => AccessControl.can(P.companyRead, { companyId: c.id }));
      },
      { readOnly: true },
    );
  }

  getCompany(id: string): Promise<CompanyRecord> {
    return this.uow.run(() => this.readableCompany(id, P.companyRead), { readOnly: true });
  }

  createCompany(input: NewCompany): Promise<CompanyRecord> {
    AccessControl.assert(P.companyCreate);
    const company = createCompany(input);
    return this.uow.run(async () => {
      const saved = await this.repo.insertCompany(company);
      const after = companySnapshot(saved);
      await this.changes.record({
        entityType: 'platform.company',
        entityId: saved.id,
        action: 'create',
        after,
        event: { type: 'platform.CompanyCreated.v1', aggregateType: 'Company', data: after },
      });
      return saved;
    });
  }

  updateCompany(
    id: string,
    expectedVersion: number,
    changes: CompanyChanges,
  ): Promise<CompanyRecord> {
    return this.uow.run(async () => {
      const current = await this.readableCompany(id, P.companyUpdate);
      const hasFiscalYears = await this.repo.hasFiscalYears(id);
      const saved = await this.repo.updateCompany(
        changeCompany(current, changes, hasFiscalYears),
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
      return saved;
    });
  }

  listPlants(companyId: string): Promise<PlantRecord[]> {
    return this.uow.run(
      async () => {
        this.assertVisible(companyId);
        const plants = await this.repo.listPlants(companyId);
        return plants.filter((p) => AccessControl.can(P.plantRead, { companyId, plantId: p.id }));
      },
      { readOnly: true },
    );
  }

  getPlant(id: string): Promise<PlantRecord> {
    return this.uow.run(() => this.readablePlant(id, P.plantRead), { readOnly: true });
  }

  createPlant(companyId: string, input: NewPlant): Promise<PlantRecord> {
    return this.uow.run(async () => {
      const company = await this.readableCompany(companyId, P.plantCreate);
      const saved = await this.repo.insertPlant(createPlant(company, input));
      const after = plantSnapshot(saved);
      await this.changes.record({
        entityType: 'platform.plant',
        entityId: saved.id,
        action: 'create',
        after,
        event: { type: 'platform.PlantCreated.v1', aggregateType: 'Plant', data: after },
      });
      return saved;
    });
  }

  updatePlant(id: string, expectedVersion: number, changes: PlantChanges): Promise<PlantRecord> {
    return this.uow.run(async () => {
      const plant = await this.readablePlant(id, P.plantUpdate);
      const company = await this.repo.findCompany(plant.companyId);
      if (!company) throw new NotFoundError('Company', plant.companyId);
      const saved = await this.repo.updatePlant(
        changePlant(plant, company.countryCode, changes),
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
      return saved;
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
