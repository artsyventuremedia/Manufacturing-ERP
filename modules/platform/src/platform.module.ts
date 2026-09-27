import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, DiscoveryModule } from '@nestjs/core';
import { AccessDenialInterceptor } from './api/access-denial.interceptor.js';
import { ApprovalController } from './api/approval.controller.js';
import { AuditController } from './api/audit.controller.js';
import { AuthenticationGuard } from './api/authentication.guard.js';
import { AuthorisationController } from './api/authorisation.controller.js';
import { CustomisationController } from './api/customisation.controller.js';
import { IdempotencyInterceptor } from './api/idempotency.interceptor.js';
import { MeController } from './api/me.controller.js';
import { NumberingController } from './api/numbering.controller.js';
import { OrganisationController } from './api/organisation.controller.js';
import { RequestContextInterceptor } from './api/request-context.interceptor.js';
import { RouteAccessCheck } from './api/route-access.check.js';
import { ApprovalActivities } from './application/approval.activities.js';
import { ApprovalService } from './application/approval.service.js';
import { ApproverResolver } from './application/approver-resolver.js';
import { AuditService } from './application/audit.service.js';
import { Authenticator } from './application/authenticator.js';
import { AuthorisationService } from './application/authorisation.service.js';
import { ChangeLog } from './application/change-log.js';
import { CustomRecordService } from './application/custom-record.service.js';
import { CustomisationService } from './application/customisation.service.js';
import { ExtensionService } from './application/extensions.js';
import { IdempotencyService } from './application/idempotency.service.js';
import { IdentityService } from './application/identity.service.js';
import { NumberingService } from './application/numbering.service.js';
import { OrganisationService } from './application/organisation.service.js';
import { ProvisioningService } from './application/provisioning.service.js';
import { WorkflowDefinitionService } from './application/workflow-definition.service.js';
import { TOKEN_VERIFIER } from './application/token-verifier.js';
import { AccessLoader } from './authorisation/access-loader.js';
import { APPROVAL_PORT } from './contracts/approvals.js';
import { NUMBERING_PORT } from './contracts/numbering.js';
import './authorisation/permissions.js';
import { ApprovalRepository } from './infrastructure/approval.repository.js';
import { AuthorisationRepository } from './infrastructure/authorisation.repository.js';
import { CustomisationRepository } from './infrastructure/customisation.repository.js';
import { IdentityRepository } from './infrastructure/identity.repository.js';
import { NumberingRepository } from './infrastructure/numbering.repository.js';
import { OidcTokenVerifier } from './infrastructure/oidc-token-verifier.js';
import { OrganisationRepository } from './infrastructure/organisation.repository.js';
import { PLATFORM_OPTIONS, type PlatformOptions } from './platform.options.js';

/**
 * Platform bounded context. Registers the global authentication/authorisation guard, the
 * context → access-denial → idempotency interceptors (in that order), and the boot-time
 * check that every route declares an access rule. Requires UnitOfWork, AuditTrail and
 * EventOutbox from the host's DatabaseModule.
 */
@Module({})
export class PlatformModule {
  static forRoot(options: PlatformOptions): DynamicModule {
    return {
      module: PlatformModule,
      // Global so other modules can inject the platform ports (e.g. NUMBERING_PORT).
      global: true,
      imports: [DiscoveryModule],
      controllers: [
        MeController,
        OrganisationController,
        AuthorisationController,
        AuditController,
        NumberingController,
        ApprovalController,
        CustomisationController,
      ],
      providers: [
        { provide: PLATFORM_OPTIONS, useValue: options },
        {
          provide: TOKEN_VERIFIER,
          useValue: options.tokenVerifier ?? new OidcTokenVerifier(options.oidc),
        },
        IdentityRepository,
        OrganisationRepository,
        AuthorisationRepository,
        AccessLoader,
        ChangeLog,
        CustomisationRepository,
        ExtensionService,
        CustomisationService,
        CustomRecordService,
        AuditService,
        Authenticator,
        AuthorisationService,
        RouteAccessCheck,
        IdentityService,
        OrganisationService,
        IdempotencyService,
        ProvisioningService,
        NumberingRepository,
        NumberingService,
        { provide: NUMBERING_PORT, useExisting: NumberingService },
        ApprovalRepository,
        ApproverResolver,
        WorkflowDefinitionService,
        ApprovalService,
        ApprovalActivities,
        { provide: APPROVAL_PORT, useExisting: ApprovalService },
        { provide: APP_GUARD, useClass: AuthenticationGuard },
        { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
        { provide: APP_INTERCEPTOR, useClass: AccessDenialInterceptor },
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
      ],
      exports: [ProvisioningService, NUMBERING_PORT, APPROVAL_PORT, ApprovalActivities],
    };
  }
}
