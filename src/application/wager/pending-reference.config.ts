import type { PendingReferencePolicy } from '../../domain/wager-transaction';

export const PENDING_CONFIG = Symbol('PENDING_CONFIG');

export interface PendingConfig {
  enabled: boolean;
  intervalMs: number;
  batchSize: number;
  policy: PendingReferencePolicy;
}

const int = (v: string | undefined, d: number): number => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

export function loadPendingConfig(env: NodeJS.ProcessEnv = process.env): PendingConfig {
  return {
    enabled: (env.PENDING_WORKER_ENABLED ?? 'true') !== 'false',
    intervalMs: int(env.PENDING_WORKER_INTERVAL_MS, 1000),
    batchSize: int(env.PENDING_WORKER_BATCH_SIZE, 50),
    policy: {
      maxRetries: int(env.PENDING_MAX_RETRIES, 8),
      baseDelayMs: int(env.PENDING_BASE_DELAY_MS, 1000),
      maxDelayMs: int(env.PENDING_MAX_DELAY_MS, 5 * 60_000),
    },
  };
}
