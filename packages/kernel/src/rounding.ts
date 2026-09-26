import { Decimal as DecimalJs } from 'decimal.js';
import { type Decimal } from './decimal.js';

export type RoundingMode = 'HALF_UP' | 'HALF_EVEN' | 'HALF_DOWN' | 'UP' | 'DOWN' | 'CEIL' | 'FLOOR';

/** Explicit rounding instruction; never implicit (ADR-0008 §3). */
export interface RoundingPolicy {
  readonly scale: number;
  readonly mode: RoundingMode;
}

const MODES: Record<RoundingMode, DecimalJs.Rounding> = {
  HALF_UP: DecimalJs.ROUND_HALF_UP,
  HALF_EVEN: DecimalJs.ROUND_HALF_EVEN,
  HALF_DOWN: DecimalJs.ROUND_HALF_DOWN,
  UP: DecimalJs.ROUND_UP,
  DOWN: DecimalJs.ROUND_DOWN,
  CEIL: DecimalJs.ROUND_CEIL,
  FLOOR: DecimalJs.ROUND_FLOOR,
};

export function roundDecimal(value: Decimal, policy: RoundingPolicy): Decimal {
  if (!Number.isInteger(policy.scale) || policy.scale < 0 || policy.scale > 9) {
    throw new RangeError(`Rounding scale must be an integer 0..9, got ${policy.scale}`);
  }
  return value.toDecimalPlaces(policy.scale, MODES[policy.mode]);
}
