import { UnitOfWork } from '@manuling/db';
import { InvariantViolation, RequestContexts } from '@manuling/kernel';
import { Injectable } from '@nestjs/common';
import { type Tenant } from '../domain/tenant.js';
import { type AppUserRecord, IdentityRepository } from '../infrastructure/identity.repository.js';

@Injectable()
export class IdentityService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly identity: IdentityRepository,
  ) {}

  /** The calling user and their workspace. */
  me(): Promise<{ user: AppUserRecord; tenant: Tenant }> {
    const { actor } = RequestContexts.requireTenant();
    return this.uow.run(
      async () => {
        const user = await this.identity.findUser(actor.id);
        const tenant = await this.identity.findCurrentTenant();
        if (!user || !tenant) {
          throw new InvariantViolation(
            'platform.identity.principal_missing',
            'Authenticated principal no longer exists',
          );
        }
        return { user, tenant };
      },
      { readOnly: true },
    );
  }
}
