import { RequirePermission } from '@manuling/authz';
import { type OpenAPIRegistry, ZodPipe, decodeCursor, encodeCursor, z } from '@manuling/http';
import { Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { type AuditRecord, AuditService } from '../application/audit.service.js';
import { PLATFORM_PERMISSIONS as P } from '../authorisation/permissions.js';

export const auditQuerySchema = z.object({
  entityType: z.string().max(80).optional(),
  entityId: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
});

const auditEntry = z.object({
  id: z.uuid(),
  occurredAt: z.iso.datetime(),
  entityType: z.string(),
  entityId: z.string(),
  action: z.string(),
  before: z.unknown(),
  after: z.unknown(),
  changedFields: z.array(z.string()),
  actorType: z.string(),
  actorId: z.string(),
  onBehalfOf: z.string().nullable(),
  source: z.string(),
  correlationId: z.string(),
  clientIp: z.string().nullable(),
  chainSeq: z.number().int().nullable(),
});

type AuditEntry = z.infer<typeof auditEntry>;

function toEntry(r: AuditRecord): AuditEntry {
  return { ...r, occurredAt: r.occurredAt.toISOString(), changedFields: [...r.changedFields] };
}

/** The tenant's audit trail (PRD §10/§12). */
@Controller('v1/platform/audit-log')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermission(P.auditRead)
  async list(
    @Query(new ZodPipe(auditQuerySchema)) query: z.output<typeof auditQuerySchema>,
  ): Promise<{ items: AuditEntry[]; nextCursor?: string }> {
    const after = query.cursor ? (decodeCursor(query.cursor, 2) as [string, string]) : undefined;
    const rows = await this.audit.list({
      entityType: query.entityType,
      entityId: query.entityId,
      limit: query.limit,
      after,
    });
    const items = rows.slice(0, query.limit);
    const last = items[items.length - 1];
    return {
      items: items.map(toEntry),
      ...(rows.length > query.limit && last
        ? { nextCursor: encodeCursor([last.occurredAt.toISOString(), last.id]) }
        : {}),
    };
  }

  /** Starts SHA-256 hash chaining for this workspace (irreversible by design). */
  @Post('chain')
  @HttpCode(204)
  @RequirePermission(P.auditManage)
  async enableChain(): Promise<void> {
    await this.audit.enableChain();
  }

  @Get('chain/verification')
  @RequirePermission(P.auditRead)
  verify() {
    return this.audit.verifyChain();
  }
}

export function registerAuditOpenApi(registry: OpenAPIRegistry): void {
  const Entry = registry.register('AuditEntry', auditEntry);
  const security = [{ bearer: [] }];
  const tags = ['Audit'];
  registry.registerPath({
    method: 'get',
    path: '/v1/platform/audit-log',
    tags,
    security,
    summary: 'Audit trail, newest first',
    request: { query: auditQuerySchema },
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: z.object({ items: z.array(Entry), nextCursor: z.string().optional() }),
          },
        },
      },
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/v1/platform/audit-log/chain',
    tags,
    security,
    summary: 'Enable tamper-evident hash chaining',
    responses: { 204: { description: 'Enabled' } },
  });
  registry.registerPath({
    method: 'get',
    path: '/v1/platform/audit-log/chain/verification',
    tags,
    security,
    summary: 'Verify the hash chain',
    responses: {
      200: {
        description: 'Verification result',
        content: {
          'application/json': {
            schema: z.object({
              valid: z.boolean(),
              checked: z.number().int(),
              brokenAt: z.number().int().optional(),
            }),
          },
        },
      },
    },
  });
}
