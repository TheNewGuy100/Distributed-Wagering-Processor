import { describe, expect, test } from 'bun:test';
import { OutboxMessage, retryDelayMs, type OutboxRetryPolicy } from './outbox-message';

const policy: OutboxRetryPolicy = { baseDelayMs: 1000, maxDelayMs: 8000, maxAttempts: 5 };
const fresh = () => OutboxMessage.rehydrate({ id: 'e1', aggregateId: 'w1', failedAttempts: 0, publishedAt: null, deadAt: null });

describe('outbox message', () => {
  test('starts pending and becomes published exactly once', () => {
    const m = fresh();
    expect(m.status).toBe('PENDING');
    m.markPublished(new Date());
    expect(m.status).toBe('PUBLISHED');
    expect(() => m.markPublished(new Date())).toThrow(/PUBLISHED/);
    expect(() => m.recordFailure(new Date(), policy)).toThrow(/PUBLISHED/);
  });

  test('failures back off exponentially up to the cap', () => {
    const m = fresh();
    const delays = [1, 2, 3, 4].map(() => (m.recordFailure(new Date(), policy) as { delayMs: number }).delayMs);
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
    expect(retryDelayMs(10, policy)).toBe(8000); // capped
    expect(m.status).toBe('PENDING');
  });

  test('the last allowed failure makes it DEAD, which is terminal', () => {
    const m = fresh();
    for (let i = 0; i < 4; i++) m.recordFailure(new Date(), policy);
    expect(m.recordFailure(new Date(), policy)).toEqual({ type: 'DEAD', failedAttempts: 5 });
    expect(m.status).toBe('DEAD');
    expect(() => m.markPublished(new Date())).toThrow(/DEAD/);
  });

  test('a snapshot that is both published and dead is corrupt', () => {
    const d = new Date();
    expect(() => OutboxMessage.rehydrate({ id: 'x', aggregateId: 'a', failedAttempts: 0, publishedAt: d, deadAt: d })).toThrow();
  });
});
