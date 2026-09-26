import { UnitOfWork } from '@manuling/db';
import { NotFoundError } from '@manuling/kernel';
import { Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import { insertStamp } from './stamp.js';

export interface DefinitionRow {
  readonly id: string;
  readonly companyId: string;
  readonly docType: string;
  readonly name: string;
  readonly status: 'active' | 'inactive';
}

export interface VersionRow {
  readonly id: string;
  readonly definitionId: string;
  readonly number: number;
  readonly flow: unknown;
  readonly status: 'draft' | 'published' | 'superseded';
  readonly publishedAt: Date | null;
}

export type InstanceStatus = 'submitted' | 'in_progress' | 'approved' | 'rejected' | 'cancelled';

export interface InstanceRow {
  readonly id: string;
  readonly companyId: string;
  readonly plantId: string | null;
  readonly definitionId: string;
  readonly versionId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly attributes: Record<string, string | number | boolean | null>;
  readonly requesterId: string;
  readonly status: InstanceStatus;
  readonly currentStep: number | null;
  readonly outcomeReason: string | null;
  readonly submittedAt: Date;
  readonly completedAt: Date | null;
}

export type TaskStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired';

export interface TaskRow {
  readonly id: string;
  readonly instanceId: string;
  readonly stepIndex: number;
  readonly stepId: string;
  readonly assigneeId: string;
  readonly status: TaskStatus;
  readonly escalationLevel: number;
  readonly dueAt: Date | null;
  readonly decidedBy: string | null;
  readonly decidedOnBehalfOf: string | null;
  readonly comment: string | null;
  readonly decidedAt: Date | null;
  readonly createdAt: Date;
}

export interface DelegationRow {
  readonly id: string;
  readonly fromUserId: string;
  readonly toUserId: string;
  readonly validFrom: string;
  readonly validTo: string;
  readonly docTypes: string[] | null;
  readonly status: 'active' | 'revoked';
}

type Row = Record<string, unknown>;

/** Approval workflow persistence (step 0.8). Every query runs under the caller's tenant RLS. */
@Injectable()
export class ApprovalRepository {
  constructor(private readonly uow: UnitOfWork) {}

  private async rows(query: SQL): Promise<Row[]> {
    return (await this.uow.current().db.execute<Row>(query)).rows;
  }

  private async exec(query: SQL): Promise<number> {
    return (await this.uow.current().db.execute(query)).rowCount ?? 0;
  }

  // ----- definitions and versions --------------------------------------------------------

  async findDefinition(companyId: string, docType: string): Promise<DefinitionRow | undefined> {
    const [r] = await this.rows(
      sql`SELECT * FROM platform.workflow_definition WHERE company_id = ${companyId} AND doc_type = ${docType}`,
    );
    return r ? toDefinition(r) : undefined;
  }

  async getDefinition(id: string): Promise<DefinitionRow> {
    const [r] = await this.rows(sql`SELECT * FROM platform.workflow_definition WHERE id = ${id}`);
    if (!r) throw new NotFoundError('WorkflowDefinition', id);
    return toDefinition(r);
  }

  async listDefinitions(companyId: string): Promise<DefinitionRow[]> {
    const rows = await this.rows(
      sql`SELECT * FROM platform.workflow_definition WHERE company_id = ${companyId} ORDER BY doc_type`,
    );
    return rows.map(toDefinition);
  }

  async insertDefinition(d: DefinitionRow): Promise<void> {
    const s = insertStamp();
    await this.exec(sql`
      INSERT INTO platform.workflow_definition (id, tenant_id, company_id, doc_type, name, status, created_by, updated_by, source)
      VALUES (${d.id}, ${s.tenantId}, ${d.companyId}, ${d.docType}, ${d.name}, ${d.status}, ${s.createdBy}, ${s.updatedBy}, ${s.source})`);
  }

  async renameDefinition(id: string, name: string): Promise<void> {
    await this.exec(
      sql`UPDATE platform.workflow_definition SET name = ${name}, updated_at = now(), version = version + 1 WHERE id = ${id}`,
    );
  }

  async versions(definitionId: string): Promise<VersionRow[]> {
    const rows = await this.rows(
      sql`SELECT * FROM platform.workflow_version WHERE definition_id = ${definitionId} ORDER BY number DESC`,
    );
    return rows.map(toVersion);
  }

  async getVersion(id: string): Promise<VersionRow> {
    const [r] = await this.rows(sql`SELECT * FROM platform.workflow_version WHERE id = ${id}`);
    if (!r) throw new NotFoundError('WorkflowVersion', id);
    return toVersion(r);
  }

  async publishedVersion(definitionId: string): Promise<VersionRow | undefined> {
    const [r] = await this.rows(
      sql`SELECT * FROM platform.workflow_version WHERE definition_id = ${definitionId} AND status = 'published'`,
    );
    return r ? toVersion(r) : undefined;
  }

  /** Creates the draft, or replaces the flow of the existing draft. */
  async upsertDraft(definitionId: string, id: string, flow: unknown): Promise<VersionRow> {
    const s = insertStamp();
    const existing = await this.rows(
      sql`SELECT id FROM platform.workflow_version WHERE definition_id = ${definitionId} AND status = 'draft'`,
    );
    if (existing[0]) {
      await this
        .exec(sql`UPDATE platform.workflow_version SET flow = ${JSON.stringify(flow)}::jsonb, updated_at = now()
                          WHERE id = ${existing[0]['id'] as string}`);
      return this.getVersion(existing[0]['id'] as string);
    }
    await this.exec(sql`
      INSERT INTO platform.workflow_version (id, tenant_id, definition_id, number, flow, status, created_by, source)
      VALUES (${id}, ${s.tenantId}, ${definitionId},
              (SELECT coalesce(max(number), 0) + 1 FROM platform.workflow_version WHERE definition_id = ${definitionId}),
              ${JSON.stringify(flow)}::jsonb, 'draft', ${s.createdBy}, ${s.source})`);
    return this.getVersion(id);
  }

  async publish(versionId: string, definitionId: string, userId: string | null): Promise<void> {
    await this
      .exec(sql`UPDATE platform.workflow_version SET status = 'superseded', updated_at = now()
                        WHERE definition_id = ${definitionId} AND status = 'published'`);
    await this.exec(sql`UPDATE platform.workflow_version
                           SET status = 'published', published_at = now(), published_by = ${userId}, updated_at = now()
                         WHERE id = ${versionId} AND status = 'draft'`);
  }

  // ----- instances ----------------------------------------------------------------------------

  async insertInstance(i: InstanceRow): Promise<void> {
    const s = insertStamp();
    await this.exec(sql`
      INSERT INTO platform.workflow_instance (id, tenant_id, company_id, plant_id, definition_id, version_id, entity_type,
        entity_id, attributes, requester_id, status, created_by, updated_by, source)
      VALUES (${i.id}, ${s.tenantId}, ${i.companyId}, ${i.plantId}, ${i.definitionId}, ${i.versionId}, ${i.entityType},
        ${i.entityId}, ${JSON.stringify(i.attributes)}::jsonb, ${i.requesterId}, ${i.status}, ${s.createdBy}, ${s.updatedBy}, ${s.source})`);
  }

  async findInstance(id: string): Promise<InstanceRow | undefined> {
    const [r] = await this.rows(sql`SELECT * FROM platform.workflow_instance WHERE id = ${id}`);
    return r ? toInstance(r) : undefined;
  }

  async getInstance(id: string): Promise<InstanceRow> {
    const instance = await this.findInstance(id);
    if (!instance) throw new NotFoundError('ApprovalInstance', id);
    return instance;
  }

  /** Locks the instance row for the rest of the transaction (serialises step transitions). */
  async lockInstance(id: string): Promise<InstanceRow> {
    const [r] = await this.rows(
      sql`SELECT * FROM platform.workflow_instance WHERE id = ${id} FOR UPDATE`,
    );
    if (!r) throw new NotFoundError('ApprovalInstance', id);
    return toInstance(r);
  }

  async findOpenInstance(entityType: string, entityId: string): Promise<InstanceRow | undefined> {
    const [r] = await this.rows(sql`SELECT * FROM platform.workflow_instance
      WHERE entity_type = ${entityType} AND entity_id = ${entityId} AND status IN ('submitted', 'in_progress')`);
    return r ? toInstance(r) : undefined;
  }

  async setInstanceProgress(id: string, step: number): Promise<void> {
    await this.exec(sql`UPDATE platform.workflow_instance
       SET status = 'in_progress', current_step = ${step}, updated_at = now(), version = version + 1
     WHERE id = ${id} AND status IN ('submitted', 'in_progress')`);
  }

  /** Terminal transition; returns false if the instance was already closed (idempotent). */
  async closeInstance(
    id: string,
    status: 'approved' | 'rejected' | 'cancelled',
    reason: string | null,
  ): Promise<boolean> {
    const n = await this.exec(sql`UPDATE platform.workflow_instance
       SET status = ${status}, outcome_reason = ${reason}, completed_at = now(), updated_at = now(), version = version + 1
     WHERE id = ${id} AND status IN ('submitted', 'in_progress')`);
    return n > 0;
  }

  // ----- tasks ------------------------------------------------------------------------------------

  /** Idempotent: a retried activity does not duplicate assignments. Returns created rows. */
  async insertTasks(
    tasks: readonly Omit<
      TaskRow,
      'decidedBy' | 'decidedOnBehalfOf' | 'comment' | 'decidedAt' | 'createdAt'
    >[],
  ): Promise<TaskRow[]> {
    const tenantId = insertStamp().tenantId;
    const created: TaskRow[] = [];
    for (const t of tasks) {
      const rows = await this.rows(sql`
        INSERT INTO platform.approval_task (id, tenant_id, instance_id, step_index, step_id, assignee_id, status, escalation_level, due_at)
        VALUES (${t.id}, ${tenantId}, ${t.instanceId}, ${t.stepIndex}, ${t.stepId}, ${t.assigneeId}, 'pending', ${t.escalationLevel},
                ${t.dueAt ? t.dueAt.toISOString() : null})
        ON CONFLICT (tenant_id, instance_id, step_index, escalation_level, assignee_id) DO NOTHING
        RETURNING *`);
      if (rows[0]) created.push(toTask(rows[0]));
    }
    return created;
  }

  async tasksOfStep(instanceId: string, stepIndex: number): Promise<TaskRow[]> {
    const rows = await this.rows(sql`SELECT * FROM platform.approval_task
      WHERE instance_id = ${instanceId} AND step_index = ${stepIndex} ORDER BY escalation_level, created_at`);
    return rows.map(toTask);
  }

  async tasksOfInstance(instanceId: string): Promise<TaskRow[]> {
    const rows = await this.rows(
      sql`SELECT * FROM platform.approval_task WHERE instance_id = ${instanceId} ORDER BY step_index, escalation_level, created_at`,
    );
    return rows.map(toTask);
  }

  async findTask(id: string): Promise<TaskRow | undefined> {
    const [r] = await this.rows(sql`SELECT * FROM platform.approval_task WHERE id = ${id}`);
    return r ? toTask(r) : undefined;
  }

  /** Records a decision on a pending task; false if someone else decided it first. */
  async decideTask(
    id: string,
    decision: 'approved' | 'rejected',
    decidedBy: string,
    onBehalfOf: string | null,
    comment: string | null,
  ): Promise<boolean> {
    const n = await this.exec(sql`UPDATE platform.approval_task
       SET status = ${decision}, decided_by = ${decidedBy}, decided_on_behalf_of = ${onBehalfOf}, comment = ${comment},
           decided_at = now(), updated_at = now(), version = version + 1
     WHERE id = ${id} AND status = 'pending'`);
    return n > 0;
  }

  async closePendingTasks(
    instanceId: string,
    status: 'cancelled' | 'expired',
    stepIndex?: number,
  ): Promise<TaskRow[]> {
    const rows = await this
      .rows(sql`UPDATE platform.approval_task SET status = ${status}, updated_at = now(), version = version + 1
      WHERE instance_id = ${instanceId} AND status = 'pending'
        AND (${stepIndex ?? null}::int IS NULL OR step_index = ${stepIndex ?? null}::int)
      RETURNING *`);
    return rows.map(toTask);
  }

  /** Users who decided any step of the instance other than `stepIndex` (W4). */
  async deciderIdsOutsideStep(instanceId: string, stepIndex: number): Promise<Set<string>> {
    const rows = await this.rows(sql`SELECT DISTINCT decided_by FROM platform.approval_task
      WHERE instance_id = ${instanceId} AND step_index <> ${stepIndex} AND decided_by IS NOT NULL`);
    return new Set(rows.map((r) => r['decided_by'] as string));
  }

  /** Pending tasks assigned to the user or to anyone who delegated to them. */
  async inbox(assigneeIds: readonly string[]): Promise<(TaskRow & { instance: InstanceRow })[]> {
    if (assigneeIds.length === 0) return [];
    const rows = await this.rows(sql`
      SELECT t.*, row_to_json(i.*) AS instance_json
        FROM platform.approval_task t JOIN platform.workflow_instance i ON i.id = t.instance_id
       WHERE t.status = 'pending' AND t.assignee_id = ANY(${pgUuidArray(assigneeIds)}::uuid[])
       ORDER BY t.due_at NULLS LAST, t.created_at`);
    return rows.map((r) => ({ ...toTask(r), instance: toInstance(r['instance_json'] as Row) }));
  }

  // ----- delegation --------------------------------------------------------------------------------

  async insertDelegation(d: DelegationRow): Promise<void> {
    const s = insertStamp();
    await this.exec(sql`
      INSERT INTO platform.delegation (id, tenant_id, from_user_id, to_user_id, valid_from, valid_to, doc_types, status, created_by, updated_by, source)
      VALUES (${d.id}, ${s.tenantId}, ${d.fromUserId}, ${d.toUserId}, ${d.validFrom}::date, ${d.validTo}::date,
              ${d.docTypes ? pgTextArray(d.docTypes) : null}::text[], 'active', ${s.createdBy}, ${s.updatedBy}, ${s.source})`);
  }

  async delegationsOf(userId: string): Promise<DelegationRow[]> {
    const rows = await this.rows(sql`SELECT * FROM platform.delegation
      WHERE from_user_id = ${userId} OR to_user_id = ${userId} ORDER BY valid_from DESC`);
    return rows.map(toDelegation);
  }

  async findDelegation(id: string): Promise<DelegationRow | undefined> {
    const [r] = await this.rows(sql`SELECT * FROM platform.delegation WHERE id = ${id}`);
    return r ? toDelegation(r) : undefined;
  }

  async revokeDelegation(id: string): Promise<void> {
    await this.exec(
      sql`UPDATE platform.delegation SET status = 'revoked', updated_at = now() WHERE id = ${id}`,
    );
  }

  /** Users whose work `toUserId` may do today, optionally for one document type. */
  async activeDelegators(toUserId: string, today: string, docType?: string): Promise<string[]> {
    const rows = await this.rows(sql`SELECT DISTINCT from_user_id FROM platform.delegation
      WHERE to_user_id = ${toUserId} AND status = 'active'
        AND valid_from <= ${today}::date AND valid_to >= ${today}::date
        AND (${docType ?? null}::text IS NULL OR doc_types IS NULL OR ${docType ?? null}::text = ANY(doc_types))`);
    return rows.map((r) => r['from_user_id'] as string);
  }
}

function pgUuidArray(ids: readonly string[]): string {
  return `{${ids.join(',')}}`;
}

function pgTextArray(values: readonly string[]): string {
  return `{${values.map((v) => `"${v.replace(/["\\]/g, '\\$&')}"`).join(',')}}`;
}

const date = (v: unknown): Date | null =>
  v === null || v === undefined ? null : new Date(v as string);
const dateString = (v: unknown): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

function toDefinition(r: Row): DefinitionRow {
  return {
    id: r['id'] as string,
    companyId: r['company_id'] as string,
    docType: r['doc_type'] as string,
    name: r['name'] as string,
    status: r['status'] as DefinitionRow['status'],
  };
}

function toVersion(r: Row): VersionRow {
  return {
    id: r['id'] as string,
    definitionId: r['definition_id'] as string,
    number: Number(r['number']),
    flow: r['flow'],
    status: r['status'] as VersionRow['status'],
    publishedAt: date(r['published_at']),
  };
}

function toInstance(r: Row): InstanceRow {
  return {
    id: r['id'] as string,
    companyId: r['company_id'] as string,
    plantId: (r['plant_id'] as string | null) ?? null,
    definitionId: r['definition_id'] as string,
    versionId: r['version_id'] as string,
    entityType: r['entity_type'] as string,
    entityId: r['entity_id'] as string,
    attributes: r['attributes'] as InstanceRow['attributes'],
    requesterId: r['requester_id'] as string,
    status: r['status'] as InstanceStatus,
    currentStep:
      r['current_step'] === null || r['current_step'] === undefined
        ? null
        : Number(r['current_step']),
    outcomeReason: (r['outcome_reason'] as string | null) ?? null,
    submittedAt: new Date(r['submitted_at'] as string),
    completedAt: date(r['completed_at']),
  };
}

function toTask(r: Row): TaskRow {
  return {
    id: r['id'] as string,
    instanceId: r['instance_id'] as string,
    stepIndex: Number(r['step_index']),
    stepId: r['step_id'] as string,
    assigneeId: r['assignee_id'] as string,
    status: r['status'] as TaskStatus,
    escalationLevel: Number(r['escalation_level']),
    dueAt: date(r['due_at']),
    decidedBy: (r['decided_by'] as string | null) ?? null,
    decidedOnBehalfOf: (r['decided_on_behalf_of'] as string | null) ?? null,
    comment: (r['comment'] as string | null) ?? null,
    decidedAt: date(r['decided_at']),
    createdAt: new Date(r['created_at'] as string),
  };
}

function toDelegation(r: Row): DelegationRow {
  return {
    id: r['id'] as string,
    fromUserId: r['from_user_id'] as string,
    toUserId: r['to_user_id'] as string,
    validFrom: dateString(r['valid_from']),
    validTo: dateString(r['valid_to']),
    docTypes: (r['doc_types'] as string[] | null) ?? null,
    status: r['status'] as DelegationRow['status'],
  };
}
