export type OutboxStatus = 'PENDING' | 'PUBLISHED' | 'DEAD';

export interface OutboxRetryPolicy {
  /** Delay after the first failed attempt; doubles on every further failure. */
  baseDelayMs: number;
  maxDelayMs: number;
  /** Failed attempts after which the message is declared DEAD (needs a human). */
  maxAttempts: number;
}

export interface OutboxMessageSnapshot {
  id: string;
  aggregateId: string;
  /** Failed publish attempts so far. */
  failedAttempts: number;
  publishedAt: Date | null;
  deadAt: Date | null;
}

export type FailureResult =
  | { type: 'RETRY'; failedAttempts: number; delayMs: number }
  | { type: 'DEAD'; failedAttempts: number };

/**
 * A committed integration event waiting to be relayed to the broker.
 *
 *   PENDING ──markPublished──▶ PUBLISHED        (terminal)
 *   PENDING ──recordFailure──▶ PENDING (later)  exponential backoff, the aggregate waits for it
 *   PENDING ──recordFailure──▶ DEAD             (terminal) after maxAttempts; stops blocking its aggregate
 *
 * Only the transitions live here; claiming rows (SKIP LOCKED, per-aggregate order) is the repository's job and
 * the database clock decides when a retry is due, so the delay is returned, not turned into a timestamp.
 */
export class OutboxMessage {
  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    private _failedAttempts: number,
    private _publishedAt: Date | null,
    private _deadAt: Date | null,
  ) {}

  static rehydrate(s: OutboxMessageSnapshot): OutboxMessage {
    if (s.publishedAt && s.deadAt) throw new Error(`outbox message ${s.id} cannot be both published and dead`);
    return new OutboxMessage(s.id, s.aggregateId, s.failedAttempts, s.publishedAt, s.deadAt);
  }

  get status(): OutboxStatus {
    return this._publishedAt ? 'PUBLISHED' : this._deadAt ? 'DEAD' : 'PENDING';
  }
  get failedAttempts(): number {
    return this._failedAttempts;
  }

  markPublished(at: Date): void {
    this.assertPending('publish');
    this._publishedAt = at;
  }

  recordFailure(at: Date, policy: OutboxRetryPolicy): FailureResult {
    this.assertPending('fail');
    this._failedAttempts += 1;
    if (this._failedAttempts >= policy.maxAttempts) {
      this._deadAt = at;
      return { type: 'DEAD', failedAttempts: this._failedAttempts };
    }
    return { type: 'RETRY', failedAttempts: this._failedAttempts, delayMs: retryDelayMs(this._failedAttempts, policy) };
  }

  private assertPending(action: string): void {
    if (this.status !== 'PENDING') throw new Error(`cannot ${action} outbox message ${this.id}: it is ${this.status}`);
  }
}

/** base * 2^(attempt-1), capped. `attempt` counts failures, starting at 1. */
export function retryDelayMs(attempt: number, policy: OutboxRetryPolicy): number {
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
}
