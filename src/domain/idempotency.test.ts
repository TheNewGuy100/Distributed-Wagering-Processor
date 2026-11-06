import { describe, expect, test } from 'bun:test';
import { canonicalJson, defaultIdempotencyKey, payloadHash, type WagerPayload } from './idempotency';

const base: WagerPayload = {
  providerId: 'pv',
  externalTransactionId: 't1',
  kind: 'BET',
  playerId: 'p1',
  currency: 'BRL',
  amount: '10.00',
  roundId: 'r1',
  referenceExternalId: null,
};

describe('payload hash', () => {
  test('is stable regardless of key order', () => {
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as unknown as WagerPayload;
    expect(payloadHash(reordered)).toBe(payloadHash(base));
  });
  test('changes when any business field changes', () => {
    const h = payloadHash(base);
    for (const [k, v] of [
      ['amount', '10.01'],
      ['kind', 'WIN'],
      ['playerId', 'p2'],
      ['roundId', 'r2'],
      ['currency', 'USD'],
      ['referenceExternalId', 'x'],
    ] as const) {
      expect(payloadHash({ ...base, [k]: v })).not.toBe(h);
    }
  });
  test('canonical JSON sorts nested keys and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[2,{"y":2,"z":1}]},"b":1}');
  });
  test('default idempotency key is provider:external id', () => {
    expect(defaultIdempotencyKey('pv', 't1')).toBe('pv:t1');
  });
});
