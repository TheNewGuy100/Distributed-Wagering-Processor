import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { EntityManager, LockMode, raw } from '@mikro-orm/postgresql';
import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { MetricsService } from '../observability/metrics.service';
import { OutboxEvent } from '../persistence/entities';
import { SqsQueues } from '../sqs/sqs-queues.service';
import { OUTBOX_CONFIG, type OutboxConfig } from './outbox.config';

/** Test seam: simulate a publisher dying after the broker accepted the batch but before commit. */
@Injectable()
export class OutboxHooks {
  afterSend?: (eventIds: string[]) => void | Promise<void>;
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
      // Only the head of each aggregate is claimable (no earlier unpublished event of the same aggregate), and
      // rows another publisher already holds are skipped. The correlated NOT EXISTS is the one raw fragment: the
      // query builder has no vocabulary for a self-correlated anti-join.
      const rows = await tx
        .createQueryBuilder(OutboxEvent, 'o')
        .select('*')
        .where({ publishedAt: null })
        .andWhere(
          raw(
            'not exists (select 1 from outbox_events p where p.aggregate_id = o.aggregate_id and p.published_at is null and p.seq < o.seq)',
          ),
        )
        .orderBy({ seq: 'asc' })
        .limit(this.config.batchSize)
        .setLockMode(LockMode.PESSIMISTIC_PARTIAL_WRITE)
        .getResultList();
      if (rows.length === 0) return;
      stats.claimed = rows.length;

      const res = await this.queues.client.send(
        new SendMessageBatchCommand({
          QueueUrl: this.queues.eventsUrl,
          Entries: rows.map((r, i) => ({
            Id: String(i),
            MessageBody: JSON.stringify(r.payload),
            MessageGroupId: r.aggregateId,
            MessageDeduplicationId: r.id,
            MessageAttributes: { eventType: { DataType: 'String', StringValue: r.eventType } },
          })),
        }),
      );

      const sentIds = (res.Successful ?? []).map((s) => rows[Number(s.Id)]!.id);
      stats.sent = sentIds.length;
      stats.failed = (res.Failed ?? []).length;
      if (sentIds.length > 0) {
        await tx.nativeUpdate(
          OutboxEvent,
          { id: { $in: sentIds } },
          { publishedAt: raw('now()') as never, attempts: raw('attempts + 1') as never },
        );
      }
      for (const f of res.Failed ?? []) {
        await tx.nativeUpdate(
          OutboxEvent,
          { id: rows[Number(f.Id)]!.id },
          { attempts: raw('attempts + 1') as never, lastError: `${f.Code ?? 'ERROR'}: ${f.Message ?? ''}`.slice(0, 500) },
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
