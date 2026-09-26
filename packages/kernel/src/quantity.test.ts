import { describe, expect, it } from 'vitest';
import { InvariantViolation, ValidationError } from './errors.js';
import { Quantity } from './quantity.js';

describe('Quantity', () => {
  it('adds in the same UoM and refuses mixed units', () => {
    expect(Quantity.of('1.5', 'kg').add(Quantity.of('2.25', 'KG')).toJSON()).toEqual({
      value: '3.75',
      uom: 'KG',
    });
    expect(() => Quantity.of('1', 'KG').add(Quantity.of('1', 'NOS'))).toThrow(InvariantViolation);
  });

  it('converts explicitly with a positive factor', () => {
    expect(Quantity.of('3', 'BOX').convert('12', 'NOS').toJSON()).toEqual({
      value: '36',
      uom: 'NOS',
    });
    expect(() => Quantity.of('3', 'BOX').convert('0', 'NOS')).toThrow(ValidationError);
  });

  it('rounds and guards storage precision', () => {
    const q = Quantity.of('1.23456789', 'KG');
    expect(() => q.toStorage()).toThrow(InvariantViolation);
    expect(q.round({ scale: 3, mode: 'HALF_UP' }).toStorage()).toBe('1.235');
  });

  it('rejects invalid UoM codes', () => {
    expect(() => Quantity.of('1', 'kilo gram')).toThrow(ValidationError);
  });

  it('compares and detects sign', () => {
    expect(Quantity.of('2', 'NOS').compare(Quantity.of('3', 'NOS'))).toBe(-1);
    expect(Quantity.of('2', 'NOS').negate().isNegative()).toBe(true);
    expect(Quantity.zero('NOS').isZero()).toBe(true);
    expect(Quantity.of('2', 'NOS').subtract(Quantity.of('2', 'NOS')).isZero()).toBe(true);
    expect(Quantity.of('2', 'NOS').multiply('1.5').equals(Quantity.of('3', 'NOS'))).toBe(true);
    expect(Quantity.fromJSON({ value: '4', uom: 'mtr' }).toString()).toBe('4 MTR');
  });
});
