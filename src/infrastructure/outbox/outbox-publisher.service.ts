import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { EntityManager, LockMode, raw } from '@mikro-orm/postgresql';
import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { OutboxMessage } from '../../domain/outbox-message';
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
    // Cancel the grace timer when the loops finish, or it keeps the process alive for the whole grace period.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.config.shutdownGraceMs);
    });
    const result = await Promise.race([
      Promise.allSettled(this.loops).then(() => 'drained' as const),
      grace.then(() => 'timeout' as const),
    ]).finally(() => clearTimeout(timer));
    this.logger.log({ event: 'shutdown', component: 'outbox-publisher', result });
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
    const stats = { claimed: 0, sent: 0, failed: 0, dead: 0 };
    await this.em.fork().transactional(async (tx) => {
      // Heads: the first live event of each aggregate that is due (never tried, or its backoff elapsed), skipping rows
      // another publisher holds. The correlated NOT EXISTS is the one raw fragment: the query builder has no
      // vocabulary for a self-correlated anti-join. Published and DEAD events no longer hold their aggregate back.
      const heads = await tx
        .createQueryBuilder(OutboxEvent, 'o')
        .select('*')
        .where({ publishedAt: null, deadAt: null })
        .andWhere(raw('(o.next_attempt_at is null or o.next_attempt_at <= now())'))
        .andWhere(
          raw(
            'not exists (select 1 from outbox_events p where p.aggregate_id = o.aggregate_id and p.published_at is null and p.dead_at is null and p.seq < o.seq)',
          ),
        )
        .orderBy({ seq: 'asc' })
        .limit(this.config.batchSize)
        .setLockMode(LockMode.PESSIMISTIC_PARTIAL_WRITE)
        .getResultList();
      if (heads.length === 0) return;

      // Holding a head keeps every later event of that aggregate unclaimable by others, so the followers need no lock
      // of their own: they ride in the same batch, in order, which lets a hot wallet drain faster than one event per
      // cycle. A global seq order keeps an in-order prefix of every aggregate when the batch is cut at 10 entries.
      const headSeq = new Map(heads.map((h) => [h.aggregateId, BigInt(h.seq)]));
      const later = await tx.find(
        OutboxEvent,
        { aggregateId: { $in: [...headSeq.keys()] }, publishedAt: null, deadAt: null },
        { orderBy: { seq: 'asc' } },
      );
      const followers = later.filter((r) => BigInt(r.seq) > headSeq.get(r.aggregateId)!);
      const rows = [...heads, ...followers].sort((x, y) => (BigInt(x.seq) < BigInt(y.seq) ? -1 : 1)).slice(0, 10);
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

      // A refused event holds back the later events of its aggregate even if the broker took them (they are sent again
      // after it, protected by the dedup id), so consumers still see each wallet's events in order.
      const refused = new Map(
        (res.Failed ?? []).map((f) => [Number(f.Id), `${f.Code ?? 'ERROR'}: ${f.Message ?? ''}`.slice(0, 500)]),
      );
      const blocked = new Set<string>();
      const sentIds: string[] = [];
      for (const [i, row] of rows.entries()) {
        const message = OutboxMessage.rehydrate({
          id: row.id,
          aggregateId: row.aggregateId,
          failedAttempts: row.attempts,
          publishedAt: null,
          deadAt: null,
        });
        if (refused.has(i)) {
          blocked.add(row.aggregateId);
          stats.failed++;
          const error = refused.get(i)!;
          const outcome = message.recordFailure(new Date(), this.config.retry);
          if (outcome.type === 'DEAD') {
            stats.dead++;
            this.logger.error({
              event: 'outbox_event_dead',
              eventId: row.id,
              aggregateId: row.aggregateId,
              eventType: row.eventType,
              error,
            });
            await tx.nativeUpdate(
              OutboxEvent,
              { id: row.id },
              { attempts: outcome.failedAttempts, lastError: error, deadAt: raw('now()') as never },
            );
          } else {
            // The due time is stamped by the database clock, the same one that decides when it is claimable.
            await tx.nativeUpdate(
              OutboxEvent,
              { id: row.id },
              {
                attempts: outcome.failedAttempts,
                lastError: error,
                nextAttemptAt: raw("now() + ? * interval '1 millisecond'", [outcome.delayMs]) as never,
              },
            );
          }
        } else if (!blocked.has(row.aggregateId)) {
          message.markPublished(new Date());
          sentIds.push(row.id);
        }
      }
      stats.sent = sentIds.length;
      if (sentIds.length > 0) {
        await tx.nativeUpdate(OutboxEvent, { id: { $in: sentIds } }, { publishedAt: raw('now()') as never });
      }

      await this.hooks.afterSend?.(sentIds); // a throw here rolls everything back: rows get re-sent
    });
    // Counted only once the transaction committed.
    if (stats.sent > 0) this.metrics.inc('outbox_events_published_total', undefined, stats.sent);
    if (stats.failed > 0) this.metrics.inc('outbox_publish_failures_total', undefined, stats.failed);
    if (stats.dead > 0) this.metrics.inc('outbox_events_dead_total', undefined, stats.dead);
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
