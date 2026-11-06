import { EntityManager } from '@mikro-orm/postgresql';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DomainError } from '../../domain/errors';
import { IdempotencyConflictError, ValidationError, WalletNotFoundError } from '../errors';
import { MetricsService } from '../../infrastructure/observability/metrics.service';
import { ProcessWagerTransaction, type ProcessResult } from './process-wager-transaction';
import { parseWagerCommand } from './wager-command';

export const CONSUMER_NAME = 'wager-transactions';

export type MessageOutcome =
  | { kind: 'ACK'; reason: 'processed' | 'duplicate' | 'business'; status?: string }
  | { kind: 'DLQ'; reason: string }
  | { kind: 'RETRY'; reason: string };

/** Test seam: lets a test simulate a worker dying right after commit and before the ack. */
@Injectable()
export class ConsumerHooks {
  afterCommit?: (messageId: string) => void | Promise<void>;
}

export interface InboundMessage {
  messageId: string;
  body: string;
}

const isTransientInfra = (e: unknown): boolean => {
  const code = (e as { code?: unknown })?.code;
  const c = typeof code === 'string' ? code : '';
  return /^(08|40|53|57)/.test(c) || c === '55P03' || /^(ECONN|ETIMEDOUT|EPIPE|ENOTFOUND)/.test(c);
};

/**
 * Turns one queue message into at most one effect. The inbox row and the financial change share a
 * single SQL transaction, so a message is either fully applied and recorded, or not at all.
 *
 *  - ACK:   applied, already applied (inbox hit), or a business error that retrying cannot fix
 *  - DLQ:   poison message (unparseable / invalid), never retried
 *  - RETRY: transient failure; the consumer delays redelivery with exponential backoff
 */
@Injectable()
export class WagerMessageHandler {
  private readonly logger = new Logger(WagerMessageHandler.name);

  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(ProcessWagerTransaction) private readonly processor: ProcessWagerTransaction,
    @Inject(ConsumerHooks) private readonly hooks: ConsumerHooks,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  async handle(msg: InboundMessage): Promise<MessageOutcome> {
    let cmd;
    try {
      cmd = parseWagerCommand(JSON.parse(msg.body));
    } catch (e) {
      return { kind: 'DLQ', reason: e instanceof ValidationError ? e.message : 'malformed message body' };
    }

    let outcome: MessageOutcome;
    const start = performance.now();
    let settled: ProcessResult | null = null;
    try {
      outcome = await this.em.fork().transactional(async (tx) => {
        const claimed = await tx.execute<{ message_id: string }[]>(
          `insert into inbox_messages (consumer, message_id) values (?, ?)
           on conflict do nothing returning message_id`,
          [CONSUMER_NAME, msg.messageId],
        );
        if (claimed.length === 0) return { kind: 'ACK', reason: 'duplicate' } as const;
        const result = await this.processor.runWithin(tx, cmd);
        settled = result;
        return { kind: 'ACK', reason: 'processed', status: result.transaction.status } as const;
      });
    } catch (e) {
      this.processor.recordFailure(e, 'sqs');
      return this.classify(e, msg);
    }

    if (outcome.kind === 'ACK' && outcome.reason === 'duplicate') {
      this.metrics.inc('wager_duplicates_total', { source: 'sqs', layer: 'inbox' });
    } else if (settled) {
      this.processor.observe(settled, 'sqs', start);
    }

    // Committed. A crash from here on is exactly the "worker died before ack" case.
    await this.hooks.afterCommit?.(msg.messageId);
    return outcome;
  }

  private classify(e: unknown, msg: InboundMessage): MessageOutcome {
    if (e instanceof ValidationError) return { kind: 'DLQ', reason: e.message };
    if (e instanceof IdempotencyConflictError || e instanceof DomainError) {
      this.logger.warn(`business error for message ${msg.messageId}: ${(e as Error).message}`);
      return { kind: 'ACK', reason: 'business' };
    }
    // Wallet not found may just mean the wallet is not created yet: retry, DLQ after the limit.
    if (e instanceof WalletNotFoundError) return { kind: 'RETRY', reason: 'wallet not found' };
    this.logger.warn(
      `${isTransientInfra(e) ? 'transient' : 'unexpected'} failure for message ${msg.messageId}: ${(e as Error)?.message}`,
    );
    // Unknown errors are retried too: losing a financial message silently is worse than a late DLQ.
    return { kind: 'RETRY', reason: (e as Error)?.message ?? 'unknown error' };
  }
}
