import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { api, bootApp, createWallet, expectLedgerConsistent, uid, wager, type TestApp } from './helpers';

// The retry worker is on so that a reversal that overtakes its reference gets resolved while the tests run.
let t: TestApp;
beforeAll(async () => {
  t = await bootApp({
    PENDING_WORKER_ENABLED: 'true',
    PENDING_WORKER_INTERVAL_MS: '100',
    PENDING_BASE_DELAY_MS: '100',
    PENDING_MAX_DELAY_MS: '400',
    PENDING_MAX_RETRIES: '10',
  });
});
afterAll(() => t.close());

async function waitFor<T>(fn: () => Promise<T | false>, timeoutMs = 20000, label = 'condition'): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(100);
  }
}

describe('idempotency under parallel requests', () => {
  test('one external id with different payloads: exactly one wins, the rest are conflicts', async () => {
    const w = await createWallet(t, '1000.00');
    const ext = uid('ext');
    const amounts = Array.from({ length: 20 }, (_, i) => `${i + 1}.00`);
    const results = await Promise.all(amounts.map((amount) => wager(t, w, { externalTransactionId: ext, amount })));

    const created = results.filter((r) => r.status === 201);
    expect(created).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(19);
    // the winner's amount, and only it, was debited
    const winner = created[0]!.body.money.amount as string;
    expect(await expectLedgerConsistent(t, w.walletId)).toEqual({
      balance: (1000 - Number(winner)).toFixed(2),
      entries: 2,
    });
  });

  test('one external id under different Idempotency-Keys: one transaction, the rest are conflicts', async () => {
    const w = await createWallet(t, '100.00');
    const ext = uid('ext');
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        wager(t, w, { externalTransactionId: ext, amount: '5.00' }, { 'idempotency-key': `key-${i}-${ext}` }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(19);
    expect(await expectLedgerConsistent(t, w.walletId)).toEqual({ balance: '95.00', entries: 2 });
  });

  test('one Idempotency-Key reused for different external ids: one transaction, the rest are conflicts', async () => {
    const w = await createWallet(t, '100.00');
    const key = uid('shared-key');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => wager(t, w, { amount: '5.00' }, { 'idempotency-key': key })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(19);
    expect(await expectLedgerConsistent(t, w.walletId)).toEqual({ balance: '95.00', entries: 2 });
  });

  test('replays in parallel with the original all see the same transaction and the same balance', async () => {
    const w = await createWallet(t, '100.00');
    const ext = uid('ext');
    const results = await Promise.all(
      Array.from({ length: 30 }, () => wager(t, w, { externalTransactionId: ext, amount: '10.00' })),
    );
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(new Set(results.map((r) => r.body.balance.amount))).toEqual(new Set(['90.00']));
    expect(results.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
  });
});

describe('races between a reversal and the transaction it reverses', () => {
  test('a refund sent together with its bet ends with the stake returned once, in either order', async () => {
    for (let round = 0; round < 8; round++) {
      const w = await createWallet(t, '50.00');
      const betExt = uid('bet');
      const [bet, refund] = await Promise.all([
        wager(t, w, { externalTransactionId: betExt, amount: '20.00' }),
        wager(t, w, { kind: 'REFUND', amount: '20.00', referenceExternalTransactionId: betExt }),
      ]);
      expect(bet.status).toBe(201);
      expect([201, 202]).toContain(refund.status); // 202: it overtook the bet and waits for it

      await waitFor(async () => {
        const r = await api(t, 'GET', `/wagering/transactions/${refund.body.transactionId}`);
        return r.body.status === 'PROCESSED' ? r.body : false;
      }, 20000, `refund of round ${round}`);
      expect(await expectLedgerConsistent(t, w.walletId)).toEqual({ balance: '50.00', entries: 3 });
    }
  });

  test('a rollback and a refund of a bet that has not arrived yet: one credit, whichever resolves first', async () => {
    const w = await createWallet(t, '50.00');
    const betExt = uid('bet');
    const [refund, rollback] = await Promise.all([
      wager(t, w, { kind: 'REFUND', amount: '20.00', referenceExternalTransactionId: betExt }),
      wager(t, w, { kind: 'ROLLBACK', amount: '20.00', referenceExternalTransactionId: betExt }),
    ]);
    expect(refund.status).toBe(202);
    expect(rollback.status).toBe(202);
    await wager(t, w, { externalTransactionId: betExt, amount: '20.00' });

    const finals = await waitFor(async () => {
      const both = await Promise.all(
        [refund, rollback].map((r) => api(t, 'GET', `/wagering/transactions/${r.body.transactionId}`)),
      );
      return both.every((r) => r.body.status === 'PROCESSED' || r.body.status === 'REJECTED')
        ? both.map((r) => r.body)
        : false;
    });
    expect(finals.filter((f) => f.status === 'PROCESSED')).toHaveLength(1);
    expect(finals.find((f) => f.status === 'REJECTED')?.failureCode).toBe('ALREADY_REVERSED');
    expect(await expectLedgerConsistent(t, w.walletId)).toEqual({ balance: '50.00', entries: 3 });
  });
});

describe('random concurrent workload, checked against an independent model', () => {
  /** Deterministic PRNG, so a failure can be replayed. */
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let x = a;
      x = Math.imul(x ^ (x >>> 15), x | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  test('balances equal what the responses say was applied; nothing is negative; the ledger explains everything', async () => {
    const rnd = mulberry32(20261108);
    const wallets = await Promise.all(Array.from({ length: 4 }, () => createWallet(t, '200.00')));

    // Phase 1: concurrent bets, wins and losses, with duplicated requests mixed in.
    const first = Array.from({ length: 160 }, () => {
      const w = wallets[Math.floor(rnd() * wallets.length)]!;
      const kind = rnd() < 0.55 ? 'BET' : rnd() < 0.8 ? 'WIN' : 'LOSS';
      const amount = `${1 + Math.floor(rnd() * 60)}.${String(Math.floor(rnd() * 100)).padStart(2, '0')}`;
      return { w, kind, amount, ext: uid('ext'), dup: rnd() < 0.2 };
    });
    const phase1 = await Promise.all(
      first.flatMap((o) => {
        const send = () => wager(t, o.w, { kind: o.kind, amount: o.amount, externalTransactionId: o.ext });
        return o.dup ? [send(), send()] : [send()];
      }),
    );
    for (const r of phase1) expect([200, 201, 422]).toContain(r.status);

    // Phase 2: reversals of whatever really got processed, some of them sent twice, some with the wrong amount.
    const processed = new Map<string, { kind: string; amount: string; wallet: string }>();
    for (const o of first) {
      const view = await api(t, 'GET', `/providers/prov-a/wagering/transactions/${o.ext}`);
      if (view.body.status === 'PROCESSED') {
        processed.set(o.ext, { kind: o.kind, amount: view.body.money.amount, wallet: o.w.walletId });
      }
    }
    const reversible = [...processed].filter(([, p]) => p.kind === 'BET' || p.kind === 'WIN');
    const reversals = reversible
      .filter(() => rnd() < 0.5)
      .flatMap(([ext, p]) => {
        const w = wallets.find((x) => x.walletId === p.wallet)!;
        const kind = rnd() < 0.5 ? 'REFUND' : 'ROLLBACK';
        const amount = rnd() < 0.85 ? p.amount : '0.01';
        const send = () =>
          wager(t, w, { kind, amount, externalTransactionId: uid('rev'), referenceExternalTransactionId: ext });
        return rnd() < 0.5 ? [send(), send()] : [send()];
      });
    await Promise.all(reversals);

    // Wait until nothing is waiting for a reference any more.
    await waitFor(async () => {
      const [row] = await t.orm.em
        .fork()
        .execute<{ n: number }[]>(
          "select count(*)::int as n from wager_transactions where status = 'PENDING_REFERENCE' and wallet_id in (" + wallets.map(() => '?').join(', ') + ")",
          wallets.map((w) => w.walletId),
        );
      return row!.n === 0;
    });

    // The model: only the stored final statuses are read, every effect is recomputed from them.
    const em = t.orm.em.fork();
    for (const w of wallets) {
      const rows = await em.execute<
        { id: string; kind: string; status: string; amount: string; reference_transaction_id: string | null }[]
      >(
        'select id, kind, status, amount, reference_transaction_id from wager_transactions where wallet_id = ? order by created_at',
        [w.walletId],
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      let expected = 200_00n;
      for (const r of rows.filter((x) => x.status === 'PROCESSED')) {
        const cents = BigInt(Math.round(Number(r.amount) * 100));
        if (r.kind === 'BET') expected -= cents;
        else if (r.kind === 'WIN') expected += cents;
        else if (r.kind === 'REFUND' || r.kind === 'ROLLBACK') {
          expected += byId.get(r.reference_transaction_id!)!.kind === 'BET' ? cents : -cents;
        }
      }
      expect(expected >= 0n).toBe(true);

      const state = await expectLedgerConsistent(t, w.walletId);
      expect(BigInt(Math.round(Number(state.balance) * 100))).toBe(expected);

      // no transaction was reversed twice, whatever the reversal type
      const reversedTwice = rows.filter((x) => x.status === 'PROCESSED' && x.reference_transaction_id).map((x) => x.reference_transaction_id!);
      expect(new Set(reversedTwice).size).toBe(reversedTwice.length);
    }
  });
});
