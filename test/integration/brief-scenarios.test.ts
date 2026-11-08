import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { WagerMessageHandler } from '../../src/application/wager/wager-message-handler';
import { api, bootApp, createWallet, expectLedgerConsistent, uid, wager, wagerBody, type TestApp } from './helpers';

/** Scenarios the brief asks for by name, written the way the brief words them. */
let a: TestApp;
let b: TestApp; // a second instance on the same database
beforeAll(async () => {
  a = await bootApp();
  b = await bootApp();
});
afterAll(async () => {
  await a.close();
  await b.close();
});

const one = async <T>(t: TestApp, sql: string, params: unknown[] = []): Promise<T> => {
  const rows = await t.orm.em.fork().execute<T[]>(sql, params);
  return rows[0] as T;
};

describe('section 8: two bets of 80.00 on a 100.00 wallet, at the same time, on two instances', () => {
  test('exactly one is PROCESSED, the other REJECTED for insufficient funds; 20.00 is left; one debit; no retry duplicates it', async () => {
    const w = await createWallet(a, '100.00');
    const first = { externalTransactionId: uid('bet'), amount: '80.00' };
    const second = { externalTransactionId: uid('bet'), amount: '80.00' };

    const [r1, r2] = await Promise.all([wager(a, w, first), wager(b, w, second)]);
    const processed = [r1, r2].filter((r) => r.body.status === 'PROCESSED');
    const rejected = [r1, r2].filter((r) => r.body.status === 'REJECTED');
    expect(processed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(processed[0]!.status).toBe(201);
    expect(rejected[0]!.status).toBe(422);
    expect(rejected[0]!.body.failureCode).toBe('INSUFFICIENT_FUNDS');

    const wallet = await api(a, 'GET', `/wallets/${w.walletId}`);
    expect(wallet.body.balance).toEqual({ amount: '20.00', currency: 'BRL' });
    expect(await one<{ n: number }>(a, "select count(*)::int n from ledger_entries where wallet_id = ? and direction = 'DEBIT'", [w.walletId])).toEqual({ n: 1 });

    // the providers retry, on both instances, many times: nothing moves, each gets its original answer back
    const retries = await Promise.all([
      ...Array.from({ length: 10 }, () => wager(a, w, first)),
      ...Array.from({ length: 10 }, () => wager(b, w, second)),
    ]);
    for (const r of retries) expect(r.body.idempotentReplay).toBe(true);
    expect(await expectLedgerConsistent(a, w.walletId)).toEqual({ balance: '20.00', entries: 2 }); // opening + one debit
    expect(await one<{ n: number }>(a, "select count(*)::int n from ledger_entries where wallet_id = ? and direction = 'DEBIT'", [w.walletId])).toEqual({ n: 1 });
    // and the rejected one left no ledger entry at all
    expect(await one<{ n: number }>(a, "select count(*)::int n from wager_transactions where wallet_id = ? and status = 'REJECTED'", [w.walletId])).toEqual({ n: 1 });
  });
});

describe('one SQL transaction: wallet, ledger, transaction row, inbox and outbox are all or nothing', () => {
  /** Makes the LAST write of the use case (the outbox event) fail for one wallet, then removes the fault. */
  async function withOutboxFault<T>(walletId: string, run: () => Promise<T>): Promise<T> {
    const name = `fault_${randomUUID().slice(0, 8)}`;
    const em = a.orm.em.fork();
    await em.execute(`
      create function ${name}() returns trigger language plpgsql as $$
      begin
        if new.event_type = 'WagerTransactionProcessed' and new.payload->'data'->>'walletId' = '${walletId}' then
          raise exception 'injected failure' using errcode = '40001';
        end if;
        return new;
      end $$`);
    await em.execute(`create trigger ${name} before insert on outbox_events for each row execute function ${name}()`);
    try {
      return await run();
    } finally {
      await em.execute(`drop trigger ${name} on outbox_events`);
      await em.execute(`drop function ${name}()`);
    }
  }

  const snapshot = async (walletId: string, externalId: string, messageId?: string) => ({
    wallet: await one<{ balance: string; version: string }>(a, 'select balance, version from wallets where id = ?', [walletId]),
    ledger: (await one<{ n: number }>(a, 'select count(*)::int n from ledger_entries where wallet_id = ?', [walletId])).n,
    transactions: (await one<{ n: number }>(a, 'select count(*)::int n from wager_transactions where external_transaction_id = ?', [externalId])).n,
    inbox: messageId ? (await one<{ n: number }>(a, 'select count(*)::int n from inbox_messages where message_id = ?', [messageId])).n : 0,
    events: (
      await one<{ n: number }>(
        a,
        "select count(*)::int n from outbox_events where payload->'data'->>'transactionId' = (select id::text from wager_transactions where external_transaction_id = ?)",
        [externalId],
      )
    ).n,
  });

  test('HTTP: a failure after the ledger write leaves nothing behind, and the same request then applies once', async () => {
    const w = await createWallet(a, '100.00');
    const body = { externalTransactionId: uid('bet'), amount: '30.00' };
    const before = await snapshot(w.walletId, body.externalTransactionId);

    const failed = await withOutboxFault(w.walletId, () => wager(a, w, body));
    expect(failed.status).toBe(503); // transient: the provider may resend with the same key
    expect(await snapshot(w.walletId, body.externalTransactionId)).toEqual(before);

    const again = await wager(a, w, body);
    expect(again.status).toBe(201);
    expect(again.body.idempotentReplay).toBe(false);
    expect(await expectLedgerConsistent(a, w.walletId)).toEqual({ balance: '70.00', entries: 2 });
    const after = await snapshot(w.walletId, body.externalTransactionId);
    expect(after.transactions).toBe(1);
    expect(after.events).toBe(2); // Processed + BalanceChanged, written with the rest
  });

  test('queue: the inbox row rolls back with everything else, so the redelivered message is not taken for a duplicate', async () => {
    const handler = a.app.get(WagerMessageHandler);
    const w = await createWallet(a, '100.00');
    const payload = wagerBody(w, { amount: '25.00' });
    const data = { ...payload, idempotencyKey: `prov-a:${uid('k')}` };
    const messageId = uid('msg');
    const msg = {
      messageId: 'broker-1',
      body: JSON.stringify({ messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data }),
    };
    const ext = payload.externalTransactionId as string;
    const before = await snapshot(w.walletId, ext, messageId);

    const failed = await withOutboxFault(w.walletId, () => handler.handle(msg));
    expect(failed.kind).toBe('RETRY');
    expect(await snapshot(w.walletId, ext, messageId)).toEqual(before); // no inbox row either

    const redelivered = await handler.handle(msg);
    expect(redelivered).toMatchObject({ kind: 'ACK', reason: 'processed' });
    const after = await snapshot(w.walletId, ext, messageId);
    expect(after).toMatchObject({ ledger: 2, transactions: 1, inbox: 1, events: 2 });
    expect(await expectLedgerConsistent(a, w.walletId)).toEqual({ balance: '75.00', entries: 2 });
  });
});

describe('OPENING is internal: neither the API nor the queue can submit it', () => {
  test('a queue message of kind OPENING is a permanent error (DLQ) and moves no money', async () => {
    const handler = a.app.get(WagerMessageHandler);
    const w = await createWallet(a, '10.00');
    const data = { ...wagerBody(w, { kind: 'OPENING', amount: '500.00' }), idempotencyKey: `prov-a:${uid('k')}` };
    const out = await handler.handle({
      messageId: 'broker-2',
      body: JSON.stringify({ messageId: uid('msg'), type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data }),
    });
    expect(out.kind).toBe('DLQ');
    expect(await expectLedgerConsistent(a, w.walletId)).toEqual({ balance: '10.00', entries: 1 });
  });
});
