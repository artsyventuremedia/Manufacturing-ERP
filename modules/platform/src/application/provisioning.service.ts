import { UnitOfWork } from '@manuling/db';
import { type RequestContext, RequestContexts, newId } from '@manuling/kernel';
import { Inject, Injectable } from '@nestjs/common';
import {
  SYSTEM_ROLES,
  SYSTEM_SOD_RULES,
  OWNER_ROLE_CODE,
  defaultSodSeverity,
} from '../authorisation/role-templates.js';
import { createAppUser } from '../domain/app-user.js';
import { createAssignment } from '../domain/role.js';
import { type NewCompany, createCompany } from '../domain/company.js';
import { createFiscalYear } from '../domain/fiscal-year.js';
import { type NewPlant, createPlant } from '../domain/plant.js';
import { type Edition, createTenant } from '../domain/tenant.js';
import { AuthorisationRepository } from '../infrastructure/authorisation.repository.js';
import { IdentityRepository } from '../infrastructure/identity.repository.js';
import { OrganisationRepository } from '../infrastructure/organisation.repository.js';
import { PLATFORM_OPTIONS, type PlatformOptions } from '../platform.options.js';
import { ChangeLog } from './change-log.js';
import { companySnapshot, fiscalYearSnapshot, plantSnapshot, userSnapshot } from './snapshots.js';

export interface ProvisionTenantInput {
  readonly slug: string;
  readonly name: string;
  readonly edition: Edition;
  readonly defaultLocale: string;
  readonly defaultTimezone: string;
  readonly company: NewCompany;
  readonly plant: NewPlant;
  /** Calendar year in which the first fiscal year starts (e.g. 2026 → FY 2026-27 in India). */
  readonly firstFiscalYear: number;
  readonly admin: {
    readonly idpSubject: string;
    readonly email: string;
    readonly displayName: string;
  };
}

export interface ProvisionedTenant {
  readonly tenantId: string;
  readonly companyId: string;
  readonly plantId: string;
  readonly fiscalYearId: string;
  readonly adminUserId: string;
}

/**
 * Creates a ready-to-use tenant in one transaction: tenant → company → plant → fiscal year
 * → admin user. Runs as the app role inside the new tenant's RLS scope, so it needs no
 * elevated database privileges. Invoked by the operator CLI (the control plane later, ADR-0005).
 */
@Injectable()
export class ProvisioningService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly identity: IdentityRepository,
    private readonly organisation: OrganisationRepository,
    private readonly authorisation: AuthorisationRepository,
    private readonly changes: ChangeLog,
    @Inject(PLATFORM_OPTIONS) private readonly options: PlatformOptions,
  ) {}

  async provision(
    input: ProvisionTenantInput,
    correlationId: string = newId(),
  ): Promise<ProvisionedTenant> {
    const tenant = createTenant(input, this.options.supportedLocales);
    const company = createCompany(input.company);
    const plant = createPlant(company, input.plant);
    const fiscalYear = createFiscalYear(company, input.firstFiscalYear, []);
    const admin = createAppUser(input.admin);

    const context: RequestContext = {
      correlationId,
      source: 'system',
      locale: tenant.defaultLocale,
      timezone: tenant.defaultTimezone,
      companyIds: [],
      tenantId: tenant.id,
      actor: { type: 'system', id: 'tenant-provisioning' },
    };
    await RequestContexts.run(context, () =>
      this.uow.run(async () => {
        await this.identity.insertTenant(tenant);
        await this.organisation.insertCompany(company);
        await this.organisation.insertPlant(plant);
        await this.organisation.insertFiscalYear(fiscalYear);
        await this.identity.insertUser(admin);
        await this.seedAuthorisation(tenant.edition, admin.id);
        await this.changes.record({
          entityType: 'platform.tenant',
          entityId: tenant.id,
          action: 'provision',
          after: {
            tenant,
            company: companySnapshot(company),
            plant: plantSnapshot(plant),
            fiscalYear: fiscalYearSnapshot(fiscalYear),
            admin: userSnapshot(admin),
          },
          event: {
            type: 'platform.TenantProvisioned.v1',
            aggregateType: 'Tenant',
            data: {
              tenantId: tenant.id,
              slug: tenant.slug,
              edition: tenant.edition,
              companyId: company.id,
              plantId: plant.id,
              adminUserId: admin.id,
            },
          },
        });
      }),
    );
    return {
      tenantId: tenant.id,
      companyId: company.id,
      plantId: plant.id,
      fiscalYearId: fiscalYear.id,
      adminUserId: admin.id,
    };
  }

  /** Built-in roles (plan D2), SoD rules (plan D3) and a tenant-wide Owner assignment for the admin. */
  private async seedAuthorisation(edition: Edition, adminUserId: string): Promise<void> {
    let ownerRoleId: string | undefined;
    for (const template of SYSTEM_ROLES) {
      const id = newId();
      await this.authorisation.insertRole({
        id,
        code: template.code,
        name: template.name,
        description: template.description,
        isSystem: true,
        status: 'active',
        version: 1,
      });
      if (template.code === OWNER_ROLE_CODE) ownerRoleId = id;
    }
    for (const rule of SYSTEM_SOD_RULES) {
      await this.authorisation.insertSodRule({
        id: newId(),
        code: rule.code,
        name: rule.name,
        permissionA: rule.a,
        permissionB: rule.b,
        severity: defaultSodSeverity(edition),
        isSystem: true,
        status: 'active',
      });
    }
    await this.authorisation.insertAssignment(
      createAssignment({ userId: adminUserId, roleId: ownerRoleId! }),
    );
  }
}
