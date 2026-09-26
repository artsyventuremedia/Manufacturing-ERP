import { UnitOfWork } from '@manuling/db';
import { ForbiddenError, RequestContexts } from '@manuling/kernel';
import { Injectable } from '@nestjs/common';
import { AccessLoader } from '../authorisation/access-loader.js';
import { isInvitationUsable } from '../domain/app-user.js';
import { type AppUserRecord, IdentityRepository } from '../infrastructure/identity.repository.js';
import { ChangeLog } from './change-log.js';
import { type Principal } from './principal.js';
import { userSnapshot } from './snapshots.js';
import { type VerifiedToken } from './token-verifier.js';

/**
 * Resolves (tenant slug, verified token) to a Principal with its access snapshot.
 * Unknown tenants and non-members get the same 403 so slugs cannot be enumerated (ADR-0013).
 * A pending invitation is bound on first sign-in when the token carries the same verified email.
 */
@Injectable()
export class Authenticator {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly identity: IdentityRepository,
    private readonly accessLoader: AccessLoader,
    private readonly changes: ChangeLog,
  ) {}

  async authenticate(
    tenantSlug: string,
    token: VerifiedToken,
    now: Date = new Date(),
  ): Promise<Principal> {
    const base = RequestContexts.require();
    const entry = await this.uow.run(() => this.identity.findDirectoryEntry(tenantSlug), {
      readOnly: true,
    });
    if (!entry) throw notAMember();

    return RequestContexts.run({ ...base, tenantId: entry.id }, () =>
      this.uow.run(async () => {
        const tenant = await this.identity.findCurrentTenant();
        let user = await this.identity.findUserBySubject(token.subject);
        if (!user) user = await this.acceptInvitation(token, now);
        if (!user || !tenant) throw notAMember();
        if (user.status !== 'active')
          throw new ForbiddenError('auth.user_disabled', 'This user account is disabled');
        if (tenant.status !== 'active')
          throw new ForbiddenError('auth.tenant_suspended', 'This workspace is suspended');

        const timezone = user.timezone ?? tenant.defaultTimezone;
        const { access, companyIds } = await this.accessLoader.load(user.id, timezone, now);
        return {
          tenantId: tenant.id,
          tenantSlug: tenant.slug,
          userId: user.id,
          locale: user.locale,
          timezone,
          access,
          companyIds,
        };
      }),
    );
  }

  private async acceptInvitation(
    token: VerifiedToken,
    now: Date,
  ): Promise<AppUserRecord | undefined> {
    if (!token.email || !token.emailVerified) return undefined;
    const invitation = await this.identity.findInvitation(token.email.trim().toLowerCase());
    if (!invitation) return undefined;
    if (!isInvitationUsable(invitation, now)) {
      throw new ForbiddenError(
        'auth.invitation_expired',
        'This invitation has expired; ask an administrator to invite you again',
      );
    }
    // The accepted invitation is the user's own first action: audit it as them.
    const base = RequestContexts.require();
    return RequestContexts.run(
      { ...base, actor: { type: 'user', id: invitation.id } },
      async () => {
        const bound = await this.identity.bindInvitation(invitation.id, token.subject);
        const after = userSnapshot(bound);
        await this.changes.record({
          entityType: 'platform.user',
          entityId: bound.id,
          action: 'accept_invitation',
          before: userSnapshot(invitation),
          after,
          event: { type: 'platform.UserActivated.v1', aggregateType: 'User', data: after },
        });
        return bound;
      },
    );
  }
}

function notAMember(): ForbiddenError {
  return new ForbiddenError('auth.not_a_member', 'You do not have access to this workspace');
}
