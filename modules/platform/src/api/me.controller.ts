import { AccessContexts, AnyMember, permissionsAnywhere } from '@manuling/authz';
import { RequestContexts } from '@manuling/kernel';
import { Controller, Get } from '@nestjs/common';
import { IdentityService } from '../application/identity.service.js';
import { type MeResponse } from './dto.js';

@Controller('v1/platform/me')
export class MeController {
  constructor(private readonly identity: IdentityService) {}

  /** The caller, their workspace, visible companies and effective permissions (for the UI). */
  @Get()
  @AnyMember()
  async me(): Promise<MeResponse> {
    const { user, tenant } = await this.identity.me();
    const ctx = RequestContexts.requireTenant();
    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        locale: ctx.locale,
        timezone: ctx.timezone,
      },
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, edition: tenant.edition },
      companyIds: [...ctx.companyIds],
      permissions: permissionsAnywhere(AccessContexts.require()),
    };
  }
}
