import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { MetricsService } from '../observability/metrics.service';
import { SqsQueues } from '../sqs/sqs-queues.service';
import { OUTBOX_CONFIG, type OutboxConfig } from './outbox.config';

/** Test seam: simulate a publisher dying after the broker accepted the batch but before commit. */
@Injectable()
export class OutboxHooks {
  afterSend?: (eventIds: string[]) => void | Promise<void>;
}

interface OutboxRow {
  seq: string;
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
}

/**
 * Transactional-outbox relay. Any number of publishers (loops and instances) can run at once:
 *
 *  - rows are claimed with `FOR UPDATE SKIP LOCKED`, so two publishers never take the same row;
 *  - an event is only claimable when no earlier unpublished event of its aggregate exists, which
 *    keeps per-aggregate order even though rows are spread across publishers;
 *  - `published_at` is written in the same transaction that holds the claim. If a publisher dies
 *    after sending but before commit, the row stays unpublished and is sent again (at-least-once);
 *    the FIFO MessageDeduplicationId (= event id) and the event id let consumers discard repeats;
 *  - only committed rows are visible, so nothing is published before its business commit.
 */
@Injectable()
export class OutboxPublisher implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(OutboxPublisher.name);
  private stopping = false;
  private loops: Promise<void>[] = [];
  private readonly wakers = new Set<() => void>();

  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(SqsQueues) private readonly queues: SqsQueues,
    @Inject(OUTBOX_CONFIG) private readonly config: OutboxConfig,
    @Inject(OutboxHooks) private readonly hooks: OutboxHooks,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.enabled) {
      this.logger.log('outbox publisher disabled (OUTBOX_ENABLED=false)');
      return;
    }
    this.loops = Array.from({ length: this.config.publishers }, () => this.run());
    this.logger.log(`outbox publisher started with ${this.config.publishers} loops`);
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.loops.length === 0) return;
    this.stopping = true;
    for (const w of this.wakers) w();
    await Promise.race([
      Promise.allSettled(this.loops),
      new Promise<void>((r) => setTimeout(r, this.config.shutdownGraceMs)),
    ]);
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        const published = await this.publishOnce();
        if (published === 0) await this.sleep(this.config.pollIntervalMs);
      } catch (e) {
        this.logger.warn(`outbox cycle failed, will retry: ${(e as Error).message}`);
        await this.sleep(1000);
      }
    }
  }

  /** One claim → send → mark cycle. Returns how many rows it claimed. */
  async publishOnce(): Promise<number> {
    const stats = { claimed: 0, sent: 0, failed: 0 };
    await this.em.fork().transactional(async (tx) => {
      const rows = await tx.execute<OutboxRow[]>(
        `select o.seq, o.id, o.aggregate_id, o.event_type, o.payload
           from outbox_events o
          where o.published_at is null
            and not exists (
              select 1 from outbox_events p
               where p.aggregate_id = o.aggregate_id and p.published_at is null and p.seq < o.seq)
          order by o.seq
          limit ?
          for update of o skip locked`,
        [this.config.batchSize],
      );
      if (rows.length === 0) return;
      stats.claimed = rows.length;

      const res = await this.queues.client.send(
        new SendMessageBatchCommand({
          QueueUrl: this.queues.eventsUrl,
          Entries: rows.map((r, i) => ({
            Id: String(i),
            MessageBody: JSON.stringify(r.payload),
            MessageGroupId: r.aggregate_id,
            MessageDeduplicationId: r.id,
            MessageAttributes: { eventType: { DataType: 'String', StringValue: r.event_type } },
          })),
        }),
      );

      const sentIds = (res.Successful ?? []).map((s) => rows[Number(s.Id)]!.id);
      stats.sent = sentIds.length;
      stats.failed = (res.Failed ?? []).length;
      if (sentIds.length > 0) {
        await tx.execute(
          `update outbox_events set published_at = now(), attempts = attempts + 1
            where id in (${sentIds.map(() => '?').join(',')})`,
          sentIds,
        );
      }
      for (const f of res.Failed ?? []) {
        await tx.execute(
          'update outbox_events set attempts = attempts + 1, last_error = ? where id = ?',
          [`${f.Code ?? 'ERROR'}: ${f.Message ?? ''}`.slice(0, 500), rows[Number(f.Id)]!.id],
        );
      }

      await this.hooks.afterSend?.(sentIds); // a throw here rolls everything back: rows get re-sent
    });
    // Counted only once the transaction committed.
    if (stats.sent > 0) this.metrics.inc('outbox_events_published_total', undefined, stats.sent);
    if (stats.failed > 0) this.metrics.inc('outbox_publish_failures_total', undefined, stats.failed);
    return stats.claimed;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wakers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wakers.add(done);
      if (this.stopping) done();
    });
  }
}
