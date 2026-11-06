import { InvalidMoneyError } from '../domain/errors';
import { Money } from '../domain/money';
import { ValidationError } from './errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(value: string, field: string): string {
  if (!UUID.test(value)) throw new ValidationError(`${field} must be a UUID`);
  return value;
}

export function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

export function requiredString(o: Record<string, unknown>, field: string, max = 128): string {
  const v = o[field];
  if (typeof v !== 'string' || v.trim() === '') throw new ValidationError(`${field} is required`);
  if (v.length > max) throw new ValidationError(`${field} is too long`);
  return v;
}

export function optionalString(o: Record<string, unknown>, field: string, max = 128): string | null {
  const v = o[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.trim() === '') throw new ValidationError(`${field} must be a non-empty string`);
  if (v.length > max) throw new ValidationError(`${field} is too long`);
  return v;
}

export function currencyField(o: Record<string, unknown>): string {
  const c = requiredString(o, 'currency', 3);
  if (!/^[A-Z]{3}$/.test(c)) throw new ValidationError('currency must be a 3-letter uppercase code');
  return c;
}

export function moneyField(value: unknown, currency: string, field: string): Money {
  try {
    return Money.parse(value, currency);
  } catch (e) {
    if (e instanceof InvalidMoneyError) throw new ValidationError(`${field}: ${e.message}`);
    throw e;
  }
}
