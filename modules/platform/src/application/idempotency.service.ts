import { createHash } from 'node:crypto';
import { UnitOfWork } from '@manuling/db';
import { ConflictError, ValidationError } from '@manuling/kernel';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

export const IDEMPOTENCY_TTL_HOURS = 24;
const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,255}$/;

export type IdempotencyStart =
  | { readonly kind: 'proceed' }
  | {
      readonly kind: 'replay';
      readonly status: number;
      readonly headers: Record<string, string>;
      readonly body: unknown;
    };

export interface StoredResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/**
 * `Idempotency-Key` semantics for POST (draft-ietf-httpapi-idempotency-key-header):
 * first request proceeds; an identical retry replays the stored response; a different
 * payload under the same key is rejected; a retry while the first is running gets 409.
 * The key row is written in its own transaction so concurrent duplicates see each other.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly uow: UnitOfWork) {}

  static validateKey(key: string): string {
    if (!KEY_PATTERN.test(key)) {
      throw new ValidationError(
        'http.idempotency_key_invalid',
        'Idempotency-Key must be 8–255 URL-safe characters',
      );
    }
    return key;
  }

  static fingerprint(method: string, path: string, body: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify([method, path, body ?? null]))
      .digest('hex');
  }

  async start(
    key: string,
    method: string,
    path: string,
    requestHash: string,
  ): Promise<IdempotencyStart> {
    return this.uow.run(async ({ db }) => {
      const inserted = await db.execute(sql`
        INSERT INTO platform.idempotency_key (tenant_id, key, request_hash, method, path, status, expires_at)
        VALUES (platform.current_tenant_id(), ${key}, ${requestHash}, ${method}, ${path}, 'in_progress',
                now() + make_interval(hours => ${IDEMPOTENCY_TTL_HOURS}))
        ON CONFLICT (tenant_id, key) DO UPDATE
          SET request_hash = EXCLUDED.request_hash, method = EXCLUDED.method, path = EXCLUDED.path,
              status = 'in_progress', response_status = NULL, response_headers = NULL,
              response_body = NULL, created_at = now(), expires_at = EXCLUDED.expires_at
          WHERE platform.idempotency_key.expires_at < now()
        RETURNING 1`);
      if ((inserted.rowCount ?? 0) > 0) return { kind: 'proceed' } as const;

      const existing = await db.execute<{
        request_hash: string;
        status: 'in_progress' | 'completed';
        response_status: number | null;
        response_headers: Record<string, string> | null;
        response_body: unknown;
      }>(sql`SELECT request_hash, status, response_status, response_headers, response_body
               FROM platform.idempotency_key WHERE key = ${key}`);
      const row = existing.rows[0];
      if (!row) throw new ConflictError('http.idempotency_in_progress', 'Retry this request');
      if (row.request_hash !== requestHash) {
        throw new ValidationError(
          'http.idempotency_key_reused',
          'This Idempotency-Key was already used with a different request',
        );
      }
      if (row.status !== 'completed' || row.response_status === null) {
        throw new ConflictError(
          'http.idempotency_in_progress',
          'A request with this Idempotency-Key is still in progress',
        );
      }
      return {
        kind: 'replay',
        status: row.response_status,
        headers: row.response_headers ?? {},
        body: row.response_body,
      };
    });
  }

  async complete(key: string, response: StoredResponse): Promise<void> {
    await this.uow.run(({ db }) =>
      db.execute(sql`
        UPDATE platform.idempotency_key
           SET status = 'completed', response_status = ${response.status},
               response_headers = ${JSON.stringify(response.headers)}::jsonb,
               response_body = ${JSON.stringify(response.body ?? null)}::jsonb
         WHERE key = ${key}`),
    );
  }

  /** Frees the key after a failed request so the client can retry. */
  async release(key: string): Promise<void> {
    await this.uow.run(({ db }) =>
      db.execute(sql`DELETE FROM platform.idempotency_key WHERE key = ${key}`),
    );
  }
}
