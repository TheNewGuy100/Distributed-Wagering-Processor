import type { EntityManager } from '@mikro-orm/postgresql';
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
import { enqueueEvents } from '../../infrastructure/outbox/outbox-writer';
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
  gameId: string | null;
  referenceExternalId: string | null;
  /** Status the stored row currently has. */
  fromStatus: 'PENDING' | 'PENDING_REFERENCE';
  /** Retries already scheduled for this transaction (0 on the first attempt). */
  retryCount: number;
}

export interface SettleOutcome {
  status: TransactionStatus;
  failureCode: string | null;
  /** The request's game, or the referenced transaction's when a reversal came without one. */
  gameId: string | null;
  /** Wallet balance after this settlement (unchanged for rejections and pending references). */
  balance: Money;
  /** Final values of the row, so callers can build the response without reading it back. */
  retryCount: number;
  nextRetryAt: Date | null;
  updatedAt: Date;
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
    gameId: row.gameId ?? null,
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
  const updatedAt = new Date();
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

  // A reversal inherits the game of the transaction it reverses, so per-game reports do not undercount.
  const gameId = s.gameId ?? reference?.gameId ?? null;
  const base = {
    transactionId: s.transactionId,
    providerId: s.providerId,
    externalTransactionId: s.externalTransactionId,
    kind: s.kind,
    walletId: wallet.id,
    roundId: s.roundId,
    gameId,
    money: { amount: s.amount.toString(), currency: s.currency },
  };

  if (retry) {
    assertTransition(s.fromStatus, 'PENDING_REFERENCE');
    await tx.nativeUpdate(
      WagerTransaction,
      { id: s.transactionId },
      {
        status: 'PENDING_REFERENCE',
        retryCount: retry.retryCount,
        nextRetryAt: retry.at,
        balanceAfter: wallet.balance.toString(),
        updatedAt,
      },
    );
    // Announce the wait once; later reschedules are internal bookkeeping.
    if (s.fromStatus === 'PENDING') {
      await enqueueEvents(tx, [
        new WagerTransactionPendingReference(s.transactionId, { ...base, referenceExternalId: s.referenceExternalId }),
      ]);
    }
    return {
      status: 'PENDING_REFERENCE',
      failureCode: null,
      gameId,
      balance: wallet.balance,
      retryCount: retry.retryCount,
      nextRetryAt: retry.at,
      updatedAt,
    };
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
      balanceAfter: wallet.balance.toString(),
      ...(gameId !== s.gameId ? { gameId } : {}),
      referenceTransaction: processed ? (reference?.id ?? null) : null,
      updatedAt,
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
          money: { amount: entry.amount.toString(), currency: s.currency },
          balanceBefore: { amount: entry.balanceBefore.toString(), currency: s.currency },
          balanceAfter: { amount: entry.balanceAfter.toString(), currency: s.currency },
          walletVersion: wallet.version,
        }),
      );
    }
  } else {
    events.push(new WagerTransactionRejected(s.transactionId, { ...base, failureCode: failureCode! }));
  }
  await enqueueEvents(tx, events);

  return { status, failureCode, gameId, balance: wallet.balance, retryCount: s.retryCount, nextRetryAt: null, updatedAt };
}
