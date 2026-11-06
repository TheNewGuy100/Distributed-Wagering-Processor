import { raw, type EntityManager } from '@mikro-orm/postgresql';
import { FailureCode } from '../../domain/errors';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  type DomainEvent,
} from '../../domain/events';
import { Money } from '../../domain/money';
import type { Wallet } from '../../domain/wallet';
import {
  applyDecision,
  decide,
  type Decision,
  type ReferenceSnapshot,
  type TransactionKind,
  type TransactionStatus,
} from '../../domain/wager-rules';
import {
  assertTransition,
  planPendingReferenceRetry,
  type PendingReferencePolicy,
} from '../../domain/wager-transaction';
import { enqueueEvent } from '../../infrastructure/outbox/outbox-writer';
import { WagerTransaction } from '../../infrastructure/persistence/entities';
import { persistWalletChanges } from '../../infrastructure/persistence/wallet-repository';
import { findTransactionByExternal } from './transaction-view';

export interface SettleInput {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  kind: TransactionKind;
  playerId: string;
  currency: string;
  amount: Money;
  roundId: string | null;
  referenceExternalId: string | null;
  /** Status the stored row currently has. */
  fromStatus: 'PENDING' | 'PENDING_REFERENCE';
  /** Retries already scheduled for this transaction (0 on the first attempt). */
  retryCount: number;
}

export interface SettleOutcome {
  status: TransactionStatus;
  failureCode: string | null;
}

export async function loadReference(
  tx: EntityManager,
  providerId: string,
  referenceExternalId: string,
): Promise<ReferenceSnapshot | null> {
  const row = await findTransactionByExternal(tx, providerId, referenceExternalId);
  if (!row) return null;
  const reversals = await tx.find(
    WagerTransaction,
    { referenceTransaction: row.id, status: 'PROCESSED' },
    { fields: ['kind'] },
  );
  return {
    id: row.id,
    providerId: row.providerId,
    playerId: row.playerId,
    walletId: row.wallet ?? '',
    currency: row.currency,
    roundId: row.roundId ?? null,
    kind: row.kind as TransactionKind,
    status: row.status as TransactionStatus,
    amount: Money.parse(row.amount, row.currency),
    reversedBy: reversals.map((r) => r.kind as TransactionKind),
  };
}

/**
 * Decides and persists the outcome of one transaction whose wallet row is already locked by the
 * caller. Shared by the first attempt (HTTP/SQS) and by the pending-reference retry worker, so a
 * delayed reversal obeys exactly the same rules as an immediate one.
 */
export async function settleTransaction(
  tx: EntityManager,
  wallet: Wallet,
  s: SettleInput,
  policy: PendingReferencePolicy,
): Promise<SettleOutcome> {
  const versionBefore = wallet.version;
  const reference =
    s.referenceExternalId === null ? null : await loadReference(tx, s.providerId, s.referenceExternalId);

  let decision: Decision = decide(s, wallet, reference);
  let retry: { retryCount: number; at: Date } | null = null;

  if (decision.type === 'PENDING_REFERENCE') {
    const plan = planPendingReferenceRetry(s.retryCount, new Date(), policy);
    if (plan.type === 'RETRY') {
      retry = { retryCount: plan.retryCount, at: plan.at };
    } else {
      decision = {
        type: 'REJECT',
        code: reference === null ? FailureCode.ReferenceNotFound : FailureCode.ReferenceNotProcessed,
        detail: 'reference did not resolve within the retry limit',
      };
    }
  }

  const base = {
    transactionId: s.transactionId,
    providerId: s.providerId,
    externalTransactionId: s.externalTransactionId,
    kind: s.kind,
    walletId: wallet.id,
    amount: s.amount.toString(),
    currency: s.currency,
  };

  if (retry) {
    assertTransition(s.fromStatus, 'PENDING_REFERENCE');
    await tx.nativeUpdate(
      WagerTransaction,
      { id: s.transactionId },
      { status: 'PENDING_REFERENCE', retryCount: retry.retryCount, nextRetryAt: retry.at, updatedAt: raw('now()') as never },
    );
    // Announce the wait once; later reschedules are internal bookkeeping.
    if (s.fromStatus === 'PENDING') {
      await enqueueEvent(
        tx,
        new WagerTransactionPendingReference(s.transactionId, { ...base, referenceExternalId: s.referenceExternalId }),
      );
    }
    return { status: 'PENDING_REFERENCE', failureCode: null };
  }

  const entry = applyDecision(wallet, s.transactionId, decision);
  await persistWalletChanges(tx, wallet, versionBefore, entry ? [entry] : []);

  const processed = decision.type === 'APPLY' || decision.type === 'NO_BALANCE_EFFECT';
  const status: TransactionStatus = processed ? 'PROCESSED' : 'REJECTED';
  const failureCode = decision.type === 'REJECT' ? decision.code : null;
  assertTransition(s.fromStatus, status);

  await tx.nativeUpdate(
    WagerTransaction,
    { id: s.transactionId },
    {
      status,
      failureCode,
      nextRetryAt: null,
      referenceTransaction: processed ? (reference?.id ?? null) : null,
      updatedAt: raw('now()') as never,
    },
  );

  const events: DomainEvent[] = [];
  if (processed) {
    events.push(new WagerTransactionProcessed(s.transactionId, base));
    if (entry) {
      events.push(
        new WalletBalanceChanged(wallet.id, {
          walletId: wallet.id,
          transactionId: s.transactionId,
          direction: entry.direction,
          amount: entry.amount.toString(),
          balanceAfter: entry.balanceAfter.toString(),
          currency: s.currency,
          walletVersion: wallet.version,
        }),
      );
    }
  } else {
    events.push(new WagerTransactionRejected(s.transactionId, { ...base, failureCode: failureCode! }));
  }
  for (const ev of events) await enqueueEvent(tx, ev);

  return { status, failureCode };
}
