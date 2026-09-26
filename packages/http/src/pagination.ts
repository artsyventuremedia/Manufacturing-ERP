import { ValidationError } from '@manuling/kernel';
import { z } from 'zod';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** Query parameters accepted by every list endpoint. */
export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().max(512).optional(),
});
export type PageQuery = z.output<typeof pageQuerySchema>;

export interface Page<T> {
  readonly items: readonly T[];
  /** Opaque cursor for the next page; absent on the last page. */
  readonly nextCursor?: string;
}

type CursorValue = string | number | boolean | null;

/**
 * Keyset pagination cursors: an opaque base64url JSON array of the sort-key values of the
 * last row. Opaque so clients cannot depend on its shape; not a security boundary (RLS is).
 */
export function encodeCursor(keys: readonly CursorValue[]): string {
  return Buffer.from(JSON.stringify(keys), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string, expectedLength: number): CursorValue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== expectedLength ||
    !parsed.every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v))
  ) {
    throw invalidCursor();
  }
  return parsed as CursorValue[];
}

/**
 * Builds a page from `limit + 1` fetched rows: the extra row only signals that more exist.
 */
export function toPage<T>(
  rows: readonly T[],
  limit: number,
  keyOf: (row: T) => readonly CursorValue[],
): Page<T> {
  if (rows.length <= limit) return { items: rows };
  const items = rows.slice(0, limit);
  return { items, nextCursor: encodeCursor(keyOf(items[items.length - 1]!)) };
}

function invalidCursor(): ValidationError {
  return new ValidationError('http.cursor_invalid', 'The pagination cursor is invalid or expired');
}
