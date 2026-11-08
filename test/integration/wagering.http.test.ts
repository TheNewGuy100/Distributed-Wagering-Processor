import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { api, bootApp, createWallet, expectLedgerConsistent, uid, wager, wagerBody, type TestApp } from './helpers';

let t: TestApp;
beforeAll(async () => {
  t = await bootApp();
});
afterAll(() => t.close());

describe('wallets', () => {
  test('creates with opening credit atomically and rejects duplicates', async () => {
    const w = await createWallet(t, '100.00');
    const got = await api(t, 'GET', `/wallets/${w.walletId}`);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ id: w.walletId, balance: { amount: '100.00', currency: 'BRL' }, version: 1 });
    expect(await expectLedgerConsistent(t, w.walletId)).toEqual({ balance: '100.00', entries: 1 });

    const dup = await api(t, 'POST', '/wallets', { playerId: w.playerId, initialBalance: { amount: '1.00', currency: 'BRL' } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('WALLET_ALREADY_EXISTS');
  });

  test('a wallet is at version 1 from creation, funded or not; only later balance changes bump it', async () => {
    const funded = await createWallet(t, '100.00');
    const empty = await createWallet(t);
    expect((await api(t, 'GET', `/wallets/${funded.walletId}`)).body.version).toBe(1);
    expect((await api(t, 'GET', `/wallets/${empty.walletId}`)).body.version).toBe(1);

    await wager(t, funded, { amount: '10.00' }); // balance changes
    await wager(t, funded, { kind: 'LOSS', amount: '10.00' }); // does not
    await wager(t, empty, { amount: '10.00' }); // rejected: nothing changes
    await wager(t, empty, { kind: 'WIN', amount: '10.00' }); // balance changes
    expect((await api(t, 'GET', `/wallets/${funded.walletId}`)).body.version).toBe(2);
    expect((await api(t, 'GET', `/wallets/${empty.walletId}`)).body.version).toBe(2);

    // the reconciliation knows the numbering too
    for (const w of [funded, empty]) {
      const r = await api(t, 'POST', `/wallets/${w.walletId}/reconciliation`);
      expect(r.body).toMatchObject({ consistent: true, storedVersion: 2 });
    }
  });

  test('same player may hold one wallet per currency; no opening credit means no ledger entry', async () => {
    const playerId = uid('multi');
    expect((await api(t, 'POST', '/wallets', { playerId, initialBalance: { amount: '0.00', currency: 'BRL' } })).status).toBe(201);
    const usd = await api(t, 'POST', '/wallets', { playerId, initialBalance: { amount: '0.00', currency: 'USD' } });
    expect(usd.status).toBe(201);
    expect(await expectLedgerConsistent(t, usd.body.id)).toEqual({ balance: '0.00', entries: 0 });
  });

  test('validates input and unknown ids', async () => {
    expect((await api(t, 'POST', '/wallets', { playerId: 'p', initialBalance: { amount: '0.00', currency: 'brl' } })).status).toBe(400);
    expect((await api(t, 'POST', '/wallets', { playerId: 'p', initialBalance: { amount: 10.5, currency: 'BRL' } })).status).toBe(400);
    expect((await api(t, 'GET', '/wallets/not-a-uuid')).status).toBe(400);
    expect((await api(t, 'GET', `/wallets/${crypto.randomUUID()}`)).status).toBe(404);
  });

  test('ledger uses stable opaque cursor pagination', async () => {
    const w = await createWallet(t, '50.00');
    for (let i = 0; i < 4; i++) await wager(t, w, { kind: 'WIN', amount: '1.00' });
    const p1 = await api(t, 'GET', `/wallets/${w.walletId}/ledger?limit=2`);
    expect(p1.body.items).toHaveLength(2);
    expect(typeof p1.body.nextCursor).toBe('string');
    const p2 = await api(t, 'GET', `/wallets/${w.walletId}/ledger?limit=2&cursor=${p1.body.nextCursor}`);
    const p3 = await api(t, 'GET', `/wallets/${w.walletId}/ledger?limit=2&cursor=${p2.body.nextCursor}`);
    expect(p2.body.items).toHaveLength(2);
    expect(p3.body.items).toHaveLength(1);
    expect(p3.body.nextCursor).toBeNull();
    const ids = [...p1.body.items, ...p2.body.items, ...p3.body.items].map((e: { entryId: string }) => e.entryId);
    expect(new Set(ids).size).toBe(5);
    expect((await api(t, 'GET', `/wallets/${w.walletId}/ledger?cursor=garbage`)).status).toBe(400);
  });
});

describe('transactions', () => {
  test('BET debits, WIN credits, LOSS leaves no ledger entry', async () => {
    const w = await createWallet(t, '100.00');
    const bet = await wager(t, w, { amount: '30.00' });
    expect(bet.status).toBe(201);
    expect(bet.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });
    expect((await wager(t, w, { kind: 'WIN', amount: '5.50' })).status).toBe(201);
    expect((await wager(t, w, { kind: 'LOSS', amount: '30.00' })).status).toBe(201);
    expect(await expectLedgerConsistent(t, w.walletId)).toEqual({ balance: '75.50', entries: 3 });
  });

  test('insufficient funds is a business rejection and changes nothing', async () => {
    const w = await createWallet(t, '5.00');
    const r = await wager(t, w, { amount: '5.01' });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
    expect(await expectLedgerConsistent(t, w.walletId)).toEqual({ balance: '5.00', entries: 1 });
    const wallet = await api(t, 'GET', `/wallets/${w.walletId}`);
    expect(wallet.body.version).toBe(1);
  });

  test('invalid payloads return 400', async () => {
    const w = await createWallet(t, '5.00');
    for (const over of [{ money: { amount: 10, currency: 'BRL' } }, { amount: '10.5' }, { kind: 'OPENING' }, { kind: 'REFUND' }, { currency: 'xx' }, { gameId: undefined }]) {
      expect((await wager(t, w, over)).status).toBe(400);
    }
    expect((await api(t, 'POST', '/wagering/transactions', 'nope')).status).toBe(400);
  });

  test('unknown wallet returns 404 and persists nothing', async () => {
    const r = await wager(t, { playerId: uid('ghost'), walletId: crypto.randomUUID(), currency: 'BRL' });
    expect(r.status).toBe(404);
  });

  test('idempotent replay returns the original result; different payload conflicts', async () => {
    const w = await createWallet(t, '100.00');
    const ext = uid('ext');
    const first = await wager(t, w, { externalTransactionId: ext, amount: '10.00' });
    const again = await wager(t, w, { externalTransactionId: ext, amount: '10.00' });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ transactionId: first.body.transactionId, idempotentReplay: true });

    const changed = await wager(t, w, { externalTransactionId: ext, amount: '11.00' });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('IDEMPOTENCY_CONFLICT');

    const keyReuse = await wager(t, w, { externalTransactionId: uid('other') }, { 'idempotency-key': `prov-a:${ext}` });
    expect(keyReuse.status).toBe(409);

    expect(await expectLedgerConsistent(t, w.walletId)).toEqual({ balance: '90.00', entries: 2 });
  });

  test('the Idempotency-Key header is mandatory, and the response carries the balance in the challenge format', async () => {
    const w = await createWallet(t, '100.00');
    const body = wagerBody(w, { amount: '25.00' });
    const without = await api(t, 'POST', '/wagering/transactions', body); // no header
    expect(without.status).toBe(400);
    expect(without.body.error.message).toContain('Idempotency-Key');
    const ok = await wager(t, w, { amount: '25.00' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00', currency: 'BRL' }, idempotentReplay: false });
    expect(await expectLedgerConsistent(t, w.walletId)).toEqual({ balance: '75.00', entries: 2 });
  });

  test('a replay returns the balance observed back then, not the current one', async () => {
    const w = await createWallet(t, '100.00');
    const ext = uid('ext');
    const first = await wager(t, w, { externalTransactionId: ext, amount: '10.00' });
    expect(first.body.balance.amount).toBe('90.00');
    await wager(t, w, { amount: '30.00' }); // the balance moves on
    const replay = await wager(t, w, { externalTransactionId: ext, amount: '10.00' });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ idempotentReplay: true, balance: { amount: '90.00', currency: 'BRL' } });
    // a rejection also remembers the balance it saw
    const rejected = await wager(t, w, { amount: '999.00' });
    expect(rejected.status).toBe(422);
    expect(rejected.body.balance.amount).toBe('60.00');
    const again = await api(t, 'GET', `/wagering/transactions/${rejected.body.transactionId}`);
    expect(again.body.balance.amount).toBe('60.00');
  });

  test('walletId must belong to playerId; a bet needs a gameId, which is stored for reports', async () => {
    const a = await createWallet(t, '100.00');
    const b = await createWallet(t, '100.00');
    const crossed = await wager(t, { playerId: a.playerId, walletId: b.walletId, currency: 'BRL' });
    expect(crossed.status).toBe(400);
    expect(await expectLedgerConsistent(t, b.walletId)).toEqual({ balance: '100.00', entries: 1 });

    expect((await wager(t, a, { gameId: undefined })).status).toBe(400);
    const game = uid('book-of-dead'); // the database is shared between runs
    const ok = await wager(t, a, { gameId: game });
    expect(ok.status).toBe(201);
    const view = await api(t, 'GET', `/wagering/transactions/${ok.body.transactionId}`);
    expect(view.body).toMatchObject({ gameId: game, roundId: 'round-1', money: { amount: '10.00', currency: 'BRL' } });
    const rows = await t.orm.em.fork().execute<{ n: number }[]>('select count(*)::int n from wager_transactions where game_id = ?', [game]);
    expect(rows[0]!.n).toBe(1);
  });

  test('a currency different from the wallet is a business rejection, not a server error', async () => {
    const w = await createWallet(t, '100.00');
    const r = await wager(t, w, { currency: 'USD' });
    expect(r.status).toBe(422);
    expect(r.body.failureCode).toBe('CURRENCY_MISMATCH');
    expect(await expectLedgerConsistent(t, w.walletId)).toEqual({ balance: '100.00', entries: 1 });
  });

  test('replay of a rejection keeps returning the rejection', async () => {
    const w = await createWallet(t, '1.00');
    const ext = uid('ext');
    expect((await wager(t, w, { externalTransactionId: ext, amount: '9.00' })).status).toBe(422);
    await api(t, 'POST', '/wagering/transactions', {}); // noise
    const again = await wager(t, w, { externalTransactionId: ext, amount: '9.00' });
    expect(again.status).toBe(422);
    expect(again.body).toMatchObject({ failureCode: 'INSUFFICIENT_FUNDS', idempotentReplay: true });
  });

  test('can be fetched by id and by provider + external id', async () => {
    const w = await createWallet(t, '10.00');
    const ext = uid('ext');
    const r = await wager(t, w, { externalTransactionId: ext, amount: '1.00' });
    const byId = await api(t, 'GET', `/wagering/transactions/${r.body.transactionId}`);
    const byExt = await api(t, 'GET', `/providers/prov-a/wagering/transactions/${ext}`);
    expect(byId.body.transactionId).toBe(r.body.transactionId);
    expect(byExt.body.transactionId).toBe(r.body.transactionId);
    expect((await api(t, 'GET', `/wagering/transactions/${crypto.randomUUID()}`)).status).toBe(404);
  });
});

describe('reversals', () => {
  test('REFUND returns the stake once; any second reversal is rejected', async () => {
    const w = await createWallet(t, '20.00');
    const betExt = uid('bet');
    await wager(t, w, { externalTransactionId: betExt, amount: '8.00' });
    const refund = await wager(t, w, { kind: 'REFUND', amount: '8.00', referenceExternalTransactionId: betExt });
    expect(refund.status).toBe(201);
    const again = await wager(t, w, { kind: 'REFUND', amount: '8.00', referenceExternalTransactionId: betExt });
    const rollback = await wager(t, w, { kind: 'ROLLBACK', amount: '8.00', referenceExternalTransactionId: betExt });
    expect(again.body.failureCode).toBe('ALREADY_REVERSED');
    expect(rollback.body.failureCode).toBe('ALREADY_REVERSED');
    expect(await expectLedgerConsistent(t, w.walletId)).toEqual({ balance: '20.00', entries: 3 });
  });

  test('a REFUND only reverses a BET: a REFUND pointing at a WIN is a rejection, and changes nothing', async () => {
    const w = await createWallet(t, '10.00');
    const winExt = uid('win');
    await wager(t, w, { kind: 'WIN', externalTransactionId: winExt, amount: '5.00' });
    const refund = await wager(t, w, { kind: 'REFUND', amount: '5.00', referenceExternalTransactionId: winExt });
    expect(refund.status).toBe(422);
    expect(refund.body.failureCode).toBe('REFERENCE_NOT_REVERSIBLE');
    expect(await expectLedgerConsistent(t, w.walletId)).toEqual({ balance: '15.00', entries: 2 });
  });

  test('a ROLLBACK may reverse a REFUND, once, and not when it would overdraw', async () => {
    const w = await createWallet(t, '20.00');
    const betExt = uid('bet');
    const refundExt = uid('refund');
    await wager(t, w, { externalTransactionId: betExt, amount: '8.00' });
    await wager(t, w, { kind: 'REFUND', externalTransactionId: refundExt, amount: '8.00', referenceExternalTransactionId: betExt });
    const rollback = await wager(t, w, { kind: 'ROLLBACK', amount: '8.00', referenceExternalTransactionId: refundExt });
    expect(rollback.status).toBe(201);
    expect(rollback.body.balance.amount).toBe('12.00'); // the returned stake is taken out again
    const twice = await wager(t, w, { kind: 'ROLLBACK', amount: '8.00', referenceExternalTransactionId: refundExt });
    expect(twice.body.failureCode).toBe('ALREADY_REVERSED');
    expect(await expectLedgerConsistent(t, w.walletId)).toEqual({ balance: '12.00', entries: 4 });

    // not when the returned stake was already spent
    const poor = await createWallet(t, '5.00');
    const bet2 = uid('bet');
    const ref2 = uid('refund');
    await wager(t, poor, { externalTransactionId: bet2, amount: '5.00' });
    await wager(t, poor, { kind: 'REFUND', externalTransactionId: ref2, amount: '5.00', referenceExternalTransactionId: bet2 });
    await wager(t, poor, { amount: '5.00' }); // spends the returned stake again
    const overdraw = await wager(t, poor, { kind: 'ROLLBACK', amount: '5.00', referenceExternalTransactionId: ref2 });
    expect(overdraw.body.failureCode).toBe('REVERSAL_WOULD_OVERDRAW');
  });

  test('reversal arriving before its reference waits in PENDING_REFERENCE with a retry schedule', async () => {
    const w = await createWallet(t, '20.00');
    const r = await wager(t, w, { kind: 'ROLLBACK', amount: '8.00', referenceExternalTransactionId: uid('missing') });
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('PENDING_REFERENCE');
    expect(r.body.nextRetryAt).not.toBeNull();
    expect(await expectLedgerConsistent(t, w.walletId)).toEqual({ balance: '20.00', entries: 1 });
  });

  test('mismatched amount is rejected; reversing a WIN that would overdraw uses its own code', async () => {
    const w = await createWallet(t, '10.00');
    const winExt = uid('win');
    await wager(t, w, { kind: 'WIN', externalTransactionId: winExt, amount: '5.00' });
    await wager(t, w, { amount: '15.00' }); // spend everything
    const mismatch = await wager(t, w, { kind: 'ROLLBACK', amount: '4.00', referenceExternalTransactionId: winExt });
    expect(mismatch.body).toMatchObject({ failureCode: 'REFERENCE_MISMATCH' });
    const overdraw = await wager(t, w, { kind: 'ROLLBACK', amount: '5.00', referenceExternalTransactionId: winExt });
    expect(overdraw.body.failureCode).toBe('REVERSAL_WOULD_OVERDRAW');
    expect(await expectLedgerConsistent(t, w.walletId)).toEqual({ balance: '0.00', entries: 3 });
  });
});

describe('concurrency (real parallelism against PostgreSQL)', () => {
  test('50 parallel identical bets debit exactly once', async () => {
    const w = await createWallet(t, '100.00');
    const ext = uid('ext');
    const results = await Promise.all(
      Array.from({ length: 50 }, () => wager(t, w, { externalTransactionId: ext, amount: '10.00' })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(49);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(await expectLedgerConsistent(t, w.walletId)).toEqual({ balance: '90.00', entries: 2 });
  });

  test('contention on one wallet never overdraws and never loses an update', async () => {
    const w = await createWallet(t, '30.00');
    const results = await Promise.all(Array.from({ length: 50 }, () => wager(t, w, { amount: '1.00' })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(30);
    expect(results.filter((r) => r.status === 422)).toHaveLength(20);
    expect(await expectLedgerConsistent(t, w.walletId)).toEqual({ balance: '0.00', entries: 31 });
    const wallet = await api(t, 'GET', `/wallets/${w.walletId}`);
    expect(wallet.body.version).toBe(31);
  });

  test('parallel wallets are independent', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => createWallet(t, '100.00')));
    await Promise.all(
      wallets.flatMap((w) => Array.from({ length: 5 }, () => wager(t, w, { amount: '10.00' }))),
    );
    for (const w of wallets) {
      expect(await expectLedgerConsistent(t, w.walletId)).toEqual({ balance: '50.00', entries: 6 });
    }
  });

  test('refund and rollback racing for the same bet credit once', async () => {
    const w = await createWallet(t, '50.00');
    const betExt = uid('bet');
    await wager(t, w, { externalTransactionId: betExt, amount: '20.00' });
    const results = await Promise.all([
      ...Array.from({ length: 5 }, () => wager(t, w, { kind: 'REFUND', amount: '20.00', referenceExternalTransactionId: betExt })),
      ...Array.from({ length: 5 }, () => wager(t, w, { kind: 'ROLLBACK', amount: '20.00', referenceExternalTransactionId: betExt })),
    ]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await expectLedgerConsistent(t, w.walletId)).toEqual({ balance: '50.00', entries: 3 });
  });
});
