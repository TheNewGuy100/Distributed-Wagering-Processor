import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { bootApp, createWallet, uid, wager, type TestApp } from './helpers';

/**
 * Regression guard for the deadlock found by the concurrency tests: inserting a row with a foreign key to
 * `wallets` takes FOR KEY SHARE on the wallet; asking for FOR UPDATE afterwards deadlocks two concurrent
 * transactions. The ORM must therefore lock the wallet row FIRST, before any statement that references it.
 * This test reads the SQL the ORM really sends, so a refactor cannot silently reorder it.
 */
let t: TestApp;
beforeAll(async () => {
  // The SQL log must be on at start-up to be switchable later; mute its output until a test captures it.
  t = await bootApp({ ORM_QUERY_LOG: 'true' });
  (t.app.get(MikroORM).config.getLogger() as unknown as { writer: () => void }).writer = () => {};
});
afterAll(() => t.close());

/** Runs `fn` while recording every SQL statement the ORM sends. */
async function captureSql(orm: { config: { getLogger(): unknown } }, fn: () => Promise<unknown>): Promise<string[]> {
  const statements: string[] = [];
  const logger = orm.config.getLogger() as {
    setDebugMode(mode: boolean | string[]): void;
    debugMode: boolean | string[];
    writer: (m: string) => void;
  };
  const originalWriter = logger.writer;
  const originalMode = logger.debugMode;
  logger.writer = (m: string) => {
    const clean = m.replace(/\x1b\[[0-9;]*m/g, '');
    if (clean.includes('[query]')) statements.push(clean.replace(/\s+/g, ' ').toLowerCase());
  };
  logger.setDebugMode(['query']);
  try {
    await fn();
  } finally {
    logger.setDebugMode(originalMode);
    logger.writer = originalWriter;
  }
  return statements;
}

const indexOfStmt = (stmts: string[], re: RegExp) => stmts.findIndex((s) => re.test(s));

describe('wallet lock ordering (as sent to PostgreSQL)', () => {
  const scenarios: [string, (w: { playerId: string; currency: string }) => Promise<unknown>][] = [
    ['a BET', (w) => wager(t, w, { amount: '1.00' })],
    ['a WIN', (w) => wager(t, w, { kind: 'WIN', amount: '1.00' })],
    ['a LOSS (no balance change)', (w) => wager(t, w, { kind: 'LOSS', amount: '1.00' })],
    ['a rejected BET', (w) => wager(t, w, { amount: '9999.00' })],
    ['a reversal waiting for its reference', (w) => wager(t, w, { kind: 'REFUND', amount: '1.00', referenceExternalId: uid('later') })],
  ];

  for (const [name, run] of scenarios) {
    test(`${name}: FOR UPDATE on the wallet precedes every other statement that touches it`, async () => {
      const w = await createWallet(t, '100.00');
      const orm = t.app.get(MikroORM);
      const sql = await captureSql(orm, () => run(w));

      const begin = indexOfStmt(sql, /\bbegin\b/);
      const lock = indexOfStmt(sql, /from "wallets".*for update/);
      const claim = indexOfStmt(sql, /insert into "wager_transactions"/);
      const ledger = indexOfStmt(sql, /insert into "ledger_entries"/);
      const outbox = indexOfStmt(sql, /insert into "outbox_events"/);

      expect(begin, 'the request runs in a transaction').toBeGreaterThanOrEqual(0);
      expect(lock, 'the wallet row is locked with FOR UPDATE').toBeGreaterThan(begin);
      expect(claim, 'the transaction row is claimed').toBeGreaterThan(lock);
      // The lock is the very first data statement of the transaction.
      expect(lock).toBe(begin + 1);
      if (ledger >= 0) expect(ledger).toBeGreaterThan(claim);
      expect(outbox).toBeGreaterThan(claim);
      // Nothing references wallet rows before the lock (no key-share lock can precede it).
      const beforeLock = sql.slice(0, lock).filter((s) => /wallets|wager_transactions|ledger_entries/.test(s));
      expect(beforeLock).toEqual([]);
    });
  }

  test('an idempotent replay also takes the lock first', async () => {
    const w = await createWallet(t, '100.00');
    const ext = uid('ext');
    await wager(t, w, { externalTransactionId: ext, amount: '1.00' });
    const orm = t.app.get(MikroORM);
    const sql = await captureSql(orm, () => wager(t, w, { externalTransactionId: ext, amount: '1.00' }));
    const begin = indexOfStmt(sql, /\bbegin\b/);
    expect(indexOfStmt(sql, /from "wallets".*for update/)).toBe(begin + 1);
  });
});
