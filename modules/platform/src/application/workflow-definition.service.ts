import { AccessControl, permissionRegistry } from '@manuling/authz';
import { UnitOfWork } from '@manuling/db';
import {
  BusinessRuleViolation,
  NotFoundError,
  RequestContexts,
  ValidationError,
  newId,
} from '@manuling/kernel';
import { Injectable } from '@nestjs/common';
import { PLATFORM_PERMISSIONS as P } from '../authorisation/permissions.js';
import { type ApprovalFlow, parseFlow, stepApplies } from '../domain/approval.js';
import { parseName } from '../domain/validation.js';
import {
  ApprovalRepository,
  type DefinitionRow,
  type VersionRow,
} from '../infrastructure/approval.repository.js';
import { OrganisationRepository } from '../infrastructure/organisation.repository.js';
import { ApproverResolver } from './approver-resolver.js';
import { ChangeLog } from './change-log.js';

const DOC_TYPE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

export type DefinitionWithVersions = DefinitionRow & { readonly versions: readonly VersionRow[] };

export interface DryRunStep {
  readonly id: string;
  readonly name: string;
  readonly applies: boolean;
  readonly approverIds: readonly string[];
}

export const parseStoredFlow = (flow: unknown): ApprovalFlow =>
  parseFlow(flow, { isKnownPermission: (c) => permissionRegistry.has(c) });

/** Designing, validating and publishing approval workflows (plan W5). */
@Injectable()
export class WorkflowDefinitionService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repo: ApprovalRepository,
    private readonly organisation: OrganisationRepository,
    private readonly resolver: ApproverResolver,
    private readonly changes: ChangeLog,
  ) {}

  list(companyId: string): Promise<DefinitionWithVersions[]> {
    return this.uow.run(
      async () => {
        await this.visibleCompany(companyId, P.workflowRead);
        const defs = await this.repo.listDefinitions(companyId);
        return Promise.all(
          defs.map(async (d) => ({ ...d, versions: await this.repo.versions(d.id) })),
        );
      },
      { readOnly: true },
    );
  }

  /** Creates the workflow if needed and saves `flow` as its (single) draft version. */
  saveDraft(
    companyId: string,
    input: { docType: string; name: string; flow: unknown },
  ): Promise<DefinitionWithVersions> {
    if (!DOC_TYPE.test(input.docType)) {
      throw new ValidationError('platform.workflow.doc_type_invalid', 'Use "module.document"', {}, [
        {
          path: 'docType',
          code: 'platform.workflow.doc_type_invalid',
          message: 'Use "module.document"',
        },
      ]);
    }
    const name = parseName(input.name, 'name');
    parseStoredFlow(input.flow); // reject invalid drafts early
    return this.uow.run(async () => {
      await this.visibleCompany(companyId, P.workflowManage);
      let def = await this.repo.findDefinition(companyId, input.docType);
      if (!def) {
        def = { id: newId(), companyId, docType: input.docType, name, status: 'active' };
        await this.repo.insertDefinition(def);
      } else if (def.name !== name) {
        await this.repo.renameDefinition(def.id, name);
      }
      const draft = await this.repo.upsertDraft(def.id, newId(), input.flow);
      await this.changes.record({
        entityType: 'platform.workflow_version',
        entityId: draft.id,
        action: 'save_draft',
        after: {
          definitionId: def.id,
          docType: input.docType,
          number: draft.number,
          flow: input.flow,
        },
      });
      return { ...def, name, versions: await this.repo.versions(def.id) };
    });
  }

  publish(versionId: string): Promise<VersionRow> {
    const { actor } = RequestContexts.requireTenant();
    return this.uow.run(async () => {
      const version = await this.repo.getVersion(versionId);
      const def = await this.repo.getDefinition(version.definitionId);
      await this.visibleCompany(
        def.companyId,
        P.workflowManage,
        () => new NotFoundError('WorkflowVersion', versionId),
      );
      if (version.status !== 'draft') {
        throw new BusinessRuleViolation(
          'platform.workflow.not_draft',
          'Only a draft version can be published',
        );
      }
      parseStoredFlow(version.flow); // permissions may have changed since the draft was saved
      await this.repo.publish(version.id, def.id, actor.type === 'user' ? actor.id : null);
      const published = await this.repo.getVersion(version.id);
      await this.changes.record({
        entityType: 'platform.workflow_version',
        entityId: version.id,
        action: 'publish',
        after: { definitionId: def.id, docType: def.docType, number: published.number },
        event: {
          type: 'platform.WorkflowVersionPublished.v1',
          aggregateType: 'WorkflowDefinition',
          data: {
            definitionId: def.id,
            versionId: version.id,
            companyId: def.companyId,
            docType: def.docType,
            version: published.number,
          },
        },
      });
      return published;
    });
  }

  /** Dry run: which steps would apply to these document facts, and who would approve. */
  validate(
    companyId: string,
    input: {
      flow: unknown;
      attributes: Record<string, string | number | boolean | null>;
      plantId?: string | undefined;
      requesterId?: string | undefined;
    },
  ): Promise<DryRunStep[]> {
    const flow = parseStoredFlow(input.flow);
    return this.uow.run(
      async () => {
        await this.visibleCompany(companyId, P.workflowRead);
        const requesterId = input.requesterId ?? RequestContexts.requireTenant().actor.id;
        const subject = {
          companyId,
          plantId: input.plantId ?? null,
          attributes: input.attributes,
          requesterId,
        };
        const result: DryRunStep[] = [];
        for (const step of flow.steps) {
          const applies = stepApplies(step, input.attributes, requesterId);
          result.push({
            id: step.id,
            name: step.name,
            applies,
            approverIds: applies ? await this.resolver.resolve(step.approvers, subject) : [],
          });
        }
        return result;
      },
      { readOnly: true },
    );
  }

  private async visibleCompany(
    companyId: string,
    permission: string,
    notFound?: () => Error,
  ): Promise<void> {
    if (!RequestContexts.requireTenant().companyIds.includes(companyId)) {
      throw notFound ? notFound() : new NotFoundError('Company', companyId);
    }
    await this.organisation.getCompany(companyId);
    AccessControl.assert(permission, { companyId });
  }
}
