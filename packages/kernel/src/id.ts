import { v7 as uuidv7, validate as isUuid } from 'uuid';
import { ValidationError } from './errors.js';

/** Branded UUID so an ItemId cannot be passed where a PartyId is expected. */
export type Id<TEntity extends string> = string & { readonly __entity: TEntity };

/** Time-ordered UUIDv7 generated in the application (ADR-0008 §6). */
export function newId<TEntity extends string>(): Id<TEntity> {
  return uuidv7() as Id<TEntity>;
}

export function isId(value: unknown): value is string {
  return typeof value === 'string' && isUuid(value);
}

export function parseId<TEntity extends string>(value: string, entity = 'id'): Id<TEntity> {
  if (!isUuid(value)) {
    throw new ValidationError('kernel.id.invalid', `Invalid ${entity} "${value}"`, {
      entity,
      value,
    });
  }
  return value.toLowerCase() as Id<TEntity>;
}
