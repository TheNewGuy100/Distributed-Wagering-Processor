export const SQS_CONFIG = Symbol('SQS_CONFIG');
export const SQS_CLIENT = Symbol('SQS_CLIENT');

export interface SqsConfig {
  region: string;
  endpoint: string | undefined;
  queueName: string;
  dlqName: string;
  /** FIFO queue the outbox publisher writes domain events to. */
  eventsQueueName: string;
  consumerEnabled: boolean;
  /** Parallel long-poll loops per instance. */
  concurrency: number;
  /** After this many deliveries a failing message goes to the DLQ. */
  maxReceiveCount: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
  visibilityTimeoutSeconds: number;
  waitTimeSeconds: number;
  /** How long shutdown waits for in-flight messages before giving up. */
  shutdownGraceMs: number;
}

const int = (v: string | undefined, d: number): number => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

export function loadSqsConfig(env: NodeJS.ProcessEnv = process.env): SqsConfig {
  return {
    region: env.AWS_REGION ?? 'us-east-1',
    endpoint: env.AWS_ENDPOINT_URL,
    queueName: env.SQS_QUEUE_NAME ?? 'wager-transactions.fifo',
    dlqName: env.SQS_DLQ_NAME ?? 'wager-transactions-dlq.fifo',
    eventsQueueName: env.SQS_EVENTS_QUEUE_NAME ?? 'wager-events.fifo',
    consumerEnabled: (env.SQS_CONSUMER_ENABLED ?? 'true') !== 'false',
    concurrency: int(env.SQS_CONSUMER_CONCURRENCY, 4),
    maxReceiveCount: int(env.SQS_MAX_RECEIVE_COUNT, 5),
    retryBaseSeconds: int(env.SQS_RETRY_BASE_SECONDS, 2),
    retryMaxSeconds: int(env.SQS_RETRY_MAX_SECONDS, 300),
    visibilityTimeoutSeconds: int(env.SQS_VISIBILITY_TIMEOUT_SECONDS, 30),
    waitTimeSeconds: int(env.SQS_WAIT_TIME_SECONDS, 5),
    shutdownGraceMs: int(env.SQS_SHUTDOWN_GRACE_MS, 20_000),
  };
}
