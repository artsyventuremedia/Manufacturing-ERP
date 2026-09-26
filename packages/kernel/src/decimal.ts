import { Decimal as DecimalJs } from 'decimal.js';

/**
 * Project-wide Decimal constructor (ADR-0008).
 * 40 significant digits comfortably covers NUMERIC(24,9) intermediate products.
 * Exponent notation is disabled for everything a ledger could ever hold.
 */
export const Decimal = DecimalJs.clone({
  precision: 40,
  rounding: DecimalJs.ROUND_HALF_UP,
  toExpNeg: -30,
  toExpPos: 40,
});
export type Decimal = DecimalJs;

/**
 * Accepted inputs for decimal values. Non-integer JS numbers are rejected at runtime
 * because they have already lost precision before reaching us.
 */
export type DecimalInput = string | bigint | number | Decimal;

const DECIMAL_STRING = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

export function toDecimal(value: DecimalInput): Decimal {
  if (value instanceof DecimalJs) {
    if (!value.isFinite()) throw new TypeError('Decimal value must be finite');
    return new Decimal(value);
  }
  if (typeof value === 'bigint') return new Decimal(value.toString());
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(
        `Refusing non-integer or unsafe JS number ${value}; pass a string instead (ADR-0008)`,
      );
    }
    return new Decimal(value);
  }
  const trimmed = value.trim();
  if (!DECIMAL_STRING.test(trimmed)) throw new TypeError(`Invalid decimal string "${value}"`);
  return new Decimal(trimmed);
}

/** Plain decimal string with no exponent, e.g. "1234.5". */
export function decimalToString(value: Decimal): string {
  return value.toFixed();
}

/**
 * Checks that a value fits a Postgres NUMERIC(precision, scale) column without rounding.
 */
export function fitsNumeric(value: Decimal, precision: number, scale: number): boolean {
  if (value.decimalPlaces() > scale) return false;
  const integerDigits = value.abs().trunc().isZero() ? 0 : value.abs().trunc().toFixed().length;
  return integerDigits <= precision - scale;
}
