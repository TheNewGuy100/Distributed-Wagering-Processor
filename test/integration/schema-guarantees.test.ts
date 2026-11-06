import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import config from '../../src/infrastructure/persistence/mikro-orm.config';

/**
 * The financial guarantees that live in the database. `migration:check` keeps the entities and the migrated schema
 * in sync, but it cannot see everything (e.g. statement-level triggers), so each guarantee is also pinned here —
 * by name in the catalog AND by behaviour — to make removing one a loud, explained failure.
 */
let orm: MikroORM;
beforeAll(async () => {
  orm = await MikroORM.init(config);
  await orm.migrator.up(); // idempotent
});
afterAll(() => orm.close());

const q = <T>(sql: string, params: unknown[] = []) => orm.em.fork().execute<T[]>(sql, params);

describe('catalog: guarantees exist by name', () => {
  test('append-only ledger triggers (row-level UPDATE/DELETE and statement-level TRUNCATE)', async () => {
    const rows = await q<{ tgname: string; tgtype: number }>(
      `select tgname, tgtype from pg_trigger where tgrelid = 'ledger_entries'::regclass and not tgisinternal`,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.tgname, r.tgtype]));
    // tgtype bits: 1=ROW, 2=BEFORE, 4=INSERT, 8=DELETE, 16=UPDATE, 32=TRUNCATE
    expect(byName.ledger_entries_no_update_delete! & (1 | 2 | 8 | 16)).toBe(1 | 2 | 8 | 16);
    expect(byName.ledger_entries_no_truncate! & (2 | 32)).toBe(2 | 32);
    expect(byName.ledger_entries_no_truncate! & 1).toBe(0); // statement-level
  });

  test('one processed reversal per transaction is a PARTIAL UNIQUE index', async () => {
    const [idx] = await q<{ indexdef: string }>(
      `select indexdef from pg_indexes where indexname = 'wager_tx_one_reversal_per_reference'`,
    );
    expect(idx).toBeDefined();
    expect(idx!.indexdef).toContain('UNIQUE');
    expect(idx!.indexdef).toContain('reference_transaction_id');
    expect(idx!.indexdef).toMatch(/WHERE .*PROCESSED/);
  });

  test('idempotency and external-id uniqueness', async () => {
    const rows = await q<{ conname: string }>(
      `select conname from pg_constraint where contype = 'u' and conrelid in
         ('wager_transactions'::regclass, 'wallets'::regclass, 'ledger_entries'::regclass)`,
    );
    const names = rows.map((r) => r.conname);
    for (const n of [
      'wager_tx_provider_external_unique',
      'wager_tx_idempotency_key_unique',
      'wallets_player_currency_unique',
      'ledger_one_entry_per_wallet_tx',
    ]) {
      expect(names).toContain(n);
    }
  });

  test('CHECK constraints (non-negative balance, amounts, status/kind domains)', async () => {
    const rows = await q<{ conname: string }>(`select conname from pg_constraint where contype = 'c'`);
    const names = rows.map((r) => r.conname);
    for (const n of [
      'wallets_balance_non_negative',
      'ledger_amount_positive',
      'ledger_balance_after_non_negative',
      'ledger_balance_before_non_negative',
      'ledger_balance_arithmetic',
      'ledger_direction_valid',
      'wager_tx_kind_valid',
      'wager_tx_status_valid',
      'wager_tx_amount_valid',
      'wager_tx_reversal_has_reference',
    ]) {
      expect(names).toContain(n);
    }
  });

  test('outbox publishing indexes are partial (only unpublished rows)', async () => {
    const rows = await q<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes where tablename = 'outbox_events' and indexname like 'outbox_events_unpublished%'`,
    );
    expect(rows.map((r) => r.indexname).sort()).toEqual(['outbox_events_unpublished', 'outbox_events_unpublished_by_aggregate']);
    for (const r of rows) expect(r.indexdef).toContain('published_at IS NULL');
  });
});

describe('behaviour: the guarantees actually fire', () => {
  const walletId = crypto.randomUUID();
  const txId = crypto.randomUUID();

  beforeAll(async () => {
    const em = orm.em.fork();
    await em.execute(`insert into wallets (id, player_id, currency, balance, version) values (?, ?, 'BRL', 10, 1)`, [
      walletId,
      `schema-${walletId}`,
    ]);
    await em.execute(
      `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, kind, status, player_id, currency, amount, wallet_id)
       values (?, 'schema', ?, ?, 'h', 'WIN', 'PROCESSED', ?, 'BRL', 10, ?)`,
      [txId, txId, txId, `schema-${walletId}`, walletId],
    );
    await em.execute(
      `insert into ledger_entries (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after) values (?, ?, ?, 'CREDIT', 10, 0, 10)`,
      [crypto.randomUUID(), walletId, txId],
    );
  });

  test('ledger rows cannot be updated, deleted or truncated', async () => {
    await expect(q(`update ledger_entries set amount = 1 where wallet_id = ?`, [walletId])).rejects.toThrow(/append-only/);
    await expect(q(`delete from ledger_entries where wallet_id = ?`, [walletId])).rejects.toThrow(/append-only/);
    await expect(q(`truncate ledger_entries`)).rejects.toThrow(/append-only/);
  });

  test('a ledger entry whose balances do not add up is rejected by the database itself', async () => {
    const bad = (dir: string, before: number, after: number) =>
      q(`insert into ledger_entries (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after) values (?, ?, ?, ?, 10, ?, ?)`, [
        crypto.randomUUID(), walletId, txId, dir, before, after,
      ]);
    await expect(bad('CREDIT', 5, 20)).rejects.toThrow(/ledger_balance_arithmetic/);
    await expect(bad('DEBIT', 50, 50)).rejects.toThrow(/ledger_balance_arithmetic/);
  });

  test('a negative balance is rejected by the database itself', async () => {
    await expect(q(`update wallets set balance = -0.01 where id = ?`, [walletId])).rejects.toThrow(/wallets_balance_non_negative/);
  });

  test('a second processed reversal of the same transaction is rejected, whatever its type', async () => {
    const insertReversal = (kind: string) =>
      q(
        `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, kind, status, player_id, currency, amount, wallet_id, reference_external_id, reference_transaction_id)
         values (?, 'schema', ?, ?, 'h', ?, 'PROCESSED', ?, 'BRL', 10, ?, 'x', ?)`,
        [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), kind, `schema-${walletId}`, walletId, txId],
      );
    await insertReversal('REFUND');
    await expect(insertReversal('ROLLBACK')).rejects.toThrow(/wager_tx_one_reversal_per_reference/);
  });
});

describe('migrations', () => {
  test('every migration is reversible (defines down())', async () => {
    const dir = join(import.meta.dir, '../../src/infrastructure/persistence/migrations');
    const files = readdirSync(dir).filter((f) => /^Migration.*\.ts$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const f of files) {
      const mod = (await import(join(dir, f))) as Record<string, { prototype: object }>;
      const cls = Object.values(mod)[0]!;
      expect(Object.getOwnPropertyNames(cls.prototype), `${f} must define down()`).toContain('down');
    }
  });

  test('entities and migrated schema are in sync (no drift)', async () => {
    expect(await orm.migrator.checkSchema()).toBe(false);
  });
});
