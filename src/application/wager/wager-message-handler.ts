import { EntityManager } from '@mikro-orm/postgresql';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DomainError } from '../../domain/errors';
import { IdempotencyConflictError, ValidationError, WalletNotFoundError } from '../errors';
import { asObject, requiredString } from '../validation';
import { LogContext } from '../../infrastructure/observability/log-context';
import { MetricsService } from '../../infrastructure/observability/metrics.service';
import { InboxMessage } from '../../domain/inbox-message';
import { InboxRepository } from '../inbox.repository';
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

export const MESSAGE_TYPE = 'WagerTransactionRequested';

/**
 * Queue message envelope: `{ messageId, type, occurredAt, data }`. The business `messageId` (not the broker's) is the
 * inbox key, so a producer that re-sends the same logical message with a new broker id is still deduplicated.
 */
function parseEnvelope(raw: unknown): { messageId: string; type: string; data: Record<string, unknown> } {
  const o = asObject(raw);
  const messageId = requiredString(o, 'messageId', 255);
  if (o.type !== MESSAGE_TYPE) throw new ValidationError(`type must be ${MESSAGE_TYPE}`);
  return { messageId, type: MESSAGE_TYPE, data: asObject(o.data) };
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
    @Inject(InboxRepository) private readonly inbox: InboxRepository,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  async handle(msg: InboundMessage): Promise<MessageOutcome> {
    let cmd;
    let inboxId: string;
    let received: InboxMessage;
    try {
      const env = parseEnvelope(JSON.parse(msg.body));
      inboxId = env.messageId;
      received = InboxMessage.receive(CONSUMER_NAME, env.messageId, { type: env.type, data: env.data });
      const data = env.data;
      cmd = parseWagerCommand(data, typeof data.idempotencyKey === 'string' ? data.idempotencyKey : undefined);
    } catch (e) {
      return { kind: 'DLQ', reason: e instanceof ValidationError ? e.message : 'malformed message body' };
    }
    LogContext.set({ messageId: inboxId });

    let outcome: MessageOutcome;
    const start = performance.now();
    let settled: ProcessResult | null = null;
    try {
      outcome = await this.em.fork().transactional(async (tx) => {
        // The inbox primary key (consumer, message id) decides: a redelivered message inserts nothing.
        const verdict = await this.inbox.record(tx, received);
        if (verdict === 'DUPLICATE') return { kind: 'ACK', reason: 'duplicate' } as const;
        // Same message id, different content: a producer bug. Applying or swallowing it would both be wrong.
        if (verdict === 'PAYLOAD_CONFLICT') {
          return { kind: 'DLQ', reason: 'messageId reused with a different payload' } as const;
        }
        const result = await this.processor.runWithin(tx, cmd);
        settled = result;
        return { kind: 'ACK', reason: 'processed', status: result.transaction.status } as const;
      });
    } catch (e) {
      this.processor.recordFailure(e, 'sqs');
      return this.classify(e, msg);
    }

    if (outcome.kind === 'DLQ') {
      this.metrics.inc('inbox_payload_conflicts_total'); // the only DLQ verdict decided inside the transaction
      return outcome;
    }
    if (outcome.kind === 'ACK' && outcome.reason === 'duplicate') {
      this.metrics.inc('wager_duplicates_total', { source: 'sqs', layer: 'inbox' });
    } else if (settled) {
      this.processor.observe(settled, 'sqs', start);
    }

    // Committed. A crash from here on is exactly the "worker died before ack" case.
    await this.hooks.afterCommit?.(inboxId);
    return outcome;
  }

  /**
   * Called by the consumer just before it dead-letters a message whose retries ran out. When the message is a valid
   * wager command, it is recorded as FAILED so the provider gets a definite answer; never throws (the message goes to
   * the DLQ regardless).
   */
  async recordExhausted(msg: InboundMessage): Promise<void> {
    try {
      const env = parseEnvelope(JSON.parse(msg.body));
      const data = env.data;
      const cmd = parseWagerCommand(data, typeof data.idempotencyKey === 'string' ? data.idempotencyKey : undefined);
      await this.processor.recordFailed(cmd);
    } catch (e) {
      this.logger.warn(`could not record the failure of message ${msg.messageId}: ${(e as Error).message}`);
    }
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
