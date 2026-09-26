import { describe, expect, it } from 'vitest';
import { InvariantViolation, ValidationError } from './errors.js';
import { Money } from './money.js';

describe('Money', () => {
  it('adds without floating-point drift', () => {
    const total = Money.of('0.1', 'INR').add(Money.of('0.2', 'INR'));
    expect(total.toJSON()).toEqual({ amount: '0.3', currency: 'INR' });
  });

  it('rejects non-integer JS numbers at the boundary', () => {
    expect(() => Money.of(0.1, 'INR')).toThrow(TypeError);
    expect(Money.of(100, 'INR').toJSON().amount).toBe('100');
  });

  it('normalises currency codes and rejects invalid ones', () => {
    expect(Money.of('1', 'inr').currency).toBe('INR');
    expect(() => Money.of('1', 'RUPEE')).toThrow(ValidationError);
  });

  it('refuses to mix currencies', () => {
    expect(() => Money.of('1', 'INR').add(Money.of('1', 'USD'))).toThrow(InvariantViolation);
    expect(() => Money.of('1', 'INR').compare(Money.of('1', 'USD'))).toThrow(InvariantViolation);
  });

  it('computes GST at 18% and rounds to paise HALF_UP by default', () => {
    const tax = Money.of('1234.56', 'INR').percent('18');
    expect(tax.amount.toFixed()).toBe('222.2208');
    expect(tax.round().toJSON().amount).toBe('222.22');
    expect(Money.of('10.005', 'INR').round().toJSON().amount).toBe('10.01');
  });

  it('supports explicit rounding policies, including rupee round-off', () => {
    expect(Money.of('1456.50', 'INR').round({ scale: 0, mode: 'HALF_UP' }).toJSON().amount).toBe(
      '1457',
    );
    expect(Money.of('2.5', 'INR').round({ scale: 0, mode: 'HALF_EVEN' }).toJSON().amount).toBe('2');
    expect(Money.of('-2.5', 'INR').round({ scale: 0, mode: 'HALF_UP' }).toJSON().amount).toBe('-3');
  });

  it('uses ISO minor units per currency', () => {
    expect(Money.of('100.5', 'JPY').round().toJSON().amount).toBe('101');
    expect(Money.of('1.2345', 'KWD').round().toJSON().amount).toBe('1.235');
  });

  it('allocates with largest remainder so parts sum exactly', () => {
    const parts = Money.of('100', 'INR').allocate(['1', '1', '1']);
    expect(parts.map((p) => p.toJSON().amount)).toEqual(['33.34', '33.33', '33.33']);
    expect(Money.sum(parts, 'INR').equals(Money.of('100', 'INR'))).toBe(true);
  });

  it('allocates negative amounts symmetrically', () => {
    const parts = Money.of('-10', 'INR').allocate(['1', '2']);
    expect(parts.map((p) => p.toJSON().amount)).toEqual(['-3.33', '-6.67']);
  });

  it('allocation weights must be valid', () => {
    const m = Money.of('10', 'INR');
    expect(() => m.allocate([])).toThrow(ValidationError);
    expect(() => m.allocate(['0', '0'])).toThrow(ValidationError);
    expect(() => m.allocate(['-1', '2'])).toThrow(ValidationError);
  });

  it('guards NUMERIC(20,6) storage', () => {
    expect(Money.of('12345678901234.123456', 'INR').toStorage()).toBe('12345678901234.123456');
    expect(() => Money.of('1.1234567', 'INR').toStorage()).toThrow(InvariantViolation);
    expect(() => Money.of('123456789012345', 'INR').toStorage()).toThrow(InvariantViolation);
  });

  it('compares, negates and divides', () => {
    const a = Money.of('5', 'INR');
    const b = Money.of('7', 'INR');
    expect(a.lessThan(b)).toBe(true);
    expect(b.greaterThan(a)).toBe(true);
    expect(a.negate().isNegative()).toBe(true);
    expect(a.negate().abs().equals(a)).toBe(true);
    expect(Money.zero('INR').isZero()).toBe(true);
    expect(Money.zero('INR').isPositive()).toBe(false);
    expect(b.divide('2').toJSON().amount).toBe('3.5');
    expect(() => b.divide('0')).toThrow(InvariantViolation);
    expect(Money.fromJSON({ amount: '1.50', currency: 'INR' }).toString()).toBe('1.5 INR');
  });
});
