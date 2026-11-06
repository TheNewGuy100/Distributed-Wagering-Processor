import { describe, expect, test } from 'bun:test';
import { EventStore } from './store';

const envelope = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    eventId: crypto.randomUUID(),
    eventType: 'WagerTransactionProcessed',
    version: 1,
    aggregateId: 'agg-1',
    occurredAt: new Date().toISOString(),
    data: { kind: 'BET', amount: '10.00', currency: 'BRL' },
    ...over,
  });

const balanceChanged = (walletId: string, walletVersion: number, eventId = crypto.randomUUID()) =>
  envelope({ eventId, eventType: 'WalletBalanceChanged', aggregateId: walletId, data: { walletVersion, direction: 'DEBIT', amount: '1.00' } });

describe('EventStore', () => {
  test('records valid envelopes and counts them by type', () => {
    const s = new EventStore();
    const r = s.ingest('m1', envelope());
    expect(r).toMatchObject({ status: 'new', eventType: 'WagerTransactionProcessed', n: 1 });
    expect(s.stats).toMatchObject({ received: 1, unique: 1, duplicates: 0, invalid: 0, byType: { WagerTransactionProcessed: 1 } });
  });

  test('drops a repeated eventId (at-least-once delivery) and says so, without counting it as new', () => {
    const s = new EventStore();
    const body = envelope();
    expect(s.ingest('m1', body).status).toBe('new');
    expect(s.ingest('m2', body).status).toBe('duplicate'); // a different broker message, same event
    expect(s.stats).toMatchObject({ received: 2, unique: 1, duplicates: 1 });
    expect(s.stats.byType.WagerTransactionProcessed).toBe(1);
  });

  test.each([
    ['not JSON', 'definitely not json'],
    ['an array', '[1,2,3]'],
    ['missing eventId', JSON.stringify({ eventType: 'X', aggregateId: 'a', version: 1, occurredAt: 'now', data: {} })],
    ['data is not an object', envelope({ data: 'oops' })],
    ['version is not a number', envelope({ version: '1' })],
  ])('invalid message (%s) is recorded and does not throw', (_n, body) => {
    const s = new EventStore();
    expect(s.ingest('m', body).status).toBe('invalid');
    expect(s.stats.invalid).toBe(1);
    expect(s.stats.unique).toBe(0);
  });

  test('wallet versions must increase per wallet; a repeat or a step back is flagged, a gap is fine', () => {
    const s = new EventStore();
    expect(s.ingest('1', balanceChanged('w1', 1)).outOfOrder).toBeUndefined();
    expect(s.ingest('2', balanceChanged('w1', 2)).outOfOrder).toBeUndefined();
    const jump = s.ingest('3', balanceChanged('w1', 5));
    expect(jump.outOfOrder).toBeUndefined();
    expect(jump.gap).toEqual({ from: 3, to: 4 }); // a gap, not an error: 3 and 4 may be late or DEAD
    expect(s.stats.openGaps).toBe(2);
    const late = s.ingest('4', balanceChanged('w1', 4));
    expect(late.outOfOrder).toBeUndefined();
    expect(late.lateFill).toBe(true); // it was one of the missing ones
    expect(s.stats.openGaps).toBe(1); // version 3 never came (a DEAD event): reported, tolerated
    expect(s.ingest('5', balanceChanged('w1', 4)).outOfOrder).toBe(true); // a version that was already filled
    expect(s.ingest('5b', balanceChanged('w1', 5)).outOfOrder).toBe(true); // repeated version, new event id
    expect(s.ingest('6', balanceChanged('w2', 1)).outOfOrder).toBeUndefined(); // another wallet has its own sequence
    expect(s.stats.outOfOrder).toBe(2);
  });

  test('since() returns only what is new, newest first, and the buffer is bounded', () => {
    const s = new EventStore();
    for (let i = 0; i < 350; i++) s.ingest(`m${i}`, envelope());
    const recent = s.since(0, 1000);
    expect(recent.length).toBe(300); // ring buffer
    expect(recent[0]!.n).toBe(350);
    expect(s.since(348).map((e) => e.n)).toEqual([350, 349]);
    expect(s.since(350)).toEqual([]);
  });
});
