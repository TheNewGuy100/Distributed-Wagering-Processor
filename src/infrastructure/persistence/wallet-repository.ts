import { LockMode, type EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { InvariantViolationError } from '../../domain/errors';
import { Money } from '../../domain/money';
import { Wallet, type LedgerEntryDraft } from '../../domain/wallet';
import { LedgerEntry, Wallet as WalletSchema, type WalletEntity } from './entities';

export const walletFromEntity = (e: WalletEntity): Wallet =>
  Wallet.rehydrate({
    id: e.id,
    playerId: e.playerId,
    balance: Money.parse(e.balance, e.currency),
    version: Number(e.version),
  });

/**
 * Takes the row lock that serializes all balance changes of one wallet (`SELECT … FOR UPDATE`); null when it
 * does not exist.
 *
 * Must be the FIRST statement touching the wallet in a transaction: inserting a row that has a foreign key to
 * `wallets` takes FOR KEY SHARE on it, and upgrading that to FOR UPDATE afterwards deadlocks when two
 * transactions do it concurrently. `refresh` bypasses the identity map so the locked row is always re-read.
 */
export async function lockWalletByPlayer(
  tx: EntityManager,
  playerId: string,
  currency: string,
): Promise<Wallet | null> {
  const e = await tx.findOne(WalletSchema, { playerId, currency }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
  return e ? walletFromEntity(e) : null;
}

export async function lockWalletById(tx: EntityManager, walletId: string): Promise<Wallet | null> {
  const e = await tx.findOne(WalletSchema, { id: walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
  return e ? walletFromEntity(e) : null;
}

/**
 * Persists the wallet's new balance — guarded by `WHERE version = :before`, a second line of defence against a
 * lost update behind the row lock — and appends its ledger entries.
 */
export async function persistWalletChanges(
  tx: EntityManager,
  wallet: Wallet,
  versionBefore: number,
  entries: readonly LedgerEntryDraft[],
): Promise<void> {
  if (entries.length === 0) return;
  const updated = await tx.nativeUpdate(
    WalletSchema,
    { id: wallet.id, version: versionBefore },
    { balance: wallet.balance.toString(), version: wallet.version },
  );
  if (updated !== 1) throw new InvariantViolationError(`lost update detected on wallet ${wallet.id}`);
  for (const e of entries) {
    await tx.insert(LedgerEntry, {
      id: randomUUID(),
      wallet: wallet.id,
      transaction: e.transactionId,
      direction: e.direction,
      amount: e.amount.toString(),
      balanceBefore: e.balanceBefore.toString(),
      balanceAfter: e.balanceAfter.toString(),
    });
  }
}
