import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { JsonLogger } from '../../src/infrastructure/observability/json-logger';
import { MetricsService } from '../../src/infrastructure/observability/metrics.service';
import { SqsQueues } from '../../src/infrastructure/sqs/sqs-queues.service';
import { api, bootApp, createWallet, uid, wager, type TestApp } from './helpers';

const suffix = Date.now().toString(36);
const env = {
  SQS_QUEUE_NAME: `obs-wagers-${suffix}.fifo`,
  SQS_DLQ_NAME: `obs-dlq-${suffix}.fifo`,
  SQS_EVENTS_QUEUE_NAME: `obs-events-${suffix}.fifo`,
  LOCK_CONFLICT_THRESHOLD_MS: '1',
  // Every app on these queues must agree on queue attributes, or CreateQueue refuses (drift guard).
  SQS_VISIBILITY_TIMEOUT_SECONDS: '2',
};

let t: TestApp;
let metrics: MetricsService;
const captured: Record<string, unknown>[] = [];
const originalWrite = JsonLogger.write;

beforeAll(async () => {
  JsonLogger.write = (line) => {
    try {
      captured.push(JSON.parse(line));
    } catch {
      /* not ours */
    }
  };
  t = await bootApp(env);
  metrics = t.app.get(MetricsService);
  t.app.useLogger(new JsonLogger('log')); // tests default to 'error' only; capture everything here
  await t.orm.em.fork().execute('update outbox_events set published_at = now() where published_at is null');
}, 30000);

afterAll(async () => {
  JsonLogger.write = originalWrite;
  await t.close();
});

const linesFor = (event: string, correlationId: string) =>
  captured.filter((l) => l.event === event && l.correlationId === correlationId);

const scrape = async () => {
  const res = await fetch(`${t.url}/metrics`);
  return { status: res.status, type: res.headers.get('content-type') ?? '', text: await res.text() };
};

describe('structured logs', () => {
  test('a request carries one correlation id through every line, with ids but no financial payload', async () => {
    const w = await createWallet(t, '100.00');
    const ext = uid('ext');
    const cid = `test-${randomUUID()}`;
    const res = await fetch(`${t.url}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-correlation-id': cid, 'idempotency-key': `prov-obs:${ext}` },
      body: JSON.stringify({
        providerId: 'prov-obs',
        externalTransactionId: ext,
        kind: 'BET',
        playerId: w.playerId,
        walletId: w.walletId,
        money: { amount: '12.34', currency: 'BRL' },
        roundId: 'r1',
        gameId: 'fortune-chimp',
      }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('x-correlation-id')).toBe(cid);
    const { transactionId } = (await res.json()) as { transactionId: string };

    const settled = linesFor('wager_settled', cid);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      level: 'info',
      source: 'http',
      status: 'PROCESSED',
      transactionId,
      walletId: w.walletId,
      providerId: 'prov-obs',
    });
    const access = linesFor('http_request', cid);
    expect(access[0]).toMatchObject({ method: 'POST', route: '/wagering/transactions', status: 201, transactionId, walletId: w.walletId });

    for (const l of [...settled, ...access]) {
      const text = JSON.stringify(l);
      expect(text).not.toContain('12.34');
      expect(l).not.toHaveProperty('amount');
    }
  });

  test('a missing or unsafe correlation id is replaced by a generated one', async () => {
    const bad = await fetch(`${t.url}/health/live`, { headers: { 'x-correlation-id': 'bad id with spaces\n' } }).catch(() => null);
    const res = bad ?? (await fetch(`${t.url}/health/live`));
    const cid = res.headers.get('x-correlation-id')!;
    expect(cid).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('metrics', () => {
  test('/metrics serves Prometheus text with statuses, duplicates, rejections and latency', async () => {
    const w = await createWallet(t, '50.00');
    const ext = uid('ext');
    await wager(t, w, { externalTransactionId: ext, amount: '10.00' });
    await wager(t, w, { externalTransactionId: ext, amount: '10.00' }); // replay
    await wager(t, w, { externalTransactionId: ext, amount: '11.00' }); // conflict
    await wager(t, w, { amount: '999.00' }); // rejected

    const { status, type, text } = await scrape();
    expect(status).toBe(200);
    expect(type).toContain('text/plain');
    expect(text).toContain('wager_transactions_total{kind="BET",source="http",status="PROCESSED"}');
    expect(text).toContain('wager_transactions_total{kind="BET",source="http",status="REJECTED"}');
    expect(text).toContain('wager_duplicates_total{layer="idempotency",source="http"}');
    expect(text).toContain('wager_idempotency_conflicts_total');
    expect(text).toContain('wager_requests_failed_total{reason="IDEMPOTENCY_CONFLICT",source="http"}');
    expect(text).toContain('wager_processing_seconds_bucket{le="+Inf",source="http"}');
    expect(text).toContain('http_requests_total{method="POST",route="/wagering/transactions",status="201"}');
    expect(text).toContain('http_requests_total{method="POST",route="/wagering/transactions",status="422"}');
    expect(metrics.histogramCount('wager_processing_seconds', { source: 'http' })).toBeGreaterThan(3);
  });

  test('wallet lock contention is counted', async () => {
    const w = await createWallet(t, '1000.00');
    const before = metrics.get('wallet_lock_conflicts_total');
    await Promise.all(Array.from({ length: 40 }, () => wager(t, w, { amount: '1.00' })));
    expect(metrics.get('wallet_lock_conflicts_total')).toBeGreaterThan(before);
    expect(await (await scrape()).text).toContain('wallet_lock_wait_seconds_count');
  });

  test('outbox lag gauge reflects committed-but-unpublished events and drops to zero once published', async () => {
    const w = await createWallet(t, '10.00'); // publisher is off: events stay in the outbox
    await Bun.sleep(1100);
    const text = (await scrape()).text;
    const unpublished = Number(/^outbox_unpublished_events (\d+)$/m.exec(text)?.[1]);
    const lag = Number(/^outbox_lag_seconds ([\d.]+)$/m.exec(text)?.[1]);
    expect(unpublished).toBeGreaterThanOrEqual(2);
    expect(lag).toBeGreaterThan(1);

    const pub = await bootApp({ ...env, OUTBOX_ENABLED: 'true', OUTBOX_POLL_INTERVAL_MS: '100' });
    try {
      const deadline = Date.now() + 20000;
      let now = 1;
      while (Date.now() < deadline && now !== 0) {
        await Bun.sleep(200);
        now = Number(/^outbox_unpublished_events (\d+)$/m.exec((await scrape()).text)?.[1]);
      }
      expect(now).toBe(0);
      expect(/^outbox_lag_seconds ([\d.]+)$/m.exec((await scrape()).text)?.[1]).toBe('0');
      expect(pub.app.get(MetricsService).total('outbox_events_published_total')).toBeGreaterThan(0);
    } finally {
      await pub.close();
    }
    expect(w.walletId).toBeTruthy();
  }, 40000);

  test('pending-reference gauge counts waiting reversals', async () => {
    const w = await createWallet(t, '10.00');
    await wager(t, w, { kind: 'REFUND', amount: '1.00', referenceExternalTransactionId: uid('later') });
    const n = Number(/^pending_reference_transactions (\d+)$/m.exec((await scrape()).text)?.[1]);
    expect(n).toBeGreaterThanOrEqual(1);
  });
});

describe('SQS consumer observability', () => {
  test('message id and correlation id are logged; DLQ and duplicate counters move', async () => {
    const q = await bootApp({
      ...env,
      SQS_CONSUMER_ENABLED: 'true',
      SQS_WAIT_TIME_SECONDS: '1',
    });
    const qm = q.app.get(MetricsService);
    q.app.useLogger(new JsonLogger('log'));
    const sqs = new SQSClient({ region: 'us-east-1', endpoint: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566' });
    try {
      const w = await createWallet(q, '100.00');
      const url = q.app.get(SqsQueues).mainUrl;
      const ext = uid('ext');
      const envelope = (data: object) =>
        JSON.stringify({ messageId: uid('msg'), type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data });
      const body = {
        providerId: 'prov-obs',
        externalTransactionId: ext,
        kind: 'BET',
        playerId: w.playerId,
        walletId: w.walletId,
        money: { amount: '5.00', currency: 'BRL' },
        roundId: 'r1',
        gameId: 'fortune-chimp',
        idempotencyKey: `prov-obs:${ext}`,
      };
      const cid = `sqs-${randomUUID()}`;
      const send = (b: string, attrs = false) =>
        sqs.send(
          new SendMessageCommand({
            QueueUrl: url,
            MessageBody: b,
            MessageGroupId: w.playerId,
            MessageDeduplicationId: randomUUID(),
            ...(attrs ? { MessageAttributes: { correlationId: { DataType: 'String', StringValue: cid } } } : {}),
          }),
        );
      await send(envelope(body), true);
      await send(envelope(body)); // second SQS message, same business transaction
      await send('{ not json');

      const deadline = Date.now() + 20000;
      while (Date.now() < deadline && !(qm.total('sqs_dead_letter_total') >= 1 && qm.total('wager_duplicates_total') >= 1)) {
        await Bun.sleep(150);
      }
      expect(qm.get('sqs_dead_letter_total', { reason: 'poison' })).toBe(1);
      expect(qm.get('wager_duplicates_total', { source: 'sqs', layer: 'idempotency' })).toBe(1);
      expect(qm.get('wager_transactions_total', { kind: 'BET', status: 'PROCESSED', source: 'sqs' })).toBe(1);
      expect(qm.get('sqs_messages_total', { outcome: 'dead_lettered' })).toBe(1);

      const line = captured.find((l) => l.event === 'wager_settled' && l.correlationId === cid);
      expect(line).toMatchObject({ source: 'sqs', status: 'PROCESSED', walletId: w.walletId, providerId: 'prov-obs' });
      expect(typeof line!.messageId).toBe('string');
      expect(api).toBeDefined();
    } finally {
      sqs.destroy();
      await q.close();
    }
  }, 40000);
});
