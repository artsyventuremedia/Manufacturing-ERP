/**
 * In-process API for issuing document numbers (ADR-0002 port). Call it inside the use case's
 * UnitOfWork: gapless series then commit or roll back together with the document.
 */
export interface NumberingPort {
  next(request: NumberRequest): Promise<IssuedNumber>;
}

export interface NumberRequest {
  readonly companyId: string;
  /** `module.document`, e.g. `sales.invoice`. */
  readonly docType: string;
  /** ISO date (YYYY-MM-DD) that selects the fiscal year and date tokens. */
  readonly documentDate: string;
  /** Required for plant-scoped series. */
  readonly plantId?: string;
  /** A specific series; otherwise the default series of the document type. */
  readonly seriesCode?: string;
}

export interface IssuedNumber {
  readonly number: string;
  readonly sequence: string;
  readonly seriesId: string;
  readonly fiscalYearId: string | null;
}

export const NUMBERING_PORT = Symbol('NUMBERING_PORT');
