import { BusinessRuleViolation, type LocalDate, ValidationError, newId } from '@manuling/kernel';
import { parseCode } from './validation.js';

/** A parsed pattern: literal text interleaved with tokens. */
export type PatternPart =
  | { readonly kind: 'literal'; readonly text: string }
  | { readonly kind: 'fy' | 'fyShort' | 'yyyy' | 'yy' | 'mm' | 'company' | 'plant' }
  | { readonly kind: 'counter'; readonly width: number };

const TOKEN = /\{([A-Z]+|#+)\}/g;
const LITERAL = /^[A-Za-z0-9/-]*$/;
const TOKENS: Readonly<Record<string, PatternPart['kind']>> = {
  FY: 'fy',
  FYS: 'fyShort',
  YYYY: 'yyyy',
  YY: 'yy',
  MM: 'mm',
  COMPANY: 'company',
  PLANT: 'plant',
};

/**
 * Parses `INV/{PLANT}/{FY}/{#####}`. Exactly one counter token is required; literals are
 * limited to letters, digits, `/` and `-` so numbers are valid GST document numbers.
 */
export function parsePattern(pattern: string): PatternPart[] {
  const parts: PatternPart[] = [];
  let last = 0;
  let counters = 0;
  for (const match of pattern.matchAll(TOKEN)) {
    const literal = pattern.slice(last, match.index);
    if (literal) parts.push(literalPart(literal));
    const name = match[1]!;
    if (name.startsWith('#')) {
      if (name.length > 12) throw invalid('Counter width must be at most 12 digits');
      parts.push({ kind: 'counter', width: name.length });
      counters++;
    } else {
      const kind = TOKENS[name];
      if (!kind) throw invalid(`Unknown token {${name}}`);
      parts.push({ kind } as PatternPart);
    }
    last = match.index + match[0].length;
  }
  const tail = pattern.slice(last);
  if (tail) parts.push(literalPart(tail));
  if (counters !== 1) throw invalid('The pattern needs exactly one counter token such as {#####}');
  return parts;
}

export interface RenderInput {
  readonly sequence: bigint;
  readonly documentDate: LocalDate;
  readonly companyCode: string;
  readonly plantCode?: string | undefined;
  readonly fiscalYearCode?: string | undefined;
}

export function renderNumber(parts: readonly PatternPart[], input: RenderInput): string {
  return parts
    .map((p) => {
      switch (p.kind) {
        case 'literal':
          return p.text;
        case 'counter':
          return input.sequence.toString().padStart(p.width, '0');
        case 'yyyy':
          return String(input.documentDate.year).padStart(4, '0');
        case 'yy':
          return String(input.documentDate.year % 100).padStart(2, '0');
        case 'mm':
          return String(input.documentDate.month).padStart(2, '0');
        case 'company':
          return input.companyCode;
        case 'plant':
          if (!input.plantCode)
            throw new BusinessRuleViolation(
              'platform.numbering.plant_required',
              'This series needs a plant',
            );
          return input.plantCode;
        case 'fy':
        case 'fyShort': {
          if (!input.fiscalYearCode) {
            throw new BusinessRuleViolation(
              'platform.numbering.fiscal_year_required',
              'This series needs a fiscal year',
            );
          }
          return p.kind === 'fy'
            ? input.fiscalYearCode
            : input.fiscalYearCode.replace(/\D/g, '').slice(-4);
        }
      }
    })
    .join('');
}

export function usesToken(parts: readonly PatternPart[], kind: PatternPart['kind']): boolean {
  return parts.some((p) => p.kind === kind);
}

// ----- series -------------------------------------------------------------------------

export type CounterScope = 'company' | 'plant';
export type ResetPolicy = 'fiscal_year' | 'never';

export interface NumberingSeries {
  readonly id: string;
  readonly companyId: string;
  readonly code: string;
  readonly docType: string;
  readonly pattern: string;
  readonly gapless: boolean;
  readonly scope: CounterScope;
  readonly resetPolicy: ResetPolicy;
  readonly startValue: number;
  readonly maxLength: number | null;
  readonly isDefault: boolean;
  readonly status: 'active' | 'inactive';
  readonly version: number;
}

const DOC_TYPE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

export interface NewSeries {
  readonly code: string;
  readonly docType: string;
  readonly pattern: string;
  readonly gapless: boolean;
  readonly scope: CounterScope;
  readonly resetPolicy: ResetPolicy;
  readonly startValue?: number | undefined;
  readonly maxLength?: number | undefined;
  readonly isDefault?: boolean | undefined;
}

export function createSeries(companyId: string, input: NewSeries): NumberingSeries {
  if (!DOC_TYPE.test(input.docType)) {
    throw fieldError(
      'docType',
      'platform.numbering.doc_type_invalid',
      'Use "module.document", e.g. sales.invoice',
    );
  }
  const parts = parsePattern(input.pattern);
  validateCoherence(parts, input.scope, input.resetPolicy);
  const startValue = input.startValue ?? 1;
  if (!Number.isSafeInteger(startValue) || startValue < 0) {
    throw fieldError(
      'startValue',
      'platform.numbering.start_invalid',
      'Start value must be a non-negative integer',
    );
  }
  return {
    id: newId(),
    companyId,
    code: parseCode(input.code, 'code'),
    docType: input.docType,
    pattern: input.pattern,
    gapless: input.gapless,
    scope: input.scope,
    resetPolicy: input.resetPolicy,
    startValue,
    maxLength: input.maxLength ?? null,
    isDefault: input.isDefault ?? false,
    status: 'active',
    version: 1,
  };
}

export interface SeriesChanges {
  readonly pattern?: string | undefined;
  readonly maxLength?: number | null | undefined;
  readonly isDefault?: boolean | undefined;
  readonly status?: 'active' | 'inactive' | undefined;
}

/** Pattern and length can only change before the first number is issued (continuity). */
export function changeSeries(
  series: NumberingSeries,
  changes: SeriesChanges,
  inUse: boolean,
): NumberingSeries {
  const structural =
    (changes.pattern !== undefined && changes.pattern !== series.pattern) ||
    (changes.maxLength !== undefined && changes.maxLength !== series.maxLength);
  if (structural && inUse) {
    throw new BusinessRuleViolation(
      'platform.numbering.series_in_use',
      'This series has issued numbers; create a new series instead of changing its format',
    );
  }
  if (changes.pattern !== undefined)
    validateCoherence(parsePattern(changes.pattern), series.scope, series.resetPolicy);
  return {
    ...series,
    pattern: changes.pattern ?? series.pattern,
    maxLength: changes.maxLength === undefined ? series.maxLength : changes.maxLength,
    isDefault: changes.isDefault ?? series.isDefault,
    status: changes.status ?? series.status,
  };
}

/**
 * A number must be unique within its counter: a plant token needs a plant-scoped counter,
 * and a series that never resets must not print a fiscal year it does not reset on.
 */
function validateCoherence(
  parts: readonly PatternPart[],
  scope: CounterScope,
  reset: ResetPolicy,
): void {
  if (usesToken(parts, 'plant') && scope !== 'plant') {
    throw fieldError(
      'scope',
      'platform.numbering.scope_mismatch',
      'A pattern with {PLANT} needs a plant-scoped counter',
    );
  }
  if ((usesToken(parts, 'fy') || usesToken(parts, 'fyShort')) && reset !== 'fiscal_year') {
    throw fieldError(
      'resetPolicy',
      'platform.numbering.reset_mismatch',
      'A pattern with {FY} must reset every fiscal year',
    );
  }
}

function literalPart(text: string): PatternPart {
  if (!LITERAL.test(text)) throw invalid(`"${text}" may contain only letters, digits, "/" and "-"`);
  return { kind: 'literal', text };
}

function invalid(message: string): ValidationError {
  return fieldError('pattern', 'platform.numbering.pattern_invalid', message);
}

function fieldError(path: string, code: string, message: string): ValidationError {
  return new ValidationError(code, message, { field: path }, [{ path, code, message }]);
}
