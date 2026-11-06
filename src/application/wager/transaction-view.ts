import type { EntityManager } from '@mikro-orm/postgresql';
import { TransactionNotFoundError } from '../errors';

export interface TransactionRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  kind: string;
  status: string;
  player_id: string;
  currency: string;
  amount: string;
  round_id: string | null;
  wallet_id: string | null;
  reference_external_id: string | null;
  reference_transaction_id: string | null;
  failure_code: string | null;
  retry_count: number;
  next_retry_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WagerTransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  kind: string;
  status: string;
  playerId: string;
  walletId: string | null;
  amount: string;
  currency: string;
  roundId: string | null;
  referenceExternalId: string | null;
  failureCode: string | null;
  retryCount: number;
  nextRetryAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const iso = (v: string | null): string | null => (v === null ? null : new Date(v).toISOString());

export const toView = (r: TransactionRow): WagerTransactionView => ({
  transactionId: r.id,
  providerId: r.provider_id,
  externalTransactionId: r.external_transaction_id,
  kind: r.kind,
  status: r.status,
  playerId: r.player_id,
  walletId: r.wallet_id,
  amount: r.amount,
  currency: r.currency,
  roundId: r.round_id,
  referenceExternalId: r.reference_external_id,
  failureCode: r.failure_code,
  retryCount: r.retry_count,
  nextRetryAt: iso(r.next_retry_at),
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});

export async function findTransactionById(em: EntityManager, id: string): Promise<TransactionRow | null> {
  const rows = await em.execute<TransactionRow[]>('select * from wager_transactions where id = ?', [id]);
  return rows[0] ?? null;
}

export async function findTransactionByExternal(
  em: EntityManager,
  providerId: string,
  externalId: string,
): Promise<TransactionRow | null> {
  const rows = await em.execute<TransactionRow[]>(
    'select * from wager_transactions where provider_id = ? and external_transaction_id = ?',
    [providerId, externalId],
  );
  return rows[0] ?? null;
}

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
