import type { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { InvariantViolationError } from '../../domain/errors';
import { Money } from '../../domain/money';
import { Wallet, type LedgerEntryDraft } from '../../domain/wallet';

export interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: string | number;
  created_at: string;
}

export const walletFromRow = (r: WalletRow): Wallet =>
  Wallet.rehydrate({
    id: r.id,
    playerId: r.player_id,
    balance: Money.parse(r.balance, r.currency),
    version: Number(r.version),
  });

/**
 * Takes the row lock that serializes all balance changes of one wallet; null when it does not exist.
 *
 * Must be the FIRST statement touching the wallet in a transaction: inserting a row that has a
 * foreign key to `wallets` takes FOR KEY SHARE on it, and upgrading that to FOR UPDATE afterwards
 * deadlocks when two transactions do it concurrently.
 */
export async function lockWalletByPlayer(
  tx: EntityManager,
  playerId: string,
  currency: string,
): Promise<Wallet | null> {
  const rows = await tx.execute<WalletRow[]>(
    `select id, player_id, currency, balance, version, created_at
       from wallets where player_id = ? and currency = ? for update`,
    [playerId, currency],
  );
  return rows[0] ? walletFromRow(rows[0]) : null;
}

export async function lockWalletById(tx: EntityManager, walletId: string): Promise<Wallet | null> {
  const rows = await tx.execute<WalletRow[]>(
    'select id, player_id, currency, balance, version, created_at from wallets where id = ? for update',
    [walletId],
  );
  return rows[0] ? walletFromRow(rows[0]) : null;
}

/** Persists the wallet's new balance (optimistic version check as a second line of defense) and its ledger entries. */
export async function persistWalletChanges(
  tx: EntityManager,
  wallet: Wallet,
  versionBefore: number,
  entries: readonly LedgerEntryDraft[],
): Promise<void> {
  if (entries.length === 0) return;
  const updated = await tx.execute<{ id: string }[]>(
    'update wallets set balance = ?, version = ? where id = ? and version = ? returning id',
    [wallet.balance.toString(), wallet.version, wallet.id, versionBefore],
  );
  if (updated.length !== 1) throw new InvariantViolationError(`lost update detected on wallet ${wallet.id}`);
  for (const e of entries) {
    await tx.execute(
      `insert into ledger_entries (id, wallet_id, transaction_id, direction, amount, balance_after)
       values (?, ?, ?, ?, ?, ?)`,
      [randomUUID(), wallet.id, e.transactionId, e.direction, e.amount.toString(), e.balanceAfter.toString()],
    );
  }
}
