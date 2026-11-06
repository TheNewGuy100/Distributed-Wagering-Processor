import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { SQS_CLIENT, SQS_CONFIG, type SqsConfig } from './sqs.config';

/** Creates (idempotently) the FIFO queue and its DLQ and exposes their URLs. */
@Injectable()
export class SqsQueues implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(SqsQueues.name);
  mainUrl = '';
  dlqUrl = '';
  eventsUrl = '';

  constructor(
    @Inject(SQS_CLIENT) readonly client: SQSClient,
    @Inject(SQS_CONFIG) readonly config: SqsConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureQueues();
  }

  async ensureQueues(): Promise<void> {
    const dlq = await this.client.send(
      new CreateQueueCommand({
        QueueName: this.config.dlqName,
        Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
      }),
    );
    this.dlqUrl = dlq.QueueUrl!;
    const arn = (
      await this.client.send(new GetQueueAttributesCommand({ QueueUrl: this.dlqUrl, AttributeNames: ['QueueArn'] }))
    ).Attributes!.QueueArn!;

    const main = await this.client.send(
      new CreateQueueCommand({
        QueueName: this.config.queueName,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'false',
          VisibilityTimeout: String(this.config.visibilityTimeoutSeconds),
          // Safety net only: the consumer moves poison/exhausted messages to the DLQ explicitly.
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: arn,
            maxReceiveCount: String(this.config.maxReceiveCount + 2),
          }),
        },
      }),
    );
    this.mainUrl = main.QueueUrl!;

    const events = await this.client.send(
      new CreateQueueCommand({
        QueueName: this.config.eventsQueueName,
        Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
      }),
    );
    this.eventsUrl = events.QueueUrl!;
    this.logger.log(`queues ready: ${this.config.queueName} (+ ${this.config.dlqName})`);
  }

  /** Readiness probe: the queue must be resolvable. */
  async ping(): Promise<void> {
    await this.client.send(new GetQueueUrlCommand({ QueueName: this.config.queueName }), {
      abortSignal: AbortSignal.timeout(2000),
    });
  }

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}
