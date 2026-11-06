import { describe, expect, test } from 'bun:test';
import { canonicalJson, defaultIdempotencyKey, payloadHash, type WagerPayload } from './idempotency';

const base: WagerPayload = {
  providerId: 'pv',
  externalTransactionId: 't1',
  kind: 'BET',
  playerId: 'p1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  money: { amount: '10.00', currency: 'BRL' },
  roundId: 'r1',
  gameId: 'fortune-chimp',
  referenceExternalTransactionId: null,
};

describe('payload hash', () => {
  test('is stable regardless of key order', () => {
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as unknown as WagerPayload;
    expect(payloadHash(reordered)).toBe(payloadHash(base));
  });
  test('changes when any business field changes', () => {
    const h = payloadHash(base);
    const variants: WagerPayload[] = [
      { ...base, money: { amount: '10.01', currency: 'BRL' } },
      { ...base, money: { amount: '10.00', currency: 'USD' } },
      { ...base, kind: 'WIN' },
      { ...base, playerId: 'p2' },
      { ...base, walletId: '0192f291-27dd-7d3f-8071-5f8685deef38' },
      { ...base, roundId: 'r2' },
      { ...base, gameId: 'other-game' },
      { ...base, referenceExternalTransactionId: 'x' },
    ];
    for (const v of variants) expect(payloadHash(v)).not.toBe(h);
  });
  test('canonical JSON sorts nested keys and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[2,{"y":2,"z":1}]},"b":1}');
  });
  test('default idempotency key is provider:external id', () => {
    expect(defaultIdempotencyKey('pv', 't1')).toBe('pv:t1');
  });
});
