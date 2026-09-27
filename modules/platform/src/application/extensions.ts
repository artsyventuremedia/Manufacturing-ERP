import { AccessControl } from '@manuling/authz';
import { ValidationError } from '@manuling/kernel';
import { Injectable } from '@nestjs/common';
import {
  type ExtValues,
  type FieldDef,
  type I18nText,
  type ValueFilter,
  parseFilters,
  prepareValues,
} from '../domain/custom-fields.js';
import { CustomisationRepository } from '../infrastructure/customisation.repository.js';

export interface CoreField {
  readonly name: string;
  readonly label: I18nText;
}

export interface ExtensibleEntity {
  readonly name: string;
  readonly label: I18nText;
  /** Built-in fields, for layouts and exports. */
  readonly coreFields: readonly CoreField[];
  /** Whether custom reference fields may point at this entity. */
  readonly referenceable: boolean;
}

/**
 * Core entities that validate and present `ext` (plan C5). Modules register theirs when
 * they gain custom-field support.
 */
const registry = new Map<string, ExtensibleEntity>();

export function registerExtensibleEntity(entity: ExtensibleEntity): void {
  registry.set(entity.name, entity);
}

export function extensibleEntity(name: string): ExtensibleEntity | undefined {
  return registry.get(name);
}

export function extensibleEntities(): ExtensibleEntity[] {
  return [...registry.values()];
}

registerExtensibleEntity({
  name: 'platform.company',
  label: { en: 'Company' },
  referenceable: true,
  coreFields: [
    { name: 'code', label: { en: 'Code' } },
    { name: 'legalName', label: { en: 'Legal name' } },
    { name: 'baseCurrency', label: { en: 'Base currency' } },
    { name: 'countryCode', label: { en: 'Country' } },
    { name: 'fiscalYearStartMonth', label: { en: 'Fiscal year start' } },
    { name: 'status', label: { en: 'Status' } },
  ],
});
registerExtensibleEntity({
  name: 'platform.plant',
  label: { en: 'Plant' },
  referenceable: true,
  coreFields: [
    { name: 'code', label: { en: 'Code' } },
    { name: 'name', label: { en: 'Name' } },
    { name: 'regionCode', label: { en: 'Region' } },
    { name: 'timezone', label: { en: 'Time zone' } },
    { name: 'status', label: { en: 'Status' } },
  ],
});

/** Fields every custom object record has (for layouts and exports). */
export const CUSTOM_RECORD_CORE_FIELDS: readonly CoreField[] = [
  { name: 'id', label: { en: 'Id' } },
  { name: 'companyId', label: { en: 'Company' } },
  { name: 'createdAt', label: { en: 'Created' } },
  { name: 'updatedAt', label: { en: 'Updated' } },
];

/**
 * Validates custom values on writes (types, required, references in the same tenant,
 * field-level write rules) and filters them on reads (archived fields and field policies),
 * for core entities (`ext`) and custom objects (`data`). Runs inside a UnitOfWork.
 */
@Injectable()
export class ExtensionService {
  constructor(private readonly repo: CustomisationRepository) {}

  defs(entity: string): Promise<FieldDef[]> {
    return this.repo.fieldDefs(entity);
  }

  /**
   * Validated values for a write. `existing` undefined = create. `policyEntity` is the
   * field-policy entity (the core entity, or `custom.<object>`).
   */
  async prepare(
    entity: string,
    input: unknown,
    existing: ExtValues | undefined,
    prefix: 'ext' | 'data' = 'ext',
  ): Promise<ExtValues> {
    if (input === undefined && existing !== undefined) return existing;
    const defs = await this.repo.fieldDefs(entity);
    if (input && typeof input === 'object') {
      for (const key of Object.keys(input))
        AccessControl.assertWritable(entity, { [`ext.${key}`]: true });
    }
    const { values, references } = prepareValues(defs, input, existing, prefix);
    const byTarget = new Map<string, typeof references>();
    for (const ref of references)
      byTarget.set(ref.target, [...(byTarget.get(ref.target) ?? []), ref]);
    const missing: { path: string; code: string; message: string }[] = [];
    for (const [target, refs] of byTarget) {
      const found = await this.repo.existingReferences(
        target,
        refs.map((r) => r.id),
      );
      for (const r of refs) {
        if (!found.has(r.id))
          missing.push({
            path: r.path,
            code: 'platform.custom_field.reference_missing',
            message: `No ${target} with this id`,
          });
      }
    }
    if (missing.length > 0) {
      throw new ValidationError(
        'platform.custom_field.reference_missing',
        'Some references point to missing records',
        {},
        missing,
      );
    }
    return values;
  }

  /** Values the caller may see: archived fields and fields hidden by policy are dropped. */
  present(entity: string, values: ExtValues, defs: readonly FieldDef[]): ExtValues {
    const visible: ExtValues = {};
    const active = new Set(defs.filter((d) => d.status === 'active').map((d) => d.apiName));
    for (const [key, value] of Object.entries(values)) {
      if (!active.has(key)) continue;
      if (AccessControl.fieldAccess(entity, `ext.${key}`) === 'hidden') continue;
      visible[key] = value;
    }
    return visible;
  }

  async filters(
    entity: string,
    query: Readonly<Record<string, unknown>>,
    prefix: 'ext' | 'data',
  ): Promise<ValueFilter[]> {
    const hasFilter = Object.keys(query).some((k) => k.startsWith(`${prefix}.`));
    return hasFilter ? parseFilters(query, prefix, await this.repo.fieldDefs(entity)) : [];
  }
}
