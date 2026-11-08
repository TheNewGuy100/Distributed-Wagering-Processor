import { FailureCode, InvariantViolationError } from './errors';
import {
  decide,
  type Decision,
  type ReferenceSnapshot,
  type TransactionInput,
  type TransactionStatus,
} from './wager-rules';
import type { Wallet } from './wallet';

/** Final for good. FAILED is a resting state: the effect never happened, and a resend of the same request reopens it. */
export const TERMINAL_STATUSES: readonly TransactionStatus[] = ['PROCESSED', 'REJECTED'];

const ALLOWED: Record<TransactionStatus, readonly TransactionStatus[]> = {
  PENDING: ['PROCESSED', 'REJECTED', 'FAILED', 'PENDING_REFERENCE'],
  PENDING_REFERENCE: ['PROCESSED', 'REJECTED', 'FAILED', 'PENDING_REFERENCE'],
  PROCESSED: [],
  REJECTED: [],
  FAILED: ['PENDING'], // reopened by a resend of the very same request (same key, same payload)
};

export const isTerminal = (s: TransactionStatus): boolean => TERMINAL_STATUSES.includes(s);

/** Guards status changes: PROCESSED and REJECTED can never change again. */
export function assertTransition(from: TransactionStatus, to: TransactionStatus): void {
  if (!ALLOWED[from].includes(to)) {
    throw new InvariantViolationError(`illegal status transition ${from} -> ${to}`);
  }
}

export interface PendingReferencePolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_PENDING_REFERENCE_POLICY: PendingReferencePolicy = {
  maxRetries: 8,
  baseDelayMs: 1_000,
  maxDelayMs: 5 * 60_000,
};

export type RetryPlan = { type: 'RETRY'; retryCount: number; at: Date } | { type: 'EXHAUSTED' };

/**
 * Exponential backoff for transactions waiting on their reference. `retryCount` is the number of
 * retries already performed. Once the limit is reached the transaction must be REJECTED with
 * REFERENCE_NOT_FOUND.
 */
export function planPendingReferenceRetry(
  retryCount: number,
  now: Date,
  policy: PendingReferencePolicy = DEFAULT_PENDING_REFERENCE_POLICY,
): RetryPlan {
  if (retryCount >= policy.maxRetries) return { type: 'EXHAUSTED' };
  const delay = Math.min(policy.baseDelayMs * 2 ** retryCount, policy.maxDelayMs);
  return { type: 'RETRY', retryCount: retryCount + 1, at: new Date(now.getTime() + delay) };
}

/** Everything the domain needs to settle one transaction whose wallet is already locked. */
export interface SettlementRequest extends TransactionInput {
  gameId: string | null;
  /** Status the stored transaction currently has. */
  fromStatus: 'PENDING' | 'PENDING_REFERENCE';
  /** Retries already scheduled (0 on the first attempt). */
  retryCount: number;
}

/**
 * What happens to the transaction: it keeps waiting for its reference (`WAIT`), or it reaches a final status
 * (`SETTLE`) with the decision to execute on the wallet.
 */
export type Settlement =
  | {
      type: 'WAIT';
      status: 'PENDING_REFERENCE';
      retryCount: number;
      retryAt: Date;
      gameId: string | null;
      /** The wait is announced once, when the transaction first enters it. */
      announce: boolean;
    }
  | {
      type: 'SETTLE';
      status: 'PROCESSED' | 'REJECTED';
      decision: Decision;
      failureCode: FailureCode | null;
      gameId: string | null;
    };

/**
 * Pure: decides the fate of a transaction (apply, reject, or wait for its reference with a bounded retry budget) and
 * checks the status transition. Shared by the first attempt and by the retry worker, so a delayed reversal obeys the
 * same rules as an immediate one. Performs no mutation and no I/O.
 */
export function planSettlement(
  req: SettlementRequest,
  wallet: Wallet,
  reference: ReferenceSnapshot | null,
  now: Date,
  policy: PendingReferencePolicy = DEFAULT_PENDING_REFERENCE_POLICY,
): Settlement {
  let decision = decide(req, wallet, reference);
  // A reversal inherits the game of the transaction it reverses, so per-game reports do not undercount.
  const gameId = req.gameId ?? reference?.gameId ?? null;

  if (decision.type === 'PENDING_REFERENCE') {
    const plan = planPendingReferenceRetry(req.retryCount, now, policy);
    if (plan.type === 'RETRY') {
      assertTransition(req.fromStatus, 'PENDING_REFERENCE');
      return {
        type: 'WAIT',
        status: 'PENDING_REFERENCE',
        retryCount: plan.retryCount,
        retryAt: plan.at,
        gameId,
        announce: req.fromStatus === 'PENDING',
      };
    }
    decision = {
      type: 'REJECT',
      code: reference === null ? FailureCode.ReferenceNotFound : FailureCode.ReferenceNotProcessed,
      detail: 'reference did not resolve within the retry limit',
    };
  }

  const status = decision.type === 'APPLY' || decision.type === 'NO_BALANCE_EFFECT' ? 'PROCESSED' : 'REJECTED';
  assertTransition(req.fromStatus, status);
  return {
    type: 'SETTLE',
    status,
    decision,
    failureCode: decision.type === 'REJECT' ? decision.code : null,
    gameId,
  };
}
