import { ValidationError } from '@manuling/kernel';

/**
 * Optimistic concurrency over HTTP (PRD §10): responses carry `ETag: "v<version>"`, and
 * mutations must send `If-Match` with that value. A stale version becomes 412 via
 * ConcurrencyConflictError; a missing header becomes 428.
 */
export function formatEtag(version: number): string {
  return `"v${version}"`;
}

export function parseIfMatch(header: string | string[] | undefined): number {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined || raw.trim() === '') {
    throw new ValidationError('http.if_match_required', 'This update requires an If-Match header');
  }
  const match = /^(?:W\/)?"v(\d{1,9})"$/.exec(raw.trim());
  if (!match) {
    throw new ValidationError(
      'http.if_match_invalid',
      'If-Match must be an ETag returned by this API',
      {
        value: raw,
      },
    );
  }
  return Number(match[1]);
}
