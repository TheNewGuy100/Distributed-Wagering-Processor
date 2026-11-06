import { describe, expect, test } from 'bun:test';
import { assertTransition, isTerminal, planPendingReferenceRetry } from './wager-transaction';
import { InvariantViolationError } from './errors';

describe('status machine', () => {
  test('terminal states are final', () => {
    for (const from of ['PROCESSED', 'REJECTED'] as const) {
      expect(isTerminal(from)).toBe(true);
      for (const to of ['PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'] as const) {
        expect(() => assertTransition(from, to)).toThrow(InvariantViolationError);
      }
    }
  });
  test('pending states can progress', () => {
    expect(() => assertTransition('PENDING', 'PENDING_REFERENCE')).not.toThrow();
    expect(() => assertTransition('PENDING_REFERENCE', 'PROCESSED')).not.toThrow();
    expect(() => assertTransition('PENDING_REFERENCE', 'REJECTED')).not.toThrow();
    expect(isTerminal('PENDING_REFERENCE')).toBe(false);
  });
  test('FAILED is a resting state: the only way out is a reopen to PENDING', () => {
    expect(isTerminal('FAILED')).toBe(false);
    expect(() => assertTransition('FAILED', 'PENDING')).not.toThrow();
    for (const to of ['PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'] as const) {
      expect(() => assertTransition('FAILED', to)).toThrow(InvariantViolationError);
    }
    expect(() => assertTransition('PENDING', 'FAILED')).not.toThrow();
  });
  test('cannot go back to PENDING', () => {
    expect(() => assertTransition('PENDING_REFERENCE', 'PENDING')).toThrow(InvariantViolationError);
  });
});

describe('pending reference backoff', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const policy = { maxRetries: 4, baseDelayMs: 1000, maxDelayMs: 5000 };

  test('doubles each time and caps at max delay', () => {
    const delays = [0, 1, 2, 3].map((n) => {
      const p = planPendingReferenceRetry(n, now, policy);
      if (p.type !== 'RETRY') throw new Error('expected retry');
      return p.at.getTime() - now.getTime();
    });
    expect(delays).toEqual([1000, 2000, 4000, 5000]);
  });
  test('increments the retry counter', () => {
    expect(planPendingReferenceRetry(2, now, policy)).toMatchObject({ type: 'RETRY', retryCount: 3 });
  });
  test('exhausts at the limit', () => {
    expect(planPendingReferenceRetry(4, now, policy)).toEqual({ type: 'EXHAUSTED' });
  });
});
