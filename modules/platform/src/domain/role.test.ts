import { BusinessRuleViolation, ValidationError } from '@manuling/kernel';
import { describe, expect, it } from 'vitest';
import { changeUser, createAppUser, inviteUser, isInvitationUsable } from './app-user.js';
import {
  assertEditable,
  assertOwnerRemains,
  changeRole,
  createAssignment,
  createCustomRole,
  parseConditions,
  parsePermissions,
} from './role.js';

const known = (c: string) => ['platform.company.read', 'platform.company.update'].includes(c);

describe('invitations', () => {
  it('expire after 7 days and cannot be activated by an admin', () => {
    const now = new Date('2026-09-25T00:00:00Z');
    const invited = inviteUser({ email: 'New@Plant.in', displayName: 'New' }, now);
    expect(invited).toMatchObject({ email: 'new@plant.in', status: 'invited', idpSubject: null });
    expect(isInvitationUsable(invited, new Date('2026-10-01T23:59:59Z'))).toBe(true);
    expect(isInvitationUsable(invited, new Date('2026-10-02T00:00:01Z'))).toBe(false);
    expect(() => changeUser(invited, { status: 'active' }, 'admin')).toThrow(BusinessRuleViolation);
  });

  it('prevents disabling yourself', () => {
    const u = createAppUser({ idpSubject: 's', email: 'a@b.in', displayName: 'A' });
    expect(() => changeUser(u, { status: 'disabled' }, u.id)).toThrow(
      expect.objectContaining({ code: 'platform.user.cannot_disable_self' }),
    );
    expect(changeUser(u, { status: 'disabled', displayName: 'B' }, 'other')).toMatchObject({
      status: 'disabled',
      displayName: 'B',
    });
  });
});

describe('roles', () => {
  it('validates codes and permissions against the registry', () => {
    expect(createCustomRole({ code: 'Plant_Head', name: 'Plant head' })).toMatchObject({
      code: 'plant_head',
      isSystem: false,
    });
    expect(() => createCustomRole({ code: '1bad', name: 'x' })).toThrow(ValidationError);
    expect(
      parsePermissions(
        ['platform.company.update', 'platform.company.read', 'platform.company.read'],
        known,
      ),
    ).toEqual(['platform.company.read', 'platform.company.update']);
    expect(() => parsePermissions(['platform.company.delete'], known)).toThrow(
      expect.objectContaining({ code: 'platform.role.permission_unknown' }),
    );
  });

  it('keeps system roles read-only', () => {
    const system = { ...createCustomRole({ code: 'owner', name: 'Owner' }), isSystem: true };
    expect(() => assertEditable(system)).toThrow(
      expect.objectContaining({ code: 'authz.system_role_read_only' }),
    );
    expect(() => changeRole(system, { name: 'x' })).toThrow(BusinessRuleViolation);
    expect(
      changeRole(createCustomRole({ code: 'qa', name: 'QA' }), {
        description: '  ',
        status: 'archived',
      }),
    ).toMatchObject({
      description: null,
      status: 'archived',
    });
  });
});

describe('assignments', () => {
  it('parses structured conditions and rejects anything else', () => {
    expect(
      parseConditions([
        { attr: 'amount', op: 'lte', value: '500000' },
        { op: 'own' },
        { attr: 'currency', op: 'in', value: ['INR'] },
      ]),
    ).toHaveLength(3);
    for (const bad of [
      [{ attr: 'amount', op: 'lte', value: 5 }],
      [{ attr: 'a b', op: 'eq', value: 'x' }],
      [{ attr: 'x', op: 'regex', value: '.*' }],
      [{ attr: 'x', op: 'in', value: [] }],
      'nope',
      [null],
    ]) {
      expect(() => parseConditions(bad)).toThrow(ValidationError);
    }
  });

  it('validates scope and validity dates', () => {
    expect(
      createAssignment({
        userId: 'u',
        roleId: 'r',
        companyId: 'c',
        validFrom: '2026-04-01',
        validTo: '2027-03-31',
      }),
    ).toMatchObject({
      companyId: 'c',
      plantId: null,
      status: 'active',
    });
    expect(() => createAssignment({ userId: 'u', roleId: 'r', plantId: 'p' })).toThrow(
      expect.objectContaining({ code: 'platform.assignment.scope_invalid' }),
    );
    expect(() =>
      createAssignment({
        userId: 'u',
        roleId: 'r',
        validFrom: '2026-04-01',
        validTo: '2026-03-31',
      }),
    ).toThrow(ValidationError);
  });

  it('refuses to leave a workspace without an owner', () => {
    expect(() => assertOwnerRemains(0)).toThrow(
      expect.objectContaining({ code: 'authz.last_owner' }),
    );
    expect(() => assertOwnerRemains(1)).not.toThrow();
  });
});
