import { AccessControl } from '@manuling/authz';
import { AuditTrail, type ChainVerification, UnitOfWork } from '@manuling/db';
import { RequestContexts } from '@manuling/kernel';
import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { PLATFORM_PERMISSIONS as P } from '../authorisation/permissions.js';

export interface AuditRecord {
  readonly id: string;
  readonly occurredAt: Date;
  readonly entityType: string;
  readonly entityId: string;
  readonly action: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly changedFields: readonly string[];
  readonly actorType: string;
  readonly actorId: string;
  readonly onBehalfOf: string | null;
  readonly source: string;
  readonly correlationId: string;
  readonly clientIp: string | null;
  readonly chainSeq: number | null;
}

export interface AuditQuery {
  readonly entityType?: string | undefined;
  readonly entityId?: string | undefined;
  readonly limit: number;
  /** Keyset: occurred_at ISO and id of the last row of the previous page. */
  readonly after?: readonly [string, string] | undefined;
}

/** Reading and administering the audit trail; plus recording denied access attempts. */
@Injectable()
export class AuditService {
  private readonly logger = new Logger('AuditService');

  constructor(
    private readonly uow: UnitOfWork,
    private readonly trail: AuditTrail,
  ) {}

  list(query: AuditQuery): Promise<AuditRecord[]> {
    return this.uow.run(
      async ({ db }) => {
        const res = await db.execute<Record<string, unknown>>(sql`
          SELECT id, occurred_at, entity_type, entity_id, action, before, after, changed_fields, actor_type,
                 actor_id, on_behalf_of, source, correlation_id, client_ip, chain_seq
            FROM platform.audit_log
           WHERE (${query.entityType ?? null}::text IS NULL OR entity_type = ${query.entityType ?? null})
             AND (${query.entityId ?? null}::text IS NULL OR entity_id = ${query.entityId ?? null})
             AND (${query.after?.[0] ?? null}::timestamptz IS NULL
                  OR (occurred_at, id) < (${query.after?.[0] ?? null}::timestamptz, ${query.after?.[1] ?? null}::uuid))
           ORDER BY occurred_at DESC, id DESC
           LIMIT ${query.limit + 1}`);
        return res.rows.map(toRecord);
      },
      { readOnly: true },
    );
  }

  enableChain(): Promise<void> {
    AccessControl.assert(P.auditManage);
    return this.uow.run(async () => {
      await this.trail.enableChain();
      await this.trail.record({
        entityType: 'platform.audit_chain',
        entityId: RequestContexts.requireTenant().tenantId,
        action: 'enable',
        after: { enabled: true },
      });
    });
  }

  verifyChain(): Promise<ChainVerification> {
    return this.uow.run(() => this.trail.verifyChain(), { readOnly: true });
  }

  /**
   * Audits a refused operation by an authenticated user (ADR-0009 §14). Written in its own
   * transaction because the refused request's transaction (if any) rolled back. Never throws:
   * failing to audit a denial must not change the response.
   */
  async recordDenial(
    code: string,
    params: Readonly<Record<string, unknown>>,
    route: string,
  ): Promise<void> {
    try {
      await this.uow.run(() =>
        this.trail.record({
          entityType: 'platform.access',
          entityId: route.slice(0, 200),
          action: 'access_denied',
          after: { code, ...params },
        }),
      );
    } catch (err) {
      this.logger.error({ err, code, route }, 'failed to audit access denial');
    }
  }
}

function toRecord(r: Record<string, unknown>): AuditRecord {
  return {
    id: r['id'] as string,
    occurredAt: new Date(r['occurred_at'] as string),
    entityType: r['entity_type'] as string,
    entityId: r['entity_id'] as string,
    action: r['action'] as string,
    before: r['before'],
    after: r['after'],
    changedFields: r['changed_fields'] as string[],
    actorType: r['actor_type'] as string,
    actorId: r['actor_id'] as string,
    onBehalfOf: (r['on_behalf_of'] as string | null) ?? null,
    source: r['source'] as string,
    correlationId: r['correlation_id'] as string,
    clientIp: (r['client_ip'] as string | null) ?? null,
    chainSeq: r['chain_seq'] === null ? null : Number(r['chain_seq']),
  };
}
