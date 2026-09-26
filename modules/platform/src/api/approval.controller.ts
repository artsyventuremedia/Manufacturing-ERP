import { AnyMember, RequirePermission } from '@manuling/authz';
import { type OpenAPIRegistry, ZodPipe, z } from '@manuling/http';
import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  ApprovalService,
  type InboxItem,
  type InstanceWithTasks,
} from '../application/approval.service.js';
import {
  type DefinitionWithVersions,
  WorkflowDefinitionService,
} from '../application/workflow-definition.service.js';
import { PLATFORM_PERMISSIONS as P } from '../authorisation/permissions.js';
import {
  type DelegationRow,
  type TaskRow,
  type VersionRow,
} from '../infrastructure/approval.repository.js';
import { idParam } from './dto.js';

const idPipe = new ZodPipe(idParam);
const attributeValue = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);

export const saveDraftBody = z
  .object({
    docType: z.string().max(80),
    name: z.string().max(200),
    flow: z.record(z.string(), z.unknown()),
  })
  .strict();
export const validateBody = z
  .object({
    flow: z.record(z.string(), z.unknown()),
    attributes: z.record(z.string(), attributeValue),
    plantId: z.uuid().optional(),
    requesterId: z.uuid().optional(),
  })
  .strict();
export const decisionBody = z.object({ comment: z.string().max(2000).optional() }).strict();
export const cancelBody = z.object({ reason: z.string().min(1).max(500) }).strict();
export const delegationBody = z
  .object({
    toUserId: z.uuid(),
    validFrom: z.iso.date(),
    validTo: z.iso.date(),
    docTypes: z.array(z.string().max(80)).max(20).optional(),
  })
  .strict();

const iso = (d: Date | null) => (d ? d.toISOString() : null);

const versionOut = (v: VersionRow) => ({
  id: v.id,
  number: v.number,
  status: v.status,
  publishedAt: iso(v.publishedAt),
  flow: v.flow,
});

const definitionOut = (d: DefinitionWithVersions) => ({
  id: d.id,
  companyId: d.companyId,
  docType: d.docType,
  name: d.name,
  status: d.status,
  versions: d.versions.map(versionOut),
});

const taskOut = (t: TaskRow) => ({
  id: t.id,
  instanceId: t.instanceId,
  stepIndex: t.stepIndex,
  stepId: t.stepId,
  assigneeId: t.assigneeId,
  status: t.status,
  escalationLevel: t.escalationLevel,
  dueAt: iso(t.dueAt),
  decidedBy: t.decidedBy,
  decidedOnBehalfOf: t.decidedOnBehalfOf,
  comment: t.comment,
  decidedAt: iso(t.decidedAt),
});

const instanceOut = (i: InstanceWithTasks) => ({
  id: i.id,
  companyId: i.companyId,
  plantId: i.plantId,
  entityType: i.entityType,
  entityId: i.entityId,
  attributes: i.attributes,
  requesterId: i.requesterId,
  status: i.status,
  currentStep: i.currentStep,
  outcomeReason: i.outcomeReason,
  submittedAt: i.submittedAt.toISOString(),
  completedAt: iso(i.completedAt),
  tasks: i.tasks.map(taskOut),
});

const inboxOut = (t: InboxItem) => ({
  ...taskOut(t),
  delegatedFrom: t.delegatedFrom,
  entityType: t.instance.entityType,
  entityId: t.instance.entityId,
  attributes: t.instance.attributes,
  requesterId: t.instance.requesterId,
  submittedAt: t.instance.submittedAt.toISOString(),
});

const delegationOut = (d: DelegationRow) => ({ ...d });

/** Approval workflow design, inbox, decisions and delegation (step 0.8). */
@Controller('v1/platform')
export class ApprovalController {
  constructor(
    private readonly definitions: WorkflowDefinitionService,
    private readonly approvals: ApprovalService,
  ) {}

  // ----- workflow design -----------------------------------------------------------------

  @Get('companies/:companyId/workflows')
  @RequirePermission(P.workflowRead)
  async list(@Param('companyId', idPipe) companyId: string) {
    return { items: (await this.definitions.list(companyId)).map(definitionOut) };
  }

  @Post('companies/:companyId/workflows/drafts')
  @RequirePermission(P.workflowManage)
  async saveDraft(
    @Param('companyId', idPipe) companyId: string,
    @Body(new ZodPipe(saveDraftBody)) body: z.output<typeof saveDraftBody>,
  ) {
    return definitionOut(await this.definitions.saveDraft(companyId, body));
  }

  @Post('workflow-versions/:id/publish')
  @HttpCode(200)
  @RequirePermission(P.workflowManage)
  async publish(@Param('id', idPipe) id: string) {
    return versionOut(await this.definitions.publish(id));
  }

  @Post('companies/:companyId/workflows/validate')
  @HttpCode(200)
  @RequirePermission(P.workflowRead)
  async validate(
    @Param('companyId', idPipe) companyId: string,
    @Body(new ZodPipe(validateBody)) body: z.output<typeof validateBody>,
  ) {
    return { steps: await this.definitions.validate(companyId, body) };
  }

  // ----- inbox and decisions (authorised per task: assignee or delegate) ------------------

  @Get('approval-tasks')
  @AnyMember()
  async inbox() {
    return { items: (await this.approvals.inbox()).map(inboxOut) };
  }

  @Post('approval-tasks/:id/approve')
  @HttpCode(200)
  @AnyMember()
  async approve(
    @Param('id', idPipe) id: string,
    @Body(new ZodPipe(decisionBody)) body: z.output<typeof decisionBody>,
  ) {
    return taskOut(await this.approvals.decide(id, 'approved', body.comment ?? null));
  }

  @Post('approval-tasks/:id/reject')
  @HttpCode(200)
  @AnyMember()
  async reject(
    @Param('id', idPipe) id: string,
    @Body(new ZodPipe(decisionBody)) body: z.output<typeof decisionBody>,
  ) {
    return taskOut(await this.approvals.decide(id, 'rejected', body.comment ?? null));
  }

  @Get('approval-instances/:id')
  @AnyMember()
  async instance(@Param('id', idPipe) id: string) {
    return instanceOut(await this.approvals.getInstance(id));
  }

  @Post('approval-instances/:id/cancel')
  @HttpCode(200)
  @AnyMember()
  async cancel(
    @Param('id', idPipe) id: string,
    @Body(new ZodPipe(cancelBody)) body: z.output<typeof cancelBody>,
  ) {
    await this.approvals.cancelByUser(id, body.reason);
    return instanceOut(await this.approvals.getInstance(id));
  }

  // ----- delegation (own delegations only) -----------------------------------------------

  @Get('delegations')
  @AnyMember()
  async delegations() {
    return { items: (await this.approvals.delegations()).map(delegationOut) };
  }

  @Post('delegations')
  @AnyMember()
  async delegate(@Body(new ZodPipe(delegationBody)) body: z.output<typeof delegationBody>) {
    return delegationOut(await this.approvals.delegate(body));
  }

  @Post('delegations/:id/revoke')
  @HttpCode(204)
  @AnyMember()
  async revoke(@Param('id', idPipe) id: string): Promise<void> {
    await this.approvals.revokeDelegation(id);
  }
}

export function registerApprovalOpenApi(registry: OpenAPIRegistry): void {
  const security = [{ bearer: [] }];
  const json = (schema: z.ZodType) => ({ 'application/json': { schema } });
  const ok = (description = 'OK') => ({ 200: { description } });
  const id = z.object({ id: z.uuid() });
  const companyId = z.object({ companyId: z.uuid() });
  const path = (
    method: 'get' | 'post',
    p: string,
    tags: string[],
    summary: string,
    request: Record<string, unknown> = {},
  ) =>
    registry.registerPath({
      method,
      path: p,
      tags,
      security,
      summary,
      request,
      responses: ok(),
    });
  const wf = ['Workflows'];
  const ap = ['Approvals'];
  path(
    'get',
    '/v1/platform/companies/{companyId}/workflows',
    wf,
    'List approval workflows with versions',
    { params: companyId },
  );
  path(
    'post',
    '/v1/platform/companies/{companyId}/workflows/drafts',
    wf,
    'Save a draft flow (creates the workflow if new)',
    {
      params: companyId,
      body: { content: json(saveDraftBody) },
    },
  );
  path('post', '/v1/platform/workflow-versions/{id}/publish', wf, 'Publish a draft version', {
    params: id,
  });
  path(
    'post',
    '/v1/platform/companies/{companyId}/workflows/validate',
    wf,
    'Dry-run a flow against document facts',
    {
      params: companyId,
      body: { content: json(validateBody) },
    },
  );
  path('get', '/v1/platform/approval-tasks', ap, 'My pending approval tasks (including delegated)');
  path('post', '/v1/platform/approval-tasks/{id}/approve', ap, 'Approve a task', {
    params: id,
    body: { content: json(decisionBody) },
  });
  path('post', '/v1/platform/approval-tasks/{id}/reject', ap, 'Reject a task (comment required)', {
    params: id,
    body: { content: json(decisionBody) },
  });
  path(
    'get',
    '/v1/platform/approval-instances/{id}',
    ap,
    'Approval instance with its task timeline',
    { params: id },
  );
  path('post', '/v1/platform/approval-instances/{id}/cancel', ap, 'Cancel an open approval', {
    params: id,
    body: { content: json(cancelBody) },
  });
  path('get', '/v1/platform/delegations', ap, 'My delegations (given and received)');
  path('post', '/v1/platform/delegations', ap, 'Delegate my approvals for a date range', {
    body: { content: json(delegationBody) },
  });
  path('post', '/v1/platform/delegations/{id}/revoke', ap, 'End a delegation', { params: id });
}
