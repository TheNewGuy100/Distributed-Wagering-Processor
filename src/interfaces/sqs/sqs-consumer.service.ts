import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';
import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  WagerMessageHandler,
  type MessageOutcome,
} from '../../application/wager/wager-message-handler';
import { LogContext } from '../../infrastructure/observability/log-context';
import { MetricsService } from '../../infrastructure/observability/metrics.service';
import { SQS_CONFIG, type SqsConfig } from '../../infrastructure/sqs/sqs.config';
import { SqsQueues } from '../../infrastructure/sqs/sqs-queues.service';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Delay before redelivery after a failed attempt: base * 2^(attempt-1), capped. */
export function retryDelaySeconds(receiveCount: number, base: number, max: number): number {
  return Math.min(base * 2 ** Math.max(0, receiveCount - 1), max);
}

/**
 * Long-polling consumer. Acks (deletes) only after the handler's transaction committed.
 * Messages of one FIFO group are handled in order; different groups run in parallel.
 */
@Injectable()
export class SqsConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(SqsConsumer.name);
  private stopping = false;
  private readonly abort = new AbortController();
  private loops: Promise<void>[] = [];
  private inFlight = 0;

  constructor(
    @Inject(SqsQueues) private readonly queues: SqsQueues,
    @Inject(SQS_CONFIG) private readonly config: SqsConfig,
    @Inject(WagerMessageHandler) private readonly handler: WagerMessageHandler,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.consumerEnabled) {
      this.logger.log('SQS consumer disabled (SQS_CONSUMER_ENABLED=false)');
      return;
    }
    this.loops = Array.from({ length: this.config.concurrency }, () => this.pollLoop());
    this.logger.log(`SQS consumer started with ${this.config.concurrency} poll loops`);
  }

  /** Stop taking new work, let in-flight messages finish (bounded), release anything unprocessed. */
  async beforeApplicationShutdown(): Promise<void> {
    if (this.loops.length === 0) return;
    this.stopping = true;
    this.abort.abort();
    const grace = sleep(this.config.shutdownGraceMs).then(() => 'timeout' as const);
    const result = await Promise.race([Promise.allSettled(this.loops).then(() => 'drained' as const), grace]);
    if (result === 'timeout') {
      this.logger.warn(`shutdown grace elapsed with ${this.inFlight} message(s) in flight; they will be redelivered`);
    }
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopping) {
      let messages: Message[] = [];
      try {
        const res = await this.queues.client.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queues.mainUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: this.config.waitTimeSeconds,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
            MessageAttributeNames: ['correlationId'],
          }),
          { abortSignal: this.abort.signal },
        );
        messages = res.Messages ?? [];
      } catch (e) {
        if (this.stopping) break;
        this.logger.warn(`receive failed: ${(e as Error).message}`);
        await sleep(1000);
        continue;
      }
      if (messages.length > 0) await this.processBatch(messages);
    }
  }

  private async processBatch(messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const m of messages) {
      const key = m.Attributes?.MessageGroupId ?? m.MessageId ?? 'none';
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(m);
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        for (let i = 0; i < group.length; i++) {
          if (this.stopping) {
            await this.release(group.slice(i));
            return;
          }
          const proceed = await this.processOne(group[i]!);
          if (!proceed) {
            // Keep per-group order: do not handle later messages ahead of a failed one.
            await this.release(group.slice(i + 1));
            return;
          }
        }
      }),
    );
  }

  /** Returns true when the message is finished (acked or dead-lettered) and the group may continue. */
  private processOne(m: Message): Promise<boolean> {
    const messageId = m.MessageId ?? '';
    const correlationId = m.MessageAttributes?.correlationId?.StringValue ?? messageId;
    return LogContext.run({ messageId, correlationId }, () => this.processOneInContext(m));
  }

  private async processOneInContext(m: Message): Promise<boolean> {
    const messageId = m.MessageId ?? '';
    const receiveCount = Number(m.Attributes?.ApproximateReceiveCount ?? '1');
    this.inFlight++;
    try {
      let outcome: MessageOutcome;
      try {
        outcome = await this.handler.handle({ messageId, body: m.Body ?? '' });
      } catch (e) {
        // Raised after commit (crash simulation / post-commit failure): never ack, never delay.
        this.logger.error(`message ${messageId} handled but not acknowledged: ${(e as Error).message}`);
        return false;
      }

      switch (outcome.kind) {
        case 'ACK':
          await this.ack(m);
          this.metrics.inc('sqs_messages_total', { outcome: outcome.reason });
          return true;
        case 'DLQ':
          this.metrics.inc('sqs_dead_letter_total', { reason: 'poison' });
          this.metrics.inc('sqs_messages_total', { outcome: 'dead_lettered' });
          return await this.deadLetter(m, outcome.reason);
        case 'RETRY':
          if (receiveCount >= this.config.maxReceiveCount) {
            this.metrics.inc('sqs_dead_letter_total', { reason: 'retries_exhausted' });
            this.metrics.inc('sqs_messages_total', { outcome: 'dead_lettered' });
            return await this.deadLetter(m, `retries exhausted: ${outcome.reason}`);
          }
          this.metrics.inc('sqs_retries_total');
          this.metrics.inc('sqs_messages_total', { outcome: 'retry' });
          await this.delay(m, retryDelaySeconds(receiveCount, this.config.retryBaseSeconds, this.config.retryMaxSeconds));
          return false;
      }
    } catch (e) {
      this.logger.error(`failed to settle message ${messageId}: ${(e as Error).message}`);
      return false; // it will reappear after the visibility timeout
    } finally {
      this.inFlight--;
    }
  }

  private async ack(m: Message): Promise<void> {
    await this.queues.client.send(new DeleteMessageCommand({ QueueUrl: this.queues.mainUrl, ReceiptHandle: m.ReceiptHandle! }));
  }

  private async deadLetter(m: Message, reason: string): Promise<boolean> {
    await this.queues.client.send(
      new SendMessageCommand({
        QueueUrl: this.queues.dlqUrl,
        MessageBody: m.Body ?? '',
        MessageGroupId: m.Attributes?.MessageGroupId ?? 'dlq',
        MessageDeduplicationId: m.MessageId!,
        MessageAttributes: {
          FailureReason: { DataType: 'String', StringValue: reason.slice(0, 256) },
          OriginalMessageId: { DataType: 'String', StringValue: m.MessageId! },
        },
      }),
    );
    // Only after the DLQ accepted it; otherwise the message simply comes back.
    await this.ack(m);
    this.logger.warn(`message ${m.MessageId} moved to DLQ: ${reason}`);
    return true;
  }

  private async delay(m: Message, seconds: number): Promise<void> {
    await this.queues.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queues.mainUrl,
        ReceiptHandle: m.ReceiptHandle!,
        VisibilityTimeout: seconds,
      }),
    );
  }

  /** Hand received-but-untouched messages straight back to the queue. */
  private async release(messages: Message[]): Promise<void> {
    await Promise.allSettled(messages.map((m) => this.delay(m, 0)));
  }
}
