import { createHash } from 'node:crypto';
import { type Clock, RequestContexts, newId, systemClock } from '@manuling/kernel';
import { sql } from 'drizzle-orm';
import { type UnitOfWork } from './unit-of-work.js';

export interface AuditEntry {
  /** `{module}.{entity}`, e.g. `platform.company`. */
  readonly entityType: string;
  readonly entityId: string;
  /** e.g. create, update, revoke, invite, access_denied. */
  readonly action: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

export interface ChainVerification {
  readonly valid: boolean;
  readonly checked: number;
  /** chain_seq of the first row whose hash does not verify. */
  readonly brokenAt?: number;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type AuditRow = {
  id: string;
  tenant_id: string;
  occurred_at: Date;
  entity_type: string;
  entity_id: string;
  action: string;
  before: Json;
  after: Json;
  changed_fields: string[];
  actor_type: string;
  actor_id: string;
  on_behalf_of: string | null;
  source: string;
  correlation_id: string;
  client_ip: string | null;
  chain_seq: string | null;
  prev_hash: string | null;
  hash: string | null;
};

/**
 * Writes the audit trail (PRD §10: who, what, when, before, after, source) inside the
 * caller's UnitOfWork, so an audit row exists exactly when the change committed.
 * Tenants with a chain head get a SHA-256 hash chain for tamper evidence (PRD §12).
 */
export class AuditTrail {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock = systemClock,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    const { db } = this.uow.current();
    const ctx = RequestContexts.requireTenant();
    const before = toJson(entry.before);
    const after = toJson(entry.after);
    const changed = changedFields(before, after);
    if (entry.action === 'update' && changed.length === 0) return; // no-op save

    const occurredAt = new Date(Math.floor(this.clock.now().getTime()));
    const row = {
      id: newId(),
      tenantId: ctx.tenantId,
      occurredAt: occurredAt.toISOString(),
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      before,
      after,
      changedFields: changed,
      actorType: ctx.actor.type,
      actorId: ctx.actor.id,
      onBehalfOf: ctx.actor.onBehalfOf ?? null,
      source: ctx.source,
      correlationId: ctx.correlationId,
      clientIp: ctx.clientIp ?? null,
    };

    let chainSeq: number | null = null;
    let prevHash: string | null = null;
    let hash: string | null = null;
    const head = await db.execute<{ last_seq: string; last_hash: string }>(
      sql`SELECT last_seq, last_hash FROM platform.audit_chain_head FOR UPDATE`,
    );
    const current = head.rows[0];
    if (current) {
      chainSeq = Number(current.last_seq) + 1;
      prevHash = current.last_hash;
      hash = chainHash(prevHash, { ...row, chainSeq });
      await db.execute(
        sql`UPDATE platform.audit_chain_head SET last_seq = ${chainSeq}, last_hash = ${hash}`,
      );
    }

    await db.execute(sql`
      INSERT INTO platform.audit_log (id, tenant_id, occurred_at, entity_type, entity_id, action, before, after,
        changed_fields, actor_type, actor_id, on_behalf_of, source, correlation_id, client_ip, chain_seq, prev_hash, hash)
      VALUES (${row.id}, ${row.tenantId}, ${row.occurredAt}, ${row.entityType}, ${row.entityId}, ${row.action},
        ${jsonParam(before)}::jsonb, ${jsonParam(after)}::jsonb, ${pgTextArray(changed)}::text[], ${row.actorType}, ${row.actorId},
        ${row.onBehalfOf}, ${row.source}, ${row.correlationId}, ${row.clientIp}, ${chainSeq}, ${prevHash}, ${hash})`);
  }

  /** Starts a hash chain for the current tenant (idempotent). Earlier rows stay unchained. */
  async enableChain(): Promise<void> {
    await this.uow
      .current()
      .db.execute(
        sql`INSERT INTO platform.audit_chain_head (tenant_id) VALUES (platform.current_tenant_id()) ON CONFLICT DO NOTHING`,
      );
  }

  /** Recomputes the current tenant's chain from stored rows. */
  async verifyChain(): Promise<ChainVerification> {
    const res = await this.uow
      .current()
      .db.execute<AuditRow>(
        sql`SELECT * FROM platform.audit_log WHERE chain_seq IS NOT NULL ORDER BY chain_seq`,
      );
    let prev = '';
    let checked = 0;
    for (const r of res.rows) {
      const seq = Number(r.chain_seq);
      const expected = chainHash(prev, {
        id: r.id,
        tenantId: r.tenant_id,
        occurredAt: new Date(r.occurred_at).toISOString(),
        entityType: r.entity_type,
        entityId: r.entity_id,
        action: r.action,
        before: r.before,
        after: r.after,
        changedFields: r.changed_fields,
        actorType: r.actor_type,
        actorId: r.actor_id,
        onBehalfOf: r.on_behalf_of,
        source: r.source,
        correlationId: r.correlation_id,
        clientIp: r.client_ip,
        chainSeq: seq,
      });
      if (r.prev_hash !== prev || r.hash !== expected || seq !== checked + 1) {
        return { valid: false, checked, brokenAt: seq };
      }
      prev = expected;
      checked++;
    }
    return { valid: true, checked };
  }
}

function chainHash(prevHash: string, record: Record<string, unknown>): string {
  return createHash('sha256')
    .update(prevHash)
    .update('\n')
    .update(canonicalJson(record))
    .digest('hex');
}

/** JSON with recursively sorted keys, so the hash survives jsonb's key reordering. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Normalises values to plain JSON (Dates → ISO, LocalDate/Money via toJSON, undefined dropped). */
function toJson(value: unknown): Json {
  if (value === undefined || value === null) return null;
  return JSON.parse(JSON.stringify(value)) as Json;
}

function changedFields(before: Json, after: Json): string[] {
  const b = before !== null && typeof before === 'object' && !Array.isArray(before) ? before : {};
  const a = after !== null && typeof after === 'object' && !Array.isArray(after) ? after : {};
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  return [...keys].filter((k) => canonicalJson(b[k]) !== canonicalJson(a[k])).sort();
}

function jsonParam(value: Json): string | null {
  return value === null ? null : JSON.stringify(value);
}

function pgTextArray(values: readonly string[]): string {
  return `{${values.map((v) => `"${v.replace(/["\\]/g, '\\$&')}"`).join(',')}}`;
}
