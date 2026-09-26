import { BusinessRuleViolation, LocalDate, ValidationError } from '@manuling/kernel';
import { describe, expect, it } from 'vitest';
import { changeSeries, createSeries, parsePattern, renderNumber } from './numbering.js';

const date = LocalDate.parse('2026-09-26');
const input = {
  sequence: 7n,
  documentDate: date,
  companyCode: 'MPC',
  plantCode: 'MYS1',
  fiscalYearCode: '2026-27',
};

describe('patterns', () => {
  it('renders every token', () => {
    expect(renderNumber(parsePattern('INV/{PLANT}/{FY}/{#####}'), input)).toBe(
      'INV/MYS1/2026-27/00007',
    );
    expect(renderNumber(parsePattern('{COMPANY}-{YYYY}{MM}-{###}'), input)).toBe('MPC-202609-007');
    expect(renderNumber(parsePattern('SI{FYS}{YY}{#}'), input)).toBe('SI2627267');
    expect(renderNumber(parsePattern('{##}'), { ...input, sequence: 12345n })).toBe('12345');
  });

  it('rejects bad patterns', () => {
    for (const bad of [
      'INV/{FY}',
      '{#}{#}',
      'INV {###}',
      'INV/{XX}/{###}',
      `{${'#'.repeat(13)}}`,
      'A_B{#}',
    ]) {
      expect(() => parsePattern(bad)).toThrow(ValidationError);
    }
  });

  it('needs the context its tokens use', () => {
    expect(() =>
      renderNumber(parsePattern('{PLANT}{#}'), { ...input, plantCode: undefined }),
    ).toThrow(BusinessRuleViolation);
    expect(() =>
      renderNumber(parsePattern('{FY}{#}'), { ...input, fiscalYearCode: undefined }),
    ).toThrow(BusinessRuleViolation);
  });
});

describe('series', () => {
  const base = {
    code: 'inv',
    docType: 'sales.invoice',
    pattern: 'INV/{PLANT}/{FY}/{#####}',
    gapless: true,
    scope: 'plant' as const,
    resetPolicy: 'fiscal_year' as const,
  };

  it('validates doc type and pattern/scope/reset coherence', () => {
    expect(createSeries('c1', base)).toMatchObject({
      code: 'INV',
      startValue: 1,
      maxLength: null,
      isDefault: false,
    });
    expect(() => createSeries('c1', { ...base, docType: 'Invoice' })).toThrow(ValidationError);
    expect(() => createSeries('c1', { ...base, scope: 'company' })).toThrow(
      expect.objectContaining({ code: 'platform.numbering.scope_mismatch' }),
    );
    expect(() => createSeries('c1', { ...base, resetPolicy: 'never' })).toThrow(
      expect.objectContaining({ code: 'platform.numbering.reset_mismatch' }),
    );
    expect(() => createSeries('c1', { ...base, startValue: -1 })).toThrow(ValidationError);
  });

  it('locks the format once numbers were issued', () => {
    const s = createSeries('c1', base);
    expect(changeSeries(s, { pattern: 'SI/{PLANT}/{FY}/{####}' }, false).pattern).toBe(
      'SI/{PLANT}/{FY}/{####}',
    );
    expect(() => changeSeries(s, { pattern: 'SI/{PLANT}/{FY}/{####}' }, true)).toThrow(
      expect.objectContaining({ code: 'platform.numbering.series_in_use' }),
    );
    expect(() => changeSeries(s, { maxLength: 16 }, true)).toThrow(BusinessRuleViolation);
    expect(changeSeries(s, { status: 'inactive', isDefault: true }, true)).toMatchObject({
      status: 'inactive',
      isDefault: true,
    });
  });
});
