import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { JsonLogger } from '../../src/infrastructure/observability/json-logger';
import { MetricsService } from '../../src/infrastructure/observability/metrics.service';
import { api, bootApp, createWallet, expectLedgerConsistent, uid, wager, type TestApp } from './helpers';

const fast = {
  PENDING_WORKER_ENABLED: 'true',
  PENDING_WORKER_INTERVAL_MS: '100',
  PENDING_BASE_DELAY_MS: '100',
  PENDING_MAX_DELAY_MS: '400',
  PENDING_MAX_RETRIES: '4',
};

let t: TestApp; // API only (worker off): creates the situations
const logLines: Record<string, unknown>[] = [];
const originalWrite = JsonLogger.write;
beforeAll(async () => {
  JsonLogger.write = (line) => {
    try {
      logLines.push(JSON.parse(line));
    } catch {
      /* not a JSON log line */
    }
  };
  t = await bootApp();
  t.app.useLogger(new JsonLogger('log')); // capture instead of printing; asserted below
});
afterAll(async () => {
  JsonLogger.write = originalWrite;
  await t.close();
});

async function waitFor<T>(fn: () => Promise<T | false>, timeoutMs = 15000, label = 'condition'): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(100);
  }
}

const statusOf = async (id: string) => (await api(t, 'GET', `/wagering/transactions/${id}`)).body;
const terminal = (id: string) => async () => {
  const s = await statusOf(id);
  return s.status !== 'PENDING_REFERENCE' ? s : false;
};

describe('pending reference worker', () => {
  test('a reversal that arrived first is applied once its reference shows up', async () => {
    const w = await createWallet(t, '50.00');
    const betExt = uid('bet');
    const refund = await wager(t, w, { kind: 'REFUND', amount: '10.00', referenceExternalId: betExt });
    expect(refund.status).toBe(202);

    const worker = await bootApp(fast);
    try {
      // The first retry is scheduled by the API (default 1s policy); then the worker keeps
      // rescheduling it while the reference is still missing.
      const waiting = await waitFor(async () => {
        const s = await statusOf(refund.body.transactionId);
        return s.retryCount > 1 ? s : false;
      }, 10000, 'worker reschedule');
      expect(waiting.status).toBe('PENDING_REFERENCE');

      expect((await wager(t, w, { externalTransactionId: betExt, amount: '10.00' })).status).toBe(201);
      const done = await waitFor(terminal(refund.body.transactionId), 15000, 'refund resolution');
      expect(done.status).toBe('PROCESSED');
    } finally {
      await worker.close();
    }
    // opening 50 - bet 10 + refund 10
    expect(await expectLedgerConsistent(t, w.walletId)).toEqual({ balance: '50.00', entries: 3 });
  }, 40000);

  test('after the retry limit the reversal is rejected with REFERENCE_NOT_FOUND', async () => {
    const w = await createWallet(t, '50.00');
    const r = await wager(t, w, { kind: 'ROLLBACK', amount: '10.00', referenceExternalId: uid('never') });
    const worker = await bootApp(fast);
    try {
      const done = await waitFor(terminal(r.body.transactionId), 20000, 'exhaustion');
      expect(done).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_FOUND' });
      expect(done.retryCount).toBe(4);
    } finally {
      await worker.close();
    }
    expect(await expectLedgerConsistent(t, w.walletId)).toEqual({ balance: '50.00', entries: 1 });
  }, 40000);

  test('a late reference that does not match is rejected, not applied', async () => {
    const w = await createWallet(t, '50.00');
    const betExt = uid('bet');
    const r = await wager(t, w, { kind: 'REFUND', amount: '7.00', referenceExternalId: betExt });
    await wager(t, w, { externalTransactionId: betExt, amount: '9.00' }); // amount differs
    const worker = await bootApp(fast);
    try {
      const done = await waitFor(terminal(r.body.transactionId), 15000);
      expect(done).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_MISMATCH' });
    } finally {
      await worker.close();
    }
    expect(await expectLedgerConsistent(t, w.walletId)).toEqual({ balance: '41.00', entries: 2 });
  }, 40000);

  test('two worker instances settle each pending reversal exactly once', async () => {
    const w = await createWallet(t, '500.00');
    const pairs = Array.from({ length: 20 }, () => uid('bet'));
    const refunds = await Promise.all(
      pairs.map((ext) => wager(t, w, { kind: 'REFUND', amount: '5.00', referenceExternalId: ext })),
    );
    expect(refunds.every((r) => r.status === 202)).toBe(true);
    await Promise.all(pairs.map((ext) => wager(t, w, { externalTransactionId: ext, amount: '5.00' })));

    const [a, b] = await Promise.all([bootApp(fast), bootApp(fast)]);
    try {
      for (const r of refunds) {
        const done = await waitFor(terminal(r.body.transactionId), 30000, 'refund resolution');
        expect(done.status).toBe('PROCESSED');
      }
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
    // 20 bets debited, 20 refunds credited back: net zero, 41 ledger entries (opening + 40)
    expect(await expectLedgerConsistent(t, w.walletId)).toEqual({ balance: '500.00', entries: 41 });
    const wallet = await api(t, 'GET', `/wallets/${w.walletId}`);
    expect(wallet.body.version).toBe(41);
  }, 90000);
});

describe('reconciliation', () => {
  test('a healthy wallet reconciles cleanly', async () => {
    const w = await createWallet(t, '100.00');
    await wager(t, w, { amount: '25.00' });
    await wager(t, w, { kind: 'WIN', amount: '3.50' });
    const r = await api(t, 'POST', `/wallets/${w.walletId}/reconciliation`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      divergent: false,
      storedBalance: '78.50',
      calculatedBalance: '78.50',
      ledgerEntries: 3,
      storedVersion: 3,
      differences: [],
      flaggedAt: null,
    });
  });

  test('a divergence is reported, logged, counted and flagged — and not corrected', async () => {
    const w = await createWallet(t, '100.00');
    await wager(t, w, { amount: '10.00' });
    const metrics = t.app.get(MetricsService);
    const before = metrics.get('wallet_reconciliation_divergences_total');
    // Nest's logger is process-global: apps booted by earlier tests replaced it, so set it again here.
    t.app.useLogger(new JsonLogger('log'));

    // Simulated corruption (the ledger itself is immutable; the balance column is not).
    await t.orm.em.fork().execute('update wallets set balance = balance + 7.00 where id = ?', [w.walletId]);

    const r = await api(t, 'POST', `/wallets/${w.walletId}/reconciliation`);
    expect(r.status).toBe(200);
    expect(r.body.divergent).toBe(true);
    expect(r.body.storedBalance).toBe('97.00');
    expect(r.body.calculatedBalance).toBe('90.00');
    expect(r.body.differences.join(' ')).toContain('stored balance 97.00 != ledger-derived balance 90.00');
    expect(r.body.flaggedAt).not.toBeNull();
    expect(metrics.get('wallet_reconciliation_divergences_total')).toBe(before + 1);

    // The divergence is logged at ERROR level with the wallet id and what disagrees (not printed: asserted here).
    const logged = logLines.filter((l) => l.level === 'error' && String(l.msg).includes(w.walletId));
    expect(logged).toHaveLength(1);
    expect(String(logged[0]!.msg)).toContain('reconciliation_divergence');
    expect(String(logged[0]!.msg)).toContain('stored balance 97.00 != ledger-derived balance 90.00');

    const wallet = await api(t, 'GET', `/wallets/${w.walletId}`);
    expect(wallet.body.balance).toBe('97.00'); // left exactly as found
    expect(wallet.body.flaggedAt).not.toBeNull();
    const again = await api(t, 'POST', `/wallets/${w.walletId}/reconciliation`);
    expect(again.body.flaggedAt).toBe(r.body.flaggedAt); // first flag time is preserved
  });

  test('unknown wallet is 404, malformed id is 400', async () => {
    expect((await api(t, 'POST', `/wallets/${crypto.randomUUID()}/reconciliation`)).status).toBe(404);
    expect((await api(t, 'POST', '/wallets/nope/reconciliation')).status).toBe(400);
  });
});
