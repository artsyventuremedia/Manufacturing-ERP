import { ForbiddenError, InvariantViolation, LocalDate } from '@manuling/kernel';
import { describe, expect, it } from 'vitest';
import {
  AccessContexts,
  AccessControl,
  type AccessSnapshot,
  type Grant,
  holdsAnywhere,
  isGranted,
  mergeFieldPolicies,
  permissionsAnywhere,
  visibleCompanies,
} from './access.js';
import { evaluateConditions } from './conditions.js';
import { PermissionRegistry } from './permissions.js';
import { findSodConflicts } from './sod.js';

const TODAY = LocalDate.parse('2026-09-25');
const grant = (over: Omit<Partial<Grant>, 'permissions'> & { permissions: string[] }): Grant => ({
  roleId: 'r',
  companyId: null,
  plantId: null,
  conditions: [],
  validFrom: null,
  validTo: null,
  ...over,
  permissions: new Set(over.permissions),
});
const snapshot = (grants: Grant[], fieldAccess = new Map()): AccessSnapshot => ({
  userId: 'u1',
  today: TODAY,
  grants,
  fieldAccess,
});

describe('PermissionRegistry', () => {
  it('validates codes, splits parts and tolerates identical re-registration', () => {
    const r = new PermissionRegistry();
    const def = {
      code: 'platform.company.create',
      description: 'Create companies',
      featureKey: 'core',
    };
    r.register([def, def]);
    expect(r.get('platform.company.create')).toMatchObject({
      module: 'platform',
      entity: 'company',
      action: 'create',
    });
    expect(r.has('x.y.z')).toBe(false);
    expect(() => r.register([{ ...def, description: 'different' }])).toThrow(InvariantViolation);
    expect(() => r.register([{ ...def, code: 'Bad.Code' }])).toThrow(InvariantViolation);
    r.register([{ code: 'a.b.c', description: 'a', featureKey: 'core' }]);
    expect(r.all().map((p) => p.code)).toEqual(['a.b.c', 'platform.company.create']);
  });
});

describe('conditions', () => {
  it('compares decimals exactly and fails closed on missing attributes', () => {
    const limit = [{ attr: 'amount', op: 'lte' as const, value: '500000' }];
    expect(evaluateConditions(limit, { amount: '500000.00' }, 'u')).toBe(true);
    expect(evaluateConditions(limit, { amount: '500000.01' }, 'u')).toBe(false);
    expect(evaluateConditions(limit, {}, 'u')).toBe(false);
    expect(
      evaluateConditions([{ attr: 'amount', op: 'gt', value: '10' }], { amount: 'abc' }, 'u'),
    ).toBe(false);
    expect(
      evaluateConditions([{ attr: 'amount', op: 'gte', value: '10' }], { amount: 10 }, 'u'),
    ).toBe(true);
    expect(
      evaluateConditions([{ attr: 'amount', op: 'lt', value: '10' }], { amount: '9.99' }, 'u'),
    ).toBe(true);
    expect(
      evaluateConditions([{ attr: 'amount', op: 'gt', value: '10' }], { amount: '10' }, 'u'),
    ).toBe(false);
  });

  it('supports eq/ne/in and own-record', () => {
    expect(
      evaluateConditions([{ attr: 'amount', op: 'eq', value: '1.0' }], { amount: '1' }, 'u'),
    ).toBe(true);
    expect(
      evaluateConditions([{ attr: 'currency', op: 'ne', value: 'USD' }], { currency: 'INR' }, 'u'),
    ).toBe(true);
    expect(
      evaluateConditions(
        [{ attr: 'currency', op: 'in', value: ['INR', 'EUR'] }],
        { currency: 'USD' },
        'u',
      ),
    ).toBe(false);
    expect(evaluateConditions([{ op: 'own' }], { createdBy: 'u' }, 'u')).toBe(true);
    expect(evaluateConditions([{ op: 'own' }], { createdBy: 'v' }, 'u')).toBe(false);
  });
});

describe('grant evaluation', () => {
  const C1 = 'company-1';
  const C2 = 'company-2';

  it('applies tenant ⊇ company ⊇ plant scoping', () => {
    const s = snapshot([
      grant({ permissions: ['x.plant.read'], companyId: C1, plantId: 'p1' }),
      grant({ permissions: ['x.company.update'], companyId: C1 }),
    ]);
    expect(isGranted(s, 'x.plant.read', { companyId: C1, plantId: 'p1' })).toBe(true);
    expect(isGranted(s, 'x.plant.read', { companyId: C1, plantId: 'p2' })).toBe(false);
    expect(isGranted(s, 'x.company.update', { companyId: C1, plantId: 'p9' })).toBe(true);
    expect(isGranted(s, 'x.company.update', { companyId: C2 })).toBe(false);
    expect(isGranted(s, 'x.company.update')).toBe(false); // tenant-level needs tenant-wide
    expect(
      isGranted(snapshot([grant({ permissions: ['x.company.create'] })]), 'x.company.create'),
    ).toBe(true);
  });

  it('honours validity dates and conditions', () => {
    const s = snapshot([
      grant({ permissions: ['p.po.approve'], validFrom: LocalDate.parse('2026-10-01') }),
      grant({ permissions: ['p.po.release'], validTo: LocalDate.parse('2026-09-24') }),
      grant({
        permissions: ['p.po.create'],
        conditions: [{ attr: 'amount', op: 'lte', value: '100000' }],
      }),
    ]);
    expect(isGranted(s, 'p.po.approve')).toBe(false);
    expect(holdsAnywhere(s, 'p.po.release')).toBe(false);
    expect(isGranted(s, 'p.po.create', { attributes: { amount: '99999.99' } })).toBe(true);
    expect(isGranted(s, 'p.po.create', { attributes: { amount: '100000.01' } })).toBe(false);
    expect(holdsAnywhere(s, 'p.po.create')).toBe(true);
    expect(permissionsAnywhere(s)).toEqual(['p.po.create']);
  });

  it('computes visible companies', () => {
    expect(
      visibleCompanies(
        snapshot([
          grant({ permissions: ['a.b.c'], companyId: C1 }),
          grant({ permissions: ['a.b.d'], companyId: C1 }),
        ]),
      ),
    ).toEqual([C1]);
    expect(
      visibleCompanies(
        snapshot([
          grant({ permissions: ['a.b.c'], companyId: C1 }),
          grant({ permissions: ['a.b.c'] }),
        ]),
      ),
    ).toBe('all');
    expect(visibleCompanies(snapshot([]))).toEqual([]);
  });
});

describe('field policies', () => {
  it('merges most-permissively across roles', () => {
    const merged = mergeFieldPolicies(
      ['viewer', 'finance'],
      [
        { roleId: 'viewer', entity: 'item', field: 'standardCost', access: 'hidden' },
        { roleId: 'finance', entity: 'item', field: 'standardCost', access: 'read' },
        { roleId: 'viewer', entity: 'item', field: 'margin', access: 'hidden' },
        { roleId: 'finance', entity: 'item', field: 'margin', access: 'hidden' },
        { roleId: 'viewer', entity: 'item', field: 'notes', access: 'read' },
      ],
    );
    expect(Object.fromEntries(merged.get('item')!)).toEqual({
      standardCost: 'read',
      margin: 'hidden',
    });
  });

  it('redacts responses and rejects writes through AccessControl', () => {
    const fa = new Map([
      [
        'item',
        new Map([
          ['cost', 'hidden' as const],
          ['code', 'read' as const],
        ]),
      ],
    ]);
    AccessContexts.run(snapshot([grant({ permissions: ['i.item.update'] })], fa), () => {
      expect(AccessControl.redact('item', { code: 'A', cost: '9', name: 'x' })).toEqual({
        code: 'A',
        name: 'x',
      });
      expect(AccessControl.fieldAccess('item', 'code')).toBe('read');
      expect(AccessControl.fieldAccess('item', 'name')).toBe('write');
      expect(() => AccessControl.assertWritable('item', { name: 'y' })).not.toThrow();
      expect(() => AccessControl.assertWritable('item', { code: 'B' })).toThrow(ForbiddenError);
      expect(() => AccessControl.assert('i.item.delete')).toThrow(
        expect.objectContaining({ code: 'authz.permission_denied' }),
      );
      expect(AccessControl.can('i.item.update')).toBe(true);
    });
    expect(() => AccessControl.assert('i.item.update')).toThrow(InvariantViolation);
    expect(AccessControl.redact('item', { cost: '1' })).toEqual({ cost: '1' });
  });
});

describe('segregation of duties', () => {
  it('finds conflicting permission pairs', () => {
    const rules = [
      {
        id: '1',
        code: 'supplier_vs_payment',
        permissionA: 'p.supplier.create',
        permissionB: 'f.payment.approve',
        severity: 'block' as const,
      },
      {
        id: '2',
        code: 'po_vs_approve',
        permissionA: 'p.po.create',
        permissionB: 'p.po.approve',
        severity: 'warn' as const,
      },
    ];
    expect(
      findSodConflicts(new Set(['p.supplier.create', 'f.payment.approve', 'p.po.create']), rules),
    ).toEqual([
      {
        ruleId: '1',
        code: 'supplier_vs_payment',
        severity: 'block',
        permissions: ['p.supplier.create', 'f.payment.approve'],
      },
    ]);
    expect(findSodConflicts(new Set(['p.po.create']), rules)).toEqual([]);
  });
});
