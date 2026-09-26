import { type PlatformEventData } from '../contracts/events.js';
import { type AppUser } from '../domain/app-user.js';
import { type Company } from '../domain/company.js';
import { type FiscalYear } from '../domain/fiscal-year.js';
import { type Plant } from '../domain/plant.js';
import { type Role, type RoleAssignment } from '../domain/role.js';

/** Stable, contract-shaped snapshots used for audit before/after and event data. */

export function companySnapshot(c: Company): PlatformEventData<'platform.CompanyCreated.v1'> {
  return {
    id: c.id,
    code: c.code,
    legalName: c.legalName,
    baseCurrency: c.baseCurrency,
    countryCode: c.countryCode,
    fiscalYearStartMonth: c.fiscalYearStartMonth,
    status: c.status,
    version: c.version,
  };
}

export function plantSnapshot(p: Plant): PlatformEventData<'platform.PlantCreated.v1'> {
  return {
    id: p.id,
    companyId: p.companyId,
    code: p.code,
    name: p.name,
    regionCode: p.regionCode,
    timezone: p.timezone,
    status: p.status,
    version: p.version,
  };
}

export function fiscalYearSnapshot(
  f: FiscalYear,
): PlatformEventData<'platform.FiscalYearOpened.v1'> {
  return {
    id: f.id,
    companyId: f.companyId,
    code: f.code,
    startDate: f.startDate.toString(),
    endDate: f.endDate.toString(),
    status: f.status,
  };
}

export function userSnapshot(u: AppUser): PlatformEventData<'platform.UserChanged.v1'> {
  return { id: u.id, email: u.email, displayName: u.displayName, status: u.status };
}

export function roleSnapshot(
  r: Role,
  permissions: Iterable<string>,
): PlatformEventData<'platform.RoleChanged.v1'> {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    isSystem: r.isSystem,
    status: r.status,
    permissions: [...permissions].sort(),
  };
}

export function assignmentSnapshot(
  a: RoleAssignment & { roleCode: string },
): PlatformEventData<'platform.UserRoleAssigned.v1'> & { conditions: unknown[] } {
  return {
    id: a.id,
    userId: a.userId,
    roleId: a.roleId,
    roleCode: a.roleCode,
    companyId: a.companyId,
    plantId: a.plantId,
    validFrom: a.validFrom?.toString() ?? null,
    validTo: a.validTo?.toString() ?? null,
    status: a.status,
    conditions: [...a.conditions],
  };
}
