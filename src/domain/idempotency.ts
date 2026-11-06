import { createHash } from 'node:crypto';

/** Business fields that define a wager request; transport details (headers, trace ids) are excluded. */
export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  kind: string;
  playerId: string;
  currency: string;
  amount: string; // canonical decimal string, e.g. "10.00"
  roundId: string | null;
  referenceExternalId: string | null;
}

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function payloadHash(payload: WagerPayload): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export const defaultIdempotencyKey = (providerId: string, externalTransactionId: string): string =>
  `${providerId}:${externalTransactionId}`;
