import { BusinessRuleViolation, LocalDate, ValidationError, newId } from '@manuling/kernel';

export type FiscalYearStatus = 'open' | 'closed';

export interface FiscalYear {
  readonly id: string;
  readonly companyId: string;
  readonly code: string;
  readonly startDate: LocalDate;
  readonly endDate: LocalDate;
  readonly status: FiscalYearStatus;
  readonly version: number;
}

/**
 * Builds the 12-month fiscal year that starts in `startYear` on the company's start month.
 * Code convention: "2026-27" for split years (India, April–March), "2026" for calendar years.
 */
export function createFiscalYear(
  company: { id: string; fiscalYearStartMonth: number },
  startYear: number,
  existing: readonly Pick<FiscalYear, 'startDate' | 'endDate' | 'code'>[],
): FiscalYear {
  if (!Number.isInteger(startYear) || startYear < 1900 || startYear > 2200) {
    throw new ValidationError(
      'platform.fiscal_year.start_year_invalid',
      'Start year must be between 1900 and 2200',
      {},
      [
        {
          path: 'startYear',
          code: 'platform.fiscal_year.start_year_invalid',
          message: 'Out of range',
        },
      ],
    );
  }
  const startDate = LocalDate.of(startYear, company.fiscalYearStartMonth, 1);
  const endDate = startDate.plusMonths(12).plusDays(-1);
  const code =
    company.fiscalYearStartMonth === 1
      ? String(startYear)
      : `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;

  const clash = existing.find(
    (fy) => fy.startDate.compare(endDate) <= 0 && startDate.compare(fy.endDate) <= 0,
  );
  if (clash) {
    throw new BusinessRuleViolation(
      'platform.fiscal_year.overlaps',
      `Fiscal year ${code} overlaps ${clash.code}`,
      {
        code,
        overlaps: clash.code,
      },
    );
  }
  return {
    id: newId(),
    companyId: company.id,
    code,
    startDate,
    endDate,
    status: 'open',
    version: 1,
  };
}
