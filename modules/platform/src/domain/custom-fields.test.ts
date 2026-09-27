import { ValidationError } from '@manuling/kernel';
import { describe, expect, it } from 'vitest';
import {
  type FieldDef,
  changeFieldDef,
  coerceValue,
  createFieldDef,
  labelFor,
  parseFilters,
  prepareValues,
} from './custom-fields.js';

const ctx = {
  isExtensible: (e: string) => e === 'platform.company' || e === 'custom.mould',
  isReferenceable: (e: string) => e === 'platform.plant',
};
const field = (
  over: Partial<Parameters<typeof createFieldDef>[0]> & { apiName: string; dataType: string },
): FieldDef =>
  createFieldDef({ entity: 'platform.company', label: { en: over.apiName }, ...over }, ctx);

describe('field definitions', () => {
  it('validates entity, name, type, labels, settings and options with paths', () => {
    try {
      createFieldDef(
        {
          entity: 'platform.nope',
          apiName: 'Bad Name',
          dataType: 'money',
          label: {},
          settings: { scale: 9 },
          options: [{ value: 'a' }],
        },
        ctx,
      );
      expect.fail('should throw');
    } catch (err) {
      expect((err as ValidationError).fieldErrors.map((e) => e.path).sort()).toEqual([
        'apiName',
        'dataType',
        'entity',
        'label',
      ]);
    }
    expect(() => field({ apiName: 'weight', dataType: 'decimal', settings: { scale: 9 } })).toThrow(
      ValidationError,
    );
    expect(() =>
      field({
        apiName: 'kind',
        dataType: 'select',
        options: [
          { value: 'a', label: { en: 'A' } },
          { value: 'a', label: { en: 'A' } },
        ],
      }),
    ).toThrow(ValidationError);
    expect(() =>
      field({ apiName: 'plant', dataType: 'reference', settings: { target: 'platform.secret' } }),
    ).toThrow(ValidationError);
  });

  it('validates the default against the type', () => {
    expect(field({ apiName: 'capacity', dataType: 'integer', defaultValue: 10 }).defaultValue).toBe(
      10,
    );
    expect(() => field({ apiName: 'capacity', dataType: 'integer', defaultValue: '10' })).toThrow(
      ValidationError,
    );
  });

  it('never removes options, only adds or relabels', () => {
    const kind = field({
      apiName: 'kind',
      dataType: 'select',
      options: [{ value: 'cnc', label: { en: 'CNC' } }],
    });
    const more = changeFieldDef(kind, {
      options: [
        { value: 'cnc', label: { en: 'CNC machining' } },
        { value: 'press', label: { en: 'Press' } },
      ],
    });
    expect(more.options?.map((o) => o.value)).toEqual(['cnc', 'press']);
    expect(() =>
      changeFieldDef(more, { options: [{ value: 'press', label: { en: 'Press' } }] }),
    ).toThrow(
      expect.objectContaining({
        fieldErrors: [
          expect.objectContaining({
            path: 'options',
            message: expect.stringMatching(/cannot be removed/),
          }),
        ],
      }),
    );
  });
});

describe('values', () => {
  const defs = [
    field({ apiName: 'capacity', dataType: 'integer', settings: { min: '0', max: '1000' } }),
    field({ apiName: 'rate', dataType: 'decimal', settings: { scale: 2 } }),
    field({ apiName: 'certified', dataType: 'boolean', required: true, defaultValue: false }),
    field({
      apiName: 'kind',
      dataType: 'select',
      options: [{ value: 'cnc', label: { en: 'CNC' } }],
    }),
    field({
      apiName: 'tags',
      dataType: 'multi_select',
      options: [
        { value: 'a', label: { en: 'A' } },
        { value: 'b', label: { en: 'B' } },
      ],
    }),
    field({ apiName: 'plant', dataType: 'reference', settings: { target: 'platform.plant' } }),
    { ...field({ apiName: 'legacy', dataType: 'text' }), status: 'archived' as const },
  ];

  it('applies defaults, normalises values and collects references on create', () => {
    const plant = '01A0DC39-8895-7290-9C99-5E6B26712E0F';
    const out = prepareValues(
      defs,
      { capacity: 12, rate: '7.5', tags: ['a', 'a'], plant },
      undefined,
      'ext',
    );
    expect(out.values).toEqual({
      certified: false,
      capacity: 12,
      rate: '7.50',
      tags: ['a'],
      plant: plant.toLowerCase(),
    });
    expect(out.references).toEqual([
      { path: 'ext.plant', target: 'platform.plant', id: plant.toLowerCase() },
    ]);
  });

  it('merges on update, clears with null and keeps archived values', () => {
    const out = prepareValues(
      defs,
      { capacity: null, kind: 'cnc' },
      { capacity: 5, certified: true, legacy: 'old' },
      'ext',
    );
    expect(out.values).toEqual({ certified: true, kind: 'cnc', legacy: 'old' });
  });

  it('reports every invalid value with its path', () => {
    try {
      prepareValues(
        defs,
        { capacity: 1001, rate: '1.234', kind: 'lathe', nope: 1, legacy: 'x', certified: null },
        { certified: true },
        'ext',
      );
      expect.fail('should throw');
    } catch (err) {
      expect((err as ValidationError).fieldErrors.map((e) => [e.path, e.code])).toEqual([
        ['ext.capacity', 'platform.custom_field.value_invalid'],
        ['ext.rate', 'platform.custom_field.value_invalid'],
        ['ext.kind', 'platform.custom_field.value_invalid'],
        ['ext.nope', 'platform.custom_field.unknown'],
        ['ext.legacy', 'platform.custom_field.archived'],
        ['ext.certified', 'platform.custom_field.required'],
      ]);
    }
    expect(() => prepareValues(defs, 'x', undefined, 'ext')).toThrow(ValidationError);
  });

  it('checks every type', () => {
    const t = (dataType: string, settings?: object) =>
      field({ apiName: 'xx', dataType, ...(settings ? { settings } : {}) });
    expect(coerceValue(t('date'), '2026-02-30')).toHaveProperty('error');
    expect(coerceValue(t('date'), '2026-09-27')).toEqual({ value: '2026-09-27' });
    expect(coerceValue(t('datetime'), '2026-09-27T10:00:00+05:30')).toEqual({
      value: '2026-09-27T04:30:00.000Z',
    });
    expect(coerceValue(t('datetime'), '2026-09-27T10:00:00')).toHaveProperty('error');
    expect(coerceValue(t('email'), ' Buyer@Plant.IN ')).toEqual({ value: 'buyer@plant.in' });
    expect(coerceValue(t('url'), 'ftp://x')).toHaveProperty('error');
    expect(coerceValue(t('phone'), '+91 821 240 0000')).toEqual({ value: '+91 821 240 0000' });
    expect(coerceValue(t('text', { maxLength: 3 }), 'abcd')).toHaveProperty('error');
    expect(coerceValue(t('long_text'), 'x'.repeat(10_001))).toHaveProperty('error');
    expect(coerceValue(t('decimal'), 5)).toEqual({ value: '5.00' });
    expect(coerceValue(t('decimal'), 5.5)).toHaveProperty('error');
    expect(coerceValue(t('boolean'), 'true')).toHaveProperty('error');
  });
});

describe('filters and labels', () => {
  const defs = [
    field({ apiName: 'capacity', dataType: 'integer' }),
    field({ apiName: 'rate', dataType: 'decimal' }),
    field({
      apiName: 'kind',
      dataType: 'select',
      options: [{ value: 'cnc', label: { en: 'CNC', kn: 'ಸಿಎನ್‌ಸಿ' } }],
    }),
    field({ apiName: 'certified', dataType: 'boolean' }),
  ];

  it('parses typed filters and ignores unrelated params', () => {
    expect(
      parseFilters(
        {
          'ext.capacity[gte]': '10',
          'ext.kind': 'cnc',
          'ext.certified': 'true',
          'ext.rate[lt]': '9.999',
          limit: '5',
        },
        'ext',
        defs,
      ),
    ).toEqual([
      { field: 'capacity', op: 'gte', dataType: 'integer', value: 10 },
      { field: 'kind', op: 'eq', dataType: 'select', value: 'cnc' },
      { field: 'certified', op: 'eq', dataType: 'boolean', value: true },
      { field: 'rate', op: 'lt', dataType: 'decimal', value: '9.999000' },
    ]);
    expect(() => parseFilters({ 'ext.kind[gte]': 'cnc' }, 'ext', defs)).toThrow(ValidationError);
    expect(() => parseFilters({ 'ext.nope': 'x' }, 'ext', defs)).toThrow(ValidationError);
    expect(() => parseFilters({ 'ext.capacity': 'ten' }, 'ext', defs)).toThrow(ValidationError);
  });

  it('picks labels by locale', () => {
    const label = { en: 'Kind', kn: 'ವಿಧ' };
    expect(labelFor(label, 'kn-IN', 'kind')).toBe('ವಿಧ');
    expect(labelFor(label, 'hi-IN', 'kind')).toBe('Kind');
    expect(labelFor(null, 'en-IN', 'kind')).toBe('kind');
  });
});
