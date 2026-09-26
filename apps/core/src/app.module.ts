import { ProblemDetailsFilter } from '@manuling/http';
import { PlatformModule, type TokenVerifier } from '@manuling/platform/module';
import { type DynamicModule, Module, type ModuleMetadata } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { type AppConfig } from './config/config.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { loggerOptions } from './logger.js';
import { OpenApiModule } from './openapi/openapi.module.js';

export interface AppModuleExtras extends Pick<ModuleMetadata, 'imports'> {
  /** Replaces OIDC verification (integration tests). */
  readonly tokenVerifier?: TokenVerifier | undefined;
}

/**
 * Composition root of the modular monolith. Bounded-context modules are added to `imports`
 * as they are built (Phase 0.4+); no business logic lives here.
 */
@Module({})
export class AppModule {
  static forRoot(config: AppConfig, extra: AppModuleExtras = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        LoggerModule.forRoot(loggerOptions(config)),
        DatabaseModule,
        HealthModule,
        OpenApiModule,
        PlatformModule.forRoot({
          oidc: { issuer: config.auth.issuer, audience: config.auth.audience },
          tenantBaseDomain: config.auth.tenantBaseDomain,
          supportedLocales: config.i18n.supportedLocales,
          tokenVerifier: extra.tokenVerifier,
        }),
        ...(extra.imports ?? []),
      ],
      providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
    };
  }
}
