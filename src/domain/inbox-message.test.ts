import { describe, expect, test } from 'bun:test';
import { InboxMessage } from './inbox-message';

const payload = { type: 'WagerTransactionRequested', data: { a: 1, b: { y: 2, x: 1 } } };

describe('inbox message', () => {
  test('the content hash ignores key order', () => {
    const a = InboxMessage.receive('c', 'm1', payload);
    const b = InboxMessage.receive('c', 'm1', { data: { b: { x: 1, y: 2 }, a: 1 }, type: 'WagerTransactionRequested' });
    expect(a.payloadHash).toBe(b.payloadHash);
  });

  test('judges against what is stored', () => {
    const m = InboxMessage.receive('c', 'm1', payload);
    expect(m.judge(null)).toBe('NEW');
    expect(m.judge({ payloadHash: m.payloadHash })).toBe('DUPLICATE');
    expect(m.judge({ payloadHash: 'other' })).toBe('PAYLOAD_CONFLICT');
    expect(m.judge({ payloadHash: null })).toBe('DUPLICATE'); // legacy row without a hash
  });

  test('different content gives a different hash', () => {
    expect(InboxMessage.receive('c', 'm', { x: 1 }).payloadHash).not.toBe(InboxMessage.receive('c', 'm', { x: 2 }).payloadHash);
  });

  test('requires an identity', () => {
    expect(() => InboxMessage.receive('', 'm', {})).toThrow();
    expect(() => InboxMessage.receive('c', ' ', {})).toThrow();
  });
});
