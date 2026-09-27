import { AccessControl } from '@manuling/authz';
import { UnitOfWork } from '@manuling/db';
import {
  BusinessRuleViolation,
  ConcurrencyConflictError,
  NotFoundError,
  RequestContexts,
  ValidationError,
  newId,
} from '@manuling/kernel';
import { Injectable } from '@nestjs/common';
import { PLATFORM_PERMISSIONS as P } from '../authorisation/permissions.js';
import { type ExtValues, type FieldDef, labelFor } from '../domain/custom-fields.js';
import {
  type CustomRecord,
  CustomisationRepository,
  type ObjectDef,
} from '../infrastructure/customisation.repository.js';
import { ChangeLog } from './change-log.js';
import { CustomisationService } from './customisation.service.js';
import { ExtensionService } from './extensions.js';

export const EXPORT_ROW_LIMIT = 10_000;

export interface RecordView extends CustomRecord {
  readonly objectApiName: string;
}

/** Records of tenant-defined objects (step 0.9, plan C6/C8). */
@Injectable()
export class CustomRecordService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repo: CustomisationRepository,
    private readonly extensions: ExtensionService,
    private readonly changes: ChangeLog,
  ) {}

  list(
    apiName: string,
    query: Readonly<Record<string, unknown>>,
    limit: number,
    after?: readonly [string, string],
  ): Promise<RecordView[]> {
    return this.uow.run(
      async () => {
        const object = await this.object(apiName);
        const entity = `custom.${apiName}`;
        const filters = await this.extensions.filters(entity, query, 'data');
        CustomisationService.assertFilterable(entity, filters);
        if (!object.companyScoped) AccessControl.assert(P.customRecordRead);
        const { companyIds } = RequestContexts.requireTenant();
        const rows = await this.repo.listRecords({
          objectDefId: object.id,
          companyIds: object.companyScoped ? companyIds : 'all',
          filters,
          includeArchived: query['includeArchived'] === 'true',
          limit,
          after,
        });
        const defs = await this.extensions.defs(entity);
        return rows.filter((r) => this.canRead(object, r)).map((r) => this.view(object, r, defs));
      },
      { readOnly: true },
    );
  }

  get(apiName: string, id: string): Promise<RecordView> {
    return this.uow.run(
      async () => {
        const object = await this.object(apiName);
        const record = await this.visibleRecord(object, id);
        return this.view(object, record, await this.extensions.defs(`custom.${apiName}`));
      },
      { readOnly: true },
    );
  }

  create(
    apiName: string,
    input: { companyId?: string | null | undefined; data: unknown },
  ): Promise<RecordView> {
    return this.uow.run(async () => {
      const object = await this.object(apiName);
      const companyId = this.checkCompany(object, input.companyId ?? null);
      AccessControl.assert(P.customRecordWrite, companyId ? { companyId } : {});
      const entity = `custom.${apiName}`;
      const data = await this.extensions.prepare(entity, input.data ?? {}, undefined, 'data');
      const record = await this.repo.insertRecord({
        id: newId(),
        objectDefId: object.id,
        companyId,
        data,
        status: 'active',
        version: 1,
      });
      await this.record('create', object, undefined, record);
      return this.view(object, record, await this.extensions.defs(entity));
    });
  }

  update(
    apiName: string,
    id: string,
    expectedVersion: number,
    input: { data: unknown },
  ): Promise<RecordView> {
    const { actor } = RequestContexts.requireTenant();
    return this.uow.run(async () => {
      const object = await this.object(apiName);
      const current = await this.visibleRecord(object, id);
      AccessControl.assert(
        P.customRecordWrite,
        current.companyId ? { companyId: current.companyId } : {},
      );
      if (current.status !== 'active') {
        throw new BusinessRuleViolation(
          'platform.custom_record.archived',
          'Archived records cannot be edited',
        );
      }
      const entity = `custom.${apiName}`;
      const data = await this.extensions.prepare(entity, input.data, current.data, 'data');
      const saved = await this.repo.updateRecord(
        id,
        { data },
        expectedVersion,
        actor.type === 'user' ? actor.id : null,
      );
      if (!saved)
        throw new ConcurrencyConflictError('CustomRecord', id, expectedVersion, current.version);
      await this.record('update', object, current, saved);
      return this.view(object, saved, await this.extensions.defs(entity));
    });
  }

  archive(apiName: string, id: string, expectedVersion: number): Promise<RecordView> {
    const { actor } = RequestContexts.requireTenant();
    return this.uow.run(async () => {
      const object = await this.object(apiName);
      const current = await this.visibleRecord(object, id);
      AccessControl.assert(
        P.customRecordWrite,
        current.companyId ? { companyId: current.companyId } : {},
      );
      const saved = await this.repo.updateRecord(
        id,
        { status: 'archived' },
        expectedVersion,
        actor.type === 'user' ? actor.id : null,
      );
      if (!saved)
        throw new ConcurrencyConflictError('CustomRecord', id, expectedVersion, current.version);
      await this.record('archive', object, current, saved);
      return this.view(object, saved, await this.extensions.defs(`custom.${apiName}`));
    });
  }

  /** CSV (RFC 4180) with localised headers, honouring filters and field policies (plan C8). */
  export(
    apiName: string,
    query: Readonly<Record<string, unknown>>,
  ): Promise<{ filename: string; csv: string; truncated: boolean }> {
    const { locale } = RequestContexts.requireTenant();
    return this.uow.run(
      async () => {
        const object = await this.object(apiName);
        const rows = await this.list(apiName, query, EXPORT_ROW_LIMIT);
        const defs = (await this.extensions.defs(`custom.${apiName}`)).filter(
          (d) =>
            d.status === 'active' &&
            AccessControl.fieldAccess(`custom.${apiName}`, `ext.${d.apiName}`) !== 'hidden',
        );
        const header = [
          'Id',
          'Company',
          ...defs.map((d) => labelFor(d.label, locale, d.apiName)),
          'Created',
          'Updated',
        ];
        const lines = [
          header,
          ...rows
            .slice(0, EXPORT_ROW_LIMIT)
            .map((r) => [
              r.id,
              r.companyId ?? '',
              ...defs.map((d) => cell(r.data[d.apiName])),
              r.createdAt.toISOString(),
              r.updatedAt.toISOString(),
            ]),
        ];
        return {
          filename: `${object.apiName}.csv`,
          csv: `\uFEFF${lines.map((l) => l.map(csvEscape).join(',')).join('\r\n')}\r\n`,
          truncated: rows.length > EXPORT_ROW_LIMIT,
        };
      },
      { readOnly: true },
    );
  }

  // ----- internals -------------------------------------------------------------------------

  private async object(apiName: string): Promise<ObjectDef> {
    const object = await this.repo.findObjectByName(apiName);
    if (!object || object.status !== 'active') throw new NotFoundError('CustomObject', apiName);
    return object;
  }

  private checkCompany(object: ObjectDef, companyId: string | null): string | null {
    if (!object.companyScoped) {
      if (companyId)
        throw invalid('companyId', `${object.apiName} records are not company-specific`);
      return null;
    }
    if (!companyId) throw invalid('companyId', 'Give the company this record belongs to');
    if (!RequestContexts.requireTenant().companyIds.includes(companyId))
      throw new NotFoundError('Company', companyId);
    return companyId;
  }

  private canRead(object: ObjectDef, record: CustomRecord): boolean {
    if (!object.companyScoped || !record.companyId) return AccessControl.can(P.customRecordRead);
    return (
      RequestContexts.requireTenant().companyIds.includes(record.companyId) &&
      AccessControl.can(P.customRecordRead, { companyId: record.companyId })
    );
  }

  private async visibleRecord(object: ObjectDef, id: string): Promise<CustomRecord> {
    const record = await this.repo.findRecord(object.id, id);
    if (!record || !this.canRead(object, record)) throw new NotFoundError('CustomRecord', id);
    return record;
  }

  private view(object: ObjectDef, record: CustomRecord, defs: readonly FieldDef[]): RecordView {
    return {
      ...record,
      objectApiName: object.apiName,
      data: this.extensions.present(`custom.${object.apiName}`, record.data, defs),
    };
  }

  private record(
    action: 'create' | 'update' | 'archive',
    object: ObjectDef,
    before: CustomRecord | undefined,
    after: CustomRecord,
  ): Promise<void> {
    const data = {
      id: after.id,
      objectApiName: object.apiName,
      companyId: after.companyId,
      data: after.data,
      status: after.status,
    };
    const type =
      action === 'create'
        ? 'platform.CustomRecordCreated.v1'
        : action === 'archive'
          ? 'platform.CustomRecordArchived.v1'
          : 'platform.CustomRecordChanged.v1';
    return this.changes.record({
      entityType: 'platform.custom_record',
      entityId: after.id,
      action,
      before: before ? { data: before.data, status: before.status } : undefined,
      after: {
        object: object.apiName,
        companyId: after.companyId,
        data: after.data,
        status: after.status,
      },
      event: { type, aggregateType: 'CustomRecord', data },
    });
  }
}

function invalid(path: string, message: string): ValidationError {
  return new ValidationError('platform.custom_record.invalid', message, {}, [
    { path, code: 'platform.custom_record.invalid', message },
  ]);
}

function cell(value: ExtValues[string] | undefined): string {
  if (value === undefined || value === null) return '';
  return Array.isArray(value)
    ? value
        .map((v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v)))
        .join('; ')
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);
}

/** Quotes as needed and defuses spreadsheet formula injection (=, +, -, @ at the start). */
export function csvEscape(value: string): string {
  const isNumber = /^[+-]?\d+(\.\d+)?$/.test(value);
  const safe = !isNumber && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
