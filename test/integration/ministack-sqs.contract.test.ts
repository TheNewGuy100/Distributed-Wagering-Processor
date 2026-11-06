import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

const sqs = new SQSClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
  endpoint: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

const suffix = Date.now().toString(36);
const dlqName = `contract-dlq-${suffix}.fifo`;
const qName = `contract-q-${suffix}.fifo`;
let qUrl = '';
let dlqUrl = '';

beforeAll(async () => {
  dlqUrl = (
    await sqs.send(
      new CreateQueueCommand({
        QueueName: dlqName,
        Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
      }),
    )
  ).QueueUrl!;
  const dlqArn = (
    await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }))
  ).Attributes!.QueueArn!;
  qUrl = (
    await sqs.send(
      new CreateQueueCommand({
        QueueName: qName,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'false',
          VisibilityTimeout: '1',
          RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: '2' }),
        },
      }),
    )
  ).QueueUrl!;
});

afterAll(() => sqs.destroy());

const send = (body: string, dedup: string) =>
  sqs.send(
    new SendMessageCommand({
      QueueUrl: qUrl,
      MessageBody: body,
      MessageGroupId: 'g1',
      MessageDeduplicationId: dedup,
    }),
  );

const receive = (url: string) =>
  sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: url,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 1,
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    }),
  );

describe('MiniStack SQS contract', () => {
  test('resolves queue url by name', async () => {
    const r = await sqs.send(new GetQueueUrlCommand({ QueueName: qName }));
    expect(r.QueueUrl).toBe(qUrl);
  });

  test('FIFO dedup: same MessageDeduplicationId delivers once', async () => {
    const id = `dup-${suffix}`;
    await send('a', id);
    await send('a', id);
    const first = await receive(qUrl);
    expect(first.Messages?.length).toBe(1);
    await sqs.send(
      new DeleteMessageCommand({ QueueUrl: qUrl, ReceiptHandle: first.Messages![0]!.ReceiptHandle! }),
    );
    const second = await receive(qUrl);
    expect(second.Messages ?? []).toHaveLength(0);
  });

  test('redelivery after visibility timeout increments ApproximateReceiveCount', async () => {
    await send('b', `redeliver-${suffix}`);
    const first = await receive(qUrl);
    expect(first.Messages?.[0]?.Attributes?.ApproximateReceiveCount).toBe('1');
    await Bun.sleep(1500);
    const second = await receive(qUrl);
    expect(second.Messages?.[0]?.Body).toBe('b');
    expect(second.Messages?.[0]?.Attributes?.ApproximateReceiveCount).toBe('2');
    // left unacked on purpose; consumed by the DLQ test below
  });

  test('redrive moves message to DLQ after maxReceiveCount', async () => {
    await Bun.sleep(1500);
    await receive(qUrl); // exceeds maxReceiveCount=2 -> redrive
    await Bun.sleep(1500);
    const main = await receive(qUrl);
    expect(main.Messages ?? []).toHaveLength(0);
    const dlq = await receive(dlqUrl);
    expect(dlq.Messages?.[0]?.Body).toBe('b');
  }, 15000);
});
