import { ValidationError } from './errors.js';

export type CurrencyCode = string & { readonly __brand: 'CurrencyCode' };

/**
 * ISO 4217 minor units for currencies whose scale differs from 2, plus common ones for clarity.
 * Tenants may override display precision per currency in configuration.
 */
const MINOR_UNITS: Readonly<Record<string, number>> = {
  INR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  AED: 2,
  SGD: 2,
  CNY: 2,
  AUD: 2,
  CAD: 2,
  CHF: 2,
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  ISK: 0,
  BHD: 3,
  KWD: 3,
  OMR: 3,
  JOD: 3,
  TND: 3,
  IQD: 3,
  LYD: 3,
};

export function parseCurrency(code: string): CurrencyCode {
  const normalised = code.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalised)) {
    throw new ValidationError(
      'kernel.currency.invalid_code',
      `Invalid ISO 4217 currency code "${code}"`,
      {
        code,
      },
    );
  }
  return normalised as CurrencyCode;
}

export function currencyScale(code: CurrencyCode): number {
  return MINOR_UNITS[code] ?? 2;
}
