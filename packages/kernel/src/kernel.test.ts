import { describe, expect, it } from 'vitest';
import { AggregateRoot } from './aggregate.js';
import { FixedClock } from './clock.js';
import { RequestContexts } from './context.js';
import { toDecimal } from './decimal.js';
import {
  ConcurrencyConflictError,
  InvariantViolation,
  UnauthenticatedError,
  ValidationError,
} from './errors.js';
import { isId, newId, parseId } from './id.js';

describe('ids', () => {
  it('generates time-ordered UUIDv7', () => {
    const a = newId<'Item'>();
    const b = newId<'Item'>();
    expect(isId(a)).toBe(true);
    expect(a[14]).toBe('7');
    expect(a < b).toBe(true);
  });

  it('parses and normalises, rejecting garbage', () => {
    const id = newId();
    expect(parseId(id.toUpperCase())).toBe(id);
    expect(() => parseId('not-a-uuid', 'itemId')).toThrow(ValidationError);
  });
});

describe('toDecimal', () => {
  it('accepts strings, bigints and safe integers only', () => {
    expect(toDecimal(' 1e3 ').toFixed()).toBe('1000');
    expect(toDecimal(10n).toFixed()).toBe('10');
    expect(() => toDecimal('12abc')).toThrow(TypeError);
    expect(() => toDecimal(Number.MAX_SAFE_INTEGER + 1)).toThrow(TypeError);
  });
});

describe('RequestContexts', () => {
  const base = {
    correlationId: 'c1',
    source: 'api' as const,
    locale: 'kn-IN',
    timezone: 'Asia/Kolkata',
    companyIds: [],
  };

  it('propagates across async boundaries', async () => {
    const seen = await RequestContexts.run(
      { ...base, tenantId: 't1', actor: { type: 'user', id: 'u1' } },
      async () => {
        await new Promise((r) => setTimeout(r, 1));
        return RequestContexts.requireTenant().tenantId;
      },
    );
    expect(seen).toBe('t1');
    expect(RequestContexts.current()).toBeUndefined();
  });

  it('fails closed when context or tenant is missing', () => {
    expect(() => RequestContexts.require()).toThrow(InvariantViolation);
    RequestContexts.run(base, () => {
      expect(() => RequestContexts.requireTenant()).toThrow(UnauthenticatedError);
    });
  });
});

class Widget extends AggregateRoot {
  protected readonly aggregateType = 'Widget';
  static create(clock: FixedClock): Widget {
    const w = new Widget(newId(), 0, clock);
    w.raise('demo.WidgetCreated.v1', { name: 'x' });
    return w;
  }
  rename(): void {
    this.raise('bad-type', {});
  }
}

describe('AggregateRoot', () => {
  it('records events with the injected clock and drains them once', () => {
    const clock = new FixedClock(new Date('2026-04-01T00:00:00Z'));
    const w = Widget.create(clock);
    const events = w.pullEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'demo.WidgetCreated.v1',
      aggregateType: 'Widget',
      aggregateId: w.id,
    });
    expect(events[0]!.occurredAt.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(w.pullEvents()).toHaveLength(0);
  });

  it('enforces event naming and optimistic versions', () => {
    const w = Widget.create(new FixedClock(new Date()));
    expect(() => w.rename()).toThrow(TypeError);
    w.markPersisted(3);
    expect(() => w.assertVersion(2)).toThrow(ConcurrencyConflictError);
    expect(() => w.assertVersion(3)).not.toThrow();
  });
});
