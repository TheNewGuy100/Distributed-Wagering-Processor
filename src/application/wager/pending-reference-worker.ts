import { EntityManager, LockMode, raw } from '@mikro-orm/postgresql';
import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { Money } from '../../domain/money';
import type { TransactionKind } from '../../domain/wager-rules';
import { LogContext } from '../../infrastructure/observability/log-context';
import { MetricsService } from '../../infrastructure/observability/metrics.service';
import { WagerTransaction } from '../../infrastructure/persistence/entities';
import { lockWalletById } from '../../infrastructure/persistence/wallet-repository';
import { PENDING_CONFIG, type PendingConfig } from './pending-reference.config';
import { settleTransaction } from './settle-transaction';

/**
 * Re-evaluates REFUND/ROLLBACK transactions that arrived before the transaction they reverse.
 * Safe to run on any number of instances: each due row is handled inside a transaction that first
 * locks the wallet and then claims the row with SKIP LOCKED, so one instance wins and the rest move on.
 */
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private stopping = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(PENDING_CONFIG) private readonly config: PendingConfig,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.enabled) {
      this.logger.log('pending-reference worker disabled (PENDING_WORKER_ENABLED=false)');
      return;
    }
    this.loop = this.run();
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (!this.loop) return;
    this.stopping = true;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      let handled = 0;
      try {
        handled = await this.processDue();
      } catch (e) {
        this.logger.warn(`pending-reference cycle failed: ${(e as Error).message}`);
      }
      if (handled === 0) await this.sleep(this.config.intervalMs);
    }
  }

  /** Handles every currently due transaction; returns how many it actually settled or rescheduled. */
  async processDue(): Promise<number> {
    // "Due" is judged by the database clock (now()), the same clock that stores next_retry_at ordering.
    const due = await this.em.fork().find(
      WagerTransaction,
      { status: 'PENDING_REFERENCE', nextRetryAt: { $lte: raw('now()') as never } },
      { fields: ['id', 'wallet', 'correlationId'], orderBy: { nextRetryAt: 'asc' }, limit: this.config.batchSize },
    );
    let handled = 0;
    for (const d of due) {
      if (this.stopping) break;
      try {
        if (d.wallet && (await this.retryOne(d.id, d.wallet, d.correlationId ?? null))) handled++;
      } catch (e) {
        this.logger.warn(`retry of ${d.id} failed, will be picked up again: ${(e as Error).message}`);
      }
    }
    return handled;
  }

  private retryOne(transactionId: string, walletId: string, correlationId: string | null): Promise<boolean> {
    // Keep the trace of the request that created the transaction, so its retries and their events share its correlation id.
    return LogContext.run({ transactionId, walletId, correlationId: correlationId ?? `pending:${transactionId}` }, () =>
      this.retryOneInContext(transactionId, walletId),
    );
  }

  private retryOneInContext(transactionId: string, walletId: string): Promise<boolean> {
    return this.em.fork().transactional(async (tx) => {
      const wallet = await lockWalletById(tx, walletId); // wallet first, always (same order as the main path)
      if (!wallet) return false;
      // SKIP LOCKED: if another worker/instance already holds this row, move on instead of waiting.
      const row = await tx.findOne(
        WagerTransaction,
        { id: transactionId, status: 'PENDING_REFERENCE', nextRetryAt: { $lte: raw('now()') as never } },
        { lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, refresh: true },
      );
      if (!row) return false; // already handled by another worker/instance

      const outcome = await settleTransaction(
        tx,
        wallet,
        {
          transactionId: row.id,
          providerId: row.providerId,
          externalTransactionId: row.externalTransactionId,
          kind: row.kind as TransactionKind,
          playerId: row.playerId,
          currency: row.currency,
          amount: Money.parse(row.amount, row.currency),
          roundId: row.roundId ?? null,
          gameId: row.gameId ?? null,
          referenceExternalId: row.referenceExternalId ?? null,
          fromStatus: 'PENDING_REFERENCE',
          retryCount: row.retryCount,
        },
        this.config.policy,
      );
      const result =
        outcome.status === 'PENDING_REFERENCE' ? 'rescheduled' : outcome.status === 'PROCESSED' ? 'processed' : 'rejected';
      this.metrics.inc('pending_reference_retries_total', { result });
      this.logger.log({ event: 'pending_reference_retry', result, failureCode: outcome.failureCode });
      return true;
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
