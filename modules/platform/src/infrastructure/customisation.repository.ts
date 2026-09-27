import { UnitOfWork } from '@manuling/db';
import { ConcurrencyConflictError, NotFoundError } from '@manuling/kernel';
import { Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import {
  type ExtValues,
  type FieldDef,
  type FieldType,
  type I18nText,
  type SelectOption,
  type ValueFilter,
} from '../domain/custom-fields.js';
import { insertStamp } from './stamp.js';

export interface ObjectDef {
  readonly id: string;
  readonly apiName: string;
  readonly label: I18nText;
  readonly pluralLabel: I18nText;
  readonly description: string | null;
  readonly companyScoped: boolean;
  readonly titleField: string | null;
  readonly status: 'active' | 'archived';
  readonly version: number;
}

export interface CustomRecord {
  readonly id: string;
  readonly objectDefId: string;
  readonly companyId: string | null;
  readonly data: ExtValues;
  readonly status: 'active' | 'archived';
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface Layout {
  readonly entity: string;
  readonly kind: 'form' | 'list';
  readonly layout: unknown;
  readonly version: number;
}

type Row = Record<string, unknown>;

/** Tables that reference fields may point at, by entity name (plan C2). */
const REFERENCE_TABLES: Readonly<Record<string, string>> = {
  'platform.company': 'platform.company',
  'platform.plant': 'platform.plant',
  'platform.user': 'platform.app_user',
};

/** Custom field, custom object, record and layout persistence (step 0.9), tenant-scoped via RLS. */
@Injectable()
export class CustomisationRepository {
  constructor(private readonly uow: UnitOfWork) {}

  private async rows(query: SQL): Promise<Row[]> {
    return (await this.uow.current().db.execute<Row>(query)).rows;
  }

  private async exec(query: SQL): Promise<number> {
    return (await this.uow.current().db.execute(query)).rowCount ?? 0;
  }

  // ----- field definitions ---------------------------------------------------------------

  async fieldDefs(entity: string): Promise<FieldDef[]> {
    const rows = await this.rows(
      sql`SELECT * FROM platform.custom_field_def WHERE entity = ${entity} ORDER BY position, api_name`,
    );
    return rows.map(toField);
  }

  async findFieldDef(id: string): Promise<FieldDef | undefined> {
    const [r] = await this.rows(sql`SELECT * FROM platform.custom_field_def WHERE id = ${id}`);
    return r ? toField(r) : undefined;
  }

  async insertFieldDef(f: FieldDef): Promise<void> {
    const s = insertStamp();
    await this.exec(sql`
      INSERT INTO platform.custom_field_def (id, tenant_id, entity, api_name, data_type, label, help, required, default_value,
        options, settings, position, status, created_by, updated_by, source)
      VALUES (${f.id}, ${s.tenantId}, ${f.entity}, ${f.apiName}, ${f.dataType}, ${json(f.label)}::jsonb, ${json(f.help)}::jsonb,
        ${f.required}, ${json(f.defaultValue)}::jsonb, ${json(f.options)}::jsonb, ${json(f.settings)}::jsonb, ${f.position},
        ${f.status}, ${s.createdBy}, ${s.updatedBy}, ${s.source})`);
  }

  async updateFieldDef(f: FieldDef, expectedVersion: number): Promise<FieldDef> {
    const n = await this.exec(sql`
      UPDATE platform.custom_field_def
         SET label = ${json(f.label)}::jsonb, help = ${json(f.help)}::jsonb, required = ${f.required},
             default_value = ${json(f.defaultValue)}::jsonb, options = ${json(f.options)}::jsonb, position = ${f.position},
             status = ${f.status}, version = version + 1, updated_at = now()
       WHERE id = ${f.id} AND version = ${expectedVersion}`);
    if (n === 0)
      throw await this.stale('CustomField', f.id, expectedVersion, () => this.findFieldDef(f.id));
    return (await this.findFieldDef(f.id))!;
  }

  // ----- object definitions ---------------------------------------------------------------

  async objectDefs(): Promise<ObjectDef[]> {
    return (await this.rows(sql`SELECT * FROM platform.custom_object_def ORDER BY api_name`)).map(
      toObject,
    );
  }

  async findObjectByName(apiName: string): Promise<ObjectDef | undefined> {
    const [r] = await this.rows(
      sql`SELECT * FROM platform.custom_object_def WHERE api_name = ${apiName}`,
    );
    return r ? toObject(r) : undefined;
  }

  async findObject(id: string): Promise<ObjectDef | undefined> {
    const [r] = await this.rows(sql`SELECT * FROM platform.custom_object_def WHERE id = ${id}`);
    return r ? toObject(r) : undefined;
  }

  async insertObject(o: ObjectDef): Promise<void> {
    const s = insertStamp();
    await this.exec(sql`
      INSERT INTO platform.custom_object_def (id, tenant_id, api_name, label, plural_label, description, company_scoped,
        title_field, status, created_by, updated_by, source)
      VALUES (${o.id}, ${s.tenantId}, ${o.apiName}, ${json(o.label)}::jsonb, ${json(o.pluralLabel)}::jsonb, ${o.description},
        ${o.companyScoped}, ${o.titleField}, ${o.status}, ${s.createdBy}, ${s.updatedBy}, ${s.source})`);
  }

  async updateObject(o: ObjectDef, expectedVersion: number): Promise<ObjectDef> {
    const n = await this.exec(sql`
      UPDATE platform.custom_object_def
         SET label = ${json(o.label)}::jsonb, plural_label = ${json(o.pluralLabel)}::jsonb, description = ${o.description},
             title_field = ${o.titleField}, status = ${o.status}, version = version + 1, updated_at = now()
       WHERE id = ${o.id} AND version = ${expectedVersion}`);
    if (n === 0)
      throw await this.stale('CustomObject', o.id, expectedVersion, () => this.findObject(o.id));
    return (await this.findObject(o.id))!;
  }

  // ----- records ----------------------------------------------------------------------------

  async insertRecord(r: Omit<CustomRecord, 'createdAt' | 'updatedAt'>): Promise<CustomRecord> {
    const s = insertStamp();
    const [row] = await this.rows(sql`
      INSERT INTO platform.custom_record (id, tenant_id, object_def_id, company_id, data, status, created_by, updated_by, source)
      VALUES (${r.id}, ${s.tenantId}, ${r.objectDefId}, ${r.companyId}, ${json(r.data)}::jsonb, ${r.status}, ${s.createdBy},
        ${s.updatedBy}, ${s.source})
      RETURNING *`);
    return toRecord(row!);
  }

  async findRecord(objectDefId: string, id: string): Promise<CustomRecord | undefined> {
    const [r] = await this.rows(
      sql`SELECT * FROM platform.custom_record WHERE object_def_id = ${objectDefId} AND id = ${id}`,
    );
    return r ? toRecord(r) : undefined;
  }

  async updateRecord(
    id: string,
    changes: { data?: ExtValues; status?: 'active' | 'archived' },
    expectedVersion: number,
    updatedBy: string | null,
  ): Promise<CustomRecord | undefined> {
    const [r] = await this.rows(sql`
      UPDATE platform.custom_record
         SET data = coalesce(${changes.data ? json(changes.data) : null}::jsonb, data),
             status = coalesce(${changes.status ?? null}, status),
             version = version + 1, updated_at = now(), updated_by = ${updatedBy}
       WHERE id = ${id} AND version = ${expectedVersion}
      RETURNING *`);
    return r ? toRecord(r) : undefined;
  }

  /** Keyset page (newest first) filtered by company visibility and value filters. */
  async listRecords(query: {
    objectDefId: string;
    companyIds: readonly string[] | 'all';
    filters: readonly ValueFilter[];
    includeArchived: boolean;
    limit: number;
    after?: readonly [string, string] | undefined;
  }): Promise<CustomRecord[]> {
    const conditions: SQL[] = [sql`object_def_id = ${query.objectDefId}`];
    if (!query.includeArchived) conditions.push(sql`status = 'active'`);
    if (query.companyIds !== 'all') {
      conditions.push(
        query.companyIds.length === 0
          ? sql`company_id IS NULL`
          : sql`(company_id IS NULL OR company_id = ANY(${`{${query.companyIds.join(',')}}`}::uuid[]))`,
      );
    }
    conditions.push(...filterSql('data', query.filters));
    if (query.after) {
      conditions.push(
        sql`(created_at, id) < (${query.after[0]}::timestamptz, ${query.after[1]}::uuid)`,
      );
    }
    const rows = await this.rows(sql`
      SELECT * FROM platform.custom_record WHERE ${sql.join(conditions, sql` AND `)}
       ORDER BY created_at DESC, id DESC LIMIT ${query.limit + 1}`);
    return rows.map(toRecord);
  }

  /** Ids (of `ids`) that exist as the given entity in the current tenant. */
  async existingReferences(target: string, ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const list = `{${ids.join(',')}}`;
    let rows: Row[];
    if (target.startsWith('custom.')) {
      rows = await this.rows(sql`
        SELECT r.id FROM platform.custom_record r JOIN platform.custom_object_def o ON o.id = r.object_def_id
         WHERE o.api_name = ${target.slice('custom.'.length)} AND r.status = 'active' AND r.id = ANY(${list}::uuid[])`);
    } else {
      const table = REFERENCE_TABLES[target];
      if (!table) return new Set();
      rows = await this.rows(sql`SELECT id FROM ${sql.raw(table)} WHERE id = ANY(${list}::uuid[])`);
    }
    return new Set(rows.map((r) => r['id'] as string));
  }

  // ----- layouts -------------------------------------------------------------------------------

  async findLayout(entity: string, kind: 'form' | 'list'): Promise<Layout | undefined> {
    const [r] = await this.rows(
      sql`SELECT * FROM platform.ui_layout WHERE entity = ${entity} AND kind = ${kind}`,
    );
    return r
      ? {
          entity: r['entity'] as string,
          kind: r['kind'] as Layout['kind'],
          layout: r['layout'],
          version: Number(r['version']),
        }
      : undefined;
  }

  async upsertLayout(
    entity: string,
    kind: 'form' | 'list',
    layout: unknown,
    id: string,
  ): Promise<Layout> {
    const s = insertStamp();
    await this.exec(sql`
      INSERT INTO platform.ui_layout (id, tenant_id, entity, kind, layout, created_by, updated_by, source)
      VALUES (${id}, ${s.tenantId}, ${entity}, ${kind}, ${json(layout)}::jsonb, ${s.createdBy}, ${s.updatedBy}, ${s.source})
      ON CONFLICT (tenant_id, entity, kind) DO UPDATE
        SET layout = EXCLUDED.layout, version = platform.ui_layout.version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by`);
    return (await this.findLayout(entity, kind))!;
  }

  private async stale(
    entity: string,
    id: string,
    expected: number,
    find: () => Promise<{ version: number } | undefined>,
  ) {
    const current = await find();
    return current
      ? new ConcurrencyConflictError(entity, id, expected, current.version)
      : new NotFoundError(entity, id);
  }
}

/**
 * SQL for value filters on a JSON column. Equality uses containment (served by the GIN
 * index); ranges compare numerically for numbers and lexically for ISO dates.
 */
export function filterSql(column: 'data' | 'ext', filters: readonly ValueFilter[]): SQL[] {
  const col = sql.raw(column);
  return filters.map((f) => {
    const scalar = typeof f.value === 'object' ? JSON.stringify(f.value) : String(f.value);
    if (f.op === 'eq') {
      const probe =
        f.dataType === 'multi_select' ? { [f.field]: [f.value] } : { [f.field]: f.value };
      return sql`${col} @> ${JSON.stringify(probe)}::jsonb`;
    }
    const op = sql.raw({ gt: '>', gte: '>=', lt: '<', lte: '<=' }[f.op]);
    return f.dataType === 'integer' || f.dataType === 'decimal'
      ? sql`(${col}->>${f.field})::numeric ${op} ${scalar}::numeric`
      : sql`(${col}->>${f.field}) ${op} ${scalar}`;
  });
}

const json = (v: unknown): string | null =>
  v === null || v === undefined ? null : JSON.stringify(v);

function toField(r: Row): FieldDef {
  return {
    id: r['id'] as string,
    entity: r['entity'] as string,
    apiName: r['api_name'] as string,
    dataType: r['data_type'] as FieldType,
    label: r['label'] as I18nText,
    help: (r['help'] as I18nText | null) ?? null,
    required: r['required'] as boolean,
    defaultValue: (r['default_value'] as FieldDef['defaultValue']) ?? null,
    options: (r['options'] as SelectOption[] | null) ?? null,
    settings: (r['settings'] as FieldDef['settings']) ?? {},
    position: Number(r['position']),
    status: r['status'] as FieldDef['status'],
    version: Number(r['version']),
  };
}

function toObject(r: Row): ObjectDef {
  return {
    id: r['id'] as string,
    apiName: r['api_name'] as string,
    label: r['label'] as I18nText,
    pluralLabel: r['plural_label'] as I18nText,
    description: (r['description'] as string | null) ?? null,
    companyScoped: r['company_scoped'] as boolean,
    titleField: (r['title_field'] as string | null) ?? null,
    status: r['status'] as ObjectDef['status'],
    version: Number(r['version']),
  };
}

function toRecord(r: Row): CustomRecord {
  return {
    id: r['id'] as string,
    objectDefId: r['object_def_id'] as string,
    companyId: (r['company_id'] as string | null) ?? null,
    data: r['data'] as ExtValues,
    status: r['status'] as CustomRecord['status'],
    version: Number(r['version']),
    createdAt: new Date(r['created_at'] as string),
    updatedAt: new Date(r['updated_at'] as string),
  };
}
