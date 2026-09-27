import { newId } from '@manuling/kernel';
import { parseCode, parseName, parseRegion, parseTimezone } from './validation.js';

export type PlantStatus = 'active' | 'inactive';

export interface Plant {
  readonly id: string;
  readonly companyId: string;
  readonly code: string;
  readonly name: string;
  readonly regionCode: string | null;
  readonly timezone: string;
  readonly status: PlantStatus;
  readonly version: number;
  /** Custom field values (validated against field definitions, step 0.9). */
  readonly ext: Readonly<Record<string, unknown>>;
}

export interface NewPlant {
  readonly code: string;
  readonly name: string;
  readonly regionCode?: string | undefined;
  readonly timezone: string;
}

export function createPlant(company: { id: string; countryCode: string }, input: NewPlant): Plant {
  return {
    id: newId(),
    companyId: company.id,
    code: parseCode(input.code, 'code'),
    name: parseName(input.name, 'name'),
    regionCode:
      input.regionCode === undefined ? null : parseRegion(input.regionCode, company.countryCode),
    timezone: parseTimezone(input.timezone),
    status: 'active',
    version: 1,
    ext: {},
  };
}

export interface PlantChanges {
  readonly name?: string | undefined;
  readonly regionCode?: string | null | undefined;
  readonly timezone?: string | undefined;
  readonly status?: PlantStatus | undefined;
}

export function changePlant(plant: Plant, countryCode: string, changes: PlantChanges): Plant {
  return {
    ...plant,
    name: changes.name === undefined ? plant.name : parseName(changes.name, 'name'),
    regionCode:
      changes.regionCode === undefined
        ? plant.regionCode
        : changes.regionCode === null
          ? null
          : parseRegion(changes.regionCode, countryCode),
    timezone: changes.timezone === undefined ? plant.timezone : parseTimezone(changes.timezone),
    status: changes.status ?? plant.status,
  };
}
