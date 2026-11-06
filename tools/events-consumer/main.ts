import { SQSClient } from '@aws-sdk/client-sqs';
import { startEventsConsumer } from './server';

/**
 * Stand-in for a downstream system that subscribes to the domain events the outbox publishes
 * (`wager-events.fifo`). It records what arrives, drops repeated `eventId`s, checks per-wallet order and serves a small
 * page (default http://localhost:3100) to look at the stream.
 */
const sqs = new SQSClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
  ...(process.env.AWS_ENDPOINT_URL ? { endpoint: process.env.AWS_ENDPOINT_URL } : {}),
});

const consumer = await startEventsConsumer({
  sqs,
  queueName: process.env.SQS_EVENTS_QUEUE_NAME ?? 'wager-events.fifo',
  port: Number(process.env.PORT ?? 3100),
});
console.log(`events console on http://localhost:${consumer.port}`);

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: stopping`);
  await consumer.stop();
  sqs.destroy();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
