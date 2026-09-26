import { BusinessRuleViolation, LocalDate, ValidationError } from '@manuling/kernel';
import { describe, expect, it } from 'vitest';
import { createAppUser } from './app-user.js';
import { changeCompany, createCompany, defaultFiscalYearStartMonth } from './company.js';
import { createFiscalYear } from './fiscal-year.js';
import { changePlant, createPlant } from './plant.js';
import { createTenant } from './tenant.js';

const LOCALES = ['en-IN', 'kn-IN', 'hi-IN'];
const mpc = () =>
  createCompany({
    code: 'mpc',
    legalName: '  Mysuru  Precision Components Pvt. Ltd. ',
    baseCurrency: 'inr',
    countryCode: 'in',
  });

describe('company', () => {
  it('normalises input and defaults the Indian fiscal year to April', () => {
    const c = mpc();
    expect(c).toMatchObject({
      code: 'MPC',
      legalName: 'Mysuru Precision Components Pvt. Ltd.',
      baseCurrency: 'INR',
      countryCode: 'IN',
      fiscalYearStartMonth: 4,
      status: 'active',
      version: 1,
    });
    expect(defaultFiscalYearStartMonth('US')).toBe(1);
    expect(
      createCompany({
        code: 'X',
        legalName: 'X',
        baseCurrency: 'USD',
        countryCode: 'US',
        fiscalYearStartMonth: 10,
      }).fiscalYearStartMonth,
    ).toBe(10);
  });

  it('rejects invalid codes, currencies and months with field errors', () => {
    expect(() =>
      createCompany({ code: 'bad code', legalName: 'X', baseCurrency: 'INR', countryCode: 'IN' }),
    ).toThrow(
      expect.objectContaining({ fieldErrors: [expect.objectContaining({ path: 'code' })] }),
    );
    expect(() =>
      createCompany({ code: 'A', legalName: 'X', baseCurrency: 'RUPEE', countryCode: 'IN' }),
    ).toThrow(ValidationError);
    expect(() =>
      createCompany({ code: 'A', legalName: 'X', baseCurrency: 'INR', countryCode: 'IND' }),
    ).toThrow(ValidationError);
    expect(() =>
      createCompany({ code: 'A', legalName: ' ', baseCurrency: 'INR', countryCode: 'IN' }),
    ).toThrow(ValidationError);
    expect(() =>
      createCompany({
        code: 'A',
        legalName: 'X',
        baseCurrency: 'INR',
        countryCode: 'IN',
        fiscalYearStartMonth: 13,
      }),
    ).toThrow(ValidationError);
  });

  it('locks the fiscal calendar once fiscal years exist', () => {
    const c = mpc();
    expect(changeCompany(c, { fiscalYearStartMonth: 1 }, false).fiscalYearStartMonth).toBe(1);
    expect(() => changeCompany(c, { fiscalYearStartMonth: 1 }, true)).toThrow(
      BusinessRuleViolation,
    );
    expect(
      changeCompany(
        c,
        { fiscalYearStartMonth: 4, legalName: 'New Name', status: 'inactive' },
        true,
      ),
    ).toMatchObject({
      legalName: 'New Name',
      status: 'inactive',
    });
  });
});

describe('plant', () => {
  it('validates region against the company country and the time zone', () => {
    const c = mpc();
    const p = createPlant(c, {
      code: 'mys1',
      name: 'Hebbal',
      regionCode: 'in-ka',
      timezone: 'Asia/Kolkata',
    });
    expect(p).toMatchObject({ companyId: c.id, code: 'MYS1', regionCode: 'IN-KA' });
    expect(() =>
      createPlant(c, { code: 'P', name: 'X', regionCode: 'US-CA', timezone: 'Asia/Kolkata' }),
    ).toThrow(ValidationError);
    expect(() => createPlant(c, { code: 'P', name: 'X', timezone: 'Mars/Base' })).toThrow(
      ValidationError,
    );
    expect(createPlant(c, { code: 'P', name: 'X', timezone: 'UTC' }).regionCode).toBeNull();
  });

  it('applies changes, including clearing the region', () => {
    const p = createPlant(mpc(), {
      code: 'P',
      name: 'X',
      regionCode: 'IN-KA',
      timezone: 'Asia/Kolkata',
    });
    expect(changePlant(p, 'IN', { regionCode: null, name: 'Y', status: 'inactive' })).toMatchObject(
      {
        regionCode: null,
        name: 'Y',
        status: 'inactive',
      },
    );
    expect(changePlant(p, 'IN', {}).regionCode).toBe('IN-KA');
    expect(() => changePlant(p, 'IN', { timezone: 'nowhere' })).toThrow(ValidationError);
  });
});

describe('fiscal year', () => {
  it('builds April–March years with Indian codes, and calendar years otherwise', () => {
    const fy = createFiscalYear({ id: 'c', fiscalYearStartMonth: 4 }, 2026, []);
    expect([fy.code, fy.startDate.toString(), fy.endDate.toString()]).toEqual([
      '2026-27',
      '2026-04-01',
      '2027-03-31',
    ]);
    const cy = createFiscalYear({ id: 'c', fiscalYearStartMonth: 1 }, 2026, []);
    expect([cy.code, cy.endDate.toString()]).toEqual(['2026', '2026-12-31']);
    expect(createFiscalYear({ id: 'c', fiscalYearStartMonth: 4 }, 2099, []).code).toBe('2099-00');
  });

  it('rejects overlaps and absurd years', () => {
    const existing = [
      {
        code: '2026-27',
        startDate: LocalDate.parse('2026-04-01'),
        endDate: LocalDate.parse('2027-03-31'),
      },
    ];
    expect(() => createFiscalYear({ id: 'c', fiscalYearStartMonth: 4 }, 2026, existing)).toThrow(
      BusinessRuleViolation,
    );
    expect(() => createFiscalYear({ id: 'c', fiscalYearStartMonth: 1 }, 2027, existing)).toThrow(
      BusinessRuleViolation,
    );
    expect(createFiscalYear({ id: 'c', fiscalYearStartMonth: 4 }, 2027, existing).code).toBe(
      '2027-28',
    );
    expect(() => createFiscalYear({ id: 'c', fiscalYearStartMonth: 4 }, 1800, [])).toThrow(
      ValidationError,
    );
  });
});

describe('tenant and user', () => {
  const base = {
    slug: 'Mysuru-Precision',
    name: 'MPC',
    edition: 'growth' as const,
    defaultLocale: 'kn-IN',
    defaultTimezone: 'Asia/Kolkata',
  };

  it('normalises slugs and rejects reserved, malformed or unsupported values', () => {
    expect(createTenant(base, LOCALES)).toMatchObject({
      slug: 'mysuru-precision',
      status: 'active',
    });
    expect(() => createTenant({ ...base, slug: 'api' }, LOCALES)).toThrow(
      expect.objectContaining({ code: 'platform.slug_reserved' }),
    );
    for (const slug of ['a', '-abc', 'abc-', 'a--b', 'has space']) {
      expect(() => createTenant({ ...base, slug }, LOCALES)).toThrow(ValidationError);
    }
    expect(() => createTenant({ ...base, defaultLocale: 'fr-FR' }, LOCALES)).toThrow(
      ValidationError,
    );
  });

  it('creates users with normalised email and validates the subject', () => {
    expect(
      createAppUser({ idpSubject: ' abc ', email: 'Owner@MPC.In', displayName: 'Owner' }),
    ).toMatchObject({
      idpSubject: 'abc',
      email: 'owner@mpc.in',
      userType: 'internal',
      status: 'active',
    });
    expect(() => createAppUser({ idpSubject: ' ', email: 'a@b.in', displayName: 'X' })).toThrow(
      ValidationError,
    );
    expect(() =>
      createAppUser({ idpSubject: 's', email: 'not-an-email', displayName: 'X' }),
    ).toThrow(ValidationError);
  });
});
