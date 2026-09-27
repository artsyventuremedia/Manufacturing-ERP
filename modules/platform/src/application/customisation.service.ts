import { AccessControl } from '@manuling/authz';
import { UnitOfWork } from '@manuling/db';
import { ForbiddenError, NotFoundError, ValidationError, newId } from '@manuling/kernel';
import { Injectable } from '@nestjs/common';
import { PLATFORM_PERMISSIONS as P } from '../authorisation/permissions.js';
import {
  type FieldDef,
  type FieldDefChanges,
  type I18nText,
  type NewFieldDef,
  type ValueFilter,
  changeFieldDef,
  createFieldDef,
} from '../domain/custom-fields.js';
import {
  CustomisationRepository,
  type Layout,
  type ObjectDef,
} from '../infrastructure/customisation.repository.js';
import { ChangeLog } from './change-log.js';
import { CUSTOM_RECORD_CORE_FIELDS, extensibleEntity } from './extensions.js';

const OBJECT_NAME = /^[a-z][a-z0-9_]{2,39}$/;
const LANG = /^[a-z]{2,3}(-[A-Z]{2})?$/;

export interface NewObjectDef {
  readonly apiName: string;
  readonly label: I18nText;
  readonly pluralLabel: I18nText;
  readonly description?: string | undefined;
  readonly companyScoped?: boolean | undefined;
}

/** Custom field and object definitions and UI layouts (step 0.9). */
@Injectable()
export class CustomisationService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repo: CustomisationRepository,
    private readonly changes: ChangeLog,
  ) {}

  // ----- fields ---------------------------------------------------------------------------

  listFields(entity: string): Promise<FieldDef[]> {
    return this.uow.run(
      async () => {
        await this.assertEntity(entity);
        return this.repo.fieldDefs(entity);
      },
      { readOnly: true },
    );
  }

  createField(input: NewFieldDef): Promise<FieldDef> {
    AccessControl.assert(P.customizationManage);
    return this.uow.run(async () => {
      const objects = new Set(
        (await this.repo.objectDefs())
          .filter((o) => o.status === 'active')
          .map((o) => `custom.${o.apiName}`),
      );
      const def = createFieldDef(input, {
        isExtensible: (e) => extensibleEntity(e) !== undefined || objects.has(e),
        isReferenceable: (e) =>
          extensibleEntity(e)?.referenceable === true || e === 'platform.user' || objects.has(e),
      });
      await this.repo.insertFieldDef(def);
      await this.record('create', undefined, def);
      return def;
    });
  }

  updateField(id: string, expectedVersion: number, changes: FieldDefChanges): Promise<FieldDef> {
    AccessControl.assert(P.customizationManage);
    return this.uow.run(async () => {
      const current = await this.repo.findFieldDef(id);
      if (!current) throw new NotFoundError('CustomField', id);
      const saved = await this.repo.updateFieldDef(
        changeFieldDef(current, changes),
        expectedVersion,
      );
      await this.record('update', current, saved);
      return saved;
    });
  }

  // ----- objects ---------------------------------------------------------------------------

  listObjects(): Promise<ObjectDef[]> {
    return this.uow.run(() => this.repo.objectDefs(), { readOnly: true });
  }

  createObject(input: NewObjectDef): Promise<ObjectDef> {
    AccessControl.assert(P.customizationManage);
    if (!OBJECT_NAME.test(input.apiName)) {
      throw new ValidationError(
        'platform.custom_object.invalid',
        'Use 3–40 lowercase letters, digits or "_"',
        {},
        [
          {
            path: 'apiName',
            code: 'platform.custom_object.invalid',
            message: 'Use 3–40 lowercase letters, digits or "_"',
          },
        ],
      );
    }
    validateLabels(input.label, 'label');
    validateLabels(input.pluralLabel, 'pluralLabel');
    return this.uow.run(async () => {
      const def: ObjectDef = {
        id: newId(),
        apiName: input.apiName,
        label: input.label,
        pluralLabel: input.pluralLabel,
        description: input.description?.trim() || null,
        companyScoped: input.companyScoped ?? true,
        titleField: null,
        status: 'active',
        version: 1,
      };
      await this.repo.insertObject(def);
      await this.changes.record({
        entityType: 'platform.custom_object',
        entityId: def.id,
        action: 'create',
        after: def,
        event: {
          type: 'platform.CustomObjectDefined.v1',
          aggregateType: 'CustomObject',
          data: objectEvent(def),
        },
      });
      return def;
    });
  }

  updateObject(
    id: string,
    expectedVersion: number,
    changes: {
      label?: I18nText | undefined;
      pluralLabel?: I18nText | undefined;
      description?: string | null | undefined;
      titleField?: string | null | undefined;
      status?: 'active' | 'archived' | undefined;
    },
  ): Promise<ObjectDef> {
    AccessControl.assert(P.customizationManage);
    if (changes.label) validateLabels(changes.label, 'label');
    if (changes.pluralLabel) validateLabels(changes.pluralLabel, 'pluralLabel');
    return this.uow.run(async () => {
      const current = await this.repo.findObject(id);
      if (!current) throw new NotFoundError('CustomObject', id);
      if (changes.titleField) {
        const field = (await this.repo.fieldDefs(`custom.${current.apiName}`)).find(
          (f) => f.apiName === changes.titleField,
        );
        if (
          !field ||
          field.status !== 'active' ||
          !['text', 'select', 'email', 'phone'].includes(field.dataType)
        ) {
          throw new ValidationError(
            'platform.custom_object.title_invalid',
            'The title field must be an active text-like field',
            {},
            [
              {
                path: 'titleField',
                code: 'platform.custom_object.title_invalid',
                message: 'Unknown or unsuitable field',
              },
            ],
          );
        }
      }
      const next: ObjectDef = {
        ...current,
        label: changes.label ?? current.label,
        pluralLabel: changes.pluralLabel ?? current.pluralLabel,
        description:
          changes.description === undefined
            ? current.description
            : changes.description?.trim() || null,
        titleField: changes.titleField === undefined ? current.titleField : changes.titleField,
        status: changes.status ?? current.status,
      };
      const saved = await this.repo.updateObject(next, expectedVersion);
      await this.changes.record({
        entityType: 'platform.custom_object',
        entityId: id,
        action: 'update',
        before: current,
        after: saved,
        event: {
          type: 'platform.CustomObjectChanged.v1',
          aggregateType: 'CustomObject',
          data: objectEvent(saved),
        },
      });
      return saved;
    });
  }

  // ----- layouts ---------------------------------------------------------------------------

  getLayout(entity: string, kind: 'form' | 'list'): Promise<Layout | null> {
    return this.uow.run(
      async () => {
        await this.assertEntity(entity);
        return (await this.repo.findLayout(entity, kind)) ?? null;
      },
      { readOnly: true },
    );
  }

  /** Stores a form or list layout after checking every referenced field exists (plan C7). */
  saveLayout(entity: string, kind: 'form' | 'list', layout: unknown): Promise<Layout> {
    AccessControl.assert(P.customizationManage);
    return this.uow.run(async () => {
      const core = await this.assertEntity(entity);
      const custom = (await this.repo.fieldDefs(entity))
        .filter((f) => f.status === 'active')
        .map((f) => `${entity.startsWith('custom.') ? 'data' : 'ext'}.${f.apiName}`);
      const known = new Set([...core, ...custom]);
      const referenced = layoutFields(kind, layout);
      const unknown = referenced.filter((f) => !known.has(f));
      if (unknown.length > 0) {
        throw new ValidationError(
          'platform.layout.field_unknown',
          `Unknown fields: ${unknown.join(', ')}`,
          { unknown },
          [{ path: 'layout', code: 'platform.layout.field_unknown', message: unknown.join(', ') }],
        );
      }
      const saved = await this.repo.upsertLayout(entity, kind, layout, newId());
      await this.changes.record({
        entityType: 'platform.ui_layout',
        entityId: `${entity}:${kind}`,
        action: 'save',
        after: { entity, kind, layout },
      });
      return saved;
    });
  }

  /** Throws unless filters only use fields the caller may see (hidden values must not leak). */
  static assertFilterable(entity: string, filters: readonly ValueFilter[]): void {
    for (const f of filters) {
      if (AccessControl.fieldAccess(entity, `ext.${f.field}`) === 'hidden') {
        throw new ForbiddenError('authz.field_hidden', `You cannot filter on "${f.field}"`, {
          field: f.field,
        });
      }
    }
  }

  // ----- internals -----------------------------------------------------------------------------

  /** Core field names of an entity; custom objects must exist and be active. */
  private async assertEntity(entity: string): Promise<string[]> {
    const core = extensibleEntity(entity);
    if (core) return core.coreFields.map((f) => f.name);
    if (entity.startsWith('custom.')) {
      const object = await this.repo.findObjectByName(entity.slice('custom.'.length));
      if (object) return CUSTOM_RECORD_CORE_FIELDS.map((f) => f.name);
    }
    throw new NotFoundError('Entity', entity);
  }

  private record(
    action: 'create' | 'update',
    before: FieldDef | undefined,
    after: FieldDef,
  ): Promise<void> {
    const snap = (f: FieldDef) => ({
      id: f.id,
      entity: f.entity,
      apiName: f.apiName,
      dataType: f.dataType,
      required: f.required,
      status: f.status,
    });
    return this.changes.record({
      entityType: 'platform.custom_field',
      entityId: after.id,
      action,
      before,
      after,
      event: {
        type:
          action === 'create' ? 'platform.CustomFieldDefined.v1' : 'platform.CustomFieldChanged.v1',
        aggregateType: 'CustomField',
        data: snap(after),
      },
    });
  }
}

function objectEvent(o: ObjectDef) {
  return { id: o.id, apiName: o.apiName, companyScoped: o.companyScoped, status: o.status };
}

function validateLabels(label: I18nText, path: string): void {
  const entries = Object.entries(label);
  if (
    entries.length === 0 ||
    entries.some(([k, v]) => !LANG.test(k) || !v.trim() || v.length > 100)
  ) {
    throw new ValidationError(
      'platform.custom_object.invalid',
      'Give translations like { "en": "Mould" }',
      {},
      [
        {
          path,
          code: 'platform.custom_object.invalid',
          message: 'Use language tags and 1–100 characters',
        },
      ],
    );
  }
}

/** Field names referenced by a layout; also validates its shape. */
function layoutFields(kind: 'form' | 'list', layout: unknown): string[] {
  const invalid = (message: string) =>
    new ValidationError('platform.layout.invalid', message, {}, [
      { path: 'layout', code: 'platform.layout.invalid', message },
    ]);
  if (typeof layout !== 'object' || layout === null) throw invalid('A layout must be an object');
  if (kind === 'list') {
    const columns = (layout as { columns?: unknown }).columns;
    if (
      !Array.isArray(columns) ||
      columns.length === 0 ||
      columns.length > 50 ||
      !columns.every((c) => typeof c === 'string')
    ) {
      throw invalid('A list layout needs "columns": 1–50 field names');
    }
    return columns;
  }
  const sections = (layout as { sections?: unknown }).sections;
  if (!Array.isArray(sections) || sections.length === 0 || sections.length > 20) {
    throw invalid('A form layout needs "sections": 1–20 sections');
  }
  const fields: string[] = [];
  for (const s of sections) {
    const f = (s as { fields?: unknown } | null)?.fields;
    if (!Array.isArray(f) || !f.every((x) => typeof x === 'string'))
      throw invalid('Each section needs "fields": field names');
    fields.push(...f);
  }
  return fields;
}
