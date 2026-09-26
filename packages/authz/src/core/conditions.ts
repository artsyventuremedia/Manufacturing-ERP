import { toDecimal } from '@manuling/kernel';

/**
 * ABAC conditions on a role assignment, stored as data (never code):
 *   { attr: 'amount', op: 'lte', value: '500000' }  – numeric compares use Decimal
 *   { attr: 'currency', op: 'in', value: ['INR','USD'] }
 *   { op: 'own' }                                   – resource.createdBy === caller
 * All conditions must hold. A missing attribute fails closed.
 */
export type Condition =
  | {
      readonly attr: string;
      readonly op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
      readonly value: string;
    }
  | { readonly attr: string; readonly op: 'in'; readonly value: readonly string[] }
  | { readonly op: 'own' };

export type ResourceAttributes = Readonly<
  Record<string, string | number | boolean | null | undefined>
>;

const DECIMAL = /^[+-]?\d+(\.\d+)?$/;

export function evaluateConditions(
  conditions: readonly Condition[],
  attributes: ResourceAttributes,
  userId: string,
): boolean {
  return conditions.every((c) => evaluate(c, attributes, userId));
}

function evaluate(condition: Condition, attributes: ResourceAttributes, userId: string): boolean {
  if (condition.op === 'own') return attributes['createdBy'] === userId;
  const raw = attributes[condition.attr];
  if (raw === undefined || raw === null) return false;
  const actual = String(raw);

  switch (condition.op) {
    case 'in':
      return condition.value.includes(actual);
    case 'eq':
    case 'ne': {
      const equal = bothDecimal(actual, condition.value)
        ? toDecimal(actual).equals(toDecimal(condition.value))
        : actual === condition.value;
      return condition.op === 'eq' ? equal : !equal;
    }
    default: {
      if (!bothDecimal(actual, condition.value)) return false;
      const cmp = toDecimal(actual).comparedTo(toDecimal(condition.value));
      if (condition.op === 'lt') return cmp < 0;
      if (condition.op === 'lte') return cmp <= 0;
      if (condition.op === 'gt') return cmp > 0;
      return cmp >= 0;
    }
  }
}

function bothDecimal(a: string, b: string): boolean {
  return DECIMAL.test(a) && DECIMAL.test(b);
}
