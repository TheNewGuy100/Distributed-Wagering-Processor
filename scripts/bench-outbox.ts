/**
 * Local micro-benchmark of the outbox publisher alone (no HTTP, no load generator competing for the CPU):
 * seeds N unpublished events over A aggregates and measures how fast K publisher loops drain them.
 *   bun scripts/bench-outbox.ts [events=6000] [aggregates=50]
 */
import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import { bootApp } from '../test/integration/helpers';
import { OutboxPublisher } from '../src/infrastructure/outbox/outbox-publisher.service';
import { SqsQueues } from '../src/infrastructure/sqs/sqs-queues.service';

const events = Number(process.argv[2] ?? 6000);
const aggregates = Number(process.argv[3] ?? 50);
const suffix = Date.now().toString(36);

const t = await bootApp({
  SQS_QUEUE_NAME: `bench-w-${suffix}.fifo`,
  SQS_DLQ_NAME: `bench-d-${suffix}.fifo`,
  SQS_EVENTS_QUEUE_NAME: `bench-e-${suffix}.fifo`,
});
const publisher = t.app.get(OutboxPublisher);
const queues = t.app.get(SqsQueues);
const em = t.orm.em.fork();

async function seed(): Promise<void> {
  await em.execute('update outbox_events set published_at = now() where published_at is null and dead_at is null');
  await em.execute(
    `insert into outbox_events (id, aggregate_id, event_type, version, payload)
     select gen_random_uuid(), 'bench-' || (g % ?), 'BenchEvent', 1, '{"bench":true}'::jsonb from generate_series(1, ?) g`,
    [aggregates, events],
  );
}

async function sendLatency(n = 30): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    await queues.client.send(
      new SendMessageBatchCommand({
        QueueUrl: queues.eventsUrl,
        Entries: Array.from({ length: 10 }, (_, j) => ({
          Id: String(j),
          MessageBody: '{}',
          MessageGroupId: `lat-${j}`,
          MessageDeduplicationId: randomUUID(),
        })),
      }),
    );
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(n / 2)]!;
}

async function drain(loops: number): Promise<{ seconds: number; perSecond: number; cycles: number }> {
  await seed();
  let cycles = 0;
  const start = performance.now();
  await Promise.all(
    Array.from({ length: loops }, async () => {
      for (;;) {
        const n = await publisher.publishOnce();
        if (n === 0) {
          const [row] = await em.execute<{ left: number }[]>(
            'select count(*)::int as left from outbox_events where published_at is null and dead_at is null',
          );
          if (row!.left === 0) return;
          await Bun.sleep(5);
          continue;
        }
        cycles++;
      }
    }),
  );
  const seconds = (performance.now() - start) / 1000;
  return { seconds: Number(seconds.toFixed(2)), perSecond: Math.round(events / seconds), cycles };
}

console.log(`SQS SendMessageBatch(10) median latency: ${(await sendLatency()).toFixed(1)} ms`);
for (const loops of (process.env.LOOPS ?? '1,2,4,8').split(',').map(Number)) {
  console.log(`loops=${loops}`, await drain(loops));
}
await t.close();
process.exit(0);
