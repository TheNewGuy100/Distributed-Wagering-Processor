import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MetricsService } from '../../src/infrastructure/observability/metrics.service';
import { OutboxHooks, OutboxPublisher } from '../../src/infrastructure/outbox/outbox-publisher.service';
import { SqsQueues } from '../../src/infrastructure/sqs/sqs-queues.service';
import { api, bootApp, createWallet, expectLedgerConsistent, uid, wager, type TestApp } from './helpers';

const suffix = Date.now().toString(36);
const env = {
  SQS_QUEUE_NAME: `ob-wagers-${suffix}.fifo`,
  SQS_DLQ_NAME: `ob-dlq-${suffix}.fifo`,
  SQS_EVENTS_QUEUE_NAME: `ob-events-${suffix}.fifo`,
  OUTBOX_POLL_INTERVAL_MS: '100',
};
const withOutbox = { ...env, OUTBOX_ENABLED: 'true' };

let t: TestApp; // HTTP + outbox disabled: produces events without publishing them
let sqs: SQSClient;
let eventsUrl: string;

interface Envelope {
  eventId: string;
  eventType: string;
  version: number;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  data: Record<string, any>;
}

beforeAll(async () => {
  t = await bootApp(env);
  eventsUrl = t.app.get(SqsQueues).eventsUrl;
  sqs = new SQSClient({ region: 'us-east-1', endpoint: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566' });
  // Leftovers of other test files must not be published into this file's queue.
  await t.orm.em.fork().execute('update outbox_events set published_at = now() where published_at is null and dead_at is null');
}, 30000);

afterAll(async () => {
  await t.close();
  sqs.destroy();
});

/** Wallet aggregate + the OPENING transaction aggregate created together with it. */
const walletAggregates = async (walletId: string): Promise<string[]> => {
  const rows = await t.orm.em
    .fork()
    .execute<{ id: string }[]>("select id from wager_transactions where wallet_id = ? and kind = 'OPENING'", [walletId]);
  return [walletId, ...rows.map((r) => r.id)];
};

const pendingFor = async (aggregateIds: string[]) => {
  if (aggregateIds.length === 0) return 0;
  const rows = await t.orm.em.fork().execute<{ c: number }[]>(
    `select count(*)::int c from outbox_events where published_at is null
        and aggregate_id in (${aggregateIds.map(() => '?').join(',')})`,
    aggregateIds,
  );
  return rows[0]!.c;
};

async function waitFor<T>(fn: () => Promise<T | false>, timeoutMs = 20000, label = 'condition'): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(100);
  }
}

/** Reads the events queue in delivery order, keeping only envelopes accepted by `keep`. */
async function collect(keep: (e: Envelope) => boolean, until: (got: Envelope[]) => boolean, timeoutMs = 30000) {
  const got: Envelope[] = [];
  const start = Date.now();
  while (!until(got)) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out collecting events (have ${got.length})`);
    const res = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: eventsUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 60 }),
    );
    for (const m of (res.Messages ?? []) as Message[]) {
      const e = JSON.parse(m.Body!) as Envelope;
      await sqs.send(new DeleteMessageCommand({ QueueUrl: eventsUrl, ReceiptHandle: m.ReceiptHandle! }));
      if (keep(e)) got.push(e);
    }
  }
  return got;
}

describe('event content', () => {
  test('publishes typed envelopes after commit; WalletBalanceChanged only when the balance changed', async () => {
    const w = await createWallet(t, '100.00'); // OPENING: Processed + BalanceChanged
    const bet = await wager(t, w, { amount: '10.00' });
    const loss = await wager(t, w, { kind: 'LOSS', amount: '10.00' }); // no balance change
    const rejected = await wager(t, w, { amount: '999.00' });
    const pending = await wager(t, w, { kind: 'REFUND', amount: '5.00', referenceExternalTransactionId: uid('nope') });
    const mine = new Set([
      ...(await walletAggregates(w.walletId)),
      bet.body.transactionId,
      loss.body.transactionId,
      rejected.body.transactionId,
      pending.body.transactionId,
    ]);
    const wanted = 2 + 2 + 1 + 1 + 1; // opening(2) bet(2) loss(1) rejected(1) pending(1)

    const pub = await bootApp(withOutbox);
    try {
      const events = await collect((e) => mine.has(e.aggregateId), (g) => g.length >= wanted);
      const byType = (ty: string) => events.filter((e) => e.eventType === ty);
      expect(events).toHaveLength(wanted);
      expect(byType('WagerTransactionProcessed')).toHaveLength(3); // opening, bet, loss
      expect(byType('WalletBalanceChanged')).toHaveLength(2); // opening, bet (not loss)
      expect(byType('WagerTransactionRejected')[0]!.data.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect(byType('WagerTransactionPendingReference')).toHaveLength(1);

      for (const e of events) {
        expect(e.version).toBe(1);
        expect(typeof e.eventId).toBe('string');
        expect(new Date(e.occurredAt).toISOString()).toBe(e.occurredAt);
      }
      const changed = byType('WalletBalanceChanged').map((e) => e.data);
      expect(
        changed.map((d) => [d.direction, d.money.amount, d.balanceBefore.amount, d.balanceAfter.amount, d.walletVersion]),
      ).toEqual([
        ['CREDIT', '100.00', '0.00', '100.00', 1],
        ['DEBIT', '10.00', '100.00', '90.00', 2],
      ]);
      expect(typeof changed[0]!.money.amount).toBe('string'); // money is never a JSON number
      expect(changed[0]!.money.currency).toBe('BRL');
      // The envelope ties events together: one correlationId per request, causationId points at what caused it.
      for (const e of events) {
        expect(typeof e.correlationId).toBe('string');
        expect(e.correlationId.length).toBeGreaterThan(0);
      }
      const bet = byType('WagerTransactionProcessed').find((e) => e.data.kind === 'BET')!;
      expect(bet.data.gameId).toBe('fortune-chimp');
      expect(bet.data.money).toEqual({ amount: '10.00', currency: 'BRL' });
    } finally {
      await pub.close();
    }
    expect(await pendingFor([...mine])).toBe(0);
  }, 60000);
});

describe('delivery guarantees', () => {
  test('nothing is published before the business transaction commits', async () => {
    const eventId = crypto.randomUUID();
    const aggregate = uid('uncommitted');
    const pub = await bootApp(withOutbox);
    try {
      await t.orm.em
        .fork()
        .transactional(async (tx) => {
          await tx.execute(
            `insert into outbox_events (id, aggregate_id, event_type, version, payload)
             values (?, ?, 'WagerTransactionProcessed', 1, '{"eventId":"x"}'::jsonb)`,
            [eventId, aggregate],
          );
          await Bun.sleep(1500); // publisher cycles run (and must not see the row) while we are uncommitted
          const seen = await pendingFor([aggregate]);
          expect(seen).toBe(0); // invisible from outside
          throw new Error('rollback');
        })
        .catch(() => undefined);
      await Bun.sleep(500);
    } finally {
      await pub.close();
    }
    const published = await t.orm.em.fork().execute<{ c: number }[]>(
      'select count(*)::int c from outbox_events where aggregate_id = ?',
      [aggregate],
    );
    expect(published[0]!.c).toBe(0);
  }, 30000);

  test('two instances (4 publisher loops) publish every event exactly once, in order per wallet', async () => {
    const wallets = await Promise.all(Array.from({ length: 8 }, () => createWallet(t, '1000.00')));
    const aggregates = new Set<string>((await Promise.all(wallets.map((w) => walletAggregates(w.walletId)))).flat());
    const results = await Promise.all(
      wallets.flatMap((w) => Array.from({ length: 10 }, () => wager(t, w, { amount: '1.00' }))),
    );
    for (const r of results) aggregates.add(r.body.transactionId);
    // per wallet: opening(2) + 10 bets x 2 events; per tx aggregate counted inside
    const expected = wallets.length * (2 + 10 * 2);

    const [a, b] = await Promise.all([bootApp(withOutbox), bootApp(withOutbox)]);
    try {
      const events = await collect((e) => aggregates.has(e.aggregateId), (g) => g.length >= expected, 60000);
      await Bun.sleep(1500); // let any duplicate surface
      const extra = await collect((e) => aggregates.has(e.aggregateId), () => true, 5000).catch(() => []);
      expect(events.length + extra.length).toBe(expected);
      expect(new Set(events.map((e) => e.eventId)).size).toBe(expected);

      for (const w of wallets) {
        const versions = events
          .filter((e) => e.eventType === 'WalletBalanceChanged' && e.aggregateId === w.walletId)
          .map((e) => e.data.walletVersion as number);
        expect(versions).toEqual([...versions].sort((x, y) => x - y)); // delivered in version order
        expect(versions).toHaveLength(11);
      }
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
    expect(await pendingFor([...aggregates])).toBe(0);
    for (const w of wallets) await expectLedgerConsistent(t, w.walletId);
  }, 120000);

  test('a publisher dying after send but before commit loses nothing (event is sent again, deduplicated)', async () => {
    const w = await createWallet(t, '50.00');
    const mine = new Set(await walletAggregates(w.walletId));
    const bet = await wager(t, w, { amount: '5.00' });
    mine.add(bet.body.transactionId);
    const wanted = 4; // opening(2) + bet(2)

    const pub = await bootApp(withOutbox);
    const hooks = pub.app.get(OutboxHooks);
    let crashes = 0;
    hooks.afterSend = () => {
      if (crashes++ < 2) throw new Error('simulated publisher crash after send, before commit');
    };
    try {
      const events = await collect((e) => mine.has(e.aggregateId), (g) => g.length >= wanted);
      // The whole backlog now travels in one batch, so the broker already has everything after the first crash;
      // keep going until the publisher has crashed twice and then recovered.
      await waitFor(async () => crashes >= 2, 15000, 'two simulated crashes');
      expect(new Set(events.map((e) => e.eventId)).size).toBe(wanted); // FIFO dedup absorbed the re-sends
      await waitFor(async () => (await pendingFor([...mine])) === 0 && true, 15000, 'outbox drained');
    } finally {
      hooks.afterSend = undefined;
      await pub.close();
    }
  }, 60000);

  test('events produced while no publisher runs are delivered after a restart', async () => {
    const w = await createWallet(t, '20.00');
    const bets = await Promise.all(Array.from({ length: 5 }, () => wager(t, w, { amount: '1.00' })));
    const mine = new Set([...(await walletAggregates(w.walletId)), ...bets.map((b) => b.body.transactionId)]);
    expect(await pendingFor([...mine])).toBe(2 + 5 * 2);

    const pub = await bootApp(withOutbox); // "restart": a fresh process picks up the backlog
    try {
      const events = await collect((e) => mine.has(e.aggregateId), (g) => g.length >= 12);
      expect(events).toHaveLength(12);
    } finally {
      await pub.close();
    }
    expect(await pendingFor([...mine])).toBe(0);
    expect((await api(t, 'GET', `/wallets/${w.walletId}`)).body.balance.amount).toBe('15.00');
  }, 60000);
});

describe('outbox retry and batching', () => {
  const manual = { ...env, OUTBOX_ENABLED: 'false', OUTBOX_RETRY_BASE_MS: '300', OUTBOX_RETRY_MAX_MS: '600', OUTBOX_MAX_ATTEMPTS: '3' };

  /** Replaces the broker call: records every batch and refuses what `refuse` selects (nothing is really sent). */
  function stubBroker(pub: TestApp, refuse: (e: { MessageGroupId?: string; Id?: string; MessageDeduplicationId?: string }, indexInGroup: number) => boolean) {
    const client = pub.app.get(SqsQueues).client;
    const batches: { MessageGroupId?: string; Id?: string; MessageDeduplicationId?: string }[][] = [];
    const real = client.send.bind(client);
    (client as any).send = async (cmd: unknown, ...rest: unknown[]) => {
      if (!(cmd instanceof SendMessageBatchCommand)) return (real as any)(cmd, ...rest);
      const entries = cmd.input.Entries!;
      batches.push(entries.map((e) => ({ ...e })));
      const seen = new Map<string, number>();
      const ok: { Id: string }[] = [];
      const bad: { Id: string; Code: string; Message: string; SenderFault: boolean }[] = [];
      for (const e of entries) {
        const n = seen.get(e.MessageGroupId!) ?? 0;
        seen.set(e.MessageGroupId!, n + 1);
        if (refuse(e, n)) bad.push({ Id: e.Id!, Code: 'Refused', Message: 'simulated refusal', SenderFault: false });
        else ok.push({ Id: e.Id! });
      }
      return { Successful: ok, Failed: bad } as any;
    };
    return { batches, restore: () => ((client as any).send = real) };
  }

  const row = async (aggregateId: string) =>
    t.orm.em.fork().execute<{ id: string; seq: string; attempts: number; published: boolean; dead: boolean; due_in_ms: number | null; last_error: string | null }[]>(
      `select id, seq, attempts, published_at is not null as published, dead_at is not null as dead,
              (extract(epoch from (next_attempt_at - now())) * 1000)::int as due_in_ms, last_error
         from outbox_events where aggregate_id = ? order by seq`,
      [aggregateId],
    );

  test('a refused event backs off, keeps its wallet in order, and goes DEAD after the limit without blocking it forever', async () => {
    const w = await createWallet(t, '50.00');
    await wager(t, w, { amount: '5.00' });
    const pub = await bootApp(manual);
    const publisher = pub.app.get(OutboxPublisher);
    const [first, second] = await row(w.walletId);
    expect(first && second).toBeTruthy();
    // refuse only the FIRST event of this wallet; the broker "accepts" its second one in the same batch
    const stub = stubBroker(pub, (e) => e.MessageDeduplicationId === first!.id);
    try {

      await publisher.publishOnce();
      let [a, b] = await row(w.walletId);
      expect(a).toMatchObject({ attempts: 1, published: false, dead: false });
      expect(a!.last_error).toContain('simulated refusal');
      expect(a!.due_in_ms).toBeGreaterThan(0); // scheduled in the future, by the database clock
      expect(b).toMatchObject({ published: false }); // not marked: it must not overtake the refused one

      // not due yet: nothing of this wallet is claimed
      const before = stub.batches.length;
      await publisher.publishOnce();
      const touched = stub.batches.slice(before).flat().filter((e) => e.MessageGroupId === w.walletId);
      expect(touched).toHaveLength(0);

      // backoff elapsed: second refusal, then the third one is fatal (OUTBOX_MAX_ATTEMPTS=3)
      await Bun.sleep(450);
      await publisher.publishOnce();
      [a] = await row(w.walletId);
      expect(a).toMatchObject({ attempts: 2, dead: false });
      await Bun.sleep(700);
      await publisher.publishOnce();
      [a, b] = await row(w.walletId);
      expect(a).toMatchObject({ attempts: 3, dead: true, published: false });
      expect(pub.app.get(MetricsService).total('outbox_events_dead_total')).toBe(1);

      // the DEAD event no longer blocks its wallet: the next cycle publishes the second one
      await publisher.publishOnce();
      [, b] = await row(w.walletId);
      expect(b).toMatchObject({ published: true, dead: false });
    } finally {
      stub.restore();
      await pub.close();
    }
  }, 30000);

  test('a hot wallet drains many events per cycle, in order', async () => {
    const w = await createWallet(t, '100.00');
    await Promise.all(Array.from({ length: 6 }, () => wager(t, w, { amount: '1.00' })));
    const pub = await bootApp(manual);
    const stub = stubBroker(pub, () => false);
    try {
      expect(await pub.app.get(OutboxPublisher).publishOnce()).toBeGreaterThan(0);
      const forWallet = stub.batches.flat().filter((e) => e.MessageGroupId === w.walletId);
      // before: one event per aggregate per cycle; now the wallet's backlog rides in a single batch
      expect(forWallet.length).toBeGreaterThanOrEqual(5);
      const seqs = (await row(w.walletId)).filter((r) => r.published).map((r) => BigInt(r.seq));
      expect(seqs.length).toBe(forWallet.length);
      expect(seqs).toEqual([...seqs].sort((x, y) => (x < y ? -1 : 1)));
    } finally {
      stub.restore();
      await pub.close();
    }
  }, 30000);
});
