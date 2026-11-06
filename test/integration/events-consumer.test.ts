import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startEventsConsumer, type RunningConsumer } from '../../tools/events-consumer/server';
import { SqsQueues } from '../../src/infrastructure/sqs/sqs-queues.service';
import { api, bootApp, createWallet, uid, wager, type TestApp } from './helpers';

const suffix = Date.now().toString(36);
const env = {
  SQS_QUEUE_NAME: `ec-wagers-${suffix}.fifo`,
  SQS_DLQ_NAME: `ec-dlq-${suffix}.fifo`,
  SQS_EVENTS_QUEUE_NAME: `ec-events-${suffix}.fifo`,
  OUTBOX_ENABLED: 'true',
  OUTBOX_POLL_INTERVAL_MS: '100',
};

let t: TestApp;
let sqs: SQSClient;
let consumer: RunningConsumer;
let eventsUrl: string;
let base: string;

beforeAll(async () => {
  t = await bootApp(env);
  eventsUrl = t.app.get(SqsQueues).eventsUrl;
  sqs = new SQSClient({ region: 'us-east-1', endpoint: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566' });
  // Leftovers of other test files must not flow into this file's queue.
  await t.orm.em.fork().execute('update outbox_events set published_at = now() where published_at is null');
  consumer = await startEventsConsumer({ sqs, queueName: env.SQS_EVENTS_QUEUE_NAME, port: 0, waitTimeSeconds: 1, log: () => {} });
  base = `http://localhost:${consumer.port}`;
}, 30000);

afterAll(async () => {
  await consumer.stop();
  await t.close();
  sqs.destroy();
});

async function waitFor<T>(fn: () => T | false, timeoutMs = 20000, label = 'condition'): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(100);
  }
}

describe('events consumer fed by the real outbox', () => {
  test('events of real traffic arrive, typed, deduplicated and in per-wallet order', async () => {
    const before = consumer.store.stats.unique;
    const w = await createWallet(t, '50.00');
    for (let i = 0; i < 4; i++) await wager(t, w, { amount: '1.00' });
    await wager(t, w, { amount: '999.00' }); // rejected: no balance change
    // opening: 2 events; 4 bets: 2 each; 1 rejected: 1 event  => 11
    await waitFor(() => consumer.store.stats.unique - before >= 11, 20000, '11 events');

    const mine = consumer.store.since(0, 1000).filter((e) => e.status === 'new');
    const versions = mine
      .filter((e) => e.eventType === 'WalletBalanceChanged' && e.aggregateId === w.walletId)
      .map((e) => e.data!.walletVersion as number)
      .reverse(); // since() is newest first
    expect(versions).toEqual([1, 2, 3, 4, 5]); // opening + four bets, strictly increasing
    expect(mine.some((e) => e.eventType === 'WagerTransactionRejected' && e.data!.failureCode === 'INSUFFICIENT_FUNDS')).toBe(true);
    expect(consumer.store.stats.outOfOrder).toBe(0);
    expect(consumer.store.stats.invalid).toBe(0);
  });

  test('a repeated event id is counted as a duplicate, not as a new event', async () => {
    const original = consumer.store.since(0, 1000).find((e) => e.status === 'new' && e.eventType === 'WalletBalanceChanged')!;
    const before = consumer.store.stats.duplicates;
    const uniqueBefore = consumer.store.stats.unique;
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: eventsUrl,
        MessageGroupId: original.aggregateId!,
        MessageDeduplicationId: randomUUID(), // a different broker message...
        MessageBody: JSON.stringify({ ...original, n: undefined, status: undefined }), // ...carrying the same eventId
      }),
    );
    await waitFor(() => consumer.store.stats.duplicates > before, 15000, 'duplicate');
    expect(consumer.store.stats.unique).toBe(uniqueBefore);
  });

  test('a malformed message is recorded as invalid and acknowledged (it must not loop forever)', async () => {
    const before = consumer.store.stats.invalid;
    await sqs.send(
      new SendMessageCommand({ QueueUrl: eventsUrl, MessageGroupId: 'poison', MessageDeduplicationId: randomUUID(), MessageBody: '{ not json' }),
    );
    await waitFor(() => consumer.store.stats.invalid > before, 15000, 'invalid message');
    await Bun.sleep(2500); // longer than the queue's visibility timeout: a message that was not acked would come back
    expect(consumer.store.stats.invalid).toBe(before + 1);
  }, 30000);
});

describe('events consumer HTTP surface', () => {
  test('serves its page and assets with a strict policy, and the events as JSON', async () => {
    for (const [path, type] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/app.css', 'text/css']] as const) {
      const r = await fetch(base + path);
      expect(r.status, path).toBe(200);
      expect(r.headers.get('content-type'), path).toContain(type);
      const csp = r.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("default-src 'none'");
      expect(csp).not.toContain('unsafe-inline');
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    }
    const r = await fetch(`${base}/api/events?since=0`);
    const body = (await r.json()) as { stats: { unique: number }; events: { n: number }[] };
    expect(body.stats.unique).toBeGreaterThan(0);
    expect(body.events.length).toBeGreaterThan(0);
    expect((await fetch(base + '/healthz')).status).toBe(200);
    expect((await fetch(base + '/nope')).status).toBe(404);
    expect((await fetch(base + '/api/events', { method: 'POST' })).status).toBe(405);
  });

  test('the page never turns event data into markup', () => {
    const dir = join(import.meta.dir, '../../tools/events-consumer');
    const strip = (js: string) => js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    const js = strip(readFileSync(join(dir, 'app.js'), 'utf8'));
    for (const forbidden of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) {
      expect(js, forbidden).not.toContain(forbidden);
    }
    const html = readFileSync(join(dir, 'index.html'), 'utf8');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });
});

describe('lifecycle', () => {
  test('stops promptly: no poll or timer is left running', async () => {
    const own = await startEventsConsumer({ sqs, queueName: env.SQS_EVENTS_QUEUE_NAME, port: 0, waitTimeSeconds: 20, log: () => {} });
    await Bun.sleep(500); // inside a 20 s long poll
    const started = performance.now();
    await own.stop();
    expect(performance.now() - started).toBeLessThan(3000); // the long poll was aborted, not waited out
  });

  test('starts before the queue exists and waits for it (start order does not matter)', async () => {
    const lateName = `ec-late-${suffix}.fifo`;
    const own = await startEventsConsumer({ sqs, queueName: lateName, port: 0, waitTimeSeconds: 1, log: () => {} });
    try {
      await Bun.sleep(300);
      expect((await fetch(`http://localhost:${own.port}/healthz`)).status).toBe(200); // up and serving while it waits
      const stopped = performance.now();
      await own.stop(); // and stoppable while still waiting for the queue
      expect(performance.now() - stopped).toBeLessThan(3000);
    } finally {
      expect(api).toBeDefined();
      expect(uid('x')).toBeTruthy();
    }
  });
});
