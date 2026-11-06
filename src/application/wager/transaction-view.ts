import type { EntityManager } from '@mikro-orm/postgresql';
import type { MoneyProps } from '../../domain/events';
import { WagerTransaction, type WagerTransactionEntity } from '../../infrastructure/persistence/entities';
import { TransactionNotFoundError } from '../errors';

export type TransactionRow = WagerTransactionEntity;

export interface WagerTransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  kind: string;
  status: string;
  playerId: string;
  walletId: string | null;
  money: MoneyProps;
  /** Wallet balance observed when this transaction was settled (what a replay must return). */
  balance: MoneyProps | null;
  roundId: string | null;
  gameId: string | null;
  referenceExternalTransactionId: string | null;
  failureCode: string | null;
  retryCount: number;
  nextRetryAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

export const toView = (r: TransactionRow): WagerTransactionView => ({
  transactionId: r.id,
  providerId: r.providerId,
  externalTransactionId: r.externalTransactionId,
  kind: r.kind,
  status: r.status,
  playerId: r.playerId,
  walletId: r.wallet ?? null,
  money: { amount: r.amount, currency: r.currency },
  balance: r.balanceAfter == null ? null : { amount: r.balanceAfter, currency: r.currency },
  roundId: r.roundId ?? null,
  gameId: r.gameId ?? null,
  referenceExternalTransactionId: r.referenceExternalId ?? null,
  failureCode: r.failureCode ?? null,
  retryCount: r.retryCount,
  nextRetryAt: iso(r.nextRetryAt),
  createdAt: iso(r.createdAt)!,
  updatedAt: iso(r.updatedAt)!,
});

// `refresh` skips the identity map: rows are also changed with native updates, so a cached entity could be stale.
export const findTransactionById = (em: EntityManager, id: string): Promise<TransactionRow | null> =>
  em.findOne(WagerTransaction, { id }, { refresh: true });

export const findTransactionByExternal = (
  em: EntityManager,
  providerId: string,
  externalId: string,
): Promise<TransactionRow | null> =>
  em.findOne(WagerTransaction, { providerId, externalTransactionId: externalId }, { refresh: true });

export async function getTransactionView(em: EntityManager, id: string): Promise<WagerTransactionView> {
  const row = await findTransactionById(em, id);
  if (!row) throw new TransactionNotFoundError();
  return toView(row);
}

export async function getTransactionViewByExternal(
  em: EntityManager,
  providerId: string,
  externalId: string,
): Promise<WagerTransactionView> {
  const row = await findTransactionByExternal(em, providerId, externalId);
  if (!row) throw new TransactionNotFoundError();
  return toView(row);
}
