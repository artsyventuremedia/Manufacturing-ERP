import 'reflect-metadata';
import { LocalDate } from '@manuling/kernel';
import {
  ProvisioningService,
  type ProvisionTenantInput,
  type ProvisionedTenant,
} from '@manuling/platform/module';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { type AppConfig, loadConfig } from '../config/config.js';

/** Boots the application context (no HTTP server) and provisions one tenant. */
export async function provisionTenant(
  input: ProvisionTenantInput,
  config: AppConfig = loadConfig(),
): Promise<ProvisionedTenant> {
  const app = await NestFactory.createApplicationContext(AppModule.forRoot(config), {
    logger: ['error', 'warn'],
    abortOnError: false,
  });
  try {
    return await app.get(ProvisioningService).provision(input);
  } finally {
    await app.close();
  }
}

/** Calendar year in which the fiscal year containing today started (India: April). */
export function currentFiscalYearStart(
  startMonth: number,
  timezone: string,
  today: Date = new Date(),
): number {
  const date = LocalDate.fromInstant(today, timezone);
  return date.month >= startMonth ? date.year : date.year - 1;
}
