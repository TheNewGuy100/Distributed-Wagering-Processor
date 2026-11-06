import type { OutboxRetryPolicy } from '../../domain/outbox-message';

export const OUTBOX_CONFIG = Symbol('OUTBOX_CONFIG');

export interface OutboxConfig {
  enabled: boolean;
  /** Parallel publisher loops per instance (more instances add more on top). */
  publishers: number;
  batchSize: number;
  /** Sleep when the outbox is empty. */
  pollIntervalMs: number;
  shutdownGraceMs: number;
  /** What happens to an event the broker refuses: exponential backoff, then DEAD. */
  retry: OutboxRetryPolicy;
}

const int = (v: string | undefined, d: number): number => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

export function loadOutboxConfig(env: NodeJS.ProcessEnv = process.env): OutboxConfig {
  return {
    enabled: (env.OUTBOX_ENABLED ?? 'true') !== 'false',
    publishers: int(env.OUTBOX_PUBLISHERS, 2),
    // SendMessageBatch accepts at most 10 entries.
    batchSize: Math.min(10, int(env.OUTBOX_BATCH_SIZE, 10)),
    pollIntervalMs: int(env.OUTBOX_POLL_INTERVAL_MS, 300),
    shutdownGraceMs: int(env.OUTBOX_SHUTDOWN_GRACE_MS, 10_000),
    retry: {
      baseDelayMs: int(env.OUTBOX_RETRY_BASE_MS, 1000),
      maxDelayMs: int(env.OUTBOX_RETRY_MAX_MS, 60_000),
      maxAttempts: int(env.OUTBOX_MAX_ATTEMPTS, 20),
    },
  };
}
