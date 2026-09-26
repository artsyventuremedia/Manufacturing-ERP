import { isActive, isGranted, scopeCovers } from '@manuling/authz';
import { LocalDate, RequestContexts } from '@manuling/kernel';
import { Injectable } from '@nestjs/common';
import { AccessLoader } from '../authorisation/access-loader.js';
import { type ApproverSpec } from '../domain/approval.js';
import { AuthorisationRepository } from '../infrastructure/authorisation.repository.js';
import { IdentityRepository } from '../infrastructure/identity.repository.js';

export interface ApprovalSubject {
  readonly companyId: string;
  readonly plantId: string | null;
  readonly attributes: Readonly<Record<string, string | number | boolean | null>>;
  readonly requesterId: string;
}

/**
 * Turns an approver spec into the active users who may decide, for one document.
 * The requester is always excluded (W4). Runs inside a tenant-scoped UnitOfWork.
 */
@Injectable()
export class ApproverResolver {
  constructor(
    private readonly identity: IdentityRepository,
    private readonly authorisation: AuthorisationRepository,
    private readonly accessLoader: AccessLoader,
  ) {}

  async resolve(spec: ApproverSpec, subject: ApprovalSubject): Promise<string[]> {
    const { timezone } = RequestContexts.requireTenant();
    const today = LocalDate.fromInstant(new Date(), timezone);
    const scope = {
      companyId: subject.companyId,
      ...(subject.plantId ? { plantId: subject.plantId } : {}),
    };
    const active = (await this.identity.listActiveUsers()).filter(
      (u) => u.id !== subject.requesterId,
    );
    let ids: string[];

    switch (spec.type) {
      case 'users': {
        const wanted = new Set(spec.userIds);
        ids = active.filter((u) => wanted.has(u.id)).map((u) => u.id);
        break;
      }
      case 'role': {
        const role = await this.authorisation.findRoleByCode(spec.role);
        if (!role || role.status !== 'active') return [];
        ids = [];
        for (const user of active) {
          const assignments = await this.authorisation.assignmentsForUser(user.id);
          const holds = assignments.some(
            (a) =>
              a.roleId === role.id &&
              isActive(a, today) &&
              scopeCovers({ ...a, permissions: new Set(), roleId: a.roleId }, scope),
          );
          if (holds) ids.push(user.id);
        }
        break;
      }
      case 'permission': {
        // Each candidate's own role conditions (e.g. amount limits) must accept the document.
        ids = [];
        for (const user of active) {
          const { access } = await this.accessLoader.load(user.id, user.timezone ?? timezone);
          if (isGranted(access, spec.permission, { ...scope, attributes: subject.attributes }))
            ids.push(user.id);
        }
        break;
      }
    }
    return [...new Set(ids)].sort();
  }
}
