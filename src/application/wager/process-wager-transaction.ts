import { EntityManager } from '@mikro-orm/postgresql';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { LogContext } from '../../infrastructure/observability/log-context';
import { MetricsService } from '../../infrastructure/observability/metrics.service';
import { WagerTransaction } from '../../infrastructure/persistence/entities';
import { insertIgnoringConflict } from '../../infrastructure/persistence/orm-helpers';
import { lockWalletById } from '../../infrastructure/persistence/wallet-repository';
import { FailureCode } from '../../domain/errors';
import { assertTransition } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import { ApplicationError, IdempotencyConflictError, ValidationError, WalletNotFoundError } from '../errors';
import { PENDING_CONFIG, type PendingConfig } from './pending-reference.config';
import { settleTransaction } from './settle-transaction';
import { findTransactionByExternal, toView, type TransactionRow, type WagerTransactionView } from './transaction-view';
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
    const wallet = await lockWalletById(tx, cmd.walletId);
    const waitedMs = performance.now() - lockStart;
    this.metrics.observe('wallet_lock_wait_seconds', waitedMs / 1000);
    if (waitedMs >= this.lockConflictMs) this.metrics.inc('wallet_lock_conflicts_total');
    if (!wallet) throw new WalletNotFoundError();
    LogContext.set({ walletId: wallet.id });
    // The wallet in the payload must belong to the player in the payload (a currency mismatch is a business rejection).
    if (wallet.playerId !== cmd.playerId) throw new ValidationError('walletId does not belong to playerId');

    const transactionId = randomUUID();
    // Timestamps come from the application clock so the response can be built without reading the row back
    // (they are informational; ordering and retry scheduling never depend on created_at/updated_at).
    const createdAt = new Date();
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
        gameId: cmd.gameId,
        wallet: wallet.id,
        referenceExternalId: cmd.referenceExternalId,
        createdAt,
        updatedAt: createdAt,
      },
      'id',
    );
    if (!claimed) return this.replay(tx, wallet, cmd);
    LogContext.set({ transactionId });
    return this.settle(tx, wallet, transactionId, cmd, createdAt);
  }

  /** Decides and persists one claimed transaction (a new one, or a FAILED one reopened) and builds the response. */
  private async settle(
    tx: EntityManager,
    wallet: Wallet,
    transactionId: string,
    cmd: ProcessWagerCommand,
    createdAt: Date,
  ): Promise<ProcessResult> {
    const outcome = await settleTransaction(
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
        gameId: cmd.gameId,
        referenceExternalId: cmd.referenceExternalId,
        fromStatus: 'PENDING',
        retryCount: 0,
      },
      this.pending.policy,
    );

    // Everything in the response is already known: no read-back round trip.
    return {
      transaction: {
        transactionId,
        providerId: cmd.providerId,
        externalTransactionId: cmd.externalTransactionId,
        kind: cmd.kind,
        status: outcome.status,
        playerId: cmd.playerId,
        walletId: wallet.id,
        money: { amount: cmd.amount.toString(), currency: cmd.currency },
        balance: { amount: outcome.balance.toString(), currency: wallet.currency },
        roundId: cmd.roundId,
        gameId: outcome.gameId,
        referenceExternalTransactionId: cmd.referenceExternalId,
        failureCode: outcome.failureCode,
        retryCount: outcome.retryCount,
        nextRetryAt: outcome.nextRetryAt ? outcome.nextRetryAt.toISOString() : null,
        createdAt: createdAt.toISOString(),
        updatedAt: outcome.updatedAt.toISOString(),
      },
      idempotentReplay: false,
    };
  }

  /**
   * Gives up on a request whose processing kept failing for technical reasons (the queue consumer calls this just
   * before dead-lettering): the provider then sees a definite FAILED instead of "unknown". No ledger entry, no balance
   * change. A resend of the same request reopens it (see `reopen`). Best effort and idempotent.
   */
  async recordFailed(cmd: ProcessWagerCommand): Promise<boolean> {
    const recorded = await this.em.fork().transactional(async (tx) => {
      const wallet = await lockWalletById(tx, cmd.walletId); // wallet first, as everywhere (null: it never existed)
      const own = wallet && wallet.playerId === cmd.playerId ? wallet : null;
      const now = new Date();
      return insertIgnoringConflict(
        tx,
        WagerTransaction,
        {
          id: randomUUID(),
          providerId: cmd.providerId,
          externalTransactionId: cmd.externalTransactionId,
          idempotencyKey: cmd.idempotencyKey,
          payloadHash: cmd.payloadHash,
          kind: cmd.kind,
          status: 'FAILED',
          failureCode: FailureCode.ProcessingFailed,
          playerId: cmd.playerId,
          currency: cmd.currency,
          amount: cmd.amount.toString(),
          roundId: cmd.roundId,
          gameId: cmd.gameId,
          wallet: own?.id ?? null,
          balanceAfter: own ? own.balance.toString() : null,
          referenceExternalId: cmd.referenceExternalId,
          createdAt: now,
          updatedAt: now,
        },
        'id',
      );
    });
    if (recorded) this.metrics.inc('wager_transactions_total', { kind: cmd.kind, status: 'FAILED', source: 'sqs' });
    return recorded;
  }

  /** A resend of the very same request (same key, same payload) after a FAILED: run it again from PENDING. */
  private async reopen(
    tx: EntityManager,
    wallet: Wallet,
    failed: TransactionRow,
    cmd: ProcessWagerCommand,
  ): Promise<ProcessResult> {
    assertTransition('FAILED', 'PENDING');
    await tx.nativeUpdate(
      WagerTransaction,
      { id: failed.id },
      { status: 'PENDING', failureCode: null, wallet: wallet.id, balanceAfter: null, updatedAt: new Date() },
    );
    LogContext.set({ transactionId: failed.id });
    this.metrics.inc('wager_failed_reopened_total');
    return this.settle(tx, wallet, failed.id, cmd, new Date(failed.createdAt));
  }

  private async replay(tx: EntityManager, wallet: Wallet, cmd: ProcessWagerCommand): Promise<ProcessResult> {
    const byExternal = await findTransactionByExternal(tx, cmd.providerId, cmd.externalTransactionId);
    if (byExternal) {
      if (byExternal.idempotencyKey !== cmd.idempotencyKey || byExternal.payloadHash !== cmd.payloadHash) {
        this.metrics.inc('wager_idempotency_conflicts_total');
        throw new IdempotencyConflictError();
      }
      if (byExternal.status === 'FAILED') return this.reopen(tx, wallet, byExternal, cmd);
      LogContext.set({ transactionId: byExternal.id });
      return { transaction: toView(byExternal), idempotentReplay: true };
    }
    // The conflict was on the idempotency key itself, reused by a different transaction.
    this.metrics.inc('wager_idempotency_conflicts_total');
    throw new IdempotencyConflictError('Idempotency-Key already used by a different transaction');
  }
}
