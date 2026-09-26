import { Decimal, type DecimalInput, decimalToString, fitsNumeric, toDecimal } from './decimal.js';
import { InvariantViolation, ValidationError } from './errors.js';
import { type RoundingPolicy, roundDecimal } from './rounding.js';

/** Storage limits for quantity columns: NUMERIC(20,6) (ADR-0008). */
export const QUANTITY_PRECISION = 20;
export const QUANTITY_SCALE = 6;

export type UomCode = string & { readonly __brand: 'UomCode' };

export interface QuantityJson {
  readonly value: string;
  readonly uom: string;
}

export function parseUom(code: string): UomCode {
  const normalised = code.trim().toUpperCase();
  if (!/^[A-Z0-9_]{1,16}$/.test(normalised)) {
    throw new ValidationError('kernel.uom.invalid_code', `Invalid unit of measure code "${code}"`, {
      code,
    });
  }
  return normalised as UomCode;
}

/** Immutable quantity in a unit of measure. Conversions are always explicit. */
export class Quantity {
  private constructor(
    readonly value: Decimal,
    readonly uom: UomCode,
  ) {}

  static of(value: DecimalInput, uom: string): Quantity {
    return new Quantity(toDecimal(value), parseUom(uom));
  }

  static zero(uom: string): Quantity {
    return new Quantity(new Decimal(0), parseUom(uom));
  }

  static fromJSON(json: QuantityJson): Quantity {
    return Quantity.of(json.value, json.uom);
  }

  add(other: Quantity): Quantity {
    this.assertSameUom(other);
    return new Quantity(this.value.plus(other.value), this.uom);
  }

  subtract(other: Quantity): Quantity {
    this.assertSameUom(other);
    return new Quantity(this.value.minus(other.value), this.uom);
  }

  multiply(factor: DecimalInput): Quantity {
    return new Quantity(this.value.times(toDecimal(factor)), this.uom);
  }

  negate(): Quantity {
    return new Quantity(this.value.negated(), this.uom);
  }

  /**
   * Converts using `factor` = number of target units per one source unit
   * (e.g. BOX→NOS with 12 per box: factor "12").
   */
  convert(factor: DecimalInput, targetUom: string): Quantity {
    const f = toDecimal(factor);
    if (!f.isPositive() || f.isZero()) {
      throw new ValidationError('kernel.uom.invalid_factor', 'Conversion factor must be positive');
    }
    return new Quantity(this.value.times(f), parseUom(targetUom));
  }

  round(policy: RoundingPolicy): Quantity {
    return new Quantity(roundDecimal(this.value, policy), this.uom);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative() && !this.value.isZero();
  }

  compare(other: Quantity): -1 | 0 | 1 {
    this.assertSameUom(other);
    return this.value.comparedTo(other.value) as -1 | 0 | 1;
  }

  equals(other: Quantity): boolean {
    return this.uom === other.uom && this.value.equals(other.value);
  }

  isStorable(): boolean {
    return fitsNumeric(this.value, QUANTITY_PRECISION, QUANTITY_SCALE);
  }

  toStorage(): string {
    if (!this.isStorable()) {
      throw new InvariantViolation(
        'kernel.quantity.not_storable',
        `Quantity ${decimalToString(this.value)} exceeds NUMERIC(${QUANTITY_PRECISION},${QUANTITY_SCALE}); round it first`,
      );
    }
    return decimalToString(this.value);
  }

  toJSON(): QuantityJson {
    return { value: decimalToString(this.value), uom: this.uom };
  }

  toString(): string {
    return `${decimalToString(this.value)} ${this.uom}`;
  }

  private assertSameUom(other: Quantity): void {
    if (other.uom !== this.uom) {
      throw new InvariantViolation(
        'kernel.quantity.uom_mismatch',
        `Cannot combine ${this.uom} with ${other.uom} without explicit conversion`,
        { left: this.uom, right: other.uom },
      );
    }
  }
}
