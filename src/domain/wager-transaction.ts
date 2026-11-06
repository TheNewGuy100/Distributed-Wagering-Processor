import { InvariantViolationError } from './errors';
import type { TransactionStatus } from './wager-rules';

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
