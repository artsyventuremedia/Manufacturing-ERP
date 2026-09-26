import { ValidationError } from './errors.js';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A calendar date with no time or zone: posting dates, fiscal year boundaries, due dates
 * (ADR-0008 §7). Stored as Postgres `date` and serialised as `YYYY-MM-DD`.
 */
export class LocalDate {
  private constructor(
    readonly year: number,
    readonly month: number,
    readonly day: number,
  ) {}

  static of(year: number, month: number, day: number): LocalDate {
    const d = new Date(Date.UTC(year, month - 1, day));
    if (
      !Number.isInteger(year) ||
      year < 1 ||
      year > 9999 ||
      d.getUTCFullYear() !== year ||
      d.getUTCMonth() !== month - 1 ||
      d.getUTCDate() !== day
    ) {
      throw new ValidationError('kernel.date.invalid', `Invalid date ${year}-${month}-${day}`, {
        year,
        month,
        day,
      });
    }
    return new LocalDate(year, month, day);
  }

  static parse(value: string): LocalDate {
    const m = ISO_DATE.exec(value);
    if (!m)
      throw new ValidationError('kernel.date.invalid', `Invalid ISO date "${value}"`, { value });
    return LocalDate.of(Number(m[1]), Number(m[2]), Number(m[3]));
  }

  /** The calendar date of `instant` as seen in `timeZone` (e.g. the plant's zone). */
  static fromInstant(instant: Date, timeZone: string): LocalDate {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant);
    return LocalDate.parse(parts);
  }

  plusDays(days: number): LocalDate {
    const d = new Date(Date.UTC(this.year, this.month - 1, this.day + days));
    return LocalDate.of(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }

  /** Adds months, clamping the day to the target month's length (Jan 31 + 1 month = Feb 28/29). */
  plusMonths(months: number): LocalDate {
    const index = this.year * 12 + (this.month - 1) + months;
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return LocalDate.of(year, month, Math.min(this.day, lastDay));
  }

  compare(other: LocalDate): -1 | 0 | 1 {
    const a = this.toString();
    const b = other.toString();
    return a < b ? -1 : a > b ? 1 : 0;
  }

  equals(other: LocalDate): boolean {
    return this.compare(other) === 0;
  }

  toString(): string {
    return `${String(this.year).padStart(4, '0')}-${String(this.month).padStart(2, '0')}-${String(this.day).padStart(2, '0')}`;
  }

  toJSON(): string {
    return this.toString();
  }
}
