import { ValidationError } from '@manuling/kernel';
import { describe, expect, it } from 'vitest';
import { hoursToMs, parseFlow, stepApplies, stepOutcome } from './approval.js';

const refs = { isKnownPermission: (c: string) => c === 'procurement.purchase_order.approve' };
const user = '01a0dc39-8895-7290-9c99-6e24c5f03241';

describe('parseFlow', () => {
  it('accepts a complete two-step flow with defaults', () => {
    const flow = parseFlow(
      {
        steps: [
          {
            id: 'plant_head',
            name: 'Plant head',
            when: [{ attr: 'amount', op: 'gt', value: '100000' }],
            approvers: { type: 'permission', permission: 'procurement.purchase_order.approve' },
            slaHours: 24,
            reminderHours: 8,
            onTimeout: { action: 'escalate', to: { type: 'role', role: 'administrator' } },
          },
          {
            id: 'finance',
            approvers: { type: 'users', userIds: [user.toUpperCase(), user] },
            mode: { quorum: 2 },
          },
        ],
      },
      refs,
    );
    expect(flow.steps[0]).toMatchObject({
      mode: 'any',
      slaHours: 24,
      onTimeout: { action: 'escalate' },
      allowRepeatApprover: false,
    });
    expect(flow.steps[1]).toMatchObject({
      name: 'finance',
      when: [],
      approvers: { userIds: [user] },
      mode: { quorum: 2 },
      slaHours: null,
    });
  });

  it('reports every problem with its path', () => {
    try {
      parseFlow(
        {
          steps: [
            { id: 'A', approvers: { type: 'permission', permission: 'nope.x.y' } },
            {
              id: 'bb',
              approvers: { type: 'role', role: 'viewer' },
              mode: 'most',
              reminderHours: 5,
              slaHours: 2,
            },
            {
              id: 'bb',
              approvers: { type: 'users', userIds: [] },
              onTimeout: { action: 'reject' },
            },
          ],
        },
        refs,
      );
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).fieldErrors.map((e) => e.path).sort()).toEqual([
        'steps.0.approvers.permission',
        'steps.0.id',
        'steps.1.mode',
        'steps.1.reminderHours',
        'steps.2.approvers.userIds',
        'steps.2.id',
        'steps.2.slaHours',
      ]);
    }
    expect(() => parseFlow({}, refs)).toThrow(ValidationError);
    expect(() => parseFlow({ steps: [] }, refs)).toThrow(ValidationError);
  });
});

describe('step evaluation', () => {
  const step = parseFlow(
    {
      steps: [
        {
          id: 'big',
          when: [{ attr: 'amount', op: 'gte', value: '500000' }],
          approvers: { type: 'role', role: 'finance' },
        },
      ],
    },
    refs,
  ).steps[0]!;

  it('applies conditions with exact decimals, failing closed', () => {
    expect(stepApplies(step, { amount: '500000.00' }, 'u')).toBe(true);
    expect(stepApplies(step, { amount: '499999.99' }, 'u')).toBe(false);
    expect(stepApplies(step, {}, 'u')).toBe(false);
  });

  it('computes any / all / quorum outcomes', () => {
    expect(stepOutcome('any', { approved: 1, rejected: 0, total: 3 })).toBe('approved');
    expect(stepOutcome('any', { approved: 0, rejected: 0, total: 3 })).toBe('pending');
    expect(stepOutcome('all', { approved: 2, rejected: 0, total: 3 })).toBe('pending');
    expect(stepOutcome('all', { approved: 3, rejected: 0, total: 3 })).toBe('approved');
    expect(stepOutcome({ quorum: 2 }, { approved: 2, rejected: 0, total: 5 })).toBe('approved');
    expect(stepOutcome({ quorum: 5 }, { approved: 2, rejected: 0, total: 2 })).toBe('approved');
    expect(stepOutcome('any', { approved: 2, rejected: 1, total: 3 })).toBe('rejected');
    expect(stepOutcome('all', { approved: 0, rejected: 0, total: 0 })).toBe('pending');
    expect(hoursToMs(0.5)).toBe(1_800_000);
    expect(hoursToMs(null)).toBeNull();
  });
});
