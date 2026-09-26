import { describe, expect, it } from 'vitest';
import { ValidationError } from './errors.js';
import { LocalDate } from './local-date.js';

describe('LocalDate', () => {
  it('parses and formats ISO dates, rejecting impossible ones', () => {
    expect(LocalDate.parse('2026-04-01').toString()).toBe('2026-04-01');
    expect(() => LocalDate.parse('2026-02-30')).toThrow(ValidationError);
    expect(() => LocalDate.parse('01/04/2026')).toThrow(ValidationError);
    expect(JSON.stringify({ d: LocalDate.of(2027, 3, 31) })).toBe('{"d":"2027-03-31"}');
  });

  it('adds days and months with end-of-month clamping', () => {
    expect(LocalDate.of(2026, 4, 1).plusMonths(12).plusDays(-1).toString()).toBe('2027-03-31');
    expect(LocalDate.of(2024, 1, 31).plusMonths(1).toString()).toBe('2024-02-29');
    expect(LocalDate.of(2026, 12, 31).plusDays(1).toString()).toBe('2027-01-01');
    expect(LocalDate.of(2026, 1, 15).plusMonths(-2).toString()).toBe('2025-11-15');
  });

  it('derives the business date in a time zone', () => {
    const instant = new Date('2026-03-31T20:00:00Z');
    expect(LocalDate.fromInstant(instant, 'Asia/Kolkata').toString()).toBe('2026-04-01');
    expect(LocalDate.fromInstant(instant, 'UTC').toString()).toBe('2026-03-31');
  });

  it('compares', () => {
    const a = LocalDate.of(2026, 4, 1);
    expect(a.compare(LocalDate.of(2026, 3, 31))).toBe(1);
    expect(a.equals(LocalDate.parse('2026-04-01'))).toBe(true);
  });
});
