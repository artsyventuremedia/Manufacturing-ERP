import { AccessControl } from '@manuling/authz';
import { UnitOfWork } from '@manuling/db';
import { BusinessRuleViolation, LocalDate, NotFoundError, RequestContexts } from '@manuling/kernel';
import { Injectable } from '@nestjs/common';
import { PLATFORM_PERMISSIONS as P } from '../authorisation/permissions.js';
import {
  type IssuedNumber,
  type NumberRequest,
  type NumberingPort,
} from '../contracts/numbering.js';
import {
  type NewSeries,
  type NumberingSeries,
  type SeriesChanges,
  changeSeries,
  createSeries,
  parsePattern,
  renderNumber,
  usesToken,
} from '../domain/numbering.js';
import { NIL_KEY, NumberingRepository } from '../infrastructure/numbering.repository.js';
import {
  type FiscalYearRecord,
  OrganisationRepository,
  type PlantRecord,
} from '../infrastructure/organisation.repository.js';
import { ChangeLog } from './change-log.js';

interface Resolved {
  readonly series: NumberingSeries;
  readonly companyCode: string;
  readonly plant: PlantRecord | undefined;
  readonly fiscalYear: FiscalYearRecord | undefined;
  readonly plantKey: string;
  readonly fiscalYearKey: string;
}

/**
 * Document numbering (step 0.7). `next()` is the NumberingPort used in-process by other
 * modules inside their own UnitOfWork; the remaining methods are the admin use cases.
 */
@Injectable()
export class NumberingService implements NumberingPort {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repo: NumberingRepository,
    private readonly organisation: OrganisationRepository,
    private readonly changes: ChangeLog,
  ) {}

  next(request: NumberRequest): Promise<IssuedNumber> {
    RequestContexts.requireTenant();
    const date = LocalDate.parse(request.documentDate);
    // Called inside a document transaction? Then a gap-tolerant allocation must commit on its
    // own; called standalone, its own short transaction already commits immediately.
    const insideCallerTransaction = this.uow.inTransaction();
    return this.uow.run(async () => {
      const series = await this.repo.resolveSeries(
        request.companyId,
        request.docType,
        request.seriesCode,
      );
      if (!series) {
        throw new BusinessRuleViolation(
          'platform.numbering.no_series',
          `No active numbering series for ${request.docType}${request.seriesCode ? ` (${request.seriesCode})` : ''}`,
          { docType: request.docType, seriesCode: request.seriesCode },
        );
      }
      const r = await this.resolve(series, date, request.plantId);
      // Gapless: allocate in the caller's transaction (rollback returns the number).
      // Gap-tolerant inside a caller's transaction: commit the allocation independently so
      // documents do not queue on the counter row until the caller commits.
      const allocate = () =>
        this.repo.allocate(series.id, r.plantKey, r.fiscalYearKey, series.startValue);
      const sequence =
        series.gapless || !insideCallerTransaction
          ? await allocate()
          : await this.uow.runIndependent(allocate);
      return {
        number: this.render(r, date, sequence),
        sequence: sequence.toString(),
        seriesId: series.id,
        fiscalYearId: r.fiscalYear?.id ?? null,
      };
    });
  }

  // ----- admin ---------------------------------------------------------------------------

  listSeries(companyId: string): Promise<NumberingSeries[]> {
    return this.uow.run(
      async () => {
        await this.visibleCompany(companyId, P.numberingRead);
        return this.repo.listSeries(companyId);
      },
      { readOnly: true },
    );
  }

  createSeries(companyId: string, input: NewSeries): Promise<NumberingSeries> {
    return this.uow.run(async () => {
      await this.visibleCompany(companyId, P.numberingManage);
      const series = createSeries(companyId, input);
      if (series.isDefault) await this.repo.clearDefault(companyId, series.docType, series.id);
      const saved = await this.repo.insertSeries(series);
      await this.record('create', undefined, saved);
      return saved;
    });
  }

  updateSeries(
    id: string,
    expectedVersion: number,
    changes: SeriesChanges,
  ): Promise<NumberingSeries> {
    return this.uow.run(async () => {
      const current = await this.repo.getSeries(id);
      await this.visibleCompany(
        current.companyId,
        P.numberingManage,
        () => new NotFoundError('NumberingSeries', id),
      );
      const next = changeSeries(current, changes, await this.repo.isInUse(id));
      if (next.isDefault && next.status === 'active')
        await this.repo.clearDefault(next.companyId, next.docType, id);
      const saved = await this.repo.updateSeries(next, expectedVersion);
      await this.record('update', current, saved);
      return saved;
    });
  }

  /** The number the next allocation would produce, without allocating. */
  preview(
    id: string,
    documentDate: string,
    plantId?: string,
  ): Promise<{ number: string; sequence: string }> {
    const date = LocalDate.parse(documentDate);
    return this.uow.run(
      async () => {
        const series = await this.repo.getSeries(id);
        await this.visibleCompany(
          series.companyId,
          P.numberingRead,
          () => new NotFoundError('NumberingSeries', id),
        );
        const r = await this.resolve(series, date, plantId);
        const sequence = await this.repo.peek(
          series.id,
          r.plantKey,
          r.fiscalYearKey,
          series.startValue,
        );
        return { number: this.render(r, date, sequence), sequence: sequence.toString() };
      },
      { readOnly: true },
    );
  }

  // ----- internals -------------------------------------------------------------------------

  private async resolve(
    series: NumberingSeries,
    date: LocalDate,
    plantId: string | undefined,
  ): Promise<Resolved> {
    const parts = parsePattern(series.pattern);
    const company = await this.organisation.getCompany(series.companyId);

    let plant: PlantRecord | undefined;
    if (series.scope === 'plant' || usesToken(parts, 'plant')) {
      if (!plantId) {
        throw new BusinessRuleViolation(
          'platform.numbering.plant_required',
          'This series is numbered per plant; give a plant',
        );
      }
      plant = await this.organisation.findPlant(plantId);
      if (!plant || plant.companyId !== company.id) throw new NotFoundError('Plant', plantId);
    }

    let fiscalYear: FiscalYearRecord | undefined;
    if (
      series.resetPolicy === 'fiscal_year' ||
      usesToken(parts, 'fy') ||
      usesToken(parts, 'fyShort')
    ) {
      const years = await this.organisation.listFiscalYears(company.id);
      fiscalYear = years.find(
        (fy) => fy.startDate.compare(date) <= 0 && date.compare(fy.endDate) <= 0,
      );
      if (!fiscalYear) {
        throw new BusinessRuleViolation(
          'platform.numbering.no_fiscal_year',
          `No fiscal year of ${company.code} contains ${date.toString()}`,
          { date: date.toString() },
        );
      }
    }

    return {
      series,
      companyCode: company.code,
      plant,
      fiscalYear,
      plantKey: series.scope === 'plant' && plant ? plant.id : NIL_KEY,
      fiscalYearKey: series.resetPolicy === 'fiscal_year' && fiscalYear ? fiscalYear.id : NIL_KEY,
    };
  }

  private render(r: Resolved, date: LocalDate, sequence: bigint): string {
    const number = renderNumber(parsePattern(r.series.pattern), {
      sequence,
      documentDate: date,
      companyCode: r.companyCode,
      plantCode: r.plant?.code,
      fiscalYearCode: r.fiscalYear?.code,
    });
    if (r.series.maxLength !== null && number.length > r.series.maxLength) {
      throw new BusinessRuleViolation(
        'platform.numbering.too_long',
        `Number ${number} exceeds ${r.series.maxLength} characters; start a new series`,
        { number, maxLength: r.series.maxLength },
      );
    }
    return number;
  }

  private async visibleCompany(
    companyId: string,
    permission: string,
    notFound?: () => Error,
  ): Promise<void> {
    if (!RequestContexts.requireTenant().companyIds.includes(companyId)) {
      throw notFound ? notFound() : new NotFoundError('Company', companyId);
    }
    await this.organisation.getCompany(companyId);
    AccessControl.assert(permission, { companyId });
  }

  private async record(
    action: 'create' | 'update',
    before: NumberingSeries | undefined,
    after: NumberingSeries,
  ): Promise<void> {
    const snap = (s: NumberingSeries) => ({
      id: s.id,
      companyId: s.companyId,
      code: s.code,
      docType: s.docType,
      pattern: s.pattern,
      gapless: s.gapless,
      scope: s.scope,
      resetPolicy: s.resetPolicy,
      maxLength: s.maxLength,
      isDefault: s.isDefault,
      status: s.status,
    });
    await this.changes.record({
      entityType: 'platform.numbering_series',
      entityId: after.id,
      action,
      before: before ? snap(before) : undefined,
      after: snap(after),
      event: {
        type:
          action === 'create'
            ? 'platform.NumberingSeriesCreated.v1'
            : 'platform.NumberingSeriesChanged.v1',
        aggregateType: 'NumberingSeries',
        data: snap(after),
      },
    });
  }
}
