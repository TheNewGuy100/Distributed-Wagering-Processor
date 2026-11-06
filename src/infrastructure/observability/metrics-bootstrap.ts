import { EntityManager } from '@mikro-orm/postgresql';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { MetricsService } from './metrics.service';

/** Declares every metric (help text) and the gauges that are read from the database at scrape time. */
@Injectable()
export class MetricsBootstrap implements OnModuleInit {
  constructor(
    @Inject(MetricsService) private readonly metrics: MetricsService,
    @Inject(EntityManager) private readonly em: EntityManager,
  ) {}

  onModuleInit(): void {
    const m = this.metrics;
    m.describe('wager_transactions_total', 'Wager transactions by kind and resulting status (excludes replays)');
    m.describe('wager_duplicates_total', 'Duplicate deliveries absorbed by idempotency or the inbox');
    m.describe('wager_idempotency_conflicts_total', 'Same key or external id reused with a different payload');
    m.describe('wager_requests_failed_total', 'Wager requests that ended in an error, by reason');
    m.describe('wager_processing_seconds', 'End-to-end processing latency of a wager transaction');
    m.describe('wallet_lock_wait_seconds', 'Time spent waiting for the wallet row lock');
    m.describe('wallet_lock_conflicts_total', 'Wallet lock acquisitions that had to wait (contention)');
    m.describe('sqs_messages_total', 'Consumed SQS messages by outcome');
    m.describe('sqs_retries_total', 'Messages scheduled for retry after a transient failure');
    m.describe('sqs_dead_letter_total', 'Messages moved to the DLQ, by class of reason');
    m.describe('pending_reference_retries_total', 'Pending-reference re-evaluations by result');
    m.describe('outbox_events_published_total', 'Outbox events published to the events queue');
    m.describe('outbox_publish_failures_total', 'Outbox events the broker refused (will be retried)');
    m.describe('transient_infra_errors_total', 'Transient infrastructure errors surfaced as HTTP 503');

    m.gauge('outbox_unpublished_events', 'Committed outbox events not yet published', async () => {
      const [r] = await this.em.fork().execute<{ c: number }[]>(
        'select count(*)::int as c from outbox_events where published_at is null',
      );
      return [{ value: r?.c ?? 0 }];
    });
    m.gauge('outbox_lag_seconds', 'Age of the oldest unpublished outbox event (0 when empty)', async () => {
      const [r] = await this.em.fork().execute<{ age: number }[]>(
        `select coalesce(extract(epoch from (now() - min(created_at))), 0)::float8 as age
           from outbox_events where published_at is null`,
      );
      return [{ value: Math.round((r?.age ?? 0) * 1000) / 1000 }];
    });
    m.gauge('pending_reference_transactions', 'Transactions currently waiting for their reference', async () => {
      const [r] = await this.em.fork().execute<{ c: number }[]>(
        `select count(*)::int as c from wager_transactions where status = 'PENDING_REFERENCE'`,
      );
      return [{ value: r?.c ?? 0 }];
    });
    m.gauge('wallets_flagged', 'Wallets flagged by reconciliation', async () => {
      const [r] = await this.em.fork().execute<{ c: number }[]>(
        'select count(*)::int as c from wallets where flagged_at is not null',
      );
      return [{ value: r?.c ?? 0 }];
    });
  }
}
