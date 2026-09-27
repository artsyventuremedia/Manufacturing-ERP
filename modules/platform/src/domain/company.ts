import { BusinessRuleViolation, newId, parseCurrency } from '@manuling/kernel';
import { parseCode, parseCountry, parseMonth, parseName } from './validation.js';

export type CompanyStatus = 'active' | 'inactive';

export interface Company {
  readonly id: string;
  readonly code: string;
  readonly legalName: string;
  readonly baseCurrency: string;
  readonly countryCode: string;
  readonly fiscalYearStartMonth: number;
  readonly status: CompanyStatus;
  readonly version: number;
  /** Custom field values (validated against field definitions, step 0.9). */
  readonly ext: Readonly<Record<string, unknown>>;
}

export interface NewCompany {
  readonly code: string;
  readonly legalName: string;
  readonly baseCurrency: string;
  readonly countryCode: string;
  readonly fiscalYearStartMonth?: number | undefined;
}

/** Statutory fiscal-year start by country; April for India (1 Apr – 31 Mar). */
const DEFAULT_FY_START: Readonly<Record<string, number>> = {
  IN: 4,
  JP: 4,
  NZ: 4,
  AU: 7,
  EG: 7,
  PK: 7,
  BD: 7,
};

export function defaultFiscalYearStartMonth(countryCode: string): number {
  return DEFAULT_FY_START[countryCode] ?? 1;
}

export function createCompany(input: NewCompany): Company {
  const countryCode = parseCountry(input.countryCode);
  return {
    id: newId(),
    code: parseCode(input.code, 'code'),
    legalName: parseName(input.legalName, 'legalName'),
    baseCurrency: parseCurrency(input.baseCurrency),
    countryCode,
    fiscalYearStartMonth:
      input.fiscalYearStartMonth === undefined
        ? defaultFiscalYearStartMonth(countryCode)
        : parseMonth(input.fiscalYearStartMonth, 'fiscalYearStartMonth'),
    status: 'active',
    version: 1,
    ext: {},
  };
}

export interface CompanyChanges {
  readonly legalName?: string | undefined;
  readonly status?: CompanyStatus | undefined;
  readonly fiscalYearStartMonth?: number | undefined;
}

/**
 * Applies editable changes. Base currency and country are immutable: every ledger amount
 * and statutory rule depends on them (ADR-0006, ADR-0011).
 */
export function changeCompany(
  company: Company,
  changes: CompanyChanges,
  hasFiscalYears: boolean,
): Company {
  let fiscalYearStartMonth = company.fiscalYearStartMonth;
  if (
    changes.fiscalYearStartMonth !== undefined &&
    changes.fiscalYearStartMonth !== fiscalYearStartMonth
  ) {
    if (hasFiscalYears) {
      throw new BusinessRuleViolation(
        'platform.company.fiscal_calendar_locked',
        'The fiscal-year start cannot change once fiscal years exist',
      );
    }
    fiscalYearStartMonth = parseMonth(changes.fiscalYearStartMonth, 'fiscalYearStartMonth');
  }
  return {
    ...company,
    legalName:
      changes.legalName === undefined
        ? company.legalName
        : parseName(changes.legalName, 'legalName'),
    status: changes.status ?? company.status,
    fiscalYearStartMonth,
  };
}
