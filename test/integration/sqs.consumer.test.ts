import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ConsumerHooks } from '../../src/application/wager/wager-message-handler';
import { SqsQueues } from '../../src/infrastructure/sqs/sqs-queues.service';
import { api, bootApp, createWallet, expectLedgerConsistent, uid, wagerBody as baseWagerBody, type TestApp } from './helpers';

const suffix = Date.now().toString(36);
const env = {
  SQS_QUEUE_NAME: `it-wagers-${suffix}.fifo`,
  SQS_DLQ_NAME: `it-wagers-dlq-${suffix}.fifo`,
  SQS_CONSUMER_ENABLED: 'true',
  SQS_CONSUMER_CONCURRENCY: '2',
  SQS_VISIBILITY_TIMEOUT_SECONDS: '2',
  SQS_WAIT_TIME_SECONDS: '1',
  SQS_RETRY_BASE_SECONDS: '1',
  SQS_MAX_RECEIVE_COUNT: '3',
  SQS_SHUTDOWN_GRACE_MS: '10000',
};

let t: TestApp;
let sqs: SQSClient;
let mainUrl: string;
let dlqUrl: string;

beforeAll(async () => {
  t = await bootApp(env);
  const q = t.app.get(SqsQueues);
  mainUrl = q.mainUrl;
  dlqUrl = q.dlqUrl;
  sqs = new SQSClient({ region: 'us-east-1', endpoint: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566' });
}, 30000);

afterAll(async () => {
  await t.close();
  sqs.destroy();
});

const wagerBody = (w: { playerId: string; walletId: string; currency: string }, over: Record<string, unknown> = {}) =>
  baseWagerBody(w, { providerId: 'prov-q', ...over }) as Record<string, any>;

/** The queue message envelope of the challenge: { messageId, type, occurredAt, data } (data carries the idempotency key). */
const envelope = (data: Record<string, any>, messageId = uid('msg')) => ({
  messageId,
  type: 'WagerTransactionRequested',
  occurredAt: new Date().toISOString(),
  data: { idempotencyKey: `${data.providerId}:${data.externalTransactionId}`, ...data },
});

const send = (body: unknown, group: string, raw?: string, messageId?: string) =>
  sqs.send(
    new SendMessageCommand({
      QueueUrl: mainUrl,
      MessageBody: raw ?? JSON.stringify(envelope(body as Record<string, any>, messageId)),
      MessageGroupId: group,
      MessageDeduplicationId: randomUUID(),
    }),
  );

async function waitFor<T>(fn: () => Promise<T | false | null | undefined>, timeoutMs = 20000, label = 'condition'): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(150);
  }
}

const txByExternal = async (id: string) => {
  const r = await api(t, 'GET', `/providers/prov-q/wagering/transactions/${id}`);
  return r.status === 200 ? r.body : null;
};

/** Collects DLQ messages (deleting what it reads) until `match` finds one. */
async function findInDlq(match: (body: string) => boolean, timeoutMs = 20000) {
  return waitFor(async () => {
    const res = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: dlqUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageAttributeNames: ['All'],
        VisibilityTimeout: 1,
      }),
    );
    for (const m of res.Messages ?? []) {
      if (match(m.Body ?? '')) {
        await sqs.send(new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: m.ReceiptHandle! }));
        return { body: m.Body!, reason: m.MessageAttributes?.FailureReason?.StringValue ?? '' };
      }
    }
    return false;
  }, timeoutMs, 'message in DLQ');
}

const queueDepth = async () => {
  const a = (
    await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: mainUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    )
  ).Attributes!;
  return Number(a.ApproximateNumberOfMessages) + Number(a.ApproximateNumberOfMessagesNotVisible);
};

const inboxCount = async (messageIdLike?: string) => {
  const rows = await t.orm.em.fork().execute<{ c: number }[]>(
    `select count(*)::int c from inbox_messages where consumer = 'wager-transactions' ${messageIdLike ? 'and message_id = ?' : ''}`,
    messageIdLike ? [messageIdLike] : [],
  );
  return rows[0]!.c;
};

describe('SQS consumer', () => {
  test('readiness reports PostgreSQL and SQS', async () => {
    const r = await api(t, 'GET', '/health/ready');
    expect(r.status).toBe(200);
    expect(r.body.checks).toEqual({ postgres: 'up', sqs: 'up' });
    expect((await api(t, 'GET', '/health/live')).status).toBe(200);
  });

  test('processes a message and acks it after commit', async () => {
    const w = await createWallet(t, '100.00');
    const body = wagerBody(w);
    await send(body, w.playerId);
    const tx = await waitFor(() => txByExternal(body.externalTransactionId), 20000, 'transaction');
    expect(tx.status).toBe('PROCESSED');
    expect(await expectLedgerConsistent(t, w.walletId)).toEqual({ balance: '90.00', entries: 2 });
    await waitFor(async () => (await queueDepth()) === 0, 10000, 'queue drained');
  });

  test('the same business transaction sent twice is applied once', async () => {
    const w = await createWallet(t, '100.00');
    const body = wagerBody(w);
    await send(body, w.playerId);
    await send(body, w.playerId); // distinct SQS message, same idempotency key
    await waitFor(async () => (await queueDepth()) === 0 && (await txByExternal(body.externalTransactionId)), 20000);
    expect(await expectLedgerConsistent(t, w.walletId)).toEqual({ balance: '90.00', entries: 2 });
  });

  test('worker dying after commit but before ack: redelivery does not duplicate the effect', async () => {
    const w = await createWallet(t, '100.00');
    const body = wagerBody(w);
    const hooks = t.app.get(ConsumerHooks);
    const seen: string[] = [];
    let crashed = false;
    hooks.afterCommit = (messageId) => {
      seen.push(messageId);
      if (!crashed) {
        crashed = true;
        throw new Error('simulated crash after commit, before ack');
      }
    };
    try {
      await send(body, w.playerId);
      // First delivery commits then "crashes"; the message reappears after the visibility timeout.
      await waitFor(async () => seen.length >= 2, 20000, 'redelivery');
      await waitFor(async () => (await queueDepth()) === 0, 15000, 'queue drained');
    } finally {
      hooks.afterCommit = undefined;
    }
    expect(new Set(seen).size).toBe(1); // same SQS message delivered twice
    expect(await expectLedgerConsistent(t, w.walletId)).toEqual({ balance: '90.00', entries: 2 });
  });

  test('poison messages go to the DLQ without touching the ledger', async () => {
    const w = await createWallet(t, '100.00');
    const marker = uid('poison');
    await send(null, w.playerId, `{"not json" ${marker}`);
    const bad = wagerBody(w, { externalTransactionId: marker, money: { amount: 10.5, currency: 'BRL' } });
    await send(bad, w.playerId);

    const malformed = await findInDlq((b) => b.includes(marker) && b.startsWith('{"not json"'));
    expect(malformed.reason).toContain('malformed');
    const invalid = await findInDlq((b) => b.includes(marker) && b.includes('10.5'));
    expect(invalid.reason).toContain('amount');
    expect(await expectLedgerConsistent(t, w.walletId)).toEqual({ balance: '100.00', entries: 1 });
  });

  test('business errors are acked, not dead-lettered', async () => {
    const w = await createWallet(t, '100.00');
    const body = wagerBody(w);
    await send(body, w.playerId);
    await waitFor(() => txByExternal(body.externalTransactionId));
    await send({ ...body, money: { amount: '99.00', currency: 'BRL' } }, w.playerId); // same id, different payload -> idempotency conflict
    await send(wagerBody(w, { amount: '500.00' }), w.playerId); // insufficient funds -> REJECTED, committed
    await waitFor(async () => (await queueDepth()) === 0, 15000, 'queue drained');
    expect(await expectLedgerConsistent(t, w.walletId)).toEqual({ balance: '90.00', entries: 2 });
  });

  test('transient failure is retried with backoff and succeeds once the cause is gone', async () => {
    const playerId = uid('late');
    const walletId = randomUUID();
    const body = wagerBody({ playerId, walletId, currency: 'BRL' }, { kind: 'WIN', amount: '25.00' });
    await send(body, playerId); // the wallet does not exist yet
    await Bun.sleep(1200);
    await t.orm.em.fork().execute('insert into wallets (id, player_id, currency) values (?, ?, ?)', [walletId, playerId, 'BRL']);
    const tx = await waitFor(() => txByExternal(body.externalTransactionId), 20000, 'retried transaction');
    expect(tx.status).toBe('PROCESSED');
    expect(await expectLedgerConsistent(t, walletId)).toEqual({ balance: '25.00', entries: 1 });
  });

  test('the same messageId sent twice is deduplicated by the inbox', async () => {
    const w = await createWallet(t, '100.00');
    const body = wagerBody(w);
    const messageId = uid('same-msg');
    await send(body, w.playerId, undefined, messageId);
    await send({ ...body, externalTransactionId: uid('other') }, w.playerId, undefined, messageId); // new content, same messageId
    await waitFor(async () => (await queueDepth()) === 0 && (await txByExternal(body.externalTransactionId)), 20000);
    expect(await inboxCount(messageId)).toBe(1);
    expect(await expectLedgerConsistent(t, w.walletId)).toEqual({ balance: '90.00', entries: 2 }); // only the first applied
  });

  test('retries are bounded: exhausted messages land in the DLQ', async () => {
    const marker = uid('ghost');
    await send(wagerBody({ playerId: marker, walletId: randomUUID(), currency: 'BRL' }, { externalTransactionId: marker }), marker);
    const dead = await findInDlq((b) => b.includes(marker), 40000);
    expect(dead.reason).toContain('retries exhausted');
  }, 60000);
});

describe('multiple instances and shutdown', () => {
  test('three instances on one queue: no lost or duplicated effects', async () => {
    const extra = await Promise.all([bootApp(env), bootApp(env)]);
    process.env.SQS_CONSUMER_ENABLED = 'true';
    try {
      const wallets = await Promise.all(Array.from({ length: 6 }, () => createWallet(t, '100.00')));
      const ids: string[] = [];
      await Promise.all(
        wallets.flatMap((w) =>
          Array.from({ length: 10 }, () => {
            const b = wagerBody(w, { amount: '2.00' });
            ids.push(b.externalTransactionId);
            return send(b, w.playerId);
          }),
        ),
      );
      await waitFor(async () => (await queueDepth()) === 0, 60000, 'queue drained');
      for (const w of wallets) {
        expect(await expectLedgerConsistent(t, w.walletId)).toEqual({ balance: '80.00', entries: 11 });
      }
      expect(ids).toHaveLength(60);
    } finally {
      await Promise.all(extra.map((e) => e.close()));
    }
  }, 90000);

  test('graceful shutdown mid-stream loses nothing and duplicates nothing', async () => {
    const a = await bootApp(env);
    const w = await createWallet(a, '100.00');
    const bodies = Array.from({ length: 20 }, () => wagerBody(w, { amount: '1.00' }));
    await Promise.all(bodies.map((b) => send(b, w.playerId)));
    await Bun.sleep(300);
    await a.close(); // drains in-flight work, releases the rest
    // The main test app (still consuming) picks up whatever instance A did not finish.
    await waitFor(async () => (await queueDepth()) === 0, 40000, 'queue drained');
    expect(await expectLedgerConsistent(t, w.walletId)).toEqual({ balance: '80.00', entries: 21 });
    expect(await inboxCount()).toBeGreaterThan(0);
  }, 90000);
});
