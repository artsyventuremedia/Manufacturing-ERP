import { type CurrencyCode, currencyScale, parseCurrency } from './currency.js';
import { Decimal, type DecimalInput, decimalToString, fitsNumeric, toDecimal } from './decimal.js';
import { InvariantViolation, ValidationError } from './errors.js';
import { type RoundingPolicy, roundDecimal } from './rounding.js';

/** Storage limits for money columns: NUMERIC(20,6) (ADR-0008). */
export const MONEY_PRECISION = 20;
export const MONEY_SCALE = 6;

export interface MoneyJson {
  readonly amount: string;
  readonly currency: string;
}

/**
 * Immutable monetary amount. Arithmetic keeps full precision; rounding happens only when
 * {@link Money.round} is called with an explicit (or currency-default) policy.
 */
export class Money {
  private constructor(
    readonly amount: Decimal,
    readonly currency: CurrencyCode,
  ) {}

  static of(amount: DecimalInput, currency: string): Money {
    return new Money(toDecimal(amount), parseCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(new Decimal(0), parseCurrency(currency));
  }

  static fromJSON(json: MoneyJson): Money {
    return Money.of(json.amount, json.currency);
  }

  /** Sums a list; an empty list returns zero in the given currency. */
  static sum(items: readonly Money[], currency: string): Money {
    return items.reduce((acc, m) => acc.add(m), Money.zero(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount.plus(other.amount), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount.minus(other.amount), this.currency);
  }

  multiply(factor: DecimalInput): Money {
    return new Money(this.amount.times(toDecimal(factor)), this.currency);
  }

  divide(divisor: DecimalInput): Money {
    const d = toDecimal(divisor);
    if (d.isZero()) throw new InvariantViolation('kernel.money.divide_by_zero', 'Division by zero');
    return new Money(this.amount.dividedBy(d), this.currency);
  }

  /** Percentage of this amount, e.g. `percent('18')` for GST at 18%. Unrounded. */
  percent(rate: DecimalInput): Money {
    return new Money(this.amount.times(toDecimal(rate)).dividedBy(100), this.currency);
  }

  negate(): Money {
    return new Money(this.amount.negated(), this.currency);
  }

  abs(): Money {
    return new Money(this.amount.abs(), this.currency);
  }

  /** Rounds to the policy, defaulting to the currency's minor unit with HALF_UP. */
  round(policy?: RoundingPolicy): Money {
    const p = policy ?? { scale: currencyScale(this.currency), mode: 'HALF_UP' };
    return new Money(roundDecimal(this.amount, p), this.currency);
  }

  /**
   * Splits this amount by ratios using the largest-remainder method at the given scale.
   * The parts always sum exactly to `this.round({scale})`. Used for tax, freight and
   * landed-cost apportionment.
   */
  allocate(ratios: readonly DecimalInput[], scale = currencyScale(this.currency)): Money[] {
    if (ratios.length === 0) {
      throw new ValidationError('kernel.money.allocate_empty', 'At least one ratio is required');
    }
    const weights = ratios.map(toDecimal);
    if (weights.some((w) => w.isNegative())) {
      throw new ValidationError('kernel.money.allocate_negative', 'Ratios must not be negative');
    }
    const totalWeight = weights.reduce((a, w) => a.plus(w), new Decimal(0));
    if (totalWeight.isZero()) {
      throw new ValidationError('kernel.money.allocate_zero', 'Ratios must not all be zero');
    }
    const unit = new Decimal(10).pow(scale);
    const total = roundDecimal(this.amount, { scale, mode: 'HALF_UP' });
    const sign = total.isNegative() ? -1 : 1;
    const totalUnits = total.abs().times(unit);

    const exact = weights.map((w) => totalUnits.times(w).dividedBy(totalWeight));
    const floors = exact.map((e) => e.floor());
    let remainder = totalUnits.minus(floors.reduce((a, f) => a.plus(f), new Decimal(0))).toNumber();
    const order = exact
      .map((e, i) => ({ i, frac: e.minus(e.floor()) }))
      .sort((a, b) => b.frac.comparedTo(a.frac) || a.i - b.i);
    const units = [...floors];
    for (const { i } of order) {
      if (remainder <= 0) break;
      units[i] = units[i]!.plus(1);
      remainder -= 1;
    }
    return units.map((u) => new Money(u.dividedBy(unit).times(sign), this.currency));
  }

  isZero(): boolean {
    return this.amount.isZero();
  }

  isPositive(): boolean {
    return this.amount.isPositive() && !this.amount.isZero();
  }

  isNegative(): boolean {
    return this.amount.isNegative() && !this.amount.isZero();
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    return this.amount.comparedTo(other.amount) as -1 | 0 | 1;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amount.equals(other.amount);
  }

  greaterThan(other: Money): boolean {
    return this.compare(other) > 0;
  }

  lessThan(other: Money): boolean {
    return this.compare(other) < 0;
  }

  /** True if the value can be stored in a NUMERIC(20,6) column without rounding. */
  isStorable(): boolean {
    return fitsNumeric(this.amount, MONEY_PRECISION, MONEY_SCALE);
  }

  /** Decimal string for persistence; throws if the value would be silently rounded by the DB. */
  toStorage(): string {
    if (!this.isStorable()) {
      throw new InvariantViolation(
        'kernel.money.not_storable',
        `Amount ${decimalToString(this.amount)} exceeds NUMERIC(${MONEY_PRECISION},${MONEY_SCALE}); round it first`,
      );
    }
    return decimalToString(this.amount);
  }

  toJSON(): MoneyJson {
    return { amount: decimalToString(this.amount), currency: this.currency };
  }

  toString(): string {
    return `${decimalToString(this.amount)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new InvariantViolation(
        'kernel.money.currency_mismatch',
        `Cannot combine ${this.currency} with ${other.currency} without explicit conversion`,
        { left: this.currency, right: other.currency },
      );
    }
  }
}
