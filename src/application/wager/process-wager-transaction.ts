import { EntityManager } from '@mikro-orm/postgresql';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { LogContext } from '../../infrastructure/observability/log-context';
import { MetricsService } from '../../infrastructure/observability/metrics.service';
import { WagerTransaction } from '../../infrastructure/persistence/entities';
import { insertIgnoringConflict } from '../../infrastructure/persistence/orm-helpers';
import { lockWalletByPlayer } from '../../infrastructure/persistence/wallet-repository';
import { ApplicationError, IdempotencyConflictError, WalletNotFoundError } from '../errors';
import { PENDING_CONFIG, type PendingConfig } from './pending-reference.config';
import { settleTransaction } from './settle-transaction';
import {
  findTransactionByExternal,
  findTransactionById,
  toView,
  type WagerTransactionView,
} from './transaction-view';
import type { ProcessWagerCommand } from './wager-command';

export interface ProcessResult {
  transaction: WagerTransactionView;
  idempotentReplay: boolean;
}

export type Source = 'http' | 'sqs';

/**
 * Single use case shared by the HTTP endpoint and the SQS consumer.
 *
 * One SQL transaction does everything: lock the wallet row, claim the idempotency key (unique
 * constraints are the arbiter), decide, append ledger + update balance, record the final status
 * and enqueue outbox events. Nothing is visible, and nothing is published, before commit.
 */
@Injectable()
export class ProcessWagerTransaction {
  private readonly logger = new Logger('Wager');
  private readonly lockConflictMs = Number(process.env.LOCK_CONFLICT_THRESHOLD_MS ?? 25);

  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(PENDING_CONFIG) private readonly pending: PendingConfig,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  async execute(cmd: ProcessWagerCommand): Promise<ProcessResult> {
    const start = performance.now();
    try {
      const result = await this.em.fork().transactional((tx) => this.runWithin(tx, cmd));
      this.observe(result, 'http', start);
      return result;
    } catch (e) {
      this.recordFailure(e, 'http');
      throw e;
    }
  }

  /** Metrics + one structured log line per settled request. Call after the transaction committed. */
  observe(result: ProcessResult, source: Source, startMs: number): void {
    const t = result.transaction;
    const seconds = (performance.now() - startMs) / 1000;
    if (result.idempotentReplay) {
      this.metrics.inc('wager_duplicates_total', { source, layer: 'idempotency' });
    } else {
      this.metrics.inc('wager_transactions_total', { kind: t.kind, status: t.status, source });
    }
    this.metrics.observe('wager_processing_seconds', seconds, { source });
    this.logger.log({
      event: 'wager_settled',
      source,
      kind: t.kind,
      status: t.status,
      failureCode: t.failureCode,
      idempotentReplay: result.idempotentReplay,
      durationMs: Math.round(seconds * 1000),
    });
  }

  recordFailure(e: unknown, source: Source): void {
    const reason = e instanceof ApplicationError ? e.code : 'infrastructure';
    this.metrics.inc('wager_requests_failed_total', { source, reason });
  }

  /** Runs inside the caller's transaction (e.g. the queue consumer, which adds its inbox row to it). */
  async runWithin(tx: EntityManager, cmd: ProcessWagerCommand): Promise<ProcessResult> {
    LogContext.set({ providerId: cmd.providerId });

    // Serializes every balance change of this wallet (other wallets proceed in parallel).
    // Must come before any insert referencing the wallet; see lockWalletByPlayer.
    const lockStart = performance.now();
    const wallet = await lockWalletByPlayer(tx, cmd.playerId, cmd.currency);
    const waitedMs = performance.now() - lockStart;
    this.metrics.observe('wallet_lock_wait_seconds', waitedMs / 1000);
    if (waitedMs >= this.lockConflictMs) this.metrics.inc('wallet_lock_conflicts_total');
    if (!wallet) throw new WalletNotFoundError();
    LogContext.set({ walletId: wallet.id });

    const transactionId = randomUUID();
    // The unique constraints (idempotency key, provider + external id) are the arbiter: a duplicate inserts nothing.
    const claimed = await insertIgnoringConflict(
      tx,
      WagerTransaction,
      {
        id: transactionId,
        providerId: cmd.providerId,
        externalTransactionId: cmd.externalTransactionId,
        idempotencyKey: cmd.idempotencyKey,
        payloadHash: cmd.payloadHash,
        kind: cmd.kind,
        status: 'PENDING',
        playerId: cmd.playerId,
        currency: cmd.currency,
        amount: cmd.amount.toString(),
        roundId: cmd.roundId,
        wallet: wallet.id,
        referenceExternalId: cmd.referenceExternalId,
      },
      'id',
    );
    if (!claimed) return this.replay(tx, cmd);
    LogContext.set({ transactionId });

    await settleTransaction(
      tx,
      wallet,
      {
        transactionId,
        providerId: cmd.providerId,
        externalTransactionId: cmd.externalTransactionId,
        kind: cmd.kind,
        playerId: cmd.playerId,
        currency: cmd.currency,
        amount: cmd.amount,
        roundId: cmd.roundId,
        referenceExternalId: cmd.referenceExternalId,
        fromStatus: 'PENDING',
        retryCount: 0,
      },
      this.pending.policy,
    );

    const row = await findTransactionById(tx, transactionId);
    return { transaction: toView(row!), idempotentReplay: false };
  }

  private async replay(tx: EntityManager, cmd: ProcessWagerCommand): Promise<ProcessResult> {
    const byExternal = await findTransactionByExternal(tx, cmd.providerId, cmd.externalTransactionId);
    if (byExternal) {
      if (byExternal.idempotencyKey !== cmd.idempotencyKey || byExternal.payloadHash !== cmd.payloadHash) {
        this.metrics.inc('wager_idempotency_conflicts_total');
        throw new IdempotencyConflictError();
      }
      LogContext.set({ transactionId: byExternal.id });
      return { transaction: toView(byExternal), idempotentReplay: true };
    }
    // The conflict was on the idempotency key itself, reused by a different transaction.
    this.metrics.inc('wager_idempotency_conflicts_total');
    throw new IdempotencyConflictError('Idempotency-Key already used by a different transaction');
  }
}
